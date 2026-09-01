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

import type { Api, AssistantMessage, Message, Model, ProviderHeaders, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { runAdvisorReview, type AdvisorAuth, type AdvisorReviewResult } from "./agent.js";
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
	type AdvisorTrigger,
} from "./index.js";

/** Minimal slice of the pi API the runtime drives. */
export interface AdvisorRuntimeHost {
	/** Deliver one advisor note batch into the primary session.
	 *  `forceNonTriggering` (set for `agent_settled`-triggered reviews) suppresses
	 *  `triggerTurn` regardless of severity, so a settled review can never start
	 *  another agent run and re-trigger `agent_settled` (review→advice→run loop). */
	sendAdvice(notes: AdvisorNote[], model: string, opts?: { forceNonTriggering?: boolean }): Promise<void>;
}

/** Context the runtime needs to resolve the advisor model/auth and run a
 *  review. Extracted from the per-event pi payloads so every trigger
 *  (`turn_end`, `tool_execution_end`, `agent_settled`, `input`, the
 *  `mid_pause` debounce) can feed the same {@link AdvisorRuntime.requestReview}
 *  path. */
export interface ReviewCtx {
	signal?: AbortSignal;
	cwd: string;
	modelRegistry: { find(provider: string, id: string): Model<Api> | undefined };
	/** pi ≥0.84 resolves auth as ResolvedRequestAuth: `headers` are pi-ai
	 *  ProviderHeaders (values may be `null` deletion markers) and a
	 *  credential-resolved `baseUrl`/`env` may accompany the key. All are
	 *  forwarded to the advisor's pi-ai stream unchanged. */
	getApiKeyAndHeaders(model: Model<Api>): Promise<
		| { ok: true; apiKey?: string; headers?: ProviderHeaders; baseUrl?: string; env?: Record<string, string> }
		| { ok: false; error: string }
	>;
	projectInstructions?: string;
}

/** Options for {@link AdvisorRuntime.requestReview}. */
interface RequestOpts {
	/** Which trigger scheduled this review (for future telemetry/debug). */
	source?: AdvisorTrigger;
	/** Extra text appended to the snapshot (e.g. the just-completed tool for
	 *  `tool_result`, or the new prompt for `input`). */
	extra?: string;
	/** When true, delivery never sets `triggerTurn` — used by `agent_settled`
	 *  to break the review→advice→run→settled loop. */
	forceNonTriggering?: boolean;
}

/** One queued turn to review. Captures the per-turn context (B3) and the
 *  lifecycle signal (B2) so the review always executes against the session
 *  that queued it. */
interface PendingTurn {
	/** The staged, not-yet-reviewed per-turn deltas for this review (the
	 *  rolling buffer's content, MOVED here at commit so it can't be lost). On
	 * latest-wins replacement the superseded turn's deltas are merged in. */
	deltas: string;
	/** Extra text appended to the update (e.g. the just-completed tool for
	 *  `tool_result`, or the new prompt for `input`). */
	extra?: string;
	/** The advisor model ref to review against (frozen at queue time). */
	modelRef: string;
	/** Auth snapshot for the advisor model (frozen at queue time). */
	auth: AdvisorAuth;
	/** The advisor model (frozen at queue time). */
	model: Model<Api>;
	/** Cwd the advisor explores against (the session cwd at queue time). */
	cwd: string;
	/** Project instructions captured at queue time. */
	projectInstructions?: string;
	/** Lifecycle signal: aborted on dispose/reset/compact/tree-nav/session_shutdown. */
	signal: AbortSignal;
	/** Latest-wins generation captured at requestReview start. A batch whose gen
	 *  is no longer current by the time its review returns is suppressed (a newer
	 *  snapshot superseded it) and never delivered. */
	gen: number;
	/** Set for `agent_settled` reviews so delivery omits `triggerTurn`. */
	forceNonTriggering?: boolean;
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

	/** Rolling buffer of RECENT per-turn deltas, bounded by `contextChars`.
	 *  Replaces oh-my-pi's own append-only advisor context (which the extension
	 *  API can't reach) with a cheap char-bounded approximation. */
	#contextBuffer: string[] = [];
	#contextChars = 0;
	/** User session entries already copied into the rolling advisor context. */
	#seenUserEntryIds = new Set<string>();

	/** The advisor's PERSISTENT conversation: prior session updates + the
	 *  advisor's own assistant/toolResult turns, bounded by `contextChars`.
	 *  Every review sends this UNCHANGED as the leading prefix and appends one
	 *  new user message (the staged deltas), so consecutive requests share a
	 *  byte-identical prefix — what provider prompt caching matches against
	 *  (OpenAI/Gemini automatic prefix caching; Anthropic cache_control markers
	 *  applied by pi-ai). Without it, each review re-sent the whole rolling
	 *  buffer as a fresh single-message conversation: full input price every
	 *  turn and zero cache hits beyond the system prompt. */
	#advisorHistory: Message[] = [];
	#historyChars = 0;
	/** Stable per-session id forwarded to pi-ai as the provider prompt-cache key /
	 *  session-affinity id (OpenAI `prompt_cache_key`, Anthropic-compatible
	 *  `x-session-affinity`, OpenRouter `x-session-id`). */
	readonly #sessionId = randomUUID();

	/** Ring of recently-delivered advice (dedupe + awareness). */
	#recentAdvice: AdvisorNote[] = [];
	#recentKeys = new Set<string>();

	/** Latest review result, for /advisor status. */
	#lastResult: AdvisorReviewResult | null = null;
	#lastAdvisorModel: string | null = null;
	/** Usage of the last completed review round (tokens incl. cache split), for
	 *  /advisor status — makes prompt-cache effectiveness observable. */
	#lastUsage: AssistantMessage["usage"] | null = null;

	/** Last time a review was *started*, for the cooldown throttle (D3). */
	#lastReviewAt = 0;

	/** Latest-wins generation counter. Captured synchronously at the start of
	 *  every {@link requestReview} call (before any `await`) and re-checked after
	 *  each await so an older call that resolves auth slower than a newer one can
	 *  never overwrite a fresher snapshot. A batch stores the gen it was enqueued
	 *  with; delivery is suppressed when the batch's gen no longer equals
	 *  `#generation`. */
	#generation = 0;

	/** Set by `tool_execution_end` when `event.isError` is true, so the next
	 *  `turn_end` reviews the error *with* the finalized turn payload (rather than
	 *  a half-turn). Consumed by the coalesced shouldReview condition. */
	#pendingToolError = false;

	/** `mid_pause` trailing-debounce timer. Reset on every message/tool event so
	 *  only a genuine quiet period fires; cancelled on input/dispose/reset/
	 *  settled. Guarded by `#midPauseFiredThisRun` so it fires at most once per
	 *  user input (re-armed by `input`). */
	#midPauseTimer: ReturnType<typeof setTimeout> | null = null;
	#midPauseFiredThisRun = false;
	/** Per-review-run arming flag: cleared on `input`, set when `mid_pause`
	 *  first becomes armed. Lets us avoid arming the timer when `mid_pause` is
	 *  disabled without consulting the config on every token. */
	#midPauseArmed = false;

	/** Injectable review function — defaults to {@link runAdvisorReview}. Exposed
	 *  so the runtime's queue/epoch/retry discipline can be unit-tested with a
	 *  fake review instead of a real model call. The trailing `history` argument
	 *  is the advisor's persistent conversation (sent unchanged as the leading
	 *  prefix of every review — the prompt-cache invariant). */
	#review: (
		sessionUpdate: string,
		model: Model<Api>,
		auth: AdvisorAuth,
		cwd: string,
		signal: AbortSignal,
		config: Parameters<typeof runAdvisorReview>[5],
		history?: Message[],
	) => Promise<AdvisorReviewResult>;

	constructor(
		private readonly host: AdvisorRuntimeHost,
		private readonly config: AdvisorConfig,
		review?: (
			sessionUpdate: string,
			model: Model<Api>,
			auth: AdvisorAuth,
			cwd: string,
			signal: AbortSignal,
			config: Parameters<typeof runAdvisorReview>[5],
			history?: Message[],
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

	/** Token usage of the last completed advisor round (input/output plus the
	 *  cacheRead/cacheWrite split), for /advisor status. */
	get lastUsage(): AssistantMessage["usage"] | null {
		return this.#lastUsage;
	}

	/** How many turns the advisor is behind the main agent right now: the queued
	 *  backlog plus one if a review is currently in flight (the in-flight batch
	 *  was already `shift()`ed out of `#pending`, so the +1 counts it). This is
	 *  the backpressure metric `syncLag` gates against. Cooldown-coalesced turns
	 *  (the early `return` in `#queueReview`) intentionally don't enqueue, so
	 *  they don't count as lag — they're folded into the next review's buffer. */
	get lag(): number {
		return this.#pending.length + (this.#busy ? 1 : 0);
	}

	/** Wait until the advisor has caught up to within `threshold` turns (i.e.
	 *  `lag < threshold`), or until the wait is aborted/cancelled by a reset,
	 *  dispose, or the caller's signal. Used by the `turn_start` gate so the
	 *  main agent pauses before its next turn when the advisor has fallen
	 *  `syncLag` turns behind.
	 *
	 *  - `threshold <= 0`: never waits (returns immediately). This is the disable
	 *    path for `syncLag`.
	 *  - The wait resolves the moment `lag` drops below `threshold`; it polls on
	 *    a short interval rather than spinning.
	 *  - It is fully abortable: the lifecycle controller (reset/dispose/compact/
	 *    tree-nav) and the caller's per-turn signal (Ctrl+C) both cancel it, so a
	 *    slow/dead advisor model can never hang the main agent irrecoverably.
	 *    The epoch is re-checked on resume so the wait never blocks on a queue
	 *    that was just cleared by a reset. */
	async waitForCatchUp(threshold: number, signal?: AbortSignal): Promise<void> {
		if (threshold <= 0) return;
		if (this.lag < threshold) return;
		const composed = this.#adoptSignal(signal);
		const startEpoch = this.#epoch;
		while (!this.disposed && this.lag >= threshold) {
			// A reset/compact/tree-nav bumped the epoch: the backlog was cleared, so
			// there's nothing left to wait for. Stop instead of blocking on a queue
			// that no longer exists.
			if (this.#epoch !== startEpoch) return;
			if (composed.aborted) return;
			const abort = await abortableDelay(CATCHUP_POLL_MS, composed);
			if (abort || this.#epoch !== startEpoch) return;
		}
	}

	/** Returns true if `t` is in the configured trigger set. */
	#has(t: AdvisorTrigger): boolean {
		return this.config.triggers.includes(t);
	}

	/** Called on each primary turn_end. ALWAYS captures the finalized turn into
	 *  the rolling buffer (capture is decoupled from scheduling — switching
	 *  triggers off `turn_end` never loses context), then schedules a review iff
	 *  the coalesced condition holds:
	 *  `turn_end` is enabled, OR a tool error is pending AND `tool_error` is
	 *  enabled. The two default-enabled causes collapse to ONE `requestReview()`
	 *  so an errored turn isn't reviewed twice (the first model call would still
	 *  run even if its delivery were generation-suppressed). */
	onTurnEnd(
		message: AgentMessage,
		toolResults: ToolResultMessage[],
		branch: SessionEntry[],
		ctx: ReviewCtx,
	): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (!this.config.enabled || !this.config.advisorModel) return Promise.resolve();

		// --- capture (always, independent of triggers) ---
		const serialized = serializeTurn(message, toolResults);
		this.#captureNewUserMessages(branch);
		if (serialized) this.#pushContext(serialized);
		// Activity boundary: re-arm the mid_pause debounce for the next quiet period.
		this.#armMidPause(ctx);

		if (!serialized) return Promise.resolve();

		// --- schedule (coalesced, trigger-gated) ---
		const pendingError = this.#pendingToolError;
		this.#pendingToolError = false;
		const shouldReview = this.#has("turn_end") || (pendingError && this.#has("tool_error"));
		if (!shouldReview) return Promise.resolve();
		return this.requestReview({ source: pendingError && !this.#has("turn_end") ? "tool_error" : "turn_end", ctx });
	}

	/** `tool_execution_end` adapter. For any tool completion: arms/resets the
	 *  `mid_pause` debounce. When `event.isError`: sets `#pendingToolError` so
	 *  the *next* `turn_end` reviews the error alongside the finalized turn
	 *  (reviewing a half-turn would lose the assistant's recovery intent). When
	 *  `tool_result` is enabled: schedules an immediate review with the
	 *  just-finished tool injected as extra context. */
	onToolExecutionEnd(
		event: { toolCallId: string; toolName: string; result: unknown; isError?: boolean },
		ctx: ReviewCtx,
	): Promise<void> {
		if (this.disposed || !this.config.enabled || !this.config.advisorModel) return Promise.resolve();
		// Activity boundary: re-arm the mid_pause debounce for the next quiet period.
		this.#armMidPause(ctx);
		if (event.isError) this.#pendingToolError = true;
		if (this.#has("tool_result")) {
			const extra = `[tool ${event.isError ? "error" : "result"}: ${event.toolName}]\n${
				typeof event.result === "string" ? event.result : JSON.stringify(event.result)
			}`;
			return this.requestReview({ source: "tool_result", ctx, extra });
		}
		return Promise.resolve();
	}

	/** `agent_settled` adapter: fires once per agent run, after the whole
	 *  tool/turn loop with no automatic continuation. Delivers non-triggering
	 *  (`forceNonTriggering`) so the review can never start another run and
	 *  re-fire `agent_settled` (review→advice→run→settled loop). The `mid_pause`
	 *  timer is cancelled since the run is over. */
	onAgentSettled(ctx: ReviewCtx): Promise<void> {
		if (this.disposed || !this.config.enabled || !this.config.advisorModel) return Promise.resolve();
		this.#cancelMidPause();
		if (!this.#has("agent_settled")) return Promise.resolve();
		return this.requestReview({ source: "agent_settled", ctx, forceNonTriggering: true });
	}

	/** `input` adapter. ALWAYS delimits a goal (arms/cancels `mid_pause`) so the
	 *  debounce is scoped per-user-input regardless of whether `input` itself is
	 *  a review trigger. When `input` IS enabled: runs a prompt-review (judges
	 *  intent before the agent acts) with the prompt as extra context.
	 *
	 *  `source: "extension"` inputs are IGNORED entirely. pi fires `input` for
	 *  every `sendMessage` delivery — including THIS extension's own advice — so
	 *  treating them as user input would make the advisor review its own advice
	 *  (input trigger) or re-arm `mid_pause` after each delivery
	 *  (`#midPauseFiredThisRun` reset), a self-triggering review loop. Only real
	 *  user input (interactive/RPC) delimits a goal. */
	onInput(text: string, ctx: ReviewCtx, source?: "interactive" | "rpc" | "extension"): Promise<void> {
		if (this.disposed || !this.config.enabled || !this.config.advisorModel) return Promise.resolve();
		if (source === "extension") return Promise.resolve();
		// Re-arm mid_pause for a new run: a fresh prompt means any prior quiet
		// period was the inter-message gap, not a decision pause.
		this.#midPauseFiredThisRun = false;
		this.#armMidPause(ctx);
		if (!this.#has("input")) return Promise.resolve();
		return this.requestReview({ source: "input", ctx, extra: `[user prompt]\n${text}` });
	}

	/** `message_update` adapter: keeps the `mid_pause` debounce alive while the
	 *  agent streams, so only a genuine quiet period (no tokens AND no tool
	 *  activity) triggers a review. Never schedules directly off a token —
	 *  reviewing an incomplete snapshot races the active stream. */
	onMessageUpdate(ctx: ReviewCtx): void {
		if (this.disposed || !this.config.enabled || !this.config.advisorModel) return;
		this.#armMidPause(ctx);
	}

	/** Arm (or re-arm) the trailing debounce: reset the inactivity timer to
	 *  `midPauseMs`. Cancelled by reset/dispose/settled/input-armed-fresh; fires
	 *  at most once per user input (`#midPauseFiredThisRun`). */
	#armMidPause(ctx: ReviewCtx): void {
		if (!this.#has("mid_pause")) return;
		if (this.#midPauseFiredThisRun) return;
		this.#cancelMidPause();
		this.#midPauseArmed = true;
		this.#midPauseTimer = setTimeout(() => {
			this.#midPauseTimer = null;
			if (this.#midPauseFiredThisRun || this.disposed) return;
			this.#midPauseFiredThisRun = true;
			this.#midPauseArmed = false;
			// Fire-and-forget; the runtime's own single-flight + generation guards apply.
			void this.requestReview({ source: "mid_pause", ctx });
		}, this.config.midPauseMs);
	}

	#cancelMidPause(): void {
		if (this.#midPauseTimer) {
			clearTimeout(this.#midPauseTimer);
			this.#midPauseTimer = null;
		}
	}

	/** Build one review's session-update text: recent-advice preamble (so the
	 *  advisor can honor "NEVER repeat advice you already gave") + the
	 *  "### Session update" header + this review's staged deltas (+ extra).
	 *  Only the NEW delta rides here — prior turns live in the persistent
	 *  history prefix, keeping each request's uncached tail minimal. */
	#buildTurnText(deltas: string, extra: string | undefined, withPreamble: boolean): string {
		const recent = withPreamble ? this.#recentAdvice.slice(-RECENT_ADVICE_LIMIT) : [];
		const preamble = recent.length > 0 ? formatRecentAdvicePreamble(recent) : undefined;
		const body = [deltas, extra].filter(Boolean).join("\n\n");
		return buildSessionUpdate(body, preamble);
	}
	/** Add each new user prompt exactly once, preserving branch order. */
	#captureNewUserMessages(branch: SessionEntry[]): void {
		for (const entry of branch) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			if (this.#seenUserEntryIds.has(entry.id)) continue;
			this.#seenUserEntryIds.add(entry.id);
			const serialized = serializeTurn(entry.message, []);
			if (serialized) this.#pushContext(serialized);
		}
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

	/** Resolve auth + model and enqueue a review. Latest-wins discipline:
	 *  the generation counter is captured SYNCHRONOUSLY at the very start (before
	 *  any await) so overlapping events can't reorder; after each await we drop
	 *  this request if a newer one has superseded it. The pending queue holds at
	 *  most ONE entry (newer replaces older), so only the latest snapshot can
	 *  ever be reviewed/delivered. */
	async requestReview(opts: { source?: AdvisorTrigger; ctx: ReviewCtx; extra?: string; forceNonTriggering?: boolean }): Promise<void> {
		if (this.disposed || !this.config.advisorModel) return;
		// Snapshot the generation SYNCHRONOUSLY (before any await) so overlapping
		// events resolving auth out of order can't let an older snapshot win. We do
		// NOT bump it here: bumping before the cooldown early-return would
		// invalidate the in-flight review's delivery (gen mismatch) without
		// enqueuing a replacement, silently dropping BOTH. The generation is only
		// bumped once we commit to actually running (after cooldown passes).
		const startGen = this.#generation;
		const ctx = opts.ctx;
		const ref = this.config.advisorModel;
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
		let auth: Awaited<ReturnType<ReviewCtx["getApiKeyAndHeaders"]>>;
		try {
			auth = await ctx.getApiKeyAndHeaders(model);
		} catch (error) {
			// Event-triggered reviews are deliberately fire-and-forget so the advisor
			// does not stall pi. Convert registry/auth exceptions into observable
			// status instead of leaving an unhandled rejection and "no review yet".
			this.#lastResult = {
				advise: null,
				rounds: 0,
				error: error instanceof Error ? error.message : String(error),
			};
			return;
		}
		// A newer review already committed (bumped the generation) during this
		// await — drop this older one so it can't overwrite the fresher snapshot.
		if (this.#generation !== startGen) return;
		if (!auth.ok || !auth.apiKey) {
			this.#lastResult = {
				advise: null,
				rounds: 0,
				error: !auth.ok ? auth.error : `No API key for advisor model ${ref}`,
			};
			return;
		}

		// Cooldown (D3): if a review started too recently, coalesce into the buffer
		// (the next review will cover it) and skip queueing. We return WITHOUT
		// bumping the generation, so the in-flight review remains the latest and
		// its delivery is not suppressed.
		const now = Date.now();
		if (this.config.cooldownMs > 0 && now - this.#lastReviewAt < this.config.cooldownMs) {
			return;
		}

		// Commit: become the newest generation. Any still-in-flight review with an
		// older gen will have its delivery suppressed.
		const myGen = ++this.#generation;
		// Move the staged deltas into this pending turn (they are now frozen for
		// this review; new captures accumulate in the buffer for the NEXT one). A
		// superseded pending turn's deltas are MERGED in so latest-wins never
		// drops captured content. This happens at commit (after the auth/gen/
		// cooldown early-returns) so a dropped request leaves its deltas staged.
		const staged = this.#contextBuffer.join("\n\n");
		this.#contextBuffer = [];
		this.#contextChars = 0;
		const superseded = this.#pending[0];
		const deltas = [superseded?.deltas, staged].filter(Boolean).join("\n\n");
		const turn: PendingTurn = {
			deltas,
			extra: opts.extra,
			modelRef: ref,
			auth: { apiKey: auth.apiKey, headers: auth.headers, baseUrl: auth.baseUrl, env: auth.env },
			model,
			cwd: ctx.cwd,
			projectInstructions: ctx.projectInstructions,
			signal: this.#adoptSignal(ctx.signal),
			gen: myGen,
			forceNonTriggering: opts.forceNonTriggering,
		};
		// Latest-wins: keep at most one pending; a newer request replaces an older
		// one that hasn't drained yet.
		if (this.#pending.length > 0) this.#pending[0] = turn;
		else this.#pending.push(turn);
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

	/** Start with an empty context while marking existing user prompts as seen.
	 *  This prevents enabling/resuming mid-session from replaying old history;
	 *  prompts submitted after the seed are captured on the next turn_end. */
	seedToLeaf(branch: SessionEntry[]): void {
		this.#contextBuffer = [];
		this.#contextChars = 0;
		this.#pending = [];
		this.#pendingToolError = false;
		this.#cancelMidPause();
		this.#midPauseFiredThisRun = false;
		this.#advisorHistory = [];
		this.#historyChars = 0;
		this.#seenUserEntryIds = new Set(
			branch
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
				.map((entry) => entry.id),
		);
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
		this.#advisorHistory = [];
		this.#historyChars = 0;
		this.#seenUserEntryIds.clear();
		this.#pendingToolError = false;
		this.#cancelMidPause();
		this.#midPauseFiredThisRun = false;
		this.#midPauseArmed = false;
	}

	/** Tear down: drop everything and abort any in-flight review. */
	dispose(): void {
		this.disposed = true;
		this.#bumpEpoch();
		this.#pending = [];
		this.#consecutiveFailures = 0;
		this.#cancelMidPause();
		this.#midPauseFiredThisRun = false;
		this.#midPauseArmed = false;
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
		ctx: ReviewCtx,
	): Promise<AdvisorReviewResult | null> {
		if (this.#busy) return null;
		const serialized = serializeTurn(message, toolResults);
		if (!serialized || !this.config.advisorModel) return null;
		this.#pushContext(serialized);
		await this.requestReview({ source: "turn_end", ctx });
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
				// A newer trigger arrived while this call was in flight. Discard the
				// entire stale outcome (including errors) before retry/accounting. A
				// stale failure must never consume retries or clear the newer pending
				// snapshot after maxRetries.
				if (batch.gen !== this.#generation) continue;

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
							{ forceNonTriggering: batch.forceNonTriggering },
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
		// The review text is built at DRAIN time from the turn's frozen deltas —
		// deltas captured while the turn sat pending are already staged for the
		// NEXT review (or merged on latest-wins replacement), never lost.
		const text = this.#buildTurnText(turn.deltas, turn.extra, true);
		const result = await this.#review(
			text,
			turn.model,
			turn.auth,
			turn.cwd,
			turn.signal,
			this.#realDepsAdapter(turn),
			this.#advisorHistory,
		);
		// Persist the advisor's own turns into the conversation on success (even
		// if this batch was generation-suppressed for DELIVERY, the advisor really
		// said/did these things — keeping them preserves the NEVER-repeat context
		// and the cache prefix). Failed/aborted reviews append nothing: a partial
		// turn could orphan toolCalls without their toolResults.
		if (!result.error && result.appended && result.appended.length > 0) {
			this.#extendHistory(result.appended);
		}
		return result;
	}

	/** Append one review's messages to the persistent advisor conversation and
	 *  keep it bounded. Eviction drops the oldest HALF of review segments at
	 *  once (a segment starts at each user message) rather than one message per
	 *  review: batch eviction amortizes the prompt-cache miss — one cold request
	 *  now, then ~S/2 cache-hit reviews before the next trim. Cutting only at
	 *  user-message boundaries never orphans a toolResult from its toolCall. */
	#extendHistory(appended: Message[]): void {
		this.#advisorHistory.push(...appended.map(boundToolResultChars));
		this.#historyChars += appended.reduce((n, m) => n + estimateMessageChars(m), 0);
		const cap = Math.max(512, this.config.contextChars);
		if (this.#historyChars <= cap) return;
		const starts: number[] = []
		this.#advisorHistory.forEach((m, i) => {
			if (m.role === "user") starts.push(i);
		});
		// Never drop the only (newest) segment; a single oversized review is
		// bounded by maxToolRounds and the per-toolResult cap applied on append.
		if (starts.length <= 1) return;
		const dropSegments = Math.floor(starts.length / 2);
		const cut = starts[dropSegments];
		this.#advisorHistory = this.#advisorHistory.slice(cut);
		this.#historyChars = this.#advisorHistory.reduce((n, m) => n + estimateMessageChars(m), 0);
	}

	/** Adapter that lets the injectable `review(text, ref)` test path drive the
	 *  real loop with the per-turn-frozen model/auth/cwd/signal. */
	#realDepsAdapter(turn: PendingTurn): Parameters<typeof runAdvisorReview>[5] {
		return {
			thinking: this.config.thinking,
			thinkingLevel: this.config.thinkingLevel,
			maxToolRounds: this.config.maxToolRounds,
			systemPrompt: this.config.systemPrompt,
			projectInstructions: turn.projectInstructions,
			sessionId: this.#sessionId,
			onUsage: (usage) => {
				this.#lastUsage = usage;
			},
		};
	}

	#parseRef(ref: string): { provider: string; id: string } | null {
		const i = ref.indexOf("/");
		if (i <= 0) return null;
		return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
	}
}

/** Poll interval for {@link AdvisorRuntime.waitForCatchUp}. Short enough to feel
 *  responsive when a review finishes, long enough to avoid busy-waiting in the
 *  `turn_start` gate. Globals are used (not module-closure) so test monkeypatches
 *  of globalThis.setTimeout apply. */
const CATCHUP_POLL_MS = 50;

/** Hard cap on a toolResult's persisted text in the advisor history. The
 *  in-loop copy keeps the full result (the advisor needs it for the CURRENT
 *  review); the history copy only feeds future context, where a bounded tail
 *  suffices and keeps one read-heavy review from blowing the budget. */
const HISTORY_TOOL_RESULT_MAX_CHARS = 10_000;

/** Bound a message's persisted footprint: toolResult text beyond
 *  HISTORY_TOOL_RESULT_MAX_CHARS is truncated (head + tail) in the history
 *  copy. Other messages pass through unchanged. */
function boundToolResultChars(m: Message): Message {
	if (m.role !== "toolResult") return m;
	let text = "";
	for (const part of m.content) {
		if (part.type === "text") text += part.text;
	}
	if (text.length <= HISTORY_TOOL_RESULT_MAX_CHARS) return m;
	const head = Math.floor(HISTORY_TOOL_RESULT_MAX_CHARS * 0.7);
	const tail = HISTORY_TOOL_RESULT_MAX_CHARS - head;
	const truncated = `${text.slice(0, head)}\n\n[... advisor history truncated at ${HISTORY_TOOL_RESULT_MAX_CHARS} chars; full result was seen during that review ...]\n\n${text.slice(-tail)}`;
	return { ...m, content: [{ type: "text", text: truncated }] };
}

/** Rough char estimate of a message for budget accounting (never sent to the
 *  provider; only used to decide when the history needs trimming). */
function estimateMessageChars(m: Message): number {
	try {
		return JSON.stringify(m).length;
	} catch {
		return 512;
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
		sendAdvice: async (notes, model, opts) => {
			const content = formatAdvisorBatchContent(notes);
			const details: AdvisorMessageDetails = { notes, model };
			// `forceNonTriggering` (agent_settled reviews) suppresses triggerTurn
			// regardless of severity, breaking the review→advice→run→settled loop.
			const base = deliveryOptions(notes[0]?.severity, getInterrupting());
			const deliverOpts = opts?.forceNonTriggering
				? { deliverAs: base.deliverAs as "steer" }
				: base;
			await pi.sendMessage(
				{
					customType: ADVISOR_CUSTOM_TYPE,
					content,
					display: true,
					details,
				},
				deliverOpts,
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
