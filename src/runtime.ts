/**
 * AdvisorRuntime — owns the per-turn review loop and delivery.
 *
 * Ported from oh-my-pi's `AdvisorRuntime`
 * (`packages/coding-agent/src/advisor/runtime.ts`), adapted to the pi extension
 * surface: instead of driving a second pi `Agent`, it runs `runAdvisorReview`
 * (a `completeSimple` loop) per queued turn and delivers the captured advice
 * back into the primary session via `pi.sendMessage`.
 *
 * Preserved from oh-my-pi:
 * - A backlog queue + single-flight `busy` guard so reviews never overlap.
 * - An `epoch` counter bumped on reset/dispose/session_start/compact/tree-nav
 *   so an in-flight review whose session was replaced/rewritten mid-prompt is
 *   dropped instead of delivering stale advice into the new conversation.
 * - 3-strike failure drop so a broken advisor model never stalls the session.
 * - Non-interrupting `nit` vs interrupting `concern`/`blocker` delivery.
 *
 * Two-layer repeat guard (B5): the advisor can't see its own prior advice
 * (those custom messages are not part of the per-turn payload), so a hard
 * delivery-time dedupe prevents repeats, and a compact "recent advice" preamble
 * is injected into the session-update header to give the model awareness (only
 * when dedupe didn't fire, so it never re-anchors on its own filtered output).
 *
 * Simplified for the extension:
 * - Reviews are fire-and-forget from `turn_end` (never block the main agent).
 * - The per-turn delta is the `turn_end` event's `message` + `toolResults`
 *   (see transcript.ts), not a byte-delta or a branch window. A rolling char
 *   buffer keeps cross-turn context bounded by `contextChars`.
 * - A lifecycle `AbortSignal` (captured per-turn) is threaded to the review and
 *   to the retry backoff, so abort/shutdown cancels in-flight work.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { runAdvisorReview, type AdvisorReviewResult } from "./agent.js";
import { buildSessionUpdate, serializeTurn } from "./transcript.js";
import {
	ADVISOR_CUSTOM_TYPE,
	adviceKey,
	formatAdvisorBatchContent,
	formatRecentAdvicePreamble,
	isInterruptingSeverity,
	RECENT_ADVICE_LIMIT,
	type AdvisorConfig,
	type AdvisorMessageDetails,
	type AdvisorNote,
} from "./index.js";

/** Minimal slice of the pi API the runtime drives. */
export interface AdvisorRuntimeHost {
	/** Deliver one advisor note batch into the primary session. */
	sendAdvice(notes: AdvisorNote[], model: string): Promise<void>;
}

/** One queued turn to review. Captures the per-turn context (B3) and the
 *  lifecycle signal (B2) so the review always executes against the session
 *  that queued it. */
interface PendingTurn {
	/** The advisor-facing "Session update" text for this turn. */
	text: string;
	/** The advisor model ref to review against (frozen at queue time). */
	modelRef: string;
	/** Auth snapshot for the advisor model (frozen at queue time). */
	auth: { apiKey?: string; headers?: Record<string, string> };
	/** The advisor model (frozen at queue time). */
	model: Model<Api>;
	/** Cwd the advisor explores against (the session cwd at queue time). */
	cwd: string;
	/** Lifecycle signal: aborted on dispose/reset/compact/tree-nav/session_shutdown. */
	signal: AbortSignal;
}

export class AdvisorRuntime {
	#pending: PendingTurn[] = [];
	#busy = false;
	#consecutiveFailures = 0;
	/** Bumped by every external reset/dispose/session_start/compact/tree-nav.
	 *  A drain iteration captures it before its awaits; a mismatch on resume
	 *  means a reset aborted the in-flight review, so the stale batch is dropped
	 *  instead of being retried into the post-reset conversation. */
	#epoch = 0;
	disposed = false;

	/** Rolling buffer of recent per-turn deltas, bounded by `contextChars`.
	 *  Replaces oh-my-pi's own append-only advisor context (which the extension
	 *  API can't reach) with a cheap char-bounded approximation. */
	#contextBuffer: string[] = [];
	#contextChars = 0;

	/** Ring of recently-delivered advice (dedupe + awareness). */
	#recentAdvice: AdvisorNote[] = [];
	#recentKeys = new Set<string>();

	/** Latest review result, for /advisor status. */
	#lastResult: AdvisorReviewResult | null = null;
	#lastAdvisorModel: string | null = null;

	/** Last time a review was *started*, for the cooldown throttle (D3). */
	#lastReviewAt = 0;

	/** Injectable review function — defaults to {@link runAdvisorReview}. Exposed
	 *  so the runtime's queue/epoch/retry discipline can be unit-tested with a
	 *  fake review instead of a real model call. */
	#review: (
		sessionUpdate: string,
		model: Model<Api>,
		auth: { apiKey?: string; headers?: Record<string, string> },
		cwd: string,
		signal: AbortSignal,
		config: Parameters<typeof runAdvisorReview>[5],
	) => Promise<AdvisorReviewResult>;

	constructor(
		private readonly host: AdvisorRuntimeHost,
		private readonly config: AdvisorConfig,
		review?: (
			sessionUpdate: string,
			model: Model<Api>,
			auth: { apiKey?: string; headers?: Record<string, string> },
			cwd: string,
			signal: AbortSignal,
			config: Parameters<typeof runAdvisorReview>[5],
		) => Promise<AdvisorReviewResult>,
	) {
		this.#review = review ?? ((text, model, auth, cwd, signal, cfg) => runAdvisorReview(text, model, auth, cwd, signal, cfg));
	}

	get isBusy(): boolean {
		return this.#busy;
	}

	get lastResult(): AdvisorReviewResult | null {
		return this.#lastResult;
	}

	get lastAdvisorModel(): string | null {
		return this.#lastAdvisorModel;
	}

	/** Called on each primary turn_end. Serializes the turn's payload, queues it,
	 *  and kicks the drain. */
	onTurnEnd(
		message: AgentMessage,
		toolResults: ToolResultMessage[],
		branch: SessionEntry[],
		ctx: {
			signal?: AbortSignal;
			cwd: string;
			modelRegistry: { find(provider: string, id: string): Model<Api> | undefined };
			getApiKeyAndHeaders(model: Model<Api>): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
		},
	): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (!this.config.enabled || !this.config.advisorModel) return Promise.resolve();

		const serialized = serializeTurn(message, toolResults);
		// Advance the rolling context buffer regardless of whether this turn had
		// conversational content, so the advisor's window tracks the live session.
		void branch; // branch no longer drives the delta; kept for API stability.
		if (serialized) {
			this.#pushContext(serialized);
		}

		if (!serialized) return Promise.resolve();
		return this.#queueReview(serialized, ctx);
	}

	/** Build the full session-update text from the rolling context buffer and a
	 *  recent-advice preamble (only when not about to be deduped). The current
	 *  turn is already in the buffer (pushed before queueing), so we just join. */
	#buildUpdate(withPreamble: boolean): string {
		const recent = withPreamble ? this.#recentAdvice.slice(-RECENT_ADVICE_LIMIT) : [];
		const preamble = recent.length > 0 ? formatRecentAdvicePreamble(recent) : undefined;
		const body = this.#contextBuffer.join("\n\n");
		return buildSessionUpdate(body, preamble);
	}

	/** Append a serialized turn to the rolling buffer, evicting oldest by chars. */
	#pushContext(serialized: string): void {
		this.#contextBuffer.push(serialized);
		this.#contextChars += serialized.length + 4; // join separator slop
		const cap = Math.max(512, this.config.contextChars);
		while (this.#contextChars > cap && this.#contextBuffer.length > 1) {
			const evicted = this.#contextBuffer.shift()!;
			this.#contextChars -= evicted.length + 4;
		}
	}

	/** Resolve auth + model at queue time (B3) and enqueue a turn for review. */
	async #queueReview(
		serializedTurn: string,
		ctx: {
			signal?: AbortSignal;
			cwd: string;
			modelRegistry: { find(provider: string, id: string): Model<Api> | undefined };
			getApiKeyAndHeaders(model: Model<Api>): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
		},
	): Promise<void> {
		const ref = this.config.advisorModel!;
		const parsed = this.#parseRef(ref);
		if (!parsed) {
			this.#lastResult = { advise: null, rounds: 0, error: `Invalid advisor model ref: ${ref}` };
			return;
		}
		const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
		if (!model) {
			this.#lastResult = { advise: null, rounds: 0, error: `Advisor model not found: ${ref}` };
			return;
		}
		const auth = await ctx.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			this.#lastResult = {
				advise: null,
				rounds: 0,
				error: !auth.ok ? auth.error : `No API key for advisor model ${ref}`,
			};
			return;
		}

		// Cooldown (D3): if a review started too recently, coalesce this turn
		// into the buffer and skip queueing — it'll be covered by the next review.
		const now = Date.now();
		if (this.config.cooldownMs > 0 && now - this.#lastReviewAt < this.config.cooldownMs) {
			return;
		}

		const turn: PendingTurn = {
			text: this.#buildUpdate(true),
			modelRef: ref,
			auth: { apiKey: auth.apiKey, headers: auth.headers },
			model,
			cwd: ctx.cwd,
			signal: this.#adoptSignal(ctx.signal),
		};
		this.#pending.push(turn);
		await this.#drain();
	}

	/** Shared lifecycle controller — aborted by reset/dispose/compact/tree-nav
	 *  to cancel the in-flight review. Per-turn signals compose with this via
	 *  `AbortSignal.any` rather than mutating it, so a per-turn abort can't
	 *  poison later turns. */
	#lifecycle = new AbortController();

	/** Wrap the turn's signal so aborting it OR the shared lifecycle cancels
	 *  the in-flight review (B2). Composition via `AbortSignal.any` keeps the
	 *  lifecycle shared (so reset/dispose/compact cancels everything) WITHOUT a
	 *  per-turn abort leaking into the shared controller — a Ctrl+C on turn N
	 *  must not permanently break the advisor for turn N+1. `AbortSignal.any`
	 *  propagates an already-aborted input (the composed signal aborts at once),
	 *  so the drain's existing `batch.signal.aborted` check handles bailed turns. */
	#adoptSignal(turnSignal?: AbortSignal): AbortSignal {
		if (turnSignal) return AbortSignal.any([turnSignal, this.#lifecycle.signal]);
		return this.#lifecycle.signal;
	}

	/** Seed the context buffer so enabling mid-session doesn't replay old turns.
	 *  With the rolling buffer model the seed is simply "start empty": only new
	 *  turns go in. Kept as a no-op for the wiring layer's existing call sites. */
	seedToLeaf(_branch: SessionEntry[]): void {
		this.#contextBuffer = [];
		this.#contextChars = 0;
		this.#pending = [];
	}

	/** Re-prime after a history rewrite (compaction, session switch/resume,
	 *  fork). Bumps the epoch (dropping any in-flight review) and clears the
	 *  rolling context buffer. */
	reset(): void {
		this.#bumpEpoch();
		this.#pending = [];
		this.#consecutiveFailures = 0;
		this.#contextBuffer = [];
		this.#contextChars = 0;
	}

	/** Tear down: drop everything and abort any in-flight review. */
	dispose(): void {
		this.disposed = true;
		this.#bumpEpoch();
		this.#pending = [];
		this.#consecutiveFailures = 0;
	}

	/** Bump the epoch and abort the lifecycle controller (replacing it). */
	#bumpEpoch(): void {
		this.#epoch++;
		this.#lifecycle.abort();
		this.#lifecycle = new AbortController();
	}

	/** Called from a command context to run one review on demand. */
	async reviewNow(
		message: AgentMessage,
		toolResults: ToolResultMessage[],
		ctx: {
			signal?: AbortSignal;
			cwd: string;
			modelRegistry: { find(provider: string, id: string): Model<Api> | undefined };
			getApiKeyAndHeaders(model: Model<Api>): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
		},
	): Promise<AdvisorReviewResult | null> {
		if (this.#busy) return null;
		const serialized = serializeTurn(message, toolResults);
		if (!serialized || !this.config.advisorModel) return null;
		this.#pushContext(serialized);
		await this.#queueReview(serialized, ctx);
		return this.#lastResult;
	}

	async #drain(): Promise<AdvisorReviewResult | null> {
		if (this.#busy) return null;
		this.#busy = true;
		try {
			while (!this.disposed && this.#pending.length) {
				const epoch = this.#epoch;
				const batch = this.#pending.shift()!;
				if (this.#epoch !== epoch) continue; // reset invalidated this batch

				if (batch.signal.aborted) continue;

				this.#lastReviewAt = Date.now();
				const result = await this.#runOne(batch);
				if (this.#epoch !== epoch) continue; // reset during review

				if (result.error) {
					this.#consecutiveFailures++;
					if (this.#consecutiveFailures >= Math.max(1, this.config.maxRetries)) {
						// B4a: record the failure so /advisor review reports it, not the
						// stale prior success. Mirrors #runOne's {advise:null,error} pattern.
						this.#lastResult = result;
						this.#consecutiveFailures = 0;
						this.#pending = [];
					} else {
						// Re-queue and back off. The backoff is abortable: chained to the
						// lifecycle signal so dispose/reset cancels it immediately (B2).
						this.#pending.unshift(batch);
						const aborted = await abortableDelay(1000, batch.signal);
						if (aborted || this.#epoch !== epoch) continue;
					}
					continue;
				}

				this.#consecutiveFailures = 0;
				this.#lastResult = result;
				if (result.advise) {
					const note: AdvisorNote = { note: result.advise.note, severity: result.advise.severity };
					const key = adviceKey(note.note);
					// B5: hard dedupe at delivery. Skip repeats outright.
					if (!this.#recentKeys.has(key)) {
						this.#recentKeys.add(key);
						this.#recentAdvice.push(note);
						while (this.#recentAdvice.length > RECENT_ADVICE_LIMIT) {
							const evicted = this.#recentAdvice.shift()!;
							this.#recentKeys.delete(adviceKey(evicted.note));
						}
						await this.host.sendAdvice(
							[note],
							this.#lastAdvisorModel ?? this.config.advisorModel ?? "",
						);
					}
				}
			}
			return this.#lastResult;
		} finally {
			this.#busy = false;
		}
	}

	async #runOne(turn: PendingTurn): Promise<AdvisorReviewResult> {
		this.#lastAdvisorModel = turn.modelRef;
		return this.#review(turn.text, turn.model, turn.auth, turn.cwd, turn.signal, this.#realDepsAdapter());
	}

	/** Adapter that lets the injectable `review(text, ref)` test path drive the
	 *  real loop with the per-turn-frozen model/auth/cwd/signal. */
	#realDepsAdapter(): Parameters<typeof runAdvisorReview>[5] {
		return {
			thinking: this.config.thinking,
			thinkingLevel: this.config.thinkingLevel,
			maxToolRounds: this.config.maxToolRounds,
			systemPrompt: this.config.systemPrompt,
			onUsage: () => {},
		};
	}

	#parseRef(ref: string): { provider: string; id: string } | null {
		const i = ref.indexOf("/");
		if (i <= 0) return null;
		return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
	}
}

/** A delay that resolves to `true` if `signal` aborted before the timeout, else
 *  `false`. Used for the retry backoff so dispose/reset cancels it (B2). */
function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(true);
	return new Promise((resolve) => {
		// Use the global timers so test monkeypatches of globalThis.setTimeout
		// are honoured (a module-closure reference would capture the original).
		const t = globalThis.setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(false);
		}, ms);
		const onAbort = () => {
			globalThis.clearTimeout(t);
			resolve(true);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** Decide how to deliver one advisor note via `pi.sendMessage`. Maps oh-my-pi's
 *  severity→channel logic onto pi's delivery modes:
 *  - `nit` → non-interrupting: `deliverAs: "steer"` without `triggerTurn`. It
 *    lands at the next step boundary while the agent streams, or waits for the
 *    next user prompt if the agent is idle (nits are low priority).
 *  - `concern`/`blocker` → interrupting: `deliverAs: "steer"` WITH
 *    `triggerTurn: true` so an idle agent is resumed immediately; a streaming
 *    agent sees it at the next boundary and acts on it next turn. */
export function deliveryOptions(
	severity: AdvisorNote["severity"],
	forceInterrupting = false,
): { deliverAs: "steer"; triggerTurn?: boolean } {
	if (forceInterrupting || isInterruptingSeverity(severity)) {
		return { deliverAs: "steer", triggerTurn: true };
	}
	return { deliverAs: "steer" };
}

/** Build the host wiring that turns runtime advice into a `pi.sendMessage` call.
 *  `getInterrupting` is read live on each delivery so the `/advisor interrupting`
 *  toggle takes effect without rebuilding the host. */
export function makeHost(
	pi: {
		sendMessage: (
			message: {
				customType: string;
				content: string;
				display: boolean;
				details: unknown;
			},
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
		) => void | Promise<void>;
	},
	getInterrupting: () => boolean = () => false,
): Pick<AdvisorRuntimeHost, "sendAdvice"> {
	return {
		sendAdvice: async (notes, model) => {
			const content = formatAdvisorBatchContent(notes);
			const details: AdvisorMessageDetails = { notes, model };
			const opts = deliveryOptions(notes[0]?.severity, getInterrupting());
			await pi.sendMessage(
				{
					customType: ADVISOR_CUSTOM_TYPE,
					content,
					display: true,
					details,
				},
				opts,
			);
		},
	};
}

/** Status line summary for /advisor status. */
export function summarizeResult(result: AdvisorReviewResult | null): string {
	if (!result) return "no review yet";
	if (result.error) return `last review failed: ${result.error}`;
	if (result.advise) {
		return `last advice (${result.advise.severity ?? "nit"}, ${result.rounds} rounds): ${result.advise.note.slice(0, 80)}${result.advise.note.length > 80 ? "…" : ""}`;
	}
	return `last review: silent (${result.rounds} rounds)`;
}
