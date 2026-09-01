/**
 * Unit tests for the advisor agent loop (src/agent.ts) — the core "does it
 * work" tests. Uses a scriptable fake `complete` so no network/API key is needed.
 *
 * Updated for the per-turn `runAdvisorReview(sessionUpdate, model, auth, cwd,
 * signal, config)` signature.
 */

import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
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

	it("forwards resolved auth unchanged: null deletion-marker headers, env, and credential baseUrl (pi 0.84)", async () => {
		const model = fakeModel({ baseUrl: "http://localhost" });
		let seen: { apiKey?: string; headers?: Record<string, string | null>; env?: Record<string, string> } | undefined;
		const complete = scriptableComplete([textAssistant("ok")], (_m, _c, options) => {
			seen = options;
		});
		const result = await runAdvisorReview(
			"### Session update",
			model,
			{
				apiKey: "k",
				headers: { "X-Custom": "1", "X-Delete-Marker": null },
				baseUrl: "https://gateway.example/v1",
				env: { AWS_REGION: "us-east-1" },
			},
			"/tmp",
			new AbortController().signal,
			{ maxToolRounds: 2, thinking: false, thinkingLevel: "medium", complete },
		);

		expect(result.error).toBeUndefined();
		// pi ≥0.84 ProviderHeaders pass through untouched, including `null`
		// deletion markers that pi-ai applies when merging provider defaults.
		expect(seen?.headers).toEqual({ "X-Custom": "1", "X-Delete-Marker": null });
		expect(seen?.apiKey).toBe("k");
		expect(seen?.env).toEqual({ AWS_REGION: "us-east-1" });
		// Credential-resolved endpoint overrides the model's catalog baseUrl,
		// mirroring pi core's model runtime.
		expect(complete.calls[0].model.baseUrl).toBe("https://gateway.example/v1");
	});

	it("sends history unchanged as the leading prefix; the new update is the last message", async () => {
		const model = fakeModel();
		const history: Message[] = [
			{ role: "user", content: "### Session update\n\n[User]: earlier", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "looked fine" }], timestamp: 2 } as unknown as Message,
		];
		const complete = scriptableComplete([textAssistant("ok")]);
		const t = fakeTurn(model, complete);
		const result = await runAdvisorReview(
			"### Session update\n\n[User]: now",
			t.model,
			t.auth,
			t.cwd,
			t.signal,
			t.config,
			history,
		);

		expect(result.error).toBeUndefined();
		const msgs = complete.calls[0].messages;
		// The persistent prefix is forwarded byte-identical (the prompt-cache
		// invariant) and the new update is appended as the final user message.
		// (The array reference is captured live, so the advisor's own final turn
		// may already be appended behind it — the prefix is what matters.)
		expect(msgs.slice(0, 2)).toEqual(history);
		expect(msgs[2].role).toBe("user");
		expect((msgs[2] as { content: string }).content).toContain("[User]: now");
		expect(msgs.length).toBe(history.length + 2); // update + advisor's final turn
	});

	it("returns appended = the new user message + the advisor's turns, fully tool-paired", async () => {
		const model = fakeModel();
		const complete = scriptableComplete([
			assistantMessage([readCall("src/a.ts")]),
			assistantMessage([adviseCall("watch the null case", "concern")]),
		]);
		const t = fakeTurn(model, complete);
		const result = await runAdvisorReview("### Session update", t.model, t.auth, t.cwd, t.signal, t.config);

		expect(result.error).toBeUndefined();
		expect(result.advise!.note).toBe("watch the null case");
		expect(result.appended).toBeDefined();
		expect(result.appended![0].role).toBe("user");
		// Every toolResult in the appended set pairs with a preceding toolCall —
		// the runtime persists this verbatim, so an orphan would 400 the next
		// request on tool-strict providers (Anthropic).
		const calls = new Set<string>();
		for (const m of result.appended!) {
			if (m.role === "assistant") {
				for (const c of m.content) if (c.type === "toolCall") calls.add(c.id);
			}
			if (m.role === "toolResult") expect(calls.has(m.toolCallId)).toBe(true);
		}
		expect(calls.size).toBeGreaterThanOrEqual(2); // read + advise both paired
	});

	it("drops an empty final response from appended; keeps a substantive one", async () => {
		const model = fakeModel();
		const silent = scriptableComplete([assistantMessage([])]);
		const t1 = fakeTurn(model, silent);
		const r1 = await runAdvisorReview("u", t1.model, t1.auth, t1.cwd, t1.signal, t1.config);
		expect(r1.appended).toHaveLength(1); // just the user update

		const spoke = scriptableComplete([textAssistant("all good")]);
		const t2 = fakeTurn(model, spoke);
		const r2 = await runAdvisorReview("u", t2.model, t2.auth, t2.cwd, t2.signal, t2.config);
		expect(r2.appended).toHaveLength(2); // user update + the advisor's final text
	});

	it("returns no appended when the review fails (partial turns must not persist)", async () => {
		const model = fakeModel();
		const complete = scriptableComplete([]); // script exhausted → throws
		const t = fakeTurn(model, complete);
		const result = await runAdvisorReview("u", t.model, t.auth, t.cwd, t.signal, t.config);
		expect(result.error).toBeTruthy();
		expect(result.appended).toBeUndefined();
	});

	it("forwards the per-session sessionId to the completion options (provider prompt-cache key)", async () => {
		const model = fakeModel();
		let seen: { sessionId?: string } | undefined;
		const complete = scriptableComplete([textAssistant("ok")], (_m, _c, options) => {
			seen = options;
		});
		const t = fakeTurn(model, complete);
		await runAdvisorReview("u", t.model, t.auth, t.cwd, t.signal, { ...t.config, sessionId: "advisor-session-1" });
		expect(seen?.sessionId).toBe("advisor-session-1");
	});

	it("uses the model's catalog baseUrl when no credential endpoint is resolved", async () => {
		const model = fakeModel({ baseUrl: "http://localhost" });
		const complete = scriptableComplete([textAssistant("ok")]);
		await runAdvisorReview(
			"### Session update",
			model,
			{ apiKey: "k", headers: {} },
			"/tmp",
			new AbortController().signal,
			{ maxToolRounds: 2, thinking: false, thinkingLevel: "medium", complete },
		);
		expect(complete.calls[0].model.baseUrl).toBe("http://localhost");
	});

	it("appends project instructions to the advisor system prompt", async () => {
		const model = fakeModel();
		let systemPrompt = "";
		const complete = scriptableComplete([textAssistant("ok")], (_model, context) => {
			systemPrompt = context.systemPrompt ?? "";
		});
		const t = fakeTurn(model, complete);
		await runAdvisorReview("### Session update", t.model, t.auth, t.cwd, t.signal, {
			...t.config,
			projectInstructions: "Focus on API compatibility and accessibility.",
		});
		expect(systemPrompt).toContain("<project-advisor-instructions>");
		expect(systemPrompt).toContain("Focus on API compatibility and accessibility.");
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
