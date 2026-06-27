/**
 * Shared constants, types, and helpers for pi-advisor.
 *
 * Config lives at ~/.pi/agent/extensions/pi-advisor.json — the same convention
 * pi-vision-handoff / pi-model-sort use for picker-backed extensions. No
 * settings.json is touched.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Subdirectory under the pi agent dir where this extension stores its config. */
const CONFIG_SUBDIR = "extensions";

/** Config file name. */
export const CONFIG_FILENAME = "pi-advisor.json";

/** Full config path: ~/.pi/agent/extensions/pi-advisor.json */
export function getConfigPath(): string {
	return join(getAgentDir(), CONFIG_SUBDIR, CONFIG_FILENAME);
}

/** Description shown in the / commands list. */
export const ADVISOR_COMMAND_DESCRIPTION =
	"Configure the advisor — pick a second model that peer-reviews every turn and injects advice";

/** Severity of an advisor note. Mirrors oh-my-pi's advisor severity ladder. */
export type AdvisorSeverity = "nit" | "concern" | "blocker";

/** One advice note produced by the advisor. */
export interface AdvisorNote {
	note: string;
	severity?: AdvisorSeverity;
}

/** Details payload on the `<advisory>` custom message rendered into the transcript. */
export interface AdvisorMessageDetails {
	notes: AdvisorNote[];
	/** The advisor model ref that produced this batch, for /advisor status. */
	model: string;
}

/** The customType this extension injects into the session transcript. */
export const ADVISOR_CUSTOM_TYPE = "advisor";

/** How many recently-delivered advisor notes to remember for delivery-time
 *  dedupe (B5: the advisor can't see its own prior advice since those entries
 *  are filtered, so a hard dedupe guard prevents the repeat-feedback loop). */
export const RECENT_ADVICE_LIMIT = 12;

/** Normalize an advisory note to a stable dedupe key. Lowercases and collapses
 *  whitespace so paraphrased repeats still match. A length suffix is appended so
 *  two distinct long notes sharing a prefix aren't silently merged by the 240-char
 *  truncation. Trades precision for recall: a false collision just suppresses a
 *  near-duplicate (fine); a false miss falls back to the ring-buffer awareness layer. */
export function adviceKey(note: string): string {
	const normalized = note.trim().toLowerCase().replace(/\s+/g, " ");
	return `${normalized.slice(0, 240)}#${normalized.length}`;
}

/** Render a compact preamble of recently-given advice, injected into the
 *  session-update header so the advisor can honor "NEVER repeat advice you
 *  already gave". Only injected when delivery-time dedupe did NOT fire, so the
 *  advisor never reads and re-anchors on its own (already-filtered) output. */
export function formatRecentAdvicePreamble(notes: readonly AdvisorNote[]): string {
	if (notes.length === 0) return "";
	const lines = notes.map((n) => `[${n.severity ?? "nit"}] ${n.note.slice(0, 140)}`);
	return `<recent_advice already_given do_not_repeat>\n${lines.join("\n")}\n</recent_advice>`;
}

/** Behavioral framing carried as a tag attribute so the agent-facing output
 *  stays a clean `<advisory>` block. The primary agent's system prompt never
 *  mentions advisories, so this is its only cue for how to treat them. Ported
 *  verbatim from oh-my-pi's AdviseTool. */
const ADVISOR_GUIDANCE = "weigh, don't blindly obey";

/** Whether advice at this severity should be delivered as an interrupting steer
 *  (concern/blocker) rather than a non-interrupting note that lands at the next
 *  step boundary (nit). Mirrors oh-my-pi's `isInterruptingSeverity`. */
export function isInterruptingSeverity(severity: AdvisorSeverity | undefined): boolean {
	return severity === "concern" || severity === "blocker";
}

/** Escape text for safe inclusion inside an XML-style wrapper. The advisor
 *  notes are user-model output and may contain `<`, `>`, `&`; without escaping
 *  a note could break out of the `<advisory>` wrapper or read as instructions. */
export function escapeXmlText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Render a batch of advisor notes as the agent-facing message body: one
 *  `<advisory>` element per note, severity as an attribute. Shared by the
 *  interrupting and non-interrupting delivery paths so both build byte-identical
 *  content. Ported from oh-my-pi's `formatAdvisorBatchContent`. */
export function formatAdvisorBatchContent(notes: readonly AdvisorNote[]): string {
	return notes
		.map((n) => {
			const severity = n.severity ? ` severity="${n.severity}"` : "";
			return `<advisory${severity} guidance="${ADVISOR_GUIDANCE}">\n${escapeXmlText(n.note)}\n</advisory>`;
		})
		.join("\n");
}

export interface AdvisorConfig {
	/** Master switch. When false, no review occurs even if a model is configured. */
	enabled: boolean;
	/** The advisor model, as "provider/id". null = not configured (advisor inactive). */
	advisorModel: string | null;
	/**
	 * Whether the advisor model should reason (think) before reviewing. Off by
	 * default — review is a perception/judgement task and thinking adds latency +
	 * cost. When on, `thinkingLevel` is sent to the model via pi-ai's `reasoning`
	 * option (only honoured when the advisor model declares `reasoning: true`). */
	thinking: boolean;
	/** Thinking effort when `thinking` is on. */
	thinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh";
	/** Approximate char budget for the advisor's rolling context buffer of recent
	 *  per-turn deltas. The oldest turn is evicted when exceeded, so cost stays
	 *  bounded while the advisor keeps cross-turn context (replacing oh-my-pi's
	 *  own append-only context, which the extension API can't reach). */
	contextChars: number;
	/** Minimum gap (ms) between advisor reviews. 0 = review every turn_end (the
	 *  default). Set higher to throttle cost on a busy agent: turns arriving
	 *  inside the cooldown are coalesced into the next eligible review, not dropped. */
	cooldownMs: number;
	/** Max read-only tool rounds the advisor may take per review before it must
	 *  call `advise` or yield. Guards against a runaway advisor loop. */
	maxToolRounds: number;
	/** Max attempts to retry a failed advisor review before dropping the backlog
	 *  so the session never stalls. Mirrors oh-my-pi's 3-strike drop. */
	maxRetries: number;
	/** When true (default), ALL advice — including `nit` — is delivered as
	 *  interrupting (triggers a new agent turn immediately so the agent
	 *  acknowledges/acts on every note). When false, only `concern`/`blocker`
	 *  interrupt; `nit` lands as a non-interrupting note visible on the next
	 *  turn. Toggled with `/advisor interrupting`. */
	interrupting: boolean;
	/** Override the advisor system prompt. Defaults to the built-in prompt. */
	systemPrompt?: string;
}

export const DEFAULT_CONFIG: AdvisorConfig = {
	enabled: true,
	advisorModel: null,
	thinking: false,
	thinkingLevel: "medium",
	contextChars: 12_000,
	cooldownMs: 0,
	maxToolRounds: 6,
	maxRetries: 3,
	interrupting: true,
};

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
function isThinkingLevel(v: unknown): v is AdvisorConfig["thinkingLevel"] {
	return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

/** Parse a "provider/id" reference. Returns null if malformed. */
export function parseModelRef(ref: string): { provider: string; id: string } | null {
	const trimmed = ref.trim();
	if (!trimmed) return null;
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0) return null; // no slash, or empty provider
	const provider = trimmed.slice(0, slashIndex);
	const id = trimmed.slice(slashIndex + 1);
	if (!provider || !id) return null;
	return { provider, id };
}

/** Format a provider/id reference string. */
export function formatModelRef(provider: string, id: string): string {
	return `${provider}/${id}`;
}

/** Merge a parsed config object onto defaults, tolerating missing/invalid fields. */
export function normalizeConfig(raw: unknown): AdvisorConfig {
	const base: AdvisorConfig = { ...DEFAULT_CONFIG };
	if (!raw || typeof raw !== "object") return base;
	const obj = raw as Record<string, unknown>;

	if (typeof obj.enabled === "boolean") base.enabled = obj.enabled;
	if (typeof obj.advisorModel === "string" && obj.advisorModel.trim()) {
		base.advisorModel = parseModelRef(obj.advisorModel) ? obj.advisorModel.trim() : null;
	} else if (obj.advisorModel === null) {
		base.advisorModel = null;
	}
	if (typeof obj.thinking === "boolean") base.thinking = obj.thinking;
	if (isThinkingLevel(obj.thinkingLevel)) base.thinkingLevel = obj.thinkingLevel;
	// `contextEntries` is silently accepted from old config files for
	// back-compat but no longer read (replaced by contextChars). Swallow it here.
	if (
		typeof obj.contextChars === "number" &&
		Number.isFinite(obj.contextChars) &&
		obj.contextChars >= 512
	) {
		base.contextChars = Math.floor(obj.contextChars);
	}
	if (
		typeof obj.cooldownMs === "number" &&
		Number.isFinite(obj.cooldownMs) &&
		obj.cooldownMs >= 0
	) {
		base.cooldownMs = Math.floor(obj.cooldownMs);
	}
	if (
		typeof obj.maxToolRounds === "number" &&
		Number.isFinite(obj.maxToolRounds) &&
		obj.maxToolRounds >= 0
	) {
		base.maxToolRounds = Math.floor(obj.maxToolRounds);
	}
	if (
		typeof obj.maxRetries === "number" &&
		Number.isFinite(obj.maxRetries) &&
		obj.maxRetries >= 0
	) {
		base.maxRetries = Math.floor(obj.maxRetries);
	}
	if (typeof obj.interrupting === "boolean") base.interrupting = obj.interrupting;
	if (typeof obj.systemPrompt === "string" && obj.systemPrompt.trim()) {
		base.systemPrompt = obj.systemPrompt;
	}
	return base;
}

/** Read config from disk (falls back to defaults on missing/corrupt file). */
export function readConfig(): AdvisorConfig {
	const path = getConfigPath();
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const raw = readFileSync(path, "utf8");
		return normalizeConfig(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Write config to disk. Creates the directory if needed. Returns the path written. */
export function writeConfig(config: AdvisorConfig): string {
	const path = getConfigPath();
	const dir = join(getAgentDir(), CONFIG_SUBDIR);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
	return path;
}
