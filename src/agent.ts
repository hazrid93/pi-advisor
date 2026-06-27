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
	options?: { apiKey?: string; headers?: Record<string, string>; signal?: AbortSignal; reasoning?: string },
) => Promise<AssistantMessage>;

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
	/** Optional sink for advisor model usage (tokens/cost) for /advisor status. */
	onUsage?: (usage: AssistantMessage["usage"], model: Model<Api>) => void;
	/** Injected completion function (defaults to pi-ai's `completeSimple`). */
	complete?: AdvisorComplete;
}

/** The result of one advisor review. */
export interface AdvisorReviewResult {
	/** The captured advise note, or null when the advisor chose silence. */
	advise: AdviseCapture | null;
	/** Number of tool rounds executed. */
	rounds: number;
	/** Failure reason, when the review could not complete. */
	error?: string;
}

/** Hard cap on total loop iterations even if maxToolRounds is set very high. */
const ABSOLUTE_MAX_ROUNDS = 12;

/** Run one advisor review. Returns the captured advice (or null for silence).
 *
 *  Per-turn inputs (model, auth, cwd, signal) are positional so they're frozen
 *  at queue time (B3); everything else rides in `config`. */
export async function runAdvisorReview(
	sessionUpdate: string,
	model: Model<Api>,
	auth: { apiKey?: string; headers?: Record<string, string> },
	cwd: string,
	signal: AbortSignal,
	config: AdvisorReviewConfig,
): Promise<AdvisorReviewResult> {
	if (!auth.apiKey) {
		return { advise: null, rounds: 0, error: "No API key for advisor model" };
	}

	const systemPrompt = config.systemPrompt ?? ADVISOR_SYSTEM_PROMPT;
	const tools = advisorTools();
	const reasoning = resolveAdvisorReasoning(model, config.thinking, config.thinkingLevel);
	const complete = config.complete ?? completeSimple;
	const maxRounds = Math.min(config.maxToolRounds, ABSOLUTE_MAX_ROUNDS);

	const messages: Message[] = [
		{ role: "user", content: sessionUpdate, timestamp: Date.now() },
	];

	let rounds = 0;
	let advise: AdviseCapture | null = null;

	while (rounds <= maxRounds) {
		if (signal.aborted) {
			return { advise: null, rounds, error: "aborted" };
		}

		let response: AssistantMessage;
		try {
			response = await complete(
				model,
				{ systemPrompt, messages, tools },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal,
					reasoning,
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
			return { advise, rounds };
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
			return { advise, rounds: rounds + 1 };
		}

		rounds++;
	}

	// Hit the round cap without advising. Treat as silence rather than an error
	// — the advisor explored but had nothing conclusive to raise.
	return { advise, rounds };
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
