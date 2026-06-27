/**
 * Unit tests for the transcript serializers (src/transcript.ts).
 *
 * Updated for the event-payload model: `serializeTurn` takes a `turn_end`
 * payload (message + toolResults) and `lastTurnFromBranch` extracts such a
 * payload from a session branch for `/advisor review`. The old bounded-window
 * `buildAdvisorDelta` is gone.
 */

import { describe, expect, it } from "vitest";
import { buildSessionUpdate, lastTurnFromBranch, serializeTurn } from "../src/transcript.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { ADVISOR_CUSTOM_TYPE } from "../src/index.js";

let idCounter = 0;
function id(): string {
	return `e${idCounter++}`;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fake",
		model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
}

function userEntry(text: string): SessionEntry {
	return { type: "message", id: id(), parentId: null, timestamp: new Date().toISOString(), message: userMessage(text) } as SessionEntry;
}
function assistantEntry(text: string): SessionEntry {
	return { type: "message", id: id(), parentId: null, timestamp: new Date().toISOString(), message: assistantMessage(text) } as SessionEntry;
}
function toolResultEntry(toolCallId: string, text: string): SessionEntry {
	return { type: "message", id: id(), parentId: null, timestamp: new Date().toISOString(), message: toolResult(toolCallId, text) } as SessionEntry;
}
function advisorEntry(note: string): SessionEntry {
	return {
		type: "custom_message",
		id: id(),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: ADVISOR_CUSTOM_TYPE,
		content: `<advisory>${note}</advisory>`,
		display: true,
		details: { notes: [{ note }], model: "fake/fake" },
	} as SessionEntry;
}

describe("serializeTurn", () => {
	it("serializes an assistant message + its tool results", () => {
		const msg = assistantMessage("ran the thing");
		const trs = [toolResult("c1", "output line 1")];
		const out = serializeTurn(msg, trs);
		expect(out).toContain("ran the thing");
		expect(out).toContain("output line 1");
	});

	it("serializes a user message", () => {
		const out = serializeTurn(userMessage("hello?"), []);
		expect(out).toContain("hello?");
	});

	it("returns null when there is no conversational content", () => {
		// An assistant message with empty content + no tool results has nothing
		// to serialize → null, so the runtime skips queueing a review for it.
		const empty: AssistantMessage = { ...assistantMessage(""), content: [] };
		expect(serializeTurn(empty, [])).toBeNull();
	});
});

describe("buildSessionUpdate", () => {
	it("wraps the body with the header", () => {
		const out = buildSessionUpdate("body text");
		expect(out).toBe("### Session update\n\nbody text");
	});
	it("prepends the preamble when given", () => {
		const out = buildSessionUpdate("body", "<recent_advice>x</recent_advice>");
		expect(out).toContain("<recent_advice>x</recent_advice>");
		expect(out).toContain("### Session update");
	});
});

describe("lastTurnFromBranch", () => {
	it("returns null for an empty branch", () => {
		expect(lastTurnFromBranch([])).toBeNull();
	});

	it("extracts the last assistant message", () => {
		const branch = [userEntry("hi"), assistantEntry("hello")];
		const t = lastTurnFromBranch(branch);
		expect(t).not.toBeNull();
		expect((t!.message as AssistantMessage).role).toBe("assistant");
	});

	it("collects trailing tool results with the last assistant message", () => {
		const branch = [
			assistantEntry("let me read"),
			toolResultEntry("c1", "file contents"),
			assistantEntry("done"),
		];
		const t = lastTurnFromBranch(branch);
		expect(t).not.toBeNull();
		expect((t!.message as AssistantMessage).content[0]).toMatchObject({ type: "text", text: "done" });
		expect(t!.toolResults).toHaveLength(0); // 'done' has no trailing toolResults
	});

	it("pairs a trailing assistant message with its preceding tool results", () => {
		const branch = [
			assistantEntry("let me read"),
			toolResultEntry("c1", "file contents"),
		];
		// The leaf is a toolResult; lastTurnFromBranch walks back to the assistant message.
		const t = lastTurnFromBranch(branch);
		expect(t).not.toBeNull();
		expect((t!.message as AssistantMessage).content[0]).toMatchObject({ type: "text", text: "let me read" });
		expect(t!.toolResults).toHaveLength(1);
		expect(t!.toolResults[0].toolCallId).toBe("c1");
	});

	it("skips advisor custom entries when finding the last assistant message", () => {
		const branch = [assistantEntry("work"), advisorEntry("you did it wrong")];
		// advisorEntry is a custom_message, not a message, so the last assistant
		// message is the first entry.
		const t = lastTurnFromBranch(branch);
		expect(t).not.toBeNull();
		expect((t!.message as AssistantMessage).content[0]).toMatchObject({ type: "text", text: "work" });
	});
});
