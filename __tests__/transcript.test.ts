/**
 * Unit tests for the transcript delta builder (src/transcript.ts).
 */

import { describe, expect, it } from "vitest";
import { buildAdvisorDelta } from "../src/transcript.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ADVISOR_CUSTOM_TYPE } from "../src/index.js";

let idCounter = 0;
function id(): string {
	return `e${idCounter++}`;
}

function userEntry(text: string): SessionEntry {
	return {
		type: "message",
		id: id(),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "user",
			content: text,
			timestamp: Date.now(),
		},
	};
}

function assistantEntry(text: string): SessionEntry {
	return {
		type: "message",
		id: id(),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
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
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

/** An advisor-injected custom message entry — must be filtered from the window. */
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
	};
}

describe("buildAdvisorDelta", () => {
	it("returns null for an empty branch", () => {
		const r = buildAdvisorDelta([], null, 30);
		expect(r.text).toBeNull();
		expect(r.lastSeenEntryId).toBeNull();
	});

	it("returns the full window when the cursor is null", () => {
		const branch = [userEntry("hello"), assistantEntry("hi there")];
		const r = buildAdvisorDelta(branch, null, 30);
		expect(r.text).toContain("### Session update");
		expect(r.text).toContain("hello");
		expect(r.text).toContain("hi there");
		expect(r.lastSeenEntryId).toBe(branch[1].id);
	});

	it("only includes entries after the cursor on subsequent calls", () => {
		const branch = [userEntry("first"), assistantEntry("second"), userEntry("third")];
		const first = buildAdvisorDelta(branch, null, 30);
		expect(first.text).toContain("first");
		expect(first.text).toContain("third");
		// Cursor advances to the last entry of the window.
		expect(first.lastSeenEntryId).toBe(branch[2].id);

		// Nothing new after the cursor → null text, same cursor.
		const second = buildAdvisorDelta(branch, first.lastSeenEntryId, 30);
		expect(second.text).toBeNull();
		expect(second.lastSeenEntryId).toBe(branch[2].id);

		// Append a new turn → only the new turn appears (old ones stay filtered out).
		const branch2 = [...branch, assistantEntry("fourth")];
		const third = buildAdvisorDelta(branch2, second.lastSeenEntryId, 30);
		expect(third.text).toContain("fourth");
		expect(third.text).not.toContain("first");
		expect(third.text).not.toContain("third");
		expect(third.lastSeenEntryId).toBe(branch2[3].id);
	});

	it("returns null when there is nothing new after the cursor", () => {
		const branch = [userEntry("only")];
		const first = buildAdvisorDelta(branch, null, 30);
		const second = buildAdvisorDelta(branch, first.lastSeenEntryId, 30);
		expect(second.text).toBeNull();
		expect(second.lastSeenEntryId).toBe(first.lastSeenEntryId);
	});

	it("filters the advisor's own <advisory> entries out of the window", () => {
		const branch = [
			userEntry("do the thing"),
			advisorEntry("you did it wrong"), // must NOT appear
			assistantEntry("done"),
		];
		const r = buildAdvisorDelta(branch, null, 30);
		expect(r.text).toContain("do the thing");
		expect(r.text).toContain("done");
		expect(r.text).not.toContain("you did it wrong");
		expect(r.text).not.toContain("advisory");
	});

	it("bounds the window to the trailing N entries", () => {
		const branch = [
			userEntry("old-1"),
			assistantEntry("old-2"),
			userEntry("old-3"),
			assistantEntry("recent-4"),
		];
		// Window of 2 → only the last two entries appear.
		const r = buildAdvisorDelta(branch, null, 2);
		expect(r.text).toContain("recent-4");
		expect(r.text).not.toContain("old-1");
		expect(r.text).not.toContain("old-2");
		expect(r.lastSeenEntryId).toBe(branch[3].id);
	});

	it("re-primes from the bounded window when the cursor is stale (entry gone)", () => {
		const branch = [userEntry("a"), assistantEntry("b"), userEntry("c")];
		// Pretend the cursor pointed at an entry that no longer exists (compaction/fork).
		const r = buildAdvisorDelta(branch, "gone-id", 30);
		expect(r.text).toContain("a");
		expect(r.text).toContain("c");
		expect(r.lastSeenEntryId).toBe(branch[2].id);
	});
});
