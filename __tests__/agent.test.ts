/**
 * Unit tests for the advisor agent loop (src/agent.ts) — the core "does it
 * work" tests. Uses a scriptable fake `complete` so no network/API key is needed.
 *
 * Updated for the per-turn `runAdvisorReview(sessionUpdate, model, auth, cwd,
 * signal, config)` signature.
 */

import { describe, expect, it } from "vitest";
import { runAdvisorReview, type AdvisorComplete } from "../src/agent.js";
import { adviseCall, fakeTurn, fakeModel, readCall, scriptableComplete, textAssistant, assistantMessage } from "./helpers.js";

describe("runAdvisorReview", () => {
	it("captures an immediate advise call (no exploration)", async () => {
		const model = fakeModel();
		const complete = scriptableComplete([
			assistantMessage([adviseCall("use the durable queue", "concern")]),
		]);
		const t = fakeTurn(model, complete);
		const result = await runAdvisorReview("### Session update\n\n…", t.model, t.auth, t.cwd, t.signal, t.config);

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
		const t = fakeTurn(model, complete);
		const result = await runAdvisorReview("### Session update", t.model, t.auth, t.cwd, t.signal, t.config);

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
		const t = fakeTurn(model, complete, { cwd: __dirname });
		const result = await runAdvisorReview("### Session update", t.model, t.auth, t.cwd, t.signal, t.config);

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
		const t = fakeTurn(model, complete, { cwd: __dirname, maxToolRounds: 2 });
		const result = await runAdvisorReview(
			"### Session update",
			t.model,
			t.auth,
			t.cwd,
			t.signal,
			t.config,
		);

		// With maxToolRounds=2, the loop runs rounds 0, 1, 2 then hits the cap.
		expect(result.advise).toBeNull();
		expect(result.rounds).toBe(3);
		// Each round issued exactly one complete() call.
		expect(complete.calls.length).toBe(3);
	});

	it("returns an error when auth has no apiKey", async () => {
		const model = fakeModel();
		const complete = scriptableComplete([]);
		const t = fakeTurn(model, complete);
		const result = await runAdvisorReview(
			"### Session update",
			t.model,
			{ headers: {} },
			t.cwd,
			t.signal,
			t.config,
		);

		expect(result.advise).toBeNull();
		expect(result.error).toContain("No API key");
		expect(complete.calls).toHaveLength(0);
	});

	it("classifies a thrown error during completion as an error (not silence)", async () => {
		const model = fakeModel();
		let i = 0;
		const complete = (async () => {
			i++;
			throw new Error("network down");
		}) as unknown as AdvisorComplete;
		const t = fakeTurn(model, complete);
		const result = await runAdvisorReview("### Session update", t.model, t.auth, t.cwd, t.signal, t.config);

		expect(result.advise).toBeNull();
		expect(result.error).toBe("network down");
		expect(i).toBe(1);
	});

	it("passes reasoning only when thinking is on AND the model supports it", async () => {
		const model = fakeModel({ reasoning: true });
		const complete = scriptableComplete([textAssistant("ok")]);
		const t = fakeTurn(model, complete, { thinking: true, thinkingLevel: "high" });
		await runAdvisorReview("### Session update", t.model, t.auth, t.cwd, t.signal, t.config);
		expect(complete.calls[0].reasoning).toBe("high");
	});

	it("does NOT pass reasoning when the model lacks reasoning support", async () => {
		const model = fakeModel({ reasoning: false });
		const complete = scriptableComplete([textAssistant("ok")]);
		const t = fakeTurn(model, complete, { thinking: true, thinkingLevel: "high" });
		await runAdvisorReview("### Session update", t.model, t.auth, t.cwd, t.signal, t.config);
		expect(complete.calls[0].reasoning).toBeUndefined();
	});

	it("does NOT pass reasoning when thinking is off", async () => {
		const model = fakeModel({ reasoning: true });
		const complete = scriptableComplete([textAssistant("ok")]);
		const t = fakeTurn(model, complete, { thinking: false, thinkingLevel: "high" });
		await runAdvisorReview("### Session update", t.model, t.auth, t.cwd, t.signal, t.config);
		expect(complete.calls[0].reasoning).toBeUndefined();
	});

	it("does not pass reasoning when the model marks the level null via thinkingLevelMap (G6)", async () => {
		const model = fakeModel({ reasoning: true, thinkingLevelMap: { high: null } });
		const complete = scriptableComplete([textAssistant("ok")]);
		const t = fakeTurn(model, complete, { thinking: true, thinkingLevel: "high" });
		await runAdvisorReview("### Session update", t.model, t.auth, t.cwd, t.signal, t.config);
		expect(complete.calls[0].reasoning).toBeUndefined();
	});

	it("sends the four advisor tools (read, grep, find, advise)", async () => {
		const model = fakeModel();
		let toolsSeen: unknown;
		const complete = scriptableComplete([textAssistant("ok")], (_m, ctx) => {
			toolsSeen = ctx.tools;
		});
		const t = fakeTurn(model, complete);
		await runAdvisorReview("### Session update", t.model, t.auth, t.cwd, t.signal, t.config);
		const names = (toolsSeen as Array<{ name: string }>).map((t) => t.name).sort();
		expect(names).toEqual(["advise", "find", "grep", "read"]);
	});

	it("returns an aborted error when the signal is already aborted", async () => {
		const model = fakeModel();
		const complete = scriptableComplete([]);
		const ac = new AbortController();
		ac.abort();
		const t = fakeTurn(model, complete);
		const result = await runAdvisorReview("### Session update", t.model, t.auth, t.cwd, ac.signal, t.config);
		expect(result.error).toBe("aborted");
		expect(complete.calls).toHaveLength(0);
	});
});
