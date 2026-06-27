/**
 * Unit tests for AdvisorRuntime (src/runtime.ts) — backlog, single-flight,
 * epoch guards, 3-strike drop, rolling-context seeding, delivery-time dedupe.
 *
 * Uses an injectable `review` function (no real model call) so the runtime's
 * queue + epoch + retry discipline is fully testable. Updated for the
 * event-payload model: onTurnEnd/reviewNow take (message, toolResults, branch, ctx).
 */

import { describe, expect, it, vi } from "vitest";
import { AdvisorRuntime, deliveryOptions } from "../src/runtime.js";
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ADVISOR_CUSTOM_TYPE } from "../src/index.js";
import type { AdvisorReviewResult } from "../src/agent.js";

let idCounter = 0;
function entry(role: "user" | "assistant", text: string): SessionEntry {
	idCounter++;
	return {
		type: "message",
		id: `e${idCounter}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role,
			content: role === "assistant" ? [{ type: "text", text }] : text,
			...(role === "assistant"
				? {
						api: "openai-completions",
						provider: "fake",
						model: "fake",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "stop" as const,
						timestamp: Date.now(),
					}
				: { timestamp: Date.now() }),
		} as unknown as AgentMessage,
	} as unknown as SessionEntry;
}
function advisorEntry(note = "x"): SessionEntry {
	idCounter++;
	return {
		type: "custom_message",
		id: `a${idCounter}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: ADVISOR_CUSTOM_TYPE,
		content: `<advisory>${note}</advisory>`,
		display: true,
		details: { notes: [{ note }], model: "fake/fake" },
	} as SessionEntry;
}

/** The runtime's full review-fn signature, simplified for tests. */
type ReviewFn = (
	text: string,
	model: Model<Api>,
	auth: { apiKey?: string; headers?: Record<string, string> },
	cwd: string,
	signal: AbortSignal,
	config: { maxToolRounds: number; thinking: boolean; thinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh"; systemPrompt?: string; onUsage?: () => void },
) => Promise<AdvisorReviewResult>;

/** A usable assistant message + toolResults for a turn. */
function turn(text: string): { message: AssistantMessage; toolResults: ToolResultMessage[] } {
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
		},
		toolResults: [],
	};
}

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

function makeRuntime(
	review: ReviewFn,
	branch: SessionEntry[] = [],
	config: Partial<{ maxRetries: number; contextChars: number; advisorModel: string | null; enabled: boolean; cooldownMs: number }> = {},
) {
	const sendAdvice = vi.fn(async () => {});
	const host = { sendAdvice };
	const rt = new AdvisorRuntime(
		host as never,
		{
		enabled: config.enabled ?? true,
			advisorModel: config.advisorModel === undefined ? "fake/fake" : config.advisorModel,
			thinking: false,
			thinkingLevel: "medium" as const,
			contextChars: config.contextChars ?? 12_000,
			cooldownMs: config.cooldownMs ?? 0,
			maxToolRounds: 6,
			maxRetries: config.maxRetries ?? 3,
			interrupting: true,
		},
		review as never,
	);
	const ctx = {
		signal: new AbortController().signal,
		cwd: "/tmp",
		modelRegistry: { find: () => FAKE_MODEL },
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k", headers: {} }),
	};
	return { rt, sendAdvice, host, ctx, branch };
}

/** Wait for the runtime's background drain to settle (no busy). */
async function settle(rt: AdvisorRuntime, ms = 50): Promise<void> {
	for (let i = 0; i < 50 && rt.isBusy; i++) {
		await new Promise((r) => setTimeout(r, ms / 10));
	}
	await new Promise((r) => setTimeout(r, 5));
}

describe("deliveryOptions", () => {
	it("nit is non-interrupting when forceInterrupting is false", () => {
		expect(deliveryOptions("nit")).toEqual({ deliverAs: "steer" });
		expect(deliveryOptions(undefined)).toEqual({ deliverAs: "steer" });
	});
	it("concern and blocker are interrupting (triggerTurn: true)", () => {
		expect(deliveryOptions("concern")).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(deliveryOptions("blocker")).toEqual({ deliverAs: "steer", triggerTurn: true });
	});
	it("forceInterrupting makes ALL severities interrupting (including nit)", () => {
		expect(deliveryOptions("nit", true)).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(deliveryOptions(undefined, true)).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(deliveryOptions("concern", true)).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(deliveryOptions("blocker", true)).toEqual({ deliverAs: "steer", triggerTurn: true });
	});
});

describe("AdvisorRuntime — happy path", () => {
	it("delivers captured advice via the host on turn_end", async () => {
		const { rt, sendAdvice, ctx } = makeRuntime(async () => ({ advise: { note: "watch the queue", severity: "concern" }, rounds: 1 }));
		const t = turn("do the thing");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "do the thing")], ctx);
		await settle(rt);
		expect(sendAdvice).toHaveBeenCalledTimes(1);
		expect((sendAdvice.mock.calls[0] as unknown[])[0]).toEqual([{ note: "watch the queue", severity: "concern" }]);
		expect(rt.lastResult?.advise?.note).toBe("watch the queue");
		expect(rt.isBusy).toBe(false);
	});

	it("does nothing when no advisor model is configured", async () => {
		const review = vi.fn(async () => ({ advise: null, rounds: 0 }));
		const { rt, sendAdvice, ctx } = makeRuntime(review as never, [], { advisorModel: null });
		const t = turn("hi");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "hi")], ctx);
		await settle(rt);
		expect(review).not.toHaveBeenCalled();
		expect(sendAdvice).not.toHaveBeenCalled();
	});

	it("does nothing when disabled", async () => {
		const review = vi.fn(async () => ({ advise: null, rounds: 0 }));
		const { rt, sendAdvice, ctx } = makeRuntime(review as never, [], { enabled: false });
		const t = turn("hi");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "hi")], ctx);
		await settle(rt);
		expect(review).not.toHaveBeenCalled();
		expect(sendAdvice).not.toHaveBeenCalled();
	});

	it("stays silent (no delivery) when the advisor review returns no advise", async () => {
		const { rt, sendAdvice, ctx } = makeRuntime(async () => ({ advise: null, rounds: 0 }));
		const t = turn("all good");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "all good")], ctx);
		await settle(rt);
		expect(sendAdvice).not.toHaveBeenCalled();
		expect(rt.lastResult?.advise).toBeNull();
	});
});

describe("AdvisorRuntime — B5 delivery-time dedupe", () => {
	it("does not deliver an identical repeat note twice", async () => {
		const { rt, sendAdvice, ctx } = makeRuntime(async () => ({ advise: { note: "same note", severity: "nit" }, rounds: 1 }));
		const t = turn("x");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		await settle(rt);
		const t2 = turn("y");
		void rt.onTurnEnd(t2.message as AgentMessage, t2.toolResults, [entry("user", "y")], ctx);
		await settle(rt);
		expect(sendAdvice).toHaveBeenCalledTimes(1);
	});

	it("delivers two distinct notes", async () => {
		let n = 0;
		const { rt, sendAdvice, ctx } = makeRuntime(async () => ({ advise: { note: `note ${++n}`, severity: "nit" }, rounds: 1 }));
		const t = turn("x");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		await settle(rt);
		const t2 = turn("y");
		void rt.onTurnEnd(t2.message as AgentMessage, t2.toolResults, [entry("user", "y")], ctx);
		await settle(rt);
		expect(sendAdvice).toHaveBeenCalledTimes(2);
	});
});

describe("AdvisorRuntime — failure handling", () => {
	it("retries up to maxRetries then drops the backlog (3-strike)", async () => {
		let calls = 0;
		const { rt, sendAdvice, ctx } = makeRuntime(
			async () => {
				calls++;
				return { advise: null, rounds: 0, error: "boom" };
			},
			[],
			{ maxRetries: 3 },
		);
		const original = setTimeout;
		(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) =>
			original(fn, ms ? 1 : 1)) as typeof setTimeout;
		try {
			const t = turn("x");
			await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		} finally {
			(globalThis as { setTimeout: typeof setTimeout }).setTimeout = original;
		}
		expect(calls).toBe(3);
		expect(sendAdvice).not.toHaveBeenCalled();
		expect(rt.isBusy).toBe(false);
		// B4a: lastResult records the failure, not a stale prior success.
		expect(rt.lastResult?.error).toBe("boom");
	}, 15000);

	it("recovers (clears failures) after a successful review following an error", async () => {
		let n = 0;
		const { rt, sendAdvice, ctx } = makeRuntime(async () => {
			n++;
			return n === 1 ? { advise: null, rounds: 0, error: "transient" } : { advise: { note: "ok", severity: "nit" }, rounds: 1 };
		});
		const original = setTimeout;
		(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) =>
			original(fn, ms ? 1 : 1)) as typeof setTimeout;
		try {
			const t = turn("x");
			await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		} finally {
			(globalThis as { setTimeout: typeof setTimeout }).setTimeout = original;
		}
		expect(sendAdvice).toHaveBeenCalledTimes(1);
		expect(rt.lastResult?.advise?.note).toBe("ok");
	}, 15000);
});

describe("AdvisorRuntime — epoch guards / reset", () => {
	it("reset drops an in-flight batch instead of delivering into the post-reset conversation", async () => {
		let resolveReview: (r: AdvisorReviewResult) => void = () => {};
		const { rt, sendAdvice, ctx } = makeRuntime(
			() => new Promise<AdvisorReviewResult>((res) => { resolveReview = res; }),
		);
		const t = turn("x");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		await new Promise((r) => setTimeout(r, 5));
		expect(rt.isBusy).toBe(true);
		rt.reset();
		resolveReview({ advise: { note: "stale", severity: "concern" }, rounds: 1 });
		await new Promise((r) => setTimeout(r, 20));
		expect(sendAdvice).not.toHaveBeenCalled();
	});

	it("dispose stops further turns from doing anything", async () => {
		const review = vi.fn(async () => ({ advise: { note: "x" }, rounds: 1 }));
		const { rt, sendAdvice, ctx } = makeRuntime(review as never);
		rt.dispose();
		const t = turn("x");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		await settle(rt);
		expect(review).not.toHaveBeenCalled();
		expect(sendAdvice).not.toHaveBeenCalled();
	});
});

describe("AdvisorRuntime — rolling context buffer", () => {
	it("seedToLeaf clears the buffer so old turns are not replayed", async () => {
		const seenTexts: string[] = [];
		const { rt, ctx } = makeRuntime(async (text: string) => { seenTexts.push(text); return { advise: null, rounds: 0 }; });
		rt.seedToLeaf([entry("user", "old1"), entry("assistant", "old2")]);
		const t = turn("after-seed");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "after-seed")], ctx);
		await settle(rt);
		expect(seenTexts).toHaveLength(1);
		expect(seenTexts[0]).toContain("after-seed");
		expect(seenTexts[0]).not.toContain("old1");
	});
});

describe("AdvisorRuntime — reviewNow", () => {
	it("runs an immediate review on demand", async () => {
		const { rt, sendAdvice, ctx } = makeRuntime(async () => ({ advise: { note: "on-demand", severity: "nit" }, rounds: 1 }));
		const t = turn("a");
		const result = await rt.reviewNow(t.message as AgentMessage, t.toolResults, ctx);
		expect(result?.advise?.note).toBe("on-demand");
		expect(sendAdvice).toHaveBeenCalledTimes(1);
	});

	it("returns null when busy", async () => {
		let resolveReview: (r: AdvisorReviewResult) => void = () => {};
		const { rt, ctx } = makeRuntime(() => new Promise<AdvisorReviewResult>((res) => { resolveReview = res; }));
		const t = turn("a");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "a")], ctx);
		await new Promise((r) => setTimeout(r, 5));
		const t2 = turn("b");
		const result = await rt.reviewNow(t2.message as AgentMessage, t2.toolResults, ctx);
		expect(result).toBeNull();
		resolveReview({ advise: null, rounds: 0 });
		await new Promise((r) => setTimeout(r, 10));
	});
});

describe("AdvisorRuntime — cooldown (D3)", () => {
	it("coalesces turns arriving inside the cooldown window", async () => {
		const seen: string[] = [];
		const { rt, sendAdvice, ctx } = makeRuntime(async (text: string) => { seen.push(text); return { advise: null, rounds: 0 }; }, [], { cooldownMs: 60_000 });
		const t = turn("x");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		await settle(rt);
		const t2 = turn("y");
		void rt.onTurnEnd(t2.message as AgentMessage, t2.toolResults, [entry("user", "y")], ctx);
		await settle(rt);
		expect(seen).toHaveLength(1); // second turn coalesced, not reviewed
		expect(sendAdvice).not.toHaveBeenCalled();
	});
});
