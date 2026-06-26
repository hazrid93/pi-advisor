/**
 * Unit tests for AdvisorRuntime (src/runtime.ts) — backlog, single-flight,
 * epoch guards, 3-strike drop, cursor seeding, delivery.
 *
 * Uses an injectable `review` function (no real model call) so the runtime's
 * queue + epoch + retry discipline is fully testable.
 */

import { describe, expect, it, vi } from "vitest";
import { AdvisorRuntime, deliveryOptions } from "../src/runtime.js";
import type { Api, Model } from "@earendil-works/pi-ai";
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
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop" as const,
						timestamp: Date.now(),
					}
				: { timestamp: Date.now() }),
		} as SessionEntry extends infer M ? M : never,
	} as SessionEntry;
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

function makeRuntime(
	review: (text: string, ref: string) => Promise<AdvisorReviewResult>,
	branch: SessionEntry[] = [],
	config: Partial<{ maxRetries: number; contextEntries: number; advisorModel: string | null; enabled: boolean }> = {},
) {
	const sendAdvice = vi.fn(async () => {});
	const host = {
		getBranch: () => branch,
		sendAdvice,
		resolveModel: vi.fn(() => ({}) as Model<Api>),
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "k", headers: {} })),
		notify: vi.fn(),
	};
	const rt = new AdvisorRuntime(
		host as never,
		{
			enabled: config.enabled ?? true,
			advisorModel: config.advisorModel === undefined ? "fake/fake" : config.advisorModel,
			thinking: false,
			thinkingLevel: "medium" as const,
			contextEntries: config.contextEntries ?? 30,
			maxToolRounds: 6,
			maxRetries: config.maxRetries ?? 3,
		},
		review,
	);
	return { rt, sendAdvice, host };
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
		const branch = [entry("user", "do the thing")];
		const { rt, sendAdvice } = makeRuntime(async () => ({ advise: { note: "watch the queue", severity: "concern" }, rounds: 1 }), branch);
		rt.onTurnEnd(branch);
		await settle(rt);
		expect(sendAdvice).toHaveBeenCalledTimes(1);
		expect(sendAdvice.mock.calls[0][0]).toEqual([{ note: "watch the queue", severity: "concern" }]);
		expect(rt.lastResult?.advise?.note).toBe("watch the queue");
		expect(rt.isBusy).toBe(false);
	});

	it("does nothing when no advisor model is configured", async () => {
		const branch = [entry("user", "hi")];
		const review = vi.fn(async () => ({ advise: null, rounds: 0 }));
		const { rt, sendAdvice } = makeRuntime(review, branch, { advisorModel: null });
		rt.onTurnEnd(branch);
		await settle(rt);
		expect(review).not.toHaveBeenCalled();
		expect(sendAdvice).not.toHaveBeenCalled();
	});

	it("does nothing when disabled", async () => {
		const branch = [entry("user", "hi")];
		const review = vi.fn(async () => ({ advise: null, rounds: 0 }));
		const { rt, sendAdvice } = makeRuntime(review, branch, { enabled: false });
		rt.onTurnEnd(branch);
		await settle(rt);
		expect(review).not.toHaveBeenCalled();
		expect(sendAdvice).not.toHaveBeenCalled();
	});

	it("stays silent (no delivery) when the advisor review returns no advise", async () => {
		const branch = [entry("user", "all good")];
		const { rt, sendAdvice } = makeRuntime(async () => ({ advise: null, rounds: 0 }), branch);
		rt.onTurnEnd(branch);
		await settle(rt);
		expect(sendAdvice).not.toHaveBeenCalled();
		expect(rt.lastResult?.advise).toBeNull();
	});
});

describe("AdvisorRuntime — failure handling", () => {
	it("retries up to maxRetries then drops the backlog (3-strike)", async () => {
		const branch = [entry("user", "x")];
		let calls = 0;
		const { rt, sendAdvice } = makeRuntime(
			async () => {
				calls++;
				return { advise: null, rounds: 0, error: "boom" };
			},
			branch,
			{ maxRetries: 3 },
		);
		// Speed up the backoff so the test doesn't wait 1s three times.
		const original = setTimeout;
		(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) =>
			original(fn, ms ? 1 : 1)) as typeof setTimeout;
		try {
			rt.onTurnEnd(branch);
			await settle(rt, 200);
		} finally {
			(globalThis as { setTimeout: typeof setTimeout }).setTimeout = original;
		}
		// 3 attempts before the drop.
		expect(calls).toBe(3);
		expect(sendAdvice).not.toHaveBeenCalled();
		expect(rt.isBusy).toBe(false);
	}, 15000);

	it("recovers (clears failures) after a successful review following an error", async () => {
		const branch = [entry("user", "x")];
		let n = 0;
		const { rt, sendAdvice } = makeRuntime(async () => {
			n++;
			return n === 1 ? { advise: null, rounds: 0, error: "transient" } : { advise: { note: "ok", severity: "nit" }, rounds: 1 };
		}, branch);
		const original = setTimeout;
		(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) =>
			original(fn, ms ? 1 : 1)) as typeof setTimeout;
		try {
			rt.onTurnEnd(branch);
			await settle(rt, 200);
		} finally {
			(globalThis as { setTimeout: typeof setTimeout }).setTimeout = original;
		}
		expect(sendAdvice).toHaveBeenCalledTimes(1);
		expect(rt.lastResult?.advise?.note).toBe("ok");
	}, 15000);
});

describe("AdvisorRuntime — epoch guards / reset", () => {
	it("reset drops an in-flight batch instead of delivering into the post-reset conversation", async () => {
		const branch = [entry("user", "x")];
		let resolveReview: (r: AdvisorReviewResult) => void = () => {};
		const { rt, sendAdvice } = makeRuntime(
			() => new Promise<AdvisorReviewResult>((res) => { resolveReview = res; }),
			branch,
		);
		rt.onTurnEnd(branch);
		// While the review is in flight, reset (simulating a session switch/compaction).
		await new Promise((r) => setTimeout(r, 5));
		expect(rt.isBusy).toBe(true);
		rt.reset();
		// Now resolve the stale review. Because the epoch advanced, the result
		// must be discarded — no advice delivered.
		resolveReview({ advise: { note: "stale", severity: "concern" }, rounds: 1 });
		await new Promise((r) => setTimeout(r, 20));
		expect(sendAdvice).not.toHaveBeenCalled();
	});

	it("dispose stops further turns from doing anything", async () => {
		const branch = [entry("user", "x")];
		const review = vi.fn(async () => ({ advise: { note: "x" }, rounds: 1 }));
		const { rt, sendAdvice } = makeRuntime(review, branch);
		rt.dispose();
		rt.onTurnEnd(branch);
		await settle(rt);
		expect(review).not.toHaveBeenCalled();
		expect(sendAdvice).not.toHaveBeenCalled();
	});
});

describe("AdvisorRuntime — cursor seeding", () => {
	it("seedToLeaf prevents replaying old turns on the first enabled turn", async () => {
		const branch = [entry("user", "old1"), entry("assistant", "old2"), entry("user", "new")];
		const seenTexts: string[] = [];
		const { rt, sendAdvice } = makeRuntime(async (text: string) => {
			seenTexts.push(text);
			return { advise: null, rounds: 0 };
		}, branch);
		rt.seedToLeaf(branch);
		// First turn after seed: only "new" should be in the window (old turns
		// are behind the cursor and thus filtered out).
		rt.onTurnEnd([...branch, entry("user", "after-seed")]);
		await settle(rt);
		expect(seenTexts).toHaveLength(1);
		expect(seenTexts[0]).toContain("after-seed");
		expect(seenTexts[0]).not.toContain("old1");
		expect(sendAdvice).not.toHaveBeenCalled();
	});

	it("filters its own <advisory> entries out of the review window", async () => {
		const branch = [entry("user", "real work"), advisorEntry("you did it wrong"), entry("assistant", "ok")];
		const seenTexts: string[] = [];
		const { rt } = makeRuntime(async (text: string) => { seenTexts.push(text); return { advise: null, rounds: 0 }; }, branch);
		rt.onTurnEnd(branch);
		await settle(rt);
		expect(seenTexts).toHaveLength(1);
		expect(seenTexts[0]).toContain("real work");
		expect(seenTexts[0]).toContain("ok");
		expect(seenTexts[0]).not.toContain("you did it wrong");
	});
});

describe("AdvisorRuntime — reviewNow", () => {
	it("runs an immediate full-window review on demand", async () => {
		const branch = [entry("user", "a"), entry("assistant", "b")];
		const { rt, sendAdvice } = makeRuntime(async () => ({ advise: { note: "on-demand", severity: "nit" }, rounds: 1 }), branch);
		const result = await rt.reviewNow(branch);
		expect(result?.advise?.note).toBe("on-demand");
		expect(sendAdvice).toHaveBeenCalledTimes(1);
	});

	it("returns null when busy", async () => {
		const branch = [entry("user", "a")];
		let resolveReview: (r: AdvisorReviewResult) => void = () => {};
		const { rt } = makeRuntime(() => new Promise<AdvisorReviewResult>((res) => { resolveReview = res; }), branch);
		rt.onTurnEnd(branch);
		await new Promise((r) => setTimeout(r, 5));
		const result = await rt.reviewNow(branch);
		expect(result).toBeNull();
		resolveReview({ advise: null, rounds: 0 });
		await new Promise((r) => setTimeout(r, 10));
	});
});
