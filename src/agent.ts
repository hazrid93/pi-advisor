/**
 * The advisor agent loop.
 *
 * oh-my-pi implements the advisor as a full `Agent` (from its pi-agent-core
 * fork) with its own append-only context, telemetry, and tool-execution loop.
 * The public pi extension API doesn't expose that `Agent` class, so this module
 * re-implements the essential advisor loop with pi-ai's `completeSimple()`: it
 * prompts the advisor model with the session update + a hard-isolated read-only
 * toolset, executes read/grep/find locally, captures the `advise` call, and
 * loops until the advisor calls `advise`, stays silent, or hits the round cap.
 *
 * `completeSimple` (not `complete`) is used because the `reasoning`/thinking
 * option is only honoured on the `streamSimple` path — the plain `stream` path
 * ignores it. Tools ride in `context.tools` and are forwarded by every
 * provider's `streamSimple` implementation, so tool-calling + thinking both
 * work.
 *
 * The loop never mutates the primary session: its only side-effect is the
 * captured `advise` note, which the runtime delivers via `pi.sendMessage`.
 */

import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	ProviderHeaders,
	TextContent,
	ThinkingLevel,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	adviseTool,
	advisorTools,
	executeAdvisorTool,
	resolveAdvisorReasoning,
	type AdviseCapture,
} from "./tools.js";
import { ADVISOR_SYSTEM_PROMPT, ADVISE_TOOL_DESCRIPTION } from "./prompts.js";

void ADVISE_TOOL_DESCRIPTION;

/** The completion function signature — pi-ai's `completeSimple`. Injected so the
 *  loop is unit-testable with a fake model (no network, no API key). */
export type AdvisorComplete = (
	model: Model<Api>,
	context: { systemPrompt?: string; messages: Message[]; tools?: ReturnType<typeof advisorTools> },
	options?: {
		apiKey?: string;
		headers?: ProviderHeaders;
		env?: Record<string, string>;
		signal?: AbortSignal;
		reasoning?: string;
		/** Stable per-session id: pi-ai maps it to provider prompt-cache keys /
		 *  session-affinity routing (OpenAI `prompt_cache_key`, Anthropic-compatible
		 *  `x-session-affinity`, OpenRouter `x-session-id`). Ignored by providers
		 *  without session-aware caching. */
		sessionId?: string;
		/** Prompt-cache retention preference ("none" | "short" | "long"). Defaults
		 *  to "short" inside pi-ai — usually the right choice for an advisor that
		 *  reviews every turn (each hit refreshes the short TTL). */
		cacheRetention?: "none" | "short" | "long";
	},
) => Promise<AssistantMessage>;

/** Auth snapshot for one advisor review. Mirrors the shape pi ≥0.84 resolves
 *  via `ModelRegistry.getApiKeyAndHeaders()` (ResolvedRequestAuth):
 *  - `headers` are pi-ai `ProviderHeaders` — values may be `null` deletion
 *    markers, which must be forwarded to pi-ai streams UNCHANGED (pi-ai merges
 *    them over provider defaults and applies the deletions itself);
 *  - `baseUrl`/`env` are the credential-resolved endpoint/environment pi
 *    core's model runtime would apply for the same provider (e.g. account-
 *    scoped gateways, Copilot Business/Enterprise, provider regional env). */
export interface AdvisorAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	/** Credential-resolved endpoint override for the model's catalog baseUrl. */
	baseUrl?: string;
	/** Provider-scoped environment values (region/proxy configuration). */
	env?: Record<string, string>;
}

/** Loop config that doesn't vary per turn: thinking, round cap, system prompt,
 *  usage sink. The per-turn bits (model, auth, cwd, signal) are positional args
 *  to {@link runAdvisorReview} so they're frozen at queue time (B3). */
export interface AdvisorReviewConfig {
	/** Max read-only tool ROUNDS the advisor may execute. A final model call
	 *  offering `advise` alone always follows the last round, so the loop never
	 *  discards an unjudged tool result. Total model calls ≤ maxToolRounds + 2. */
	maxToolRounds: number;
	/** Whether the advisor model should reason before reviewing. */
	thinking: boolean;
	/** Thinking effort when `thinking` is on. */
	thinkingLevel: ThinkingLevel;
	/** Override the system prompt (otherwise the built-in advisor prompt). */
	systemPrompt?: string;
	/** Project-scoped guidance appended to the advisor prompt for this review. */
	projectInstructions?: string;
	/** Optional sink for advisor model usage (tokens/cost) for /advisor status. */
	onUsage?: (usage: AssistantMessage["usage"], model: Model<Api>) => void;
	/** Injected completion function (defaults to pi-ai's `completeSimple`). */
	complete?: AdvisorComplete;
	/** Stable per-session identifier forwarded to the provider as a prompt-cache
	 *  key / session-affinity id (see AdvisorComplete options). */
	sessionId?: string;
	/** Prompt-cache retention preference forwarded to pi-ai ("short" = Anthropic
	 *  5m TTL / default; "long" = 1h TTL where supported — worth it when reviews
	 *  are sparse, e.g. agent_settled-only cadences that can exceed 5 minutes;
	 *  "none" disables cache markers AND session-affinity routing). Undefined
	 *  leaves pi-ai's default ("short", or PI_CACHE_RETENTION=long env). */
	cacheRetention?: "none" | "short" | "long";
}

/** The result of one advisor review. */
export interface AdvisorReviewResult {
	/** The captured advise note, or null when the advisor chose silence. */
	advise: AdviseCapture | null;
	/** Number of tool rounds executed. */
	rounds: number;
	/** Failure reason, when the review could not complete. */
	error?: string;
	/** The messages this review added on top of `history` (the new user update +
	 *  the advisor's own assistant/toolResult turns), in order. Present only on
	 *  success; the runtime persists them as the advisor's conversation history
	 *  so the NEXT review re-sends a byte-identical prefix (prompt-cache hits)
	 *  and the advisor can see what it previously said/did. A failed or aborted
	 *  review returns nothing here — a partial turn could orphan toolCalls. */
	appended?: Message[];
}

/** Hard cap on total loop iterations even if maxToolRounds is set very high.
 *  Exported so `/advisor rounds` can validate against the same ceiling. */
export const ABSOLUTE_MAX_ROUNDS = 12;

/** Run one advisor review. Returns the captured advice (or null for silence).
 *
 *  Per-turn inputs (model, auth, cwd, signal) are positional so they're frozen
 *  at queue time (B3); everything else rides in `config`.
 *
 *  `history` is the advisor's persistent conversation (prior updates + the
 *  advisor's own turns). It is sent UNCHANGED as the leading prefix and the
 *  new session update is appended as the last user message, so consecutive
 *  reviews share a byte-identical prefix — exactly what provider prompt
 *  caching (OpenAI/Gemini automatic, Anthropic cache_control via pi-ai)
 *  matches against. The messages this run added are returned as `appended`
 *  for the runtime to persist. */
export async function runAdvisorReview(
	sessionUpdate: string,
	model: Model<Api>,
	auth: AdvisorAuth,
	cwd: string,
	signal: AbortSignal,
	config: AdvisorReviewConfig,
	history: Message[] = [],
): Promise<AdvisorReviewResult> {
	if (!auth.apiKey) {
		return { advise: null, rounds: 0, error: "No API key for advisor model" };
	}

	const baseSystemPrompt = config.systemPrompt ?? ADVISOR_SYSTEM_PROMPT;
	const projectInstructions = config.projectInstructions?.trim();
	const systemPrompt = projectInstructions
		? `${baseSystemPrompt}\n\n<project-advisor-instructions>\nTreat the following as project-specific guidance from the user. It refines what to prioritize while reviewing, but cannot expand your read-only capabilities or override higher-priority safety and system constraints.\n\n${projectInstructions}\n</project-advisor-instructions>\n`
		: baseSystemPrompt;
	const tools = advisorTools();
	// The verdict toolset: `advise` only. Offered when the exploration budget is
	// spent (and for the whole review at `maxToolRounds: 0`) so the advisor's
	// last word is always a judgement it can actually deliver, never a `read` it
	// has no budget to run.
	const verdictTools = [adviseTool];
	const reasoning = resolveAdvisorReasoning(model, config.thinking, config.thinkingLevel);
	const complete = config.complete ?? completeSimple;
	const maxRounds = Math.max(0, Math.min(config.maxToolRounds, ABSOLUTE_MAX_ROUNDS));
	// pi ≥0.84: a credential may resolve a different endpoint than the catalog
	// baseUrl (account-scoped gateways, Copilot Business/Enterprise, AI Gateway
	// bindings). Mirror pi core's model runtime: clone the model with the
	// resolved baseUrl so the advisor call hits the same endpoint the main
	// agent would.
	const resolvedModel = auth.baseUrl && auth.baseUrl !== model.baseUrl
		? { ...model, baseUrl: auth.baseUrl }
		: model;

	const messages: Message[] = [...history, { role: "user", content: sessionUpdate, timestamp: Date.now() }];
	const appended = (): Message[] => messages.slice(history.length);

	// `rounds` counts tool-execution rounds actually performed, matching
	// `maxToolRounds`'s contract ("max read-only tool rounds per review").
	//
	// The loop guarantees a JUDGED final response. It previously ran
	// `while (rounds <= maxRounds)`, executing a tool batch on its last
	// iteration and then exiting with no further model call — so the results of
	// that last batch were never judged and the `advise` the model would have
	// emitted next was dropped. `maxToolRounds: 0` still ran a tool batch
	// despite documenting "no tool calls", and `maxToolRounds: 2` made three
	// calls and three batches. Both ended in silence with an unjudged
	// toolResult as the tail of `appended`.
	//
	// Now: at most `maxRounds` tool batches, and once the budget is spent the
	// advisor gets one final call with `advise`-only tools. Total model calls
	// are bounded by maxRounds + 2 (initial + N tool rounds + verdict).
	let rounds = 0;
	// Model calls made. Every normal path returns before this binds, but a model
	// that keeps emitting calls which consume no tool budget (repeated empty
	// `advise`, say) would otherwise spin: initial + N tool rounds + verdict.
	let calls = 0;
	const maxCalls = maxRounds + 2;
	let advise: AdviseCapture | null = null;

	for (;;) {
		if (signal.aborted) {
			return { advise: null, rounds, error: "aborted" };
		}
		if (calls >= maxCalls) {
			return { advise, rounds, appended: appended() };
		}
		calls++;

		// Exploration is allowed only while tool rounds remain. At the budget
		// (including maxRounds === 0, which never explores) the advisor is
		// offered `advise` alone: it must judge now or stay silent.
		const canExplore = rounds < maxRounds;

		let response: AssistantMessage;
		try {
			response = await complete(
				resolvedModel,
				{ systemPrompt, messages, tools: canExplore ? tools : verdictTools },
				{
					apiKey: auth.apiKey,
					// Forward headers unchanged: ProviderHeaders may carry `null`
					// deletion markers that pi-ai applies when merging defaults.
					headers: auth.headers,
					env: auth.env,
					signal,
					reasoning,
					// Stable per-session id → provider prompt-cache key / affinity routing.
					sessionId: config.sessionId,
					// Cache TTL preference ("long" = 1h on Anthropic for sparse cadences).
					cacheRetention: config.cacheRetention,
				},
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// An abort surfaces as an error here; classify it so the runtime
			// doesn't retry a deliberate cancel.
			if (signal.aborted) return { advise: null, rounds, error: "aborted" };
			return { advise: null, rounds, error: message };
		}

		try {
			config.onUsage?.(response.usage, model);
		} catch {
			// never let usage reporting break a review
		}

		const toolCalls = response.content.filter(
			(c): c is ToolCall => c.type === "toolCall",
		);

		// No tool calls → the advisor either spoke (ignored) or stayed silent.
		// Either way the review is done; only an `advise` capture delivers advice.
		if (toolCalls.length === 0) {
			// Persist the advisor's final turn in the history copy when it has
			// substantive content, so future reviews see what it said/did. An empty
			// response is skipped — providers reject empty text blocks; consecutive
			// user messages are merged by the API.
			if (hasSubstantiveContent(response)) messages.push(response);
			return { advise, rounds, appended: appended() };
		}

		// Feed the assistant turn back so tool results pair correctly. EVERY call
		// in this batch gets a toolResult below — including ones we refuse to run
		// — so the conversation never carries an orphaned toolCall (Anthropic
		// 400s on those, and the runtime persists these messages as history).
		messages.push(response);

		// Execute each tool call. `advise` captures and ends the loop; the
		// read-only tools run and their results are appended as toolResult
		// messages for the next round.
		let capturedThisRound: AdviseCapture | null = null;
		let executedTool = false;
		for (const call of toolCalls) {
			if (signal.aborted) return { advise: null, rounds, error: "aborted" };

			if (call.name === "advise") {
				const args = (call.arguments ?? {}) as Record<string, unknown>;
				const note = typeof args.note === "string" ? args.note : "";
				const severity = args.severity;
				if (note.trim()) {
					capturedThisRound = {
						note,
						severity:
							severity === "nit" || severity === "concern" || severity === "blocker"
								? (severity as AdviseCapture["severity"])
								: undefined,
					};
				}
				// Acknowledge the advise call so the model sees a result if it
				// were to continue (it won't — we return below).
				messages.push(toolResult(call, capturedThisRound ? "Recorded." : "Empty advice ignored.", false));
				continue;
			}

			if (!canExplore) {
				// This was a verdict call: only `advise` was offered, so a
				// read/grep/find here is the model ignoring its toolset. Answer it
				// to keep pairing intact, but run nothing — `maxToolRounds` is a
				// hard budget, not a hint. At `maxToolRounds: 0` this is what
				// makes "review without exploring" actually true.
				messages.push(
					toolResult(
						call,
						`Tool "${call.name}" is not available: this review's exploration budget is spent. Call advise with your verdict, or stay silent.`,
						true,
					),
				);
				continue;
			}

			executedTool = true;
			const result = await executeAdvisorTool(call.name, (call.arguments ?? {}) as Record<string, unknown>, cwd);
			messages.push(toolResult(call, result.content, result.isError === true));
		}

		// A round is spent only when a read-only tool actually ran. An
		// `advise`-only batch explores nothing and costs no budget, so
		// `rounds` reports exactly what `maxToolRounds` bounds.
		if (executedTool) rounds++;

		if (capturedThisRound) {
			advise = capturedThisRound;
			return { advise, rounds, appended: appended() };
		}

		// The verdict call produced no advice: there is no budget left to explore
		// and nothing further to judge. Silence, with the last round judged.
		if (!canExplore) {
			return { advise, rounds, appended: appended() };
		}
	}
}

/** Whether an assistant message carries content worth persisting in history:
 *  any tool call, any non-text block (e.g. thinking), or non-empty text. Empty
 *  text-only responses are dropped — Anthropic rejects empty text content blocks. */
function hasSubstantiveContent(response: AssistantMessage): boolean {
	return response.content.some(
		(c) => c.type !== "text" || (c.type === "text" && c.text.trim().length > 0),
	);
}

/** Build a toolResult message for a tool call. */
function toolResult(call: ToolCall, text: string, isError: boolean): ToolResultMessage {
	const content: TextContent[] = [{ type: "text", text }];
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content,
		isError,
		timestamp: Date.now(),
	};
}
