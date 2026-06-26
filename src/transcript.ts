/**
 * Build the advisor's per-turn "Session update" from the session branch.
 *
 * oh-my-pi feeds the advisor only the transcript delta since the last review
 * (rendered with `formatSessionHistoryMarkdown`, thinking + tool calls + tool
 * results included). This extension can't reach pi's internal markdown
 * formatter, so it builds an equivalent view from the session branch using pi's
 * public `convertToLlm` + `serializeConversation` helpers (the same ones the
 * `handoff` example uses): it takes a bounded trailing window of entries, drops
 * the advisor's own injected `<advisory>` messages (so it never recursively
 * reviews its own advice), and serializes the result to text.
 *
 * A bounded recent window (instead of the full transcript) keeps cost down and
 * avoids orphaned tool-result messages — a `toolResult` only makes sense paired
 * with its preceding assistant `toolCall`, and slicing a trailing window of
 * whole entries preserves those pairings as long as the window starts at an
 * entry boundary.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { ADVISOR_CUSTOM_TYPE } from "./index.js";

/** Map a session entry to an AgentMessage the advisor can review. Compaction
 *  summaries become a synthetic compaction message so the advisor keeps context
 *  across a compact. Other non-conversational entries (model changes, labels,
 *  custom state) are skipped — they aren't part of the conversation. */
function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		} as unknown as AgentMessage;
	}
	return undefined;
}

/** Is this an entry the advisor itself injected? Filtered out of the review
 *  window so the advisor never reviews (and re-raises) its own advice. */
function isAdvisorOwnEntry(entry: SessionEntry): boolean {
	return (
		(entry.type === "custom_message" || entry.type === "custom") &&
		(entry as { customType?: string }).customType === ADVISOR_CUSTOM_TYPE
	);
}

export interface DeltaResult {
	/** The "### Session update\\n\\n<serialized>" text to send to the advisor, or
	 *  null when there is nothing new to review. */
	text: string | null;
	/** The entry id the advisor should remember as its new cursor. */
	lastSeenEntryId: string | null;
}

/**
 * Build the advisor's review text from the session branch.
 *
 * @param branch       The full current branch (ctx.sessionManager.getBranch()).
 * @param lastSeenId   The entry id the advisor last reviewed from, or null to
 *                     seed to the current leaf (review only new turns going
 *                     forward — mirrors oh-my-pi's mid-session seed).
 * @param windowEntries Max trailing entries to include.
 */
export function buildAdvisorDelta(
	branch: SessionEntry[],
	lastSeenId: string | null,
	windowEntries: number,
): DeltaResult {
	if (branch.length === 0) return { text: null, lastSeenEntryId: lastSeenId };

	// Find where the advisor left off. If the cursor is stale (the branch was
	// rewritten by compaction/fork), fall back to the whole branch window.
	let startIndex = 0;
	if (lastSeenId) {
		const idx = branch.findIndex((e) => e.id === lastSeenId);
		if (idx >= 0) startIndex = idx + 1;
		else startIndex = 0; // cursor gone — re-prime from the bounded window
	}

	const slice = branch.slice(startIndex);
	// Bound to the trailing window so cost stays predictable. Take the last N.
	const bounded = slice.length > windowEntries ? slice.slice(slice.length - windowEntries) : slice;

	// Drop the advisor's own injected messages.
	const reviewed = bounded.filter((e) => !isAdvisorOwnEntry(e));
	const messages = reviewed.map(entryToMessage).filter((m): m is AgentMessage => m !== undefined);

	const lastEntry = bounded[bounded.length - 1] ?? null;

	if (messages.length === 0) {
		return { text: null, lastSeenEntryId: lastEntry?.id ?? lastSeenId };
	}

	let llmMessages: Message[];
	try {
		llmMessages = convertToLlm(messages);
	} catch {
		// convertToLlm can throw on malformed custom messages; fall back to a
		// best-effort text dump so the advisor still gets something to review.
		llmMessages = messages
			.filter((m): m is Message => "role" in m && (m.role === "user" || m.role === "assistant" || m.role === "toolResult"))
			.map((m) => m as Message);
	}

	const serialized = serializeConversation(llmMessages).trim();
	if (!serialized) {
		return { text: null, lastSeenEntryId: lastEntry?.id ?? lastSeenId };
	}

	return {
		text: `### Session update\n\n${serialized}`,
		lastSeenEntryId: lastEntry?.id ?? lastSeenId,
	};
}
