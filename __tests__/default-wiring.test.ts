/**
 * Default-wiring tests: construct `AdvisorRuntime` with NO injected review, so
 * the real `runAdvisorReview` runs against a mocked `completeSimple`.
 *
 * Every other runtime test injects a fake `review` through the constructor's
 * third parameter. That seam has always forwarded `history` correctly — which
 * is exactly why a six-parameter default closure could drop the seventh
 * argument and silently disable the advisor's persistent conversation while
 * the whole suite stayed green. These tests exercise the path production uses.
 */

import { describe, expect, it, vi } from "vitest";

const completeSimpleMock = vi.hoisted(() => vi.fn());
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: completeSimpleMock }));

import { AdvisorRuntime } from "../src/runtime.js";
import type { AdvisorConfig } from "../src/index.js";
import type { Api, AssistantMessage, Message, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const FAKE_MODEL: Model<Api> = {
	id: "fake",
	name: "Fake",
	api: "openai-completions" as Api,
	provider: "fake",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
};

const BASE_CONFIG: AdvisorConfig = {
	enabled: true,
	advisorModel: "fake/fake",
	thinking: false,
	thinkingLevel: "medium",
	contextChars: 24_000,
	turnInterval: 1,
	maxToolRounds: 2,
	maxRetries: 3,
	interrupting: true,
	syncLag: 0,
	triggers: ["turn_end"],
	midPauseMs: 4000,
	instructionsMode: "project",
};

function assistantTurn(text: string): { message: AgentMessage; toolResults: ToolResultMessage[] } {
	return {
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "fake",
			model: "fake",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		} as unknown as AgentMessage,
		toolResults: [],
	};
}

/** An assistant response that calls `advise` — ends the loop in one round. */
function adviseResponse(note: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call_${note}`, name: "advise", arguments: { note, severity: "nit" } }],
		api: "openai-completions",
		provider: "fake",
		model: "fake",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

/** Build a runtime through the DEFAULT wiring (no third constructor arg). */
function makeDefaultRuntime(config: Partial<AdvisorConfig> = {}) {
	const sendAdvice = vi.fn(async () => {});
	const rt = new AdvisorRuntime({ sendAdvice }, { ...BASE_CONFIG, ...config });
	const ctx = {
		signal: new AbortController().signal,
		cwd: "/tmp",
		modelRegistry: { find: () => FAKE_MODEL },
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k", headers: {} }),
	};
	return { rt, ctx, sendAdvice };
}

/**
 * `runAdvisorReview` mutates the `messages` array it passes to `complete` (it
 * pushes the assistant turn and tool results in place), so reading
 * `mock.calls[i]` afterwards shows the FINAL state, not what was sent. Snapshot
 * inside the mock instead.
 */
function captureRequests(): { messages: Message[]; tools: string[] }[] {
	const seen: { messages: Message[]; tools: string[] }[] = [];
	let n = 0;
	completeSimpleMock.mockImplementation(
		async (_model: unknown, ctx: { messages: Message[]; tools?: { name: string }[] }) => {
			seen.push({
				messages: structuredClone(ctx.messages),
				tools: (ctx.tools ?? []).map((t) => t.name),
			});
			return adviseResponse(`n${++n}`);
		},
	);
	return seen;
}

describe("default wiring: persistent advisor conversation", () => {
	it("sends the previous review's conversation as the prefix of the next", async () => {
		completeSimpleMock.mockReset();
		const seen = captureRequests();
		const { rt, ctx } = makeDefaultRuntime();

		const t1 = assistantTurn("first turn");
		await rt.onTurnEnd(t1.message, t1.toolResults, [], ctx);
		const t2 = assistantTurn("second turn");
		await rt.onTurnEnd(t2.message, t2.toolResults, [], ctx);

		expect(seen.length).toBe(2);
		// Review 1 is a cold start: just the session update.
		expect(seen[0].messages.length).toBe(1);
		// Review 2 carries review 1's full turn (update + advise call + its result)
		// ahead of the new update — the advisor remembers.
		expect(seen[1].messages.length).toBe(4);
		expect(seen[1].messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
	});

	it("keeps the prefix byte-identical across reviews (the prompt-cache invariant)", async () => {
		completeSimpleMock.mockReset();
		const seen = captureRequests();
		const { rt, ctx } = makeDefaultRuntime();

		for (const text of ["turn a", "turn b", "turn c"]) {
			const t = assistantTurn(text);
			await rt.onTurnEnd(t.message, t.toolResults, [], ctx);
		}

		expect(seen.length).toBe(3);
		// Each request must start with the previous request's messages, unchanged.
		expect(seen[1].messages.slice(0, seen[0].messages.length)).toEqual(seen[0].messages);
		expect(seen[2].messages.slice(0, seen[1].messages.length)).toEqual(seen[1].messages);
	});

	it("passes the advisor toolset and per-session options through to completeSimple", async () => {
		completeSimpleMock.mockReset();
		const seen = captureRequests();
		const { rt, ctx } = makeDefaultRuntime({ cacheRetention: "long" });

		const t = assistantTurn("only turn");
		await rt.onTurnEnd(t.message, t.toolResults, [], ctx);

		expect(seen[0].tools).toEqual(["read", "grep", "find", "advise"]);
		const options = completeSimpleMock.mock.calls[0][2] as {
			apiKey?: string;
			sessionId?: string;
			cacheRetention?: string;
		};
		expect(options.apiKey).toBe("k");
		expect(options.cacheRetention).toBe("long");
		// A stable per-session id is what the provider keys its cache/affinity on.
		expect(typeof options.sessionId).toBe("string");
		expect(options.sessionId).toBeTruthy();
	});

	it("resets the conversation on session replacement, restarting the prefix", async () => {
		completeSimpleMock.mockReset();
		const seen = captureRequests();
		const { rt, ctx } = makeDefaultRuntime();

		const t1 = assistantTurn("before");
		await rt.onTurnEnd(t1.message, t1.toolResults, [], ctx);
		rt.reset();
		const t2 = assistantTurn("after");
		await rt.onTurnEnd(t2.message, t2.toolResults, [], ctx);

		expect(seen.length).toBe(2);
		expect(seen[1].messages.length).toBe(1);
	});
});
