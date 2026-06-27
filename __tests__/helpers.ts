/**
 * Test helpers: a scriptable fake `complete` (no network) + minimal fixtures.
 *
 * Updated for the per-turn `runAdvisorReview(sessionUpdate, model, auth, cwd,
 * signal, config)` signature: `fakeDeps` now returns a `{ model, auth, cwd,
 * signal, config }` tuple the loop expects.
 */

import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	ToolCall,
} from "@earendil-works/pi-ai";
import type { AdvisorComplete } from "../src/agent.js";
import type { AdvisorReviewConfig } from "../src/agent.js";

/** A minimal advisor-capable model fixture. */
export function fakeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "fake-advisor",
		name: "Fake Advisor",
		api: "openai-completions" as Api,
		provider: "fake",
		baseUrl: "http://localhost",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...overrides,
	};
}

/** Build an AssistantMessage with the given content blocks. */
export function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions" as Api,
		provider: "fake",
		model: "fake-advisor",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/** A text-only assistant message. */
export function textAssistant(text: string): AssistantMessage {
	return assistantMessage([{ type: "text", text }]);
}

/** An advise tool call. */
export function adviseCall(note: string, severity?: string): ToolCall {
	return {
		type: "toolCall",
		id: `call_${Math.random().toString(36).slice(2, 8)}`,
		name: "advise",
		arguments: severity ? { note, severity } : { note },
	};
}

/** A read tool call. */
export function readCall(path: string): ToolCall {
	return {
		type: "toolCall",
		id: `call_${Math.random().toString(36).slice(2, 8)}`,
		name: "read",
		arguments: { path },
	};
}

/**
 * A scriptable fake `complete`. Each call pops the next scripted response.
 * Asserts it received the expected (model, context, options) shape so tests
 * also verify the loop calls completeSimple correctly.
 */
export function scriptableComplete(
	script: AssistantMessage[],
	onCall?: (model: Model<Api>, context: { systemPrompt?: string; messages: Message[]; tools?: unknown[] }, options?: { reasoning?: string; apiKey?: string }) => void,
): AdvisorComplete & { calls: { model: Model<Api>; messages: Message[]; reasoning?: string }[] } {
	const calls: { model: Model<Api>; messages: Message[]; reasoning?: string }[] = [];
	let i = 0;
	const fn = (async (
		model: Model<Api>,
		context: { systemPrompt?: string; messages: Message[]; tools?: unknown[] },
		options?: { apiKey?: string; headers?: Record<string, string>; signal?: AbortSignal; reasoning?: string },
	) => {
		calls.push({ model, messages: context.messages, reasoning: options?.reasoning });
		onCall?.(model, context, options);
		const next = script[i++] ?? script[script.length - 1];
		if (!next) throw new Error("scriptableComplete: script exhausted");
		return next;
	}) as AdvisorComplete;
	(fn as AdvisorComplete & { calls: typeof calls }).calls = calls;
	return fn as AdvisorComplete & { calls: typeof calls };
}

/** The per-turn args + config for `runAdvisorReview`, wired to a fake model +
 *  scriptable complete. Mirrors how the runtime calls the loop. */
export interface FakeTurnArgs {
	model: Model<Api>;
	auth: { apiKey?: string; headers?: Record<string, string> };
	cwd: string;
	signal: AbortSignal;
	config: AdvisorReviewConfig;
}

/** Build per-turn args + config wired to a fake model + scriptable complete. */
export function fakeTurn(
	model: Model<Api>,
	complete: AdvisorComplete,
	overrides: {
		cwd?: string;
		maxToolRounds?: number;
		thinking?: boolean;
		thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
		systemPrompt?: string;
	} = {},
): FakeTurnArgs {
	const cwd = overrides.cwd ?? "/tmp";
	return {
		model,
		auth: { apiKey: "fake-key", headers: {} },
		cwd,
		signal: new AbortController().signal,
		config: {
			maxToolRounds: overrides.maxToolRounds ?? 6,
			thinking: overrides.thinking ?? false,
			thinkingLevel: overrides.thinkingLevel ?? "medium",
			systemPrompt: overrides.systemPrompt,
			complete,
		},
	};
}
