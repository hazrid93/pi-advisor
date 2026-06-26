/**
 * AdvisorRuntime — owns the per-turn review loop and delivery.
 *
 * Ported from oh-my-pi's `AdvisorRuntime`
 * (`packages/coding-agent/src/advisor/runtime.ts`), adapted to the pi extension
 * surface: instead of driving a second pi `Agent`, it runs `runAdvisorReview`
 * (a `completeSimple` loop) per queued delta and delivers the captured advice
 * back into the primary session via `pi.sendMessage`.
 *
 * Preserved from oh-my-pi:
 * - A backlog queue + single-flight `busy` guard so reviews never overlap.
 * - An `epoch` counter bumped on reset/dispose/session_start so an in-flight
 *   review whose session was replaced mid-prompt is dropped instead of
 *   delivering stale advice into the new conversation.
 * - 3-strike failure drop so a broken advisor model never stalls the session.
 * - Cursor seeding to the current leaf on first enable (don't replay history).
 * - Non-interrupting `nit` vs interrupting `concern`/`blocker` delivery.
 *
 * Simplified for the extension: reviews are fire-and-forget from `turn_end`
 * (they never block the main agent), and the per-turn delta is a bounded
 * trailing transcript window (see transcript.ts) rather than a byte-delta.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { runAdvisorReview, type AdvisorReviewResult } from "./agent.js";
import { buildAdvisorDelta } from "./transcript.js";
import {
	ADVISOR_CUSTOM_TYPE,
	formatAdvisorBatchContent,
	isInterruptingSeverity,
	type AdvisorConfig,
	type AdvisorMessageDetails,
	type AdvisorNote,
} from "./index.js";

/** Minimal slice of the pi API the runtime drives. */
export interface AdvisorRuntimeHost {
	/** Read the live primary transcript branch. */
	getBranch(): SessionEntry[];
	/** Deliver one advisor note batch into the primary session. */
	sendAdvice(notes: AdvisorNote[], model: string): Promise<void>;
	/** Resolve the advisor model from its "provider/id" ref. */
	resolveModel(ref: string): Model<Api> | undefined;
	/** Resolve auth for the advisor model. */
	getApiKeyAndHeaders(
		model: Model<Api>,
	): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
	/** Notify the user (TUI). No-op when headless. */
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface PendingDelta {
	text: string;
	/** The new cursor after this delta was built. */
	lastSeenEntryId: string | null;
}

export class AdvisorRuntime {
	#lastSeenEntryId: string | null = null;
	#pending: PendingDelta[] = [];
	#busy = false;
	#consecutiveFailures = 0;
	/** Bumped by every external reset/dispose/session_start. A drain iteration
	 *  captures it before its awaits; a mismatch on resume means a reset aborted
	 *  the in-flight review, so the stale batch is dropped instead of being
	 *  retried into the post-reset conversation. */
	#epoch = 0;
	disposed = false;

	/** Latest review result, for /advisor status. */
	#lastResult: AdvisorReviewResult | null = null;
	#lastAdvisorModel: string | null = null;

	/** Injectable review function — defaults to {@link runAdvisorReview}. Exposed
	 *  so the runtime's queue/epoch/retry discipline can be unit-tested with a
	 *  fake review instead of a real model call. */
	#review: (sessionUpdate: string, advisorModelRef: string) => Promise<AdvisorReviewResult>;

	constructor(
		private readonly host: AdvisorRuntimeHost,
		private readonly config: AdvisorConfig,
		review?: (sessionUpdate: string, advisorModelRef: string) => Promise<AdvisorReviewResult>,
	) {
		this.#review = review ?? ((text, ref) => runAdvisorReview(text, ref, this.#realDeps()));
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

	/** Called on each primary turn_end. Builds the delta and kicks the drain. */
	onTurnEnd(branch: SessionEntry[]): void {
		if (this.disposed) return;
		if (!this.config.enabled || !this.config.advisorModel) return;

		const delta = buildAdvisorDelta(branch, this.#lastSeenEntryId, this.config.contextEntries);
		// Always advance the cursor so we don't re-review the same turns next time,
		// even when there was nothing conversational to send (e.g. only custom
		// state entries landed).
		this.#lastSeenEntryId = delta.lastSeenEntryId;
		if (!delta.text) return;

		this.#pending.push({ text: delta.text, lastSeenEntryId: delta.lastSeenEntryId });
		void this.#drain();
	}

	/** Seed the cursor to the current leaf so enabling the advisor mid-session
	 *  doesn't replay the whole old conversation on the first enabled turn.
	 *  Mirrors oh-my-pi's `seedTo`. */
	seedToLeaf(branch: SessionEntry[]): void {
		const leaf = branch[branch.length - 1];
		this.#lastSeenEntryId = leaf?.id ?? null;
		this.#pending = [];
	}

	/** Re-prime after a history rewrite (compaction, session switch/resume,
	 *  fork). Clears the cursor so the next turn replays the bounded window. */
	reset(): void {
		this.#epoch++;
		this.#pending = [];
		this.#consecutiveFailures = 0;
	}

	/** Tear down: drop everything and abort any in-flight review. */
	dispose(): void {
		this.disposed = true;
		this.#epoch++;
		this.#pending = [];
		this.#consecutiveFailures = 0;
	}

	/** Called from a command context to run one review on demand (e.g. a
	 *  `/advisor review` re-review). Optional convenience. */
	async reviewNow(branch: SessionEntry[]): Promise<AdvisorReviewResult | null> {
		if (this.#busy) return null;
		// Force a full bounded-window review by resetting the cursor first.
		this.#lastSeenEntryId = null;
		const delta = buildAdvisorDelta(branch, null, this.config.contextEntries);
		this.#lastSeenEntryId = delta.lastSeenEntryId;
		if (!delta.text || !this.config.advisorModel) return null;
		this.#pending.push({ text: delta.text, lastSeenEntryId: delta.lastSeenEntryId });
		return this.#drain();
	}

	async #drain(): Promise<AdvisorReviewResult | null> {
		if (this.#busy) return null;
		this.#busy = true;
		try {
			while (!this.disposed && this.#pending.length) {
				const epoch = this.#epoch;
				const batch = this.#pending.shift()!;
				if (this.#epoch !== epoch) continue; // reset invalidated this batch

				const result = await this.#runOne(batch.text);
				// A reset during the review invalidates its outcome.
				if (this.#epoch !== epoch) continue;

				if (result.error) {
					this.#consecutiveFailures++;
					if (this.#consecutiveFailures >= Math.max(1, this.config.maxRetries)) {
						console.warn(
							`pi-advisor: review failed ${this.#consecutiveFailures}x; dropping backlog to prevent stall (${result.error})`,
						);
						this.#consecutiveFailures = 0;
						this.#pending = [];
					} else {
						// Re-queue and back off briefly.
						this.#pending.unshift(batch);
						await new Promise((r) => setTimeout(r, 1000));
						if (this.#epoch !== epoch) continue;
					}
					continue;
				}

				this.#consecutiveFailures = 0;
				this.#lastResult = result;
				if (result.advise) {
					const note: AdvisorNote = { note: result.advise.note, severity: result.advise.severity };
					await this.host.sendAdvice([note], this.#lastAdvisorModel ?? this.config.advisorModel ?? "");
				}
			}
			return this.#lastResult;
		} finally {
			this.#busy = false;
		}
	}

	async #runOne(sessionUpdate: string): Promise<AdvisorReviewResult> {
		const ref = this.config.advisorModel;
		if (!ref) return { advise: null, rounds: 0, error: "No advisor model configured" };
		this.#lastAdvisorModel = ref;
		return this.#review(sessionUpdate, ref);
	}

	/** Build the real {@link AdvisorLoopDeps} for {@link runAdvisorReview}. */
	#realDeps(): Parameters<typeof runAdvisorReview>[2] {
		const model = this.host.resolveModel(this.config.advisorModel!);
		return {
			resolveModel: () => model,
			getApiKeyAndHeaders: (m) => this.host.getApiKeyAndHeaders(m),
			cwd: this.hostCwd,
			signal: undefined,
			maxToolRounds: this.config.maxToolRounds,
			thinking: this.config.thinking,
			thinkingLevel: this.config.thinkingLevel,
			systemPrompt: this.config.systemPrompt,
			onUsage: () => {},
		};
	}

	// cwd is captured per-turn via the host; stored here for the sync review path.
	private hostCwd = "";

	/** Update the cwd the advisor explores against (the session cwd). */
	setCwd(cwd: string): void {
		this.hostCwd = cwd;
	}
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

