/**
 * Shared constants, types, and helpers for pi-advisor.
 *
 * Config lives at ~/.pi/agent/extensions/pi-advisor.json — the same convention
 * pi-vision-handoff / pi-model-sort use for picker-backed extensions. No
 * settings.json is touched.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readProjectInstructions } from "./project-instructions.js";
import { readGlobalInstructions } from "./global-instructions.js";
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

/** Which source of advisor instructions is active. Global instructions live
 *  per-user (`~/.pi/agent/extensions/pi-advisor-instructions.md`); project
 *  instructions live in each repo's `.pi/advisor.md`. Default `"project"` so a
 *  fresh repo does NOT inherit the global file unless the user opts in. */
export type AdvisorInstructionsMode = "project" | "global" | "none";

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

/** Selectable review trigger points. The advisor captures every finalized
 *  turn into its rolling buffer regardless of which triggers are enabled
 *  (capture is decoupled from scheduling); only the enabled triggers actually
 *  *schedule* a review. `input` is deliberately NOT a review point — it
 *  precedes any implementation output and is used only to delimit/reset a goal
 *  (and to cancel the `mid_pause` debounce). Multi-select, persisted globally,
 *  toggled via `/advisor triggers`. Default: `["turn_end", "tool_error"]`. */
export type AdvisorTrigger =
	| "turn_end"
	| "tool_error"
	| "tool_result"
	| "agent_settled"
	| "mid_pause"
	| "input";

/** All selectable triggers, in menu/display order. */
export const ADVISOR_TRIGGERS: readonly AdvisorTrigger[] = [
	"turn_end",
	"tool_error",
	"tool_result",
	"agent_settled",
	"mid_pause",
	"input",
];

/** Human-readable one-liner for each trigger, shown in the `/advisor triggers`
 *  toggle menu and `/advisor status`. */
export const ADVISOR_TRIGGER_LABELS: Record<AdvisorTrigger, string> = {
	turn_end: "After every turn (turn_end)",
	tool_error: "After a turn containing a tool error (deferred to turn_end)",
	tool_result: "After each tool completes (tool_execution_end)",
	agent_settled: "Once when the agent run fully settles (agent_settled)",
	mid_pause: "After a quiet period mid-run (debounced; at most once per input)",
	input: "On user input — prompt/intent review before the agent runs",
};

/** Default trigger set. */
export const DEFAULT_TRIGGERS: AdvisorTrigger[] = ["turn_end", "tool_error"];

/** Default quiet period for the `mid_pause` debounce, in ms. */
export const DEFAULT_MID_PAUSE_MS = 4000;
export const MIN_MID_PAUSE_MS = 500;
export const MAX_MID_PAUSE_MS = 60_000;

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
	/** Approximate char budget for the advisor's persistent conversation of
	 *  recent session updates + its own review turns. Kept append-only across
	 *  reviews so consecutive requests share a byte-identical prefix (provider
	 *  prompt-cache hits); when exceeded, the oldest half of past reviews is
	 *  dropped at once. Also bounds the staging buffer of not-yet-reviewed
	 *  per-turn deltas. */
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
	/** Turn-based review cadence: a review is requested every `turnInterval`
	 *  completed turns (default 1 = every turn). Cadence measured in units of
	 *  WORK, not wall-clock — it self-adjusts to slow vs rapid pacing where a
	 *  pure cooldown cannot. Skipped turns stay staged and coalesce into the
	 *  next review (nothing dropped); the `agent_settled` flush always fires
	 *  for a finished run regardless of the counter. See `/advisor turns`. */
	turnInterval: number;
	/** How far the advisor may fall behind (in turns) before the main agent
	 *  WAITS for it to catch up at the `turn_end` boundary. 0 = never wait (the
	 *  advisor reviews fully in the background; today's default). 1 = the agent
	 *  waits after every turn for that turn's review (fully synchronous). 2..6
	 *  allow a bounded backlog so the agent keeps moving while the advisor
	 *  catches up, only pausing when it falls `syncLag` turns behind. Clamped to
	 *  0..6. See `/advisor sync`. */
	syncLag: number;
	/** Override the advisor system prompt. Defaults to the built-in prompt. */
	systemPrompt?: string;
	/** Enabled review triggers (multi-select). Capture always runs on turn_end;
	 *  only these triggers schedule a review. Default `["turn_end","tool_error"]`. */
	triggers: AdvisorTrigger[];
	/** Quiet period (ms) for the `mid_pause` debounce trigger. Ignored unless
	 *  `mid_pause` is in `triggers`. See `/advisor triggers`. */
	midPauseMs: number;
	/** Which instruction source is active. "project" = per-repo `.pi/advisor.md`
	 *  (default; opt-OUT of global); "global" = the per-user global file
	 *  (`/advisor instructions global …`); "none" = neither. */
	instructionsMode: AdvisorInstructionsMode;
	/** Prompt-cache retention for advisor reviews, forwarded to pi-ai.
	 *  "short" (default) = Anthropic 5m TTL — right for every-turn cadences
	 *  (each hit refreshes the TTL). "long" = 1h TTL where the model supports
	 *  it — worth it for sparse cadences (agent_settled-only, long quiet
	 *  periods) where reviews can land >5 minutes apart and the cached prefix
	 *  would otherwise expire. "none" disables cache markers and session-
	 *  affinity routing. Unset = pi-ai default ("short", or PI_CACHE_RETENTION=long). */
	cacheRetention?: "none" | "short" | "long";
}

/** Recommended rolling transcript budget: about 6k tokens for typical code/chat. */
export const RECOMMENDED_CONTEXT_CHARS = 24_000;
/** Bounds accepted by config and `/advisor context`. */
export const MIN_CONTEXT_CHARS = 512;
export const MAX_CONTEXT_CHARS = 200_000;

/** Parse a user-facing context size such as `24000`, `24k`, or `default`. */
export function parseAdvisorContextSize(value: string): number | null {
	const normalized = value.trim().toLowerCase();
	if (normalized === "default" || normalized === "recommended" || normalized === "reset") {
		return RECOMMENDED_CONTEXT_CHARS;
	}
	const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(k|kb|m|mb)?$/);
	if (!match) return null;
	const multiplier = match[2]?.startsWith("m") ? 1_000_000 : match[2] ? 1_000 : 1;
	const chars = Math.floor(Number(match[1]) * multiplier);
	if (!Number.isSafeInteger(chars) || chars < MIN_CONTEXT_CHARS || chars > MAX_CONTEXT_CHARS) {
		return null;
	}
	return chars;
}

/** Default minimum gap between advisor reviews. Turns arriving inside the gap
 *  coalesce into the next eligible review (deltas merge, nothing is dropped),
 *  so this throttles review FREQUENCY without losing coverage. 30s caps
 *  turn_end-heavy runs at ~2 reviews/minute — the default guard against the
 *  advisor out-calling the main model on tool-heavy bursts. `/advisor
 *  cooldown off` restores review-every-turn behavior. */
export const DEFAULT_COOLDOWN_MS = 30_000;

/** Default turn-based review cadence: every completed turn requests a review
 *  (subject to cooldown coalescing). Set higher (`/advisor turns 6`) to
 *  review every N turns instead — cadence measured in units of WORK rather
 *  than wall-clock, so it self-adjusts to slow vs rapid turn pacing. Turns
 *  skipped by the interval stay staged and coalesce into the next review,
 *  exactly like cooldown-skipped ones. */
export const DEFAULT_TURN_INTERVAL = 1;
export const MAX_TURN_INTERVAL = 50;

/** Parse a turn-interval value for `/advisor turns`: a positive integer
 *  ("6"), or "1"/"every"/"default" for every turn. Returns null if invalid. */
export function parseAdvisorTurnInterval(value: string): number | null {
	const normalized = value.trim().toLowerCase();
	if (normalized === "every" || normalized === "default") return 1;
	if (!/^\d+$/.test(normalized)) return null;
	const n = Number(normalized);
	if (!Number.isSafeInteger(n) || n < 1 || n > MAX_TURN_INTERVAL) return null;
	return n;
}

/** Default max read-only tool rounds per review. Each round is an extra
 *  advisor LLM call re-sending the growing conversation, so this is the
 *  biggest per-review cost multiplier. 2 covers the common explore pattern
 *  (list/grep → read) without the long tool-chains that make reviews
 *  out-cost main-model turns; the loop can always stop earlier on its own.
 *  `/advisor rounds 6` restores the old ceiling. */
export const DEFAULT_MAX_TOOL_ROUNDS = 2;

export const DEFAULT_CONFIG: AdvisorConfig = {
	enabled: true,
	advisorModel: null,
	thinking: false,
	thinkingLevel: "medium",
	contextChars: RECOMMENDED_CONTEXT_CHARS,
	cooldownMs: DEFAULT_COOLDOWN_MS,
	turnInterval: DEFAULT_TURN_INTERVAL,
	maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
	maxRetries: 3,
	interrupting: true,
	syncLag: 0,
	triggers: [...DEFAULT_TRIGGERS],
	midPauseMs: DEFAULT_MID_PAUSE_MS,
	instructionsMode: "project",
	// cacheRetention intentionally absent: pi-ai's default ("short", or the
	// PI_CACHE_RETENTION env) applies unless the user opts in.
};

/** Upper bound for the review cooldown (10 minutes) — above this the advisor
 *  effectively stops reviewing during active work. */
export const MAX_COOLDOWN_MS = 600_000;

/** Parse a cooldown value for `/advisor cooldown`: milliseconds ("30000",
 *  "500ms"), seconds ("30s"), minutes ("1m", "1.5m"), or off ("0", "off",
 *  "none", "default"). Returns ms in [0, MAX_COOLDOWN_MS], or null if invalid. */
export function parseAdvisorCooldownMs(value: string): number | null {
	const normalized = value.trim().toLowerCase();
	if (normalized === "off" || normalized === "none" || normalized === "default" || normalized === "0") return 0;
	const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/);
	if (!match) return null;
	const unit = match[2];
	const multiplier = unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
	const ms = Math.floor(Number(match[1]) * multiplier);
	if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_COOLDOWN_MS) return null;
	return ms;
}

/** Format a cooldown for display (status lines): "30s", "1m", raw ms under 1s. */
export function formatCooldownMs(ms: number): string {
	if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000}s`;
	return `${ms}ms`;
}

/** Parse a mid_pause debounce value for `/advisor pause`: milliseconds
 *  ("4000", "500ms") or seconds ("4s"). Returns ms in
 *  [MIN_MID_PAUSE_MS, MAX_MID_PAUSE_MS], or null if invalid. No "off" —
 *  the trigger itself is toggled via `/advisor triggers mid_pause`. */
export function parseAdvisorMidPauseMs(value: string): number | null {
	const normalized = value.trim().toLowerCase();
	const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/);
	if (!match) return null;
	const ms = Math.floor(Number(match[1]) * (match[2] === "s" ? 1_000 : 1));
	if (!Number.isSafeInteger(ms) || ms < MIN_MID_PAUSE_MS || ms > MAX_MID_PAUSE_MS) return null;
	return ms;
}

/** Parse/validate the `triggers` array from raw config. Unknown entries are
 *  dropped; de-duplicated preserving order; falls back to defaults if empty. */
function normalizeTriggers(raw: unknown): AdvisorTrigger[] {
	const known = new Set<string>(ADVISOR_TRIGGERS);
	let arr: AdvisorTrigger[];
	if (Array.isArray(raw)) {
		arr = raw.filter((t): t is AdvisorTrigger => typeof t === "string" && known.has(t));
	} else {
		arr = [];
	}
	// de-dupe preserving order
	arr = [...new Set(arr)];
	return arr.length > 0 ? arr : [...DEFAULT_TRIGGERS];
}

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
		Number.isFinite(obj.contextChars)
	) {
		base.contextChars = Math.min(
			MAX_CONTEXT_CHARS,
			Math.max(MIN_CONTEXT_CHARS, Math.floor(obj.contextChars)),
		);
	}
	if (
		typeof obj.cooldownMs === "number" &&
		Number.isFinite(obj.cooldownMs) &&
		obj.cooldownMs >= 0 &&
		obj.cooldownMs <= MAX_COOLDOWN_MS
	) {
		base.cooldownMs = Math.floor(obj.cooldownMs);
	}
	if (
		typeof obj.turnInterval === "number" &&
		Number.isFinite(obj.turnInterval) &&
		obj.turnInterval >= 1 &&
		obj.turnInterval <= MAX_TURN_INTERVAL
	) {
		base.turnInterval = Math.floor(obj.turnInterval);
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
	if (
		typeof obj.syncLag === "number" &&
		Number.isFinite(obj.syncLag)
	) {
		base.syncLag = Math.min(6, Math.max(0, Math.floor(obj.syncLag)));
	}
	if (typeof obj.systemPrompt === "string" && obj.systemPrompt.trim()) {
		base.systemPrompt = obj.systemPrompt;
	}
	// `triggers` is read unconditionally: when absent/invalid, normalizeTriggers
	// falls back to DEFAULT_TRIGGERS, so a config file written by an older
	// version (before the field existed) still yields a valid selection rather
	// than an empty set. This is what makes the globally-saved menu choices
	// survive a reload instead of silently reverting.
	base.triggers = normalizeTriggers(obj.triggers);
	if (
		typeof obj.midPauseMs === "number" &&
		Number.isFinite(obj.midPauseMs) &&
		obj.midPauseMs > 0
	) {
		base.midPauseMs = Math.min(MAX_MID_PAUSE_MS, Math.max(MIN_MID_PAUSE_MS, Math.floor(obj.midPauseMs)));
	}
	// `instructionsMode` selects which instruction source is active. Unknown/
	// absent values fall back to "project" (opt-out of global), matching the
	// default so old config files (pre-mode) keep using project instructions.
	if (obj.instructionsMode === "global" || obj.instructionsMode === "none" || obj.instructionsMode === "project") {
		base.instructionsMode = obj.instructionsMode;
	}
	// `cacheRetention`: only exact valid values are honored; anything else
	// (including old configs) leaves pi-ai's default in place.
	if (obj.cacheRetention === "none" || obj.cacheRetention === "short" || obj.cacheRetention === "long") {
		base.cacheRetention = obj.cacheRetention;
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

/** Resolve the active advisor instructions text for a given config + cwd,
 *  honoring {@link AdvisorConfig.instructionsMode}:
 *  - "project": per-repo `.pi/advisor.md` (default; opt-out of global)
 *  - "global": the per-user global file
 *  - "none": no instructions
 *
 *  Falls back gracefully: a missing project file yields ""; a missing global
 *  file yields "" (so "global" with no file set is silent, not an error). */
export function resolveActiveInstructions(config: AdvisorConfig, cwd: string): string {
	switch (config.instructionsMode) {
		case "global":
			return readGlobalInstructions();
		case "none":
			return "";
		case "project":
		default:
			return readProjectInstructions(cwd);
	}
}
