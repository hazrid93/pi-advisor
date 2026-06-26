/**
 * Unit tests for the advisor agent loop (src/agent.ts) — the core "does it
 * work" tests. Uses a scriptable fake `complete` so no network/API key is needed.
 */

import { describe, expect, it } from "vitest";
import { runAdvisorReview } from "../src/agent.js";
import { adviseCall, fakeDeps, fakeModel, readCall, scriptableComplete, textAssistant } from "./helpers.js";
import { assistantMessage } from "./helpers.js";

describe("runAdvisorReview", () => {
	it("captures an immediate advise call (no exploration)", async () => {
		const model = fakeModel();
		const complete = scriptableComplete([
			assistantMessage([adviseCall("use the durable queue", "concern")]),
		]);
		const result = await runAdvisorReview("### Session update\n\n…", "fake/fake-advisor", fakeDeps(model, complete));

		expect(result.error).toBeUndefined();
		expect(result.advise).not.toBeNull();
		expect(result.advise!.note).toBe("use the durable queue");
		expect(result.advise!.severity).toBe("concern");
		expect(result.rounds).toBe(1);
		// The first message sent to the model is the session update as a user turn.
		expect(complete.calls[0].messages[0].role).toBe("user");
	});

	it("treats a plain text reply (no tool calls) as silence", async () => {
		const model = fakeModel();
		const complete = scriptableComplete([textAssistant("the agent looks on track")]);
		const result = await runAdvisorReview("### Session update", "fake/fake-advisor", fakeDeps(model, complete));

		expect(result.error).toBeUndefined();
		expect(result.advise).toBeNull();
		expect(result.rounds).toBe(0);
	});

	it("explores with read, then advises — capturing the note and feeding the tool result back", async () => {
		const model = fakeModel();
		const complete = scriptableComplete([
			// Round 0: advisor wants to read a file.
			assistantMessage([readCall("foo.txt")]),
			// Round 1: advisor has seen it and advises.
			assistantMessage([adviseCall("off-by-one in foo.txt", "blocker")]),
		]);
		const result = await runAdvisorReview("### Session update", "fake/fake-advisor", fakeDeps(model, complete, { cwd: __dirname }));

		// Second call: user(session-update) + asst(read call) + toolResult(read) +
		// asst(advise call) + toolResult(advise). The loop feeds each assistant
		// turn and its tool results back so the next round pairs correctly.
		const secondMessages = complete.calls[1].messages;
		expect(secondMessages).toHaveLength(5);
		expect(secondMessages[0].role).toBe("user");
		expect(secondMessages[1].role).toBe("assistant");
		expect(secondMessages[2].role).toBe("toolResult");
		expect(secondMessages[3].role).toBe("assistant");
		expect(secondMessages[4].role).toBe("toolResult");
		expect(result.advise!.note).toBe("off-by-one in foo.txt");
		expect(result.advise!.severity).toBe("blocker");
		expect(result.rounds).toBe(2);
	});

	it("ends as silence when the round cap is hit without an advise", async () => {
		const model = fakeModel();
		const complete = scriptableComplete([
			assistantMessage([readCall("a.txt")]),
			assistantMessage([readCall("b.txt")]),
			assistantMessage([readCall("c.txt")]),
		]);
		const result = await runAdvisorReview(
			"### Session update",
			"fake/fake-advisor",
			fakeDeps(model, complete, { cwd: __dirname, maxToolRounds: 2 }),
		);

		// With maxToolRounds=2, the loop runs rounds 0 and 1, then hits the cap.
		expect(result.advise).toBeNull();
		expect(result.rounds).toBeGreaterThanOrEqual(2);
		// Each round issued exactly one complete() call.
		expect(complete.calls.length).toBeLessThanOrEqual(3);
	});

	it("returns an error when the advisor model is not found", async () => {
		const model = fakeModel();
		const complete = scriptableComplete([]);
		const deps = { ...fakeDeps(model, complete), resolveModel: () => undefined };
		const result = await runAdvisorReview("### Session update", "fake/missing", deps);

		expect(result.advise).toBeNull();
		expect(result.error).toContain("not found");
		expect(complete.calls).toHaveLength(0);
	});

	it("returns an error when auth is not configured", async () => {
		const model = fakeModel();
		const complete = scriptableComplete([]);
		const deps = {
			...fakeDeps(model, complete),
			getApiKeyAndHeaders: async () => ({ ok: false as const, error: "no api key" }),
		};
		const result = await runAdvisorReview("### Session update", "fake/fake-advisor", deps);

		expect(result.advise).toBeNull();
		expect(result.error).toBe("no api key");
		expect(complete.calls).toHaveLength(0);
	});

	it("classifies a thrown error during completion as an error (not silence)", async () => {
		const model = fakeModel();
		let i = 0;
		const complete = (async () => {
			i++;
			throw new Error("network down");
		}) as unknown as Parameters<typeof runAdvisorReview>[2]["complete"];
		const deps = fakeDeps(model, complete!);
		const result = await runAdvisorReview("### Session update", "fake/fake-advisor", deps);

		expect(result.advise).toBeNull();
		expect(result.error).toBe("network down");
		expect(i).toBe(1);
	});

	it("passes reasoning only when thinking is on AND the model supports it", async () => {
		const model = fakeModel({ reasoning: true });
		const complete = scriptableComplete([textAssistant("ok")]);
		await runAdvisorReview(
			"### Session update",
			"fake/fake-advisor",
			fakeDeps(model, complete, { thinking: true, thinkingLevel: "high" }),
		);
		expect(complete.calls[0].reasoning).toBe("high");
	});

	it("does NOT pass reasoning when the model lacks reasoning support", async () => {
		const model = fakeModel({ reasoning: false });
		const complete = scriptableComplete([textAssistant("ok")]);
		await runAdvisorReview(
			"### Session update",
			"fake/fake-advisor",
			fakeDeps(model, complete, { thinking: true, thinkingLevel: "high" }),
		);
		expect(complete.calls[0].reasoning).toBeUndefined();
	});

	it("does NOT pass reasoning when thinking is off", async () => {
		const model = fakeModel({ reasoning: true });
		const complete = scriptableComplete([textAssistant("ok")]);
		await runAdvisorReview(
			"### Session update",
			"fake/fake-advisor",
			fakeDeps(model, complete, { thinking: false, thinkingLevel: "high" }),
		);
		expect(complete.calls[0].reasoning).toBeUndefined();
	});

	it("sends the four advisor tools (read, grep, find, advise)", async () => {
		const model = fakeModel();
		let toolsSeen: unknown;
		const complete = scriptableComplete([textAssistant("ok")], (_m, ctx) => {
			toolsSeen = ctx.tools;
		});
		await runAdvisorReview("### Session update", "fake/fake-advisor", fakeDeps(model, complete));
		const names = (toolsSeen as Array<{ name: string }>).map((t) => t.name).sort();
		expect(names).toEqual(["advise", "find", "grep", "read"]);
	});
});
