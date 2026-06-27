/**
 * Per-turn "Session update" for the advisor.
 *
 * Originally this built a bounded trailing window by diffing the session
 * branch against a cursor (`getBranch()`). That had two problems: when more
 * than the window's entries landed in one drain cycle it silently dropped the
 * head (never reviewed), and it re-derived what the `turn_end` event already
 * carries. The pi extension API hands `turn_end` a `message` + `toolResults`
 * pair — one turn, bounded by construction — so we now serialize that payload
 * directly (no branch diff, no cursor, no stale-cursor fallback).
 *
 * A rolling buffer of recent per-turn deltas is kept by the runtime (not here)
 * so the advisor keeps cross-turn context (replacing oh-my-pi's own append-only
 * context, which the extension API can't reach).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";

/** Serialize one turn's `turn_end` payload (`message` + its `toolResults`) to
 *  the advisor-facing "Session update" body. Returns null when the turn had no
 *  conversational content (e.g. an empty assistant message with no tool use). */
export function serializeTurn(
	message: AgentMessage,
	toolResults: ToolResultMessage[],
): string | null {
	const msgs: AgentMessage[] = [message, ...toolResults];
	let llm: Message[];
	try {
		llm = convertToLlm(msgs);
	} catch {
		// convertToLlm can throw on malformed custom messages; fall back to a
		// best-effort text dump of the standard roles so the advisor still gets
		// something to review.
		llm = msgs.filter(
			(m): m is Message =>
				"role" in m && (m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
		);
	}
	const serialized = serializeConversation(llm).trim();
	return serialized || null;
}

/** Wrap a serialized turn with the "### Session update" header the advisor
 *  expects, optionally prefixed with a recent-advice preamble (so the advisor
 *  can honor "NEVER repeat advice you already gave" — passed in by the runtime
 *  only when delivery-time dedupe did NOT fire). */
export function buildSessionUpdate(serializedTurn: string, preamble?: string): string {
	const header = preamble ? `${preamble}\n\n` : "";
	return `${header}### Session update\n\n${serializedTurn}`;
}

/** Extract the last conversational turn (assistant message + its trailing
 *  toolResults) from a session branch. Used by `/advisor review` to feed the
 *  same per-turn payload shape `turn_end` provides, without the event. Returns
 *  null if the branch has no assistant message. */
export function lastTurnFromBranch(
	branch: ReadonlyArray<SessionEntry>,
): { message: AgentMessage; toolResults: ToolResultMessage[] } | null {
	// Walk from the leaf backwards: collect trailing toolResults, then the
	// first assistant message above them is this turn's message.
	let i = branch.length - 1;
	const toolResults: ToolResultMessage[] = [];
	while (i >= 0) {
		const e = branch[i];
		if (e.type === "message" && e.message.role === "toolResult") {
			toolResults.unshift(e.message as ToolResultMessage);
			i--;
			continue;
		}
		break;
	}
	while (i >= 0) {
		const e = branch[i];
		if (e.type === "message" && e.message.role === "assistant") {
			return { message: e.message, toolResults };
		}
		i--;
	}
	return null;
}
