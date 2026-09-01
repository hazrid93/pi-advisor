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
	/** Max read-only tool rounds before the advisor must `advise` or yield. */
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

/** Hard cap on total loop iterations even if maxToolRounds is set very high. */
const ABSOLUTE_MAX_ROUNDS = 12;

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
	const reasoning = resolveAdvisorReasoning(model, config.thinking, config.thinkingLevel);
	const complete = config.complete ?? completeSimple;
	const maxRounds = Math.min(config.maxToolRounds, ABSOLUTE_MAX_ROUNDS);
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

	let rounds = 0;
	let advise: AdviseCapture | null = null;

	while (rounds <= maxRounds) {
		if (signal.aborted) {
			return { advise: null, rounds, error: "aborted" };
		}

		let response: AssistantMessage;
		try {
			response = await complete(
				resolvedModel,
				{ systemPrompt, messages, tools },
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

		// Feed the assistant turn back so tool results pair correctly.
		messages.push(response);

		// Execute each tool call. `advise` captures and ends the loop; the
		// read-only tools run and their results are appended as toolResult
		// messages for the next round.
		let capturedThisRound: AdviseCapture | null = null;
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
				// were to continue (it won't — we break below).
				messages.push(toolResult(call, capturedThisRound ? "Recorded." : "Empty advice ignored.", false));
				continue;
			}

			const result = await executeAdvisorTool(call.name, (call.arguments ?? {}) as Record<string, unknown>, cwd);
			messages.push(toolResult(call, result.content, result.isError === true));
		}

		if (capturedThisRound) {
			advise = capturedThisRound;
			return { advise, rounds: rounds + 1, appended: appended() };
		}

		rounds++;
	}

	// Hit the round cap without advising. Treat as silence rather than an error
	// — the advisor explored but had nothing conclusive to raise.
	return { advise, rounds, appended: appended() };
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
