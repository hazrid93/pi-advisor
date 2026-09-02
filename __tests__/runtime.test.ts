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
import type { Api, AssistantMessage, Message, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ADVISOR_CUSTOM_TYPE } from "../src/index.js";
import type { AdvisorAuth, AdvisorReviewResult } from "../src/agent.js";
import type { AdvisorNote, AdvisorTrigger } from "../src/index.js";

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

/** The runtime's full review-fn signature, simplified for tests. The trailing
 *  `history` arg is the advisor's persistent conversation prefix. */
type ReviewFn = (
	text: string,
	model: Model<Api>,
	auth: AdvisorAuth,
	cwd: string,
	signal: AbortSignal,
	config: { maxToolRounds: number; thinking: boolean; thinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh"; systemPrompt?: string; onUsage?: (usage: AssistantMessage["usage"]) => void; sessionId?: string; cacheRetention?: "none" | "short" | "long" },
	history?: Message[],
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
	config: Partial<{ maxRetries: number; contextChars: number; advisorModel: string | null; enabled: boolean; turnInterval: number; syncLag: number; triggers: AdvisorTrigger[]; midPauseMs: number; cacheRetention: "none" | "short" | "long" }> = {},
) {
	const sendAdvice = vi.fn(async (_notes: AdvisorNote[], _model: string, _opts?: { forceNonTriggering?: boolean }) => {});
	const host = { sendAdvice };
	const rt = new AdvisorRuntime(
		host as never,
		{
		enabled: config.enabled ?? true,
			advisorModel: config.advisorModel === undefined ? "fake/fake" : config.advisorModel,
			thinking: false,
			thinkingLevel: "medium" as const,
			contextChars: config.contextChars ?? 12_000,
			turnInterval: config.turnInterval ?? 1,
			maxToolRounds: 6,
			maxRetries: config.maxRetries ?? 3,
			interrupting: true,
			syncLag: config.syncLag ?? 0,
			triggers: config.triggers ?? ["turn_end", "tool_error"],
			midPauseMs: config.midPauseMs ?? 4000,
			instructionsMode: "project",
			cacheRetention: config.cacheRetention,
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

/** Flush one macrotask (+ pending microtasks). Real-timer counterpart to
 *  `vi.advanceTimersByTimeAsync(0)` under fake timers. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A review fn that records each snapshot text and stays in flight until the
 *  test calls `release`. Used to model an in-flight review while newer events
 *  arrive (latest-wins). */
function hangingReview(): { review: ReviewFn; calls: string[]; release: (r: AdvisorReviewResult) => void } {
	const calls: string[] = [];
	let release: (r: AdvisorReviewResult) => void = () => {};
	const review: ReviewFn = (text) => {
		calls.push(text);
		return new Promise<AdvisorReviewResult>((res) => { release = res; });
	};
	return { review, calls, release: (r) => release(r) };
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
		expect(sendAdvice.mock.calls[0][0]).toEqual([{ note: "watch the queue", severity: "concern" }]);
		expect(sendAdvice.mock.calls[0][1]).toBe("fake/fake");
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

	it("records a model-registry auth exception instead of rejecting a background trigger", async () => {
		const review = vi.fn(async () => ({ advise: null, rounds: 0 }));
		const { rt, ctx } = makeRuntime(review as never);
		ctx.getApiKeyAndHeaders = async () => { throw new Error("auth lookup failed"); };
		const t = turn("hi");
		await expect(rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "hi")], ctx)).resolves.toBeUndefined();
		expect(review).not.toHaveBeenCalled();
		expect(rt.lastResult?.error).toBe("auth lookup failed");
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

describe("AdvisorRuntime — persistent advisor history (replaces rolling re-render)", () => {
	it("each update carries only its new delta — prior turns are not re-rendered", async () => {
		const seenTexts: string[] = [];
		const { rt, ctx } = makeRuntime(async (text: string) => { seenTexts.push(text); return { advise: null, rounds: 0 }; });
		const user = entry("user", "Use PostgreSQL and keep the public API stable");
		const first = turn("I will update the storage layer");
		void rt.onTurnEnd(first.message as AgentMessage, first.toolResults, [user], ctx);
		await settle(rt);
		const second = turn("Storage changes are complete");
		void rt.onTurnEnd(second.message as AgentMessage, second.toolResults, [user], ctx);
		await settle(rt);

		expect(seenTexts).toHaveLength(2);
		expect(seenTexts[0]).toContain("Use PostgreSQL and keep the public API stable");
		expect(seenTexts[0].indexOf("Use PostgreSQL")).toBeLessThan(seenTexts[0].indexOf("update the storage layer"));
		// The first review covered the user prompt + turn 1; the second update
		// carries ONLY turn 2's delta. The past lives in the history prefix (the
		// cacheable part), so the uncached input per review stays minimal.
		expect(seenTexts[1]).not.toContain("Use PostgreSQL");
		expect(seenTexts[1]).not.toContain("update the storage layer");
		expect(seenTexts[1]).toContain("Storage changes are complete");
	});

	it("seedToLeaf clears the buffer so old turns and old user prompts are not replayed", async () => {
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

describe("AdvisorRuntime — history prefix (prompt-cache invariants)", () => {
	/** Message builders for fake `appended` payloads. */
	const histUser = (text: string, ts: number): Message => ({ role: "user", content: text, timestamp: ts });
	const histAssistantText = (text: string, ts: number): Message => ({ role: "assistant", content: [{ type: "text", text }], timestamp: ts } as unknown as Message);
	const histAssistantCall = (id: string, ts: number): Message => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "f" } }], timestamp: ts } as unknown as Message);
	const histToolResult = (id: string, text: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], timestamp: 0 } as unknown as Message);

	it("second review sends the first review's appended messages as a byte-identical prefix", async () => {
		const appended1 = [histUser("### Session update\n\n[User]: first", 1), histAssistantText("reviewed", 2)];
		const appended2 = [histUser("### Session update\n\n[User]: second", 3)];
		const queue = [appended1, appended2];
		const histories: Message[][] = [];
		const review: ReviewFn = async (_text, _m, _a, _c, _s, _cfg, history) => {
			histories.push(history ? [...history] : []);
			return { advise: null, rounds: 0, appended: queue.shift() };
		};
		const { rt, ctx } = makeRuntime(review);
		const t1 = turn("first");
		await rt.onTurnEnd(t1.message as AgentMessage, t1.toolResults, [entry("user", "u1")], ctx);
		await settle(rt);
		const t2 = turn("second");
		await rt.onTurnEnd(t2.message as AgentMessage, t2.toolResults, [], ctx);
		await settle(rt);

		expect(histories).toHaveLength(2);
		expect(histories[0]).toEqual([]); // cold start: no prefix yet
		// THE prompt-cache invariant: the next request's leading messages are
		// byte-identical to what the previous request sent — providers match
		// cached prefixes against exactly this.
		expect(histories[1]).toEqual(appended1);
	});

	it("a failed review does not extend the history (partial turns could orphan toolCalls)", async () => {
		const appended = [histUser("x", 1)];
		const histories: Message[][] = [];
		const review: ReviewFn = async (_t, _m, _a, _c, _s, _cfg, history) => {
			histories.push(history ? [...history] : []);
			// Error WITH appended: the runtime must still refuse to persist.
			return { advise: null, rounds: 0, error: "boom", appended };
		};
		const { rt, ctx } = makeRuntime(review, [], { maxRetries: 1 });
		const t1 = turn("a");
		await rt.onTurnEnd(t1.message as AgentMessage, t1.toolResults, [], ctx);
		await settle(rt);
		const t2 = turn("b");
		await rt.onTurnEnd(t2.message as AgentMessage, t2.toolResults, [], ctx);
		await settle(rt);
		expect(histories).toHaveLength(2);
		expect(histories[1]).toEqual([]); // the failure persisted nothing
	});

	it("latest-wins replacement merges deltas so no captured turn is lost", async () => {
		const { review, calls, release } = hangingReview();
		const { rt, ctx } = makeRuntime(review);
		const t0 = turn("turn-0");
		void rt.onTurnEnd(t0.message as AgentMessage, t0.toolResults, [entry("user", "u0")], ctx);
		await flush();
		expect(rt.isBusy).toBe(true);
		// While in flight, two more turns arrive — each replaces the pending, so
		// the pending's deltas must MERGE with the newer capture.
		const t1 = turn("turn-1");
		void rt.onTurnEnd(t1.message as AgentMessage, t1.toolResults, [entry("user", "u1")], ctx);
		const t2 = turn("turn-2");
		void rt.onTurnEnd(t2.message as AgentMessage, t2.toolResults, [entry("user", "u2")], ctx);
		await flush();
		release({ advise: null, rounds: 0 }); // stale in-flight completes (suppressed)
		await flush(); // merged pending drains, second review starts (hangs)
		release({ advise: null, rounds: 0 }); // merged review completes
		await settle(rt);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toContain("turn-1");
		expect(calls[1]).toContain("turn-2");
	});

	it("turnInterval reviews every Nth turn and coalesces the skipped ones", async () => {
		const seen: string[] = [];
		const { rt, ctx } = makeRuntime(
			async (text) => { seen.push(text); return { advise: null, rounds: 0 }; },
			[],
			{ turnInterval: 3 },
		);
		for (let i = 1; i <= 5; i++) {
			const t = turn(`turn-${i}`);
			await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", `u${i}`)], ctx);
			await settle(rt);
		}
		// Turns 1-2 skipped (staged), turn 3 reviews turns 1-3, turns 4-5 skipped.
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("turn-1");
		expect(seen[0]).toContain("turn-2");
		expect(seen[0]).toContain("turn-3");
		expect(seen[0]).not.toContain("turn-5"); // staged for the NEXT review
	});

	it("settle flush: a run finished early still gets its final review", async () => {
		// turnInterval 6 but the run ends after 2 turns — the settle flush must
		// review the staged deltas instead of leaving them for the next run.
		const seen: string[] = [];
		const { rt, ctx } = makeRuntime(
			async (text) => { seen.push(text); return { advise: null, rounds: 0 }; },
			[],
			{ turnInterval: 6 },
		);
		for (let i = 1; i <= 2; i++) {
			const t = turn(`only-${i}`);
			await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [], ctx);
			await settle(rt);
		}
		expect(seen).toHaveLength(0); // interval skipped both
		await rt.onAgentSettled(ctx);
		await settle(rt);
		expect(seen).toHaveLength(1); // flushed at settle
		expect(seen[0]).toContain("only-1");
		expect(seen[0]).toContain("only-2");
	});

	it("settle flush skips a duplicate when the run's last turn was just reviewed", async () => {
		const review = vi.fn(async () => ({ advise: null, rounds: 0 }));
		const { rt, ctx } = makeRuntime(review as never, [], { turnInterval: 2 });
		for (let i = 1; i <= 2; i++) {
			const t = turn(`t${i}`);
			await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [], ctx);
			await settle(rt);
		}
		expect(review).toHaveBeenCalledTimes(1); // turn 2 hit the interval
		await rt.onAgentSettled(ctx);
		await settle(rt);
		expect(review).toHaveBeenCalledTimes(1); // nothing new staged → no flush
	});

	it("settle flush does not double-queue while a review is in flight", async () => {
		const { review, calls, release } = hangingReview();
		const { rt, ctx } = makeRuntime(review, [], { turnInterval: 2 });
		// Two turns → turn 2 hits the interval and starts the in-flight review.
		for (let i = 1; i <= 2; i++) {
			const t = turn(`t${i}`);
			void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [], ctx);
		}
		await flush();
		expect(rt.isBusy).toBe(true);
		// A third turn lands while busy, then the run settles: staged deltas exist
		// but a review is already in flight → the flush must NOT enqueue a dup.
		const t3 = turn("t3");
		void rt.onTurnEnd(t3.message as AgentMessage, t3.toolResults, [], ctx);
		await rt.onAgentSettled(ctx);
		release({ advise: null, rounds: 0 });
		await settle(rt);
		expect(calls).toHaveLength(1); // no duplicate
	});

	it("tool_error bypasses the turn-interval gate", async () => {
		const seen: string[] = [];
		const { rt, ctx } = makeRuntime(
			async (text) => { seen.push(text); return { advise: null, rounds: 0 }; },
			[],
			{ turnInterval: 10 },
		);
		const t1 = turn("normal");
		await rt.onTurnEnd(t1.message as AgentMessage, t1.toolResults, [], ctx);
		await settle(rt);
		expect(seen).toHaveLength(0); // interval skipped
		// A tool error on the next turn reviews promptly despite the interval.
		const t2 = turn("after error");
		await rt.onToolExecutionEnd({ toolCallId: "c1", toolName: "bash", result: "boom", isError: true }, ctx);
		await rt.onTurnEnd(t2.message as AgentMessage, t2.toolResults, [], ctx);
		await settle(rt);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("normal");   // the skipped turn rode along
		expect(seen[0]).toContain("after error");
	});

	it("interval-skipped deltas ride the next eligible review", async () => {
		const seen: string[] = [];
		const { rt, ctx } = makeRuntime(async (text: string) => { seen.push(text); return { advise: null, rounds: 0 }; }, [], { turnInterval: 3 });
		const t1 = turn("alpha");
		await rt.onTurnEnd(t1.message as AgentMessage, t1.toolResults, [entry("user", "u1")], ctx);
		await settle(rt);
		expect(seen).toHaveLength(0); // skipped by the interval, staged
		const t2 = turn("beta");
		await rt.onTurnEnd(t2.message as AgentMessage, t2.toolResults, [entry("user", "u2")], ctx);
		await settle(rt);
		expect(seen).toHaveLength(0); // still counting
		const t3 = turn("gamma");
		await rt.onTurnEnd(t3.message as AgentMessage, t3.toolResults, [entry("user", "u3")], ctx);
		await settle(rt);
		expect(seen).toHaveLength(1); // third turn hit the interval
		expect(seen[0]).toContain("alpha"); // not dropped — folded in
		expect(seen[0]).toContain("beta");
		expect(seen[0]).toContain("gamma");
	});

	it("history eviction drops the oldest half at user-message boundaries without orphaning toolResults", async () => {
		const histories: Message[][] = [];
		let n = 0;
		const review: ReviewFn = async (_t, _m, _a, _c, _s, _cfg, history) => {
			histories.push(history ? [...history] : []);
			n++;
			// Each review appends one segment: user + assistant(toolCall) +
			// toolResult + final assistant — sized to overflow a tiny budget.
			return {
				advise: null,
				rounds: 1,
				appended: [
					histUser(`update ${n} `.padEnd(120, "x"), n),
					histAssistantCall(`c${n}`, n),
					histToolResult(`c${n}`, "y".repeat(400)),
					histAssistantText("done", n),
				],
			};
		};
		const { rt, ctx } = makeRuntime(review, [], { contextChars: 600 });
		for (let i = 0; i < 7; i++) {
			const t = turn(`t${i}`);
			await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", `u${i}`)], ctx);
			await settle(rt);
		}
		const finalHistory = histories[histories.length - 1];
		// Eviction happened: fewer segments remain than the 7 appended.
		const userCount = finalHistory.filter((m) => m.role === "user").length;
		expect(userCount).toBeGreaterThan(0);
		expect(userCount).toBeLessThan(7);
		// The history always begins at a segment boundary (a user message)…
		expect(finalHistory[0].role).toBe("user");
		// …and no toolResult is ever orphaned from its toolCall.
		const seenCalls = new Set<string>();
		for (const m of finalHistory) {
			if (m.role === "assistant") {
				for (const c of m.content) if (c.type === "toolCall") seenCalls.add(c.id);
			}
			if (m.role === "toolResult") expect(seenCalls.has(m.toolCallId)).toBe(true);
		}
	});

	it("forwards a stable per-session sessionId (provider prompt-cache key)", async () => {
		const ids: (string | undefined)[] = [];
		const review: ReviewFn = async (_t, _m, _a, _c, _s, cfg) => { ids.push(cfg.sessionId); return { advise: null, rounds: 0 }; };
		const { rt, ctx } = makeRuntime(review);
		for (let i = 0; i < 2; i++) {
			const t = turn(`t${i}`);
			await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [], ctx);
			await settle(rt);
		}
		expect(ids).toHaveLength(2);
		expect(ids[0]).toBeTruthy();
		expect(ids[1]).toBe(ids[0]); // stable across reviews within the session
	});

	it("records the last review's usage (incl. cache split) for /advisor status", async () => {
		const usage = { input: 1200, output: 40, cacheRead: 1000, cacheWrite: 160 } as AssistantMessage["usage"];
		const review: ReviewFn = async (_t, _m, _a, _c, _s, cfg) => {
			cfg.onUsage?.(usage);
			return { advise: null, rounds: 0 };
		};
		const { rt, ctx } = makeRuntime(review);
		const t = turn("x");
		await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [], ctx);
		await settle(rt);
		expect(rt.lastUsage).toEqual(usage);
	});

	it("accumulates session-wide usage totals (aggregate cache-hit rate) across reviews", async () => {
		// Fixtures use pi-ai's NORMALIZED usage shape: `input` is uncached-only
		// (input = prompt_tokens − cacheRead − cacheWrite), so a warm review has
		// tiny `input` and large `cacheRead` — like the user's real kimi-k3 log.
		const usages = [
			{ input: 1000, output: 30, cacheRead: 0, cacheWrite: 1000 },    // cold: 1000 prompt, all written
			{ input: 200, output: 40, cacheRead: 1000, cacheWrite: 200 },    // warm: 1200 prompt, 1000 cached
			{ input: 200, output: 50, cacheRead: 1200, cacheWrite: 200 },    // warm: 1600 prompt, 1200 cached
		] as AssistantMessage["usage"][];
		let i = 0;
		const review: ReviewFn = async (_t, _m, _a, _c, _s, cfg) => {
			cfg.onUsage?.(usages[i++]);
			return { advise: null, rounds: 0 };
		};
		const { rt, ctx } = makeRuntime(review);
		for (let k = 0; k < 3; k++) {
			const t = turn(`t${k}`);
			await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [], ctx);
			await settle(rt);
		}
		expect(rt.usageTotals).toEqual({
			reviews: 3,
			input: 1400,      // uncached-only sum
			output: 120,
			cacheRead: 2200,
			cacheWrite: 1400,
		});
		// True aggregate hit rate: cacheRead / (input + cacheRead + cacheWrite)
		// = 2200 / 5000 = 44% — NOT cacheRead/input (157%), the 0.6.5 bug.
		const t2 = rt.usageTotals;
		const totalInput = t2.input + t2.cacheRead + t2.cacheWrite;
		expect(totalInput).toBe(5000);
		expect(Math.round((t2.cacheRead / totalInput) * 100)).toBe(44);
	});

	it("passes the configured cacheRetention through to the review config", async () => {
		let seen: string | undefined;
		const review: ReviewFn = async (_t, _m, _a, _c, _s, cfg) => {
			seen = (cfg as { cacheRetention?: string }).cacheRetention;
			return { advise: null, rounds: 0 };
		};
		const { rt, ctx } = makeRuntime(review, [], { cacheRetention: "long" });
		const t = turn("x");
		await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [], ctx);
		await settle(rt);
		expect(seen).toBe("long");
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

describe("AdvisorRuntime — lag (sync backlog metric)", () => {
	it("lag is 0 when idle with no backlog", async () => {
		const { rt } = makeRuntime(async () => ({ advise: null, rounds: 0 }));
		expect(rt.lag).toBe(0);
	});

	it("lag counts the in-flight review as 1 (the +1, since it was shifted out of #pending)", async () => {
		const { rt, ctx } = makeRuntime(() => new Promise<AdvisorReviewResult>(() => {})); // never resolves
		const t = turn("x");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		await new Promise((r) => setTimeout(r, 10));
		expect(rt.isBusy).toBe(true);
		// In-flight review was shifted out of #pending; lag must still count it.
		expect(rt.lag).toBe(1);
	});

	it("lag counts an in-flight review (latest-wins collapses the backlog)", async () => {
		const { rt, ctx } = makeRuntime(() => new Promise<AdvisorReviewResult>(() => {}));
		for (let i = 0; i < 4; i++) {
			const ti = turn(`turn-${i}`);
			void rt.onTurnEnd(ti.message as AgentMessage, ti.toolResults, [entry("user", `turn-${i}`)], ctx);
		}
		await new Promise((r) => setTimeout(r, 15));
		// Latest-wins: the 4 turns collapse to 1 pending (the newest), so lag is
		// 1 in flight + 0 queued = 1, not 4.
		expect(rt.lag).toBe(1);
	});
});

describe("AdvisorRuntime — waitForCatchUp (sync gate)", () => {
	it("returns immediately when threshold <= 0 (the disable path)", async () => {
		const { rt, ctx } = makeRuntime(() => new Promise<AdvisorReviewResult>(() => {}));
		const t = turn("x");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		await new Promise((r) => setTimeout(r, 10));
		expect(rt.lag).toBe(1);
		// threshold 0 = never wait, returns instantly even with backlog.
		await expect(rt.waitForCatchUp(0, ctx.signal)).resolves.toBeUndefined();
	});

	it("returns immediately when not lagging (lag < threshold)", async () => {
		const { rt } = makeRuntime(async () => ({ advise: null, rounds: 0 }));
		expect(rt.lag).toBe(0);
		await expect(rt.waitForCatchUp(2)).resolves.toBeUndefined();
	});

	it("resolves once the advisor catches up below the threshold", async () => {
		let resolveReview: (r: AdvisorReviewResult) => void = () => {};
		const { rt, ctx } = makeRuntime(() => new Promise<AdvisorReviewResult>((res) => { resolveReview = res; }));
		const t = turn("x");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		await new Promise((r) => setTimeout(r, 10));
		expect(rt.lag).toBe(1);

		let resolved = false;
		const p = rt.waitForCatchUp(1).then(() => { resolved = true; });
		await new Promise((r) => setTimeout(r, 20));
		expect(resolved).toBe(false); // still lagging (1 >= 1)

		resolveReview({ advise: null, rounds: 0 });
		await p;
		expect(resolved).toBe(true);
		expect(rt.lag).toBe(0);
	});

	it("unblocks when a Ctrl+C-style caller signal aborts (never hangs the agent)", async () => {
		const { rt, ctx } = makeRuntime(() => new Promise<AdvisorReviewResult>(() => {}));
		const t = turn("x");
		void rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		await new Promise((r) => setTimeout(r, 10));
		expect(rt.lag).toBe(1);

		const caller = new AbortController();
		let resolved = false;
		const p = rt.waitForCatchUp(1, caller.signal).then(() => { resolved = true; });
		await new Promise((r) => setTimeout(r, 20));
		expect(resolved).toBe(false);

		caller.abort();
		await p;
		expect(resolved).toBe(true);
	});

	it("unblocks when reset() clears the queue mid-wait (epoch bumped)", async () => {
		let resolveReview: (r: AdvisorReviewResult) => void = () => {};
		const { rt, ctx } = makeRuntime(() => new Promise<AdvisorReviewResult>((res) => { resolveReview = res; }));
		for (let i = 0; i < 4; i++) {
			const ti = turn(`turn-${i}`);
			void rt.onTurnEnd(ti.message as AgentMessage, ti.toolResults, [entry("user", `turn-${i}`)], ctx);
		}
		await new Promise((r) => setTimeout(r, 15));
		// Latest-wins: backlog collapses to the newest, so lag = 1 in flight.
		expect(rt.lag).toBe(1);

		let resolved = false;
		const p = rt.waitForCatchUp(1).then(() => { resolved = true; });
		await new Promise((r) => setTimeout(r, 20));
		expect(resolved).toBe(false);

		rt.reset(); // compaction/tree-nav-equivalent: clears backlog + bumps epoch
		// reset aborted the lifecycle signal; in production that aborts the
		// in-flight completeSimple call. The signal-ignoring test review fn can't
		// model that, so resolve it manually to let the drain settle and #busy flip.
		resolveReview({ advise: null, rounds: 0, error: "aborted" });
		await p;
		expect(resolved).toBe(true);
		expect(rt.lag).toBe(0);
	});
});

describe("AdvisorRuntime — selectable triggers", () => {
	it("default triggers review on turn_end", async () => {
		const { rt, ctx, sendAdvice } = makeRuntime(async () => ({ advise: null, rounds: 0 }));
		const t = turn("hello");
		await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		await settle(rt);
		expect(sendAdvice).not.toHaveBeenCalled(); // silent review, nothing to deliver
		expect(rt.lastResult).not.toBeNull(); // a review ran
	});

	it("does NOT review on turn_end when turn_end is unticked (capture still runs)", async () => {
		const { rt, ctx } = makeRuntime(async () => ({ advise: null, rounds: 0 }), [], { triggers: ["agent_settled"] });
		const t = turn("hello");
		await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		await settle(rt);
		expect(rt.lastResult).toBeNull(); // no review scheduled
		// But the buffer captured the turn: a later agent_settled sees it.
		await rt.onAgentSettled(ctx);
		await settle(rt);
		expect(rt.lastResult).not.toBeNull(); // a settled review ran against the captured buffer
	});

	it("tool_error defers to turn_end and reviews with the finalized buffer (single call)", async () => {
		let count = 0;
		const { rt, ctx } = makeRuntime(async () => { count++; return { advise: null, rounds: 1 }; });
		// tool errors during the run, before turn_end.
		await rt.onToolExecutionEnd({ toolCallId: "c1", toolName: "bash", result: "boom", isError: true }, ctx);
		await rt.onToolExecutionEnd({ toolCallId: "c2", toolName: "edit", result: "ok" }, ctx);
		expect(count).toBe(0); // nothing reviewed yet — tool_error is deferred
		// turn_end fires: one coalesced review (NOT two — turn_end + tool_error).
		const t = turn("recovered");
		await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", "x")], ctx);
		await settle(rt);
		expect(count).toBe(1);
	});

	it("tool_result trigger reviews immediately with the tool injected as extra", async () => {
		let captured = "";
		const { rt, ctx } = makeRuntime(async (text) => { captured = text; return { advise: null, rounds: 0 }; }, [], { triggers: ["tool_result"] });
		await rt.onToolExecutionEnd({ toolCallId: "c1", toolName: "bash", result: "done" }, ctx);
		await settle(rt);
		expect(captured).toContain("[tool result: bash]");
		expect(captured).toContain("done");
	});

	it("agent_settled fires once across many turns and never delivers triggering", async () => {
		const calls: string[] = [];
		const { rt, ctx, sendAdvice } = makeRuntime(
			async (text) => { calls.push(text); return { advise: { note: "final nit", severity: "nit" as const }, rounds: 1 }; },
			[],
			{ triggers: ["agent_settled"] },
		);
		// Many turns happen (agent_settled is NOT enabled, so they don't review)...
		for (let i = 0; i < 3; i++) {
			const t = turn(`turn-${i}`);
			await rt.onTurnEnd(t.message as AgentMessage, t.toolResults, [entry("user", `u${i}`)], ctx);
		}
		await settle(rt);
		expect(calls.length).toBe(0); // no per-turn reviews
		// ...then the run settles: exactly one review.
		await rt.onAgentSettled(ctx);
		await settle(rt);
		expect(calls.length).toBe(1);
		expect(sendAdvice).toHaveBeenCalledTimes(1);
		// Loop-break: settled delivery MUST pass forceNonTriggering:true.
		expect(sendAdvice.mock.calls[0][2]).toEqual({ forceNonTriggering: true });
	});

	it("agent_settled loop regression: a settled review never re-triggers a recursive chain", async () => {
		const calls: string[] = [];
		const { rt, ctx } = makeRuntime(async (text) => {
			calls.push(text);
			return { advise: { note: "x", severity: "nit" as const }, rounds: 1 };
		}, [], { triggers: ["agent_settled"] });
		await rt.onAgentSettled(ctx);
		await settle(rt);
		expect(calls.length).toBe(1);
		// A genuine second settlement (e.g. the host re-runs) DOES review once.
		await rt.onAgentSettled(ctx);
		await settle(rt);
		expect(calls.length).toBe(2);
		// No further spontaneous reviews — the loop is bounded.
		await settle(rt);
		expect(calls.length).toBe(2);
	});

	it("latest-wins: an in-flight stale review is suppressed; only the newest is delivered", async () => {
		const { review, calls, release } = hangingReview();
		const { rt, ctx, sendAdvice } = makeRuntime(review);
		// First turn goes in flight (review hangs). Void + flush so it enters drain.
		const t0 = turn("turn-0");
		void rt.onTurnEnd(t0.message as AgentMessage, t0.toolResults, [entry("user", "u0")], ctx);
		await flush();
		expect(rt.isBusy).toBe(true);
		expect(calls.length).toBe(1); // the in-flight (stale) snapshot
		// While in flight, several more turns arrive — each supersedes (replaces pending).
		for (let i = 1; i <= 3; i++) {
			const ti = turn(`turn-${i}`);
			void rt.onTurnEnd(ti.message as AgentMessage, ti.toolResults, [entry("user", `u${i}`)], ctx);
		}
		await flush();
		// Latest-wins keeps at most one pending; the in-flight counts as +1 busy.
		expect(rt.lag).toBe(2);
		// Release the in-flight (stale) review: its delivery is generation-suppressed.
		release({ advise: { note: "stale", severity: "nit" as const }, rounds: 1 });
		await flush();
		// The newest snapshot is now in flight (review hangs again).
		expect(calls.length).toBe(2);
		expect(sendAdvice).not.toHaveBeenCalled(); // stale was suppressed
		// Release the newest — it delivers.
		release({ advise: { note: "fresh", severity: "nit" as const }, rounds: 1 });
		await settle(rt);
		expect(sendAdvice).toHaveBeenCalledTimes(1);
		expect(sendAdvice.mock.calls[0][0][0].note).toBe("fresh");
	});

	it("latest-wins: a stale failure neither retries nor drops the newer pending review", async () => {
		const { review, calls, release } = hangingReview();
		const { rt, ctx, sendAdvice } = makeRuntime(review, [], { maxRetries: 3 });
		const stale = turn("stale-turn");
		void rt.onTurnEnd(stale.message as AgentMessage, stale.toolResults, [entry("user", "stale")], ctx);
		await flush();

		const fresh = turn("fresh-turn");
		void rt.onTurnEnd(fresh.message as AgentMessage, fresh.toolResults, [entry("user", "fresh")], ctx);
		await flush();
		expect(calls).toHaveLength(1);

		// The stale error is discarded immediately. It must not be unshifted for
		// retries ahead of the fresh snapshot or clear that snapshot on strike 3.
		release({ advise: null, rounds: 0, error: "stale timeout" });
		await flush();
		expect(calls).toHaveLength(2);
		release({ advise: { note: "fresh survives", severity: "concern" }, rounds: 1 });
		await settle(rt);

		expect(calls).toHaveLength(2);
		expect(sendAdvice).toHaveBeenCalledTimes(1);
		expect(sendAdvice.mock.calls[0][0][0].note).toBe("fresh survives");
		expect(rt.lastResult?.error).toBeUndefined();
	});

	it("mid_pause: trailing debounce fires once after a quiet period, not on every token", async () => {
		vi.useFakeTimers();
		try {
			const { rt, ctx, sendAdvice } = makeRuntime(
				async () => ({ advise: { note: "paused", severity: "nit" as const }, rounds: 1 }),
				[],
				{ triggers: ["mid_pause"], midPauseMs: 1000 },
			);
			// Streaming: many message_update events reset the debounce; no review yet.
			for (let i = 0; i < 5; i++) rt.onMessageUpdate(ctx);
			await vi.advanceTimersByTimeAsync(500);
			expect(sendAdvice).not.toHaveBeenCalled();
			// Quiet period elapses: exactly one review fires.
			await vi.advanceTimersByTimeAsync(1000);
			expect(sendAdvice).toHaveBeenCalledTimes(1);
			// More streaming after the fire does NOT re-fire (at most once per input).
			for (let i = 0; i < 3; i++) rt.onMessageUpdate(ctx);
			await vi.advanceTimersByTimeAsync(2000);
			expect(sendAdvice).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("input re-arms mid_pause (a new prompt cancels the prior quiet-period budget)", async () => {
		vi.useFakeTimers();
		try {
			const { rt, ctx, sendAdvice } = makeRuntime(
				async () => ({ advise: { note: "p", severity: "nit" as const }, rounds: 1 }),
				[],
				{ triggers: ["mid_pause"], midPauseMs: 1000 },
			);
			rt.onMessageUpdate(ctx);
			await vi.advanceTimersByTimeAsync(800); // near the budget
			// New input cancels the budget and re-arms.
			void rt.onInput("new goal", ctx);
			await vi.advanceTimersByTimeAsync(800); // would have fired before the input
			expect(sendAdvice).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(200); // full budget after input
			expect(sendAdvice).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("input as a review trigger runs a prompt-review before the agent acts", async () => {
		let captured = "";
		const { rt, ctx } = makeRuntime(async (text) => { captured = text; return { advise: null, rounds: 0 }; }, [], { triggers: ["input"] });
		await rt.onInput("refactor everything", ctx);
		await settle(rt);
		expect(captured).toContain("[user prompt]");
		expect(captured).toContain("refactor everything");
	});

	it("extension-sourced input never runs a prompt review (self-delivery loop fix)", async () => {
		// pi fires `input` for extension sendMessage deliveries too — including
		// THIS extension's own advice. Those must not be treated as user prompts,
		// or the advisor would review its own advice (review → deliver → input →
		// review → …).
		const review = vi.fn(async () => ({ advise: null, rounds: 0 }));
		const { rt, ctx } = makeRuntime(review as never, [], { triggers: ["input"] });
		await rt.onInput("<advisory severity=\"concern\">…</advisory>", ctx, "extension");
		await settle(rt);
		expect(review).not.toHaveBeenCalled();
		// Real user input (interactive/RPC) still reviews.
		await rt.onInput("real prompt", ctx, "interactive");
		await settle(rt);
		expect(review).toHaveBeenCalledTimes(1);
		await rt.onInput("rpc prompt", ctx, "rpc");
		await settle(rt);
		expect(review).toHaveBeenCalledTimes(2);
	});

	it("extension-sourced input does not re-arm mid_pause (delivery self-trigger fix)", async () => {
		vi.useFakeTimers();
		try {
			// Distinct notes per review: the delivery-time dedupe ring would
			// otherwise (correctly) suppress an identical repeat.
			let n = 0;
			const { rt, ctx, sendAdvice } = makeRuntime(
				async () => ({ advise: { note: `p${++n}`, severity: "nit" as const }, rounds: 1 }),
				[],
				{ triggers: ["mid_pause"], midPauseMs: 1000 },
			);
			rt.onMessageUpdate(ctx);
			await vi.advanceTimersByTimeAsync(1000); // quiet period fires once
			expect(sendAdvice).toHaveBeenCalledTimes(1);
			// The delivery fires input(source: "extension") — must NOT reset the
			// once-per-run budget or re-arm the debounce.
			await rt.onInput("<advisory>delivered</advisory>", ctx, "extension");
			await vi.advanceTimersByTimeAsync(5000);
			expect(sendAdvice).toHaveBeenCalledTimes(1); // still exactly one
			// A genuine user prompt re-arms for the next run.
			await rt.onInput("next goal", ctx, "interactive");
			await vi.advanceTimersByTimeAsync(1000);
			expect(sendAdvice).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
