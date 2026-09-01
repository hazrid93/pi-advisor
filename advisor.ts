/**
 * pi-advisor — a second model that peer-reviews every turn of your main pi
 * agent and injects concise advice.
 *
 * This is the wiring layer: pi event hooks + the `/advisor` command. The
 * advisor runtime (delta tracking, serialized drain, retries, epoch guards) is
 * in `src/runtime.ts`; the advisor agent loop (`completeSimple` + read-only
 * tools + `advise` capture) is in `src/agent.ts`; the read-only toolset is in
 * `src/tools.ts`; the system prompt (ported from oh-my-pi) is in
 * `src/prompts.ts`; config lives in `src/index.ts`.
 *
 * Design (ported from can1357/oh-my-pi's advisor):
 * - A second model, picked by the user, reviews a bounded recent transcript
 *   window after each primary turn_end.
 * - It explores the workspace with a hard-isolated read-only toolset
 *   (read/grep/find) and surfaces one note via the `advise` tool.
 * - `nit` lands as a non-interrupting note at the next step boundary;
 *   `concern`/`blocker` interrupt (resume an idle agent immediately).
 * - Advice is delivered as `<advisory severity=... guidance="weigh, don't
 *   blindly obey">` custom messages, filtered out of the advisor's own review
 *   window so it never recursively reviews its own advice.
 *
 * Install: `pi install https://github.com/hazrid93/pi-advisor` then `/reload`.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	ADVISOR_COMMAND_DESCRIPTION,
	ADVISOR_TRIGGERS,
	ADVISOR_TRIGGER_LABELS,
	formatModelRef,
	MAX_CONTEXT_CHARS,
	MIN_CONTEXT_CHARS,
	parseAdvisorContextSize,
	parseModelRef,
	RECOMMENDED_CONTEXT_CHARS,
	readConfig,
	writeConfig,
	type AdvisorConfig,
	type AdvisorTrigger,
} from "./src/index.js";
import { AdvisorModelSelectorComponent, TriggersSelectorComponent, type TriggersSelectorResult, type ModelSelectorResult } from "./src/ui.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { AdvisorRuntime, makeHost, summarizeResult, type AdvisorRuntimeHost } from "./src/runtime.js";
import { lastTurnFromBranch } from "./src/transcript.js";
import { getProjectInstructionsPath, readProjectInstructions, writeProjectInstructions } from "./src/project-instructions.js";
import {
	getGlobalInstructionsPath,
	readGlobalInstructions,
	writeGlobalInstructions,
	clearGlobalInstructions,
	hasGlobalInstructions,
} from "./src/global-instructions.js";

let config: AdvisorConfig = readConfig();
let runtime: AdvisorRuntime | null = null;

function projectInstructions(cwd: string, trusted = true): string | undefined {
	if (!trusted) return undefined;
	try {
		const instructions = readProjectInstructions(cwd);
		return instructions || undefined;
	} catch {
		// A malformed or unreadable project file must never break the main agent.
		return undefined;
	}
}

/** Resolve the ACTIVE advisor instructions for the runtime, honoring the
 *  configured `instructionsMode`. Trust only gates the project source (a global,
 *  per-user file is never project-scoped). Returns undefined when the active
 *  source is unset/unreadable so the runtime falls back to the default prompt. */
function activeInstructions(cwd: string, trusted = true): string | undefined {
	switch (config.instructionsMode) {
		case "none":
			return undefined;
		case "global":
			try {
				return readGlobalInstructions() || undefined;
			} catch {
				return undefined;
			}
		case "project":
		default:
			return projectInstructions(cwd, trusted);
	}
}

/** Lazily create the runtime on first use (turn_end or command). The host only
 *  needs `pi.sendMessage` (advice delivery); per-turn model/auth resolution
 *  rides in the onTurnEnd/reviewNow ctx, so no stale-ctx closure is held. */
function buildHost(pi: ExtensionAPI): AdvisorRuntimeHost {
	return makeHost(pi, () => config.interrupting);
}

/** Lazily create the runtime on first use (turn_end or command). */
function ensureRuntime(pi: ExtensionAPI): AdvisorRuntime {
	if (runtime && !runtime.disposed) return runtime;
	runtime = new AdvisorRuntime(buildHost(pi), config);
	return runtime;
}

export default function (pi: ExtensionAPI) {
	config = readConfig();

	pi.on("session_start", async (_event, ctx) => {
		// Pick up config changes made from another session/window.
		Object.assign(config, readConfig());
		// Re-prime: drop any in-flight review and clear the rolling context buffer
		// so the advisor only reviews new turns going forward.
		const rt = ensureRuntime(pi);
		rt.reset();
		rt.seedToLeaf(ctx.sessionManager.getBranch());
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!config.enabled || !config.advisorModel) return;
		const rt = ensureRuntime(pi);
		void rt.onTurnEnd(event.message, event.toolResults, ctx.sessionManager.getBranch(), {
			signal: ctx.signal,
			cwd: ctx.cwd,
			modelRegistry: ctx.modelRegistry,
			getApiKeyAndHeaders: (m) => ctx.modelRegistry.getApiKeyAndHeaders(m),
			projectInstructions: activeInstructions(ctx.cwd, ctx.isProjectTrusted()),
		});
	});

	// Selectable triggers (see /advisor triggers). Each adapter is a thin shim
	// over the runtime; the runtime itself decides whether to capture/schedule
	// based on the enabled trigger set + latest-wins coalescing. turn_end above
	// ALWAYS captures the finalized turn; these only add EXTRA review points.
	pi.on("tool_execution_end", async (event, ctx) => {
		if (!config.enabled || !config.advisorModel) return;
		const rt = ensureRuntime(pi);
		void rt.onToolExecutionEnd(
			{ toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError },
			{
				signal: ctx.signal,
				cwd: ctx.cwd,
				modelRegistry: ctx.modelRegistry,
				getApiKeyAndHeaders: (m) => ctx.modelRegistry.getApiKeyAndHeaders(m),
				projectInstructions: activeInstructions(ctx.cwd, ctx.isProjectTrusted()),
			},
		);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!config.enabled || !config.advisorModel) return;
		const rt = ensureRuntime(pi);
		void rt.onAgentSettled({
			signal: ctx.signal,
			cwd: ctx.cwd,
			modelRegistry: ctx.modelRegistry,
			getApiKeyAndHeaders: (m) => ctx.modelRegistry.getApiKeyAndHeaders(m),
			projectInstructions: activeInstructions(ctx.cwd, ctx.isProjectTrusted()),
		});
	});

	// input always cancels/re-arms the mid_pause debounce for a new run; it only
	// triggers a prompt-review when `input` is ticked. (Fires before agent runs.)
	// The prompt-review runs fire-and-forget so a slow advisor can't block the
	// agent start; its advice lands as a steer once ready.
	pi.on("input", async (event, ctx) => {
		if (!config.enabled || !config.advisorModel) return { action: "continue" as const };
		const rt = ensureRuntime(pi);
		void rt.onInput(event.text, {
			signal: ctx.signal,
			cwd: ctx.cwd,
			modelRegistry: ctx.modelRegistry,
			getApiKeyAndHeaders: (m) => ctx.modelRegistry.getApiKeyAndHeaders(m),
			projectInstructions: activeInstructions(ctx.cwd, ctx.isProjectTrusted()),
		});
		return { action: "continue" as const };
	});

	// message_update keeps the mid_pause debounce alive; never schedules directly.
	// High-frequency (fires per token), so bail early when mid_pause is disabled.
	pi.on("message_update", async (_event, ctx) => {
		if (!config.enabled || !config.advisorModel) return;
		if (!config.triggers.includes("mid_pause")) return;
		const rt = ensureRuntime(pi);
		rt.onMessageUpdate({
			signal: ctx.signal,
			cwd: ctx.cwd,
			modelRegistry: ctx.modelRegistry,
			getApiKeyAndHeaders: (m) => ctx.modelRegistry.getApiKeyAndHeaders(m),
			projectInstructions: activeInstructions(ctx.cwd, ctx.isProjectTrusted()),
		});
	});

	// Sync gate: at the start of each turn, if the advisor has fallen `syncLag`
	// turns behind, WAIT for it to catch up before the main agent proceeds. pi
	// awaits turn_start handlers, so this blocks the next LLM turn until the
	// advisor's backlog is below the threshold. The wait is fully abortable
	// (composed with the lifecycle controller + the per-turn Ctrl+C signal) so a
	// slow/dead advisor model can't hang the agent. syncLag = 0 (default) => never
	// waits; the gate returns immediately and the advisor keeps reviewing fully
	// in the background (today's behavior). Sits between turns, so in-progress
	// tool calls in the prior turn were never interrupted.
	pi.on("turn_start", async (_event, ctx) => {
		if (!config.enabled || !config.advisorModel) return;
		if (config.syncLag <= 0) return;
		const rt = ensureRuntime(pi);
		await rt.waitForCatchUp(config.syncLag, ctx.signal);
	});

	// G2: compaction and tree navigation rewrite the branch. Bump the epoch so any
	// in-flight review is dropped instead of landing stale against the new
	// conversation, and clear the rolling context buffer.
	pi.on("session_compact", async (_event, ctx) => {
		runtime?.reset();
		runtime?.seedToLeaf(ctx.sessionManager.getBranch());
	});
	pi.on("session_tree", async (_event, ctx) => {
		runtime?.reset();
		runtime?.seedToLeaf(ctx.sessionManager.getBranch());
	});

	pi.on("session_shutdown", async () => {
		runtime?.dispose();
		runtime = null;
	});

	pi.registerCommand("advisor", {
		description: ADVISOR_COMMAND_DESCRIPTION,
		getArgumentCompletions(arg: string) {
			return completeAdvisorArgs(arg);
		},
		handler: async (args, ctx) => {
			await handleAdvisorCommand(pi, ctx, args.trim());
		},
	});
}

/** Top-level /advisor subcommands with one-line descriptions, shown as
 *  autocomplete suggestions in the TUI. Order = display order. Aliases accepted
 *  by the dispatcher (trigger/instruction singular) are intentionally NOT
 *  suggested — the canonical plural forms are. */
const ADVISOR_SUBCOMMANDS: { value: string; description: string }[] = [
	{ value: "model", description: "Set the advisor model directly (provider/id)" },
	{ value: "status", description: "Show config, triggers, instructions, and last review" },
	{ value: "enable", description: "Enable the advisor" },
	{ value: "disable", description: "Disable the advisor (keeps the model)" },
	{ value: "interrupting", description: "Toggle whether ALL advice interrupts (default: on)" },
	{ value: "sync", description: "Wait for the advisor when it falls N turns behind (0-6)" },
	{ value: "context", description: "Inspect or set the rolling transcript budget" },
	{ value: "thinking", description: "Set the advisor thinking effort (off|minimal|low|medium|high|xhigh)" },
	{ value: "triggers", description: "Toggle review triggers (default: turn_end, tool_error)" },
	{ value: "instructions", description: "Manage project + global advisor guidance and active mode" },
	{ value: "review", description: "Re-review the recent transcript now" },
	{ value: "help", description: "Show all advisor commands" },
];

const INSTRUCTIONS_ACTIONS: { value: string; description: string }[] = [
	{ value: "show", description: "Print the active project instructions" },
	{ value: "set", description: "Set project instructions from the following text" },
	{ value: "edit", description: "Open a multi-line editor for project instructions" },
	{ value: "clear", description: "Remove project instructions" },
	{ value: "global", description: "Manage the cross-repo global instructions file" },
	{ value: "mode", description: "Pick active source: project | global | none" },
];

const GLOBAL_ACTIONS: { value: string; description: string }[] = [
	{ value: "show", description: "Print the global instructions" },
	{ value: "set", description: "Set global instructions from the following text" },
	{ value: "edit", description: "Open a multi-line editor for global instructions" },
	{ value: "clear", description: "Remove global instructions" },
];

const INSTRUCTIONS_MODES: { value: string; description: string }[] = [
	{ value: "project", description: "Use per-repo .pi/advisor.md (default; opt-out of global)" },
	{ value: "global", description: "Use the cross-repo global file" },
	{ value: "none", description: "Use neither source" },
];

/** Tokenize the argument string typed so far into completed tokens + the
 *  partial token under the cursor.
 *  - arg=""            -> { completed: [], partial: "" }
 *  - arg="tr"          -> { completed: [], partial: "tr" }
 *  - arg="instructions " -> { completed: ["instructions"], partial: "" }
 *  - arg="instructions g" -> { completed: ["instructions"], partial: "g" } */
function tokenizeArgs(arg: string): { completed: string[]; partial: string } {
	const trimmed = arg.replace(/\s+$/, "");
	const hasTrailingSpace = trimmed.length < arg.length;
	const parts = trimmed.length ? trimmed.split(/\s+/) : [];
	if (hasTrailingSpace) return { completed: parts, partial: "" };
	const partial = parts.length ? parts[parts.length - 1] : "";
	return { completed: parts.slice(0, -1), partial };
}

/** Build AutocompleteItem[] where `value` is the FULL argument string to
 *  substitute (pi replaces the entire argument text with item.value). */
function buildItems(
	completed: string[],
	partial: string,
	candidates: { value: string; description: string }[],
) {
	const prefix = completed.length ? `${completed.join(" ")} ` : "";
	const matches = candidates.filter((c) => c.value.startsWith(partial));
	if (matches.length === 0) return null;
	return matches.map((c) => ({ value: `${prefix}${c.value}`, label: c.value, description: c.description }));
}

/** Context-aware autocomplete for `/advisor …`. Returns suggestions for the
 *  top-level subcommand list and, where useful, for nested arguments
 *  (`instructions global …`, `instructions mode …`, `triggers <name>`). The
 *  `enabled` set (defaults to the live config) only annotates trigger labels
 *  with [on]/[off]; it is passed in so the function stays pure and testable. */
export function completeAdvisorArgs(arg: string, enabled: string[] = config.triggers) {
	const enabledSet = new Set(enabled);
	const { completed, partial } = tokenizeArgs(arg);

	// Depth 1: completing the first subcommand token.
	if (completed.length === 0) {
		return buildItems([], partial, ADVISOR_SUBCOMMANDS);
	}

	const head = completed[0];

	// `triggers [name]` — depth 2 offers the toggleable trigger names.
	if ((head === "triggers" || head === "trigger") && completed.length === 1) {
		const candidates = ADVISOR_TRIGGERS.map((t) => ({
			value: t,
			description: `${enabledSet.has(t) ? "[on]  " : "[off] "}${ADVISOR_TRIGGER_LABELS[t]}`,
		}));
		return buildItems([completed[0]], partial, candidates);
	}

	// `instructions [action|global|mode] …`
	if (head === "instructions" || head === "instruction") {
		// Depth 2: the instructions action/group.
		if (completed.length === 1) {
			return buildItems([completed[0]], partial, INSTRUCTIONS_ACTIONS);
		}
		const sub = completed[1];
		// `instructions global [action]`
		if (sub === "global" && completed.length === 2) {
			return buildItems([completed[0], "global"], partial, GLOBAL_ACTIONS);
		}
		// `instructions mode <project|global|none>`
		if (sub === "mode" && completed.length === 2) {
			return buildItems([completed[0], "mode"], partial, INSTRUCTIONS_MODES);
		}
		return null;
	}

	return null;
}

async function handleAdvisorCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
): Promise<void> {
	const parts = args.split(/\s+/);
	const sub = parts[0]?.toLowerCase() ?? "";
	const rest = parts.slice(1).join(" ");

	if (!sub || sub === "select") {
		await showPicker(ctx);
		return;
	}

	if (sub === "help") {
		ctx.ui.notify(
			[
				"pi-advisor commands:",
				"  /advisor                Open the model picker to choose the advisor",
				"  /advisor model <p/id>  Set the advisor model directly",
				"  /advisor status        Show config + last review",
				"  /advisor enable        Enable the advisor",
				"  /advisor disable       Disable the advisor (keeps the model)",
				"  /advisor interrupting [on|off]  Toggle whether ALL advice interrupts (default: on)",
			"  /advisor sync [0-6]          Wait for the advisor when it falls N turns behind",
			"                                (0 = never wait, default; 1 = after every turn)",
				"  /advisor context [chars|Nk|default]",
				"                          Set rolling transcript size (default: 24k chars)",
				"  /advisor thinking <off|minimal|low|medium|high|xhigh>",
				"                          Set the advisor's thinking effort (off = disabled)",
				"  /advisor triggers [name] Toggle review triggers (default: turn_end, tool_error)",
				"                          Options: turn_end, tool_error, tool_result,",
				"                          agent_settled, mid_pause, input. Capture always runs.",
				"  /advisor instructions [show|set <text>|edit|clear]",
				"                          Manage PROJECT guidance (this repo)",
				"  /advisor instructions global [show|set <text>|edit|clear]",
				"                          Manage GLOBAL guidance (cross-repo, per-user)",
				"  /advisor instructions mode <project|global|none>",
				"                          Pick active source (default: project; global is opt-in)",
				"  /advisor review        Re-review the recent transcript now",
				"  /advisor help          This message",
				"",
				"Global config: ~/.pi/agent/extensions/pi-advisor.json",
				`Project guidance: ${getProjectInstructionsPath(ctx.cwd)}`,
				`Global guidance: ${getGlobalInstructionsPath()}`,
				"Advice is delivered as <advisory severity=...> notes: nit (non-interrupting when",
				"interrupting is off), concern/blocker (always interrupting).",
			].join("\n"),
			"info",
		);
		return;
	}

	if (sub === "status") {
		showStatus(ctx);
		return;
	}

	if (sub === "enable") {
		updateConfig(ctx, (c) => ({ ...c, enabled: true }), "Advisor enabled.");
		return;
	}

	if (sub === "disable") {
		updateConfig(ctx, (c) => ({ ...c, enabled: false }), "Advisor disabled.");
		return;
	}

	if (sub === "thinking") {
		handleThinking(ctx, rest);
		return;
	}

	if (sub === "interrupting") {
		handleInterrupting(ctx, rest);
		return;
	}

	if (sub === "sync") {
		handleSync(ctx, rest);
		return;
	}

	if (sub === "context" || sub === "window") {
		handleContext(ctx, rest);
		return;
	}

	if (sub === "instructions" || sub === "instruction") {
		await handleInstructions(ctx, rest);
		return;
	}

	if (sub === "triggers" || sub === "trigger") {
		await handleTriggers(ctx, rest);
		return;
	}

	if (sub === "model") {
		if (!rest) {
			ctx.ui.notify("Usage: /advisor model <provider/id>", "warning");
			return;
		}
		const parsed = parseModelRef(rest);
		if (!parsed) {
			ctx.ui.notify(`Invalid model reference: "${rest}". Use "provider/id".`, "error");
			return;
		}
		const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
		if (!model) {
			ctx.ui.notify(`Model not found: ${rest}. Use /advisor to pick from the list.`, "error");
			return;
		}
		const ref = formatModelRef(parsed.provider, parsed.id);
		updateConfig(ctx, (c) => ({ ...c, advisorModel: ref }), `Advisor model set to ${ref}.`);
		return;
	}

	if (sub === "review") {
		if (!ctx.hasUI) {
			ctx.ui.notify("/advisor review requires interactive mode.", "error");
			return;
		}
		if (!config.enabled || !config.advisorModel) {
			ctx.ui.notify("Advisor is not active. Pick a model with /advisor first.", "warning");
			return;
		}
		const rt = ensureRuntime(pi);
		const turn = lastTurnFromBranch(ctx.sessionManager.getBranch());
		if (!turn) {
			ctx.ui.notify("Nothing to review yet.", "info");
			return;
		}
		ctx.ui.notify("Reviewing recent transcript…", "info");
		const result = await rt.reviewNow(turn.message, turn.toolResults, {
			signal: ctx.signal,
			cwd: ctx.cwd,
			modelRegistry: ctx.modelRegistry,
			getApiKeyAndHeaders: (m) => ctx.modelRegistry.getApiKeyAndHeaders(m),
			projectInstructions: activeInstructions(ctx.cwd, ctx.isProjectTrusted()),
		});
		ctx.ui.notify(summarizeResult(result), result?.error ? "warning" : "info");
		return;
	}

	ctx.ui.notify(`Unknown subcommand: "${sub}". Use /advisor help for usage.`, "warning");
}

function updateConfig(
	ctx: ExtensionCommandContext,
	transform: (c: AdvisorConfig) => AdvisorConfig,
	message: string,
): void {
	const next = transform(config);
	const path = writeConfig(next);
	// Mutate the shared config object in place so the live runtime (which holds
	// the same reference) picks up the change immediately, then re-prime it.
	Object.assign(config, next);
	const rt = runtime;
	if (rt) {
		rt.reset();
		rt.seedToLeaf(ctx.sessionManager.getBranch());
	}
	ctx.ui.notify(`${message} (config: ${path})`, "info");
}

async function handleInstructions(ctx: ExtensionCommandContext, rest: string): Promise<void> {
	const input = rest.trim();
	const [actionRaw, ...tail] = input.split(/\s+/);
	const action = actionRaw?.toLowerCase() || (ctx.hasUI ? "edit" : "show");

	// --- global instructions (per-user, cross-repo): NOT gated by project trust ---
	if (action === "global") {
		return handleGlobalInstructions(ctx, tail);
	}

	// --- instructions mode: choose which source is active (global config) ---
	if (action === "mode") {
		return handleInstructionsMode(ctx, tail.join(" "));
	}

	// --- project instructions: gated by project trust ---
	if (!ctx.isProjectTrusted()) {
		ctx.ui.notify("Project advisor instructions are disabled until this project is trusted.", "error");
		return;
	}
	const path = getProjectInstructionsPath(ctx.cwd);

	try {
		if (action === "show") {
			const current = readProjectInstructions(ctx.cwd);
			ctx.ui.notify(current ? `Advisor instructions for this project:\n\n${current}\n\n${path}` : `No advisor instructions set for this project.\n${path}`, "info");
			return;
		}

		if (action === "clear" || action === "remove" || action === "reset") {
			writeProjectInstructions(ctx.cwd, "");
			runtime?.reset();
			runtime?.seedToLeaf(ctx.sessionManager.getBranch());
			ctx.ui.notify(`Cleared project advisor instructions. (${path})`, "info");
			return;
		}

		if (action === "set" || action === "add") {
			const text = tail.join(" ").trim();
			if (!text) {
				ctx.ui.notify("Usage: /advisor instructions set <text>", "warning");
				return;
			}
			writeProjectInstructions(ctx.cwd, text);
			runtime?.reset();
			runtime?.seedToLeaf(ctx.sessionManager.getBranch());
			ctx.ui.notify(`Saved project advisor instructions. (${path})`, "info");
			return;
		}

		if (action === "edit") {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive editing is unavailable. Use /advisor instructions set <text>.", "error");
				return;
			}
			const current = readProjectInstructions(ctx.cwd);
			const edited = await ctx.ui.editor("Advisor instructions for this project (submit empty to clear)", current);
			if (edited === undefined) {
				ctx.ui.notify("Advisor instructions unchanged.", "info");
				return;
			}
			const normalized = edited.trim();
			writeProjectInstructions(ctx.cwd, normalized);
			runtime?.reset();
			runtime?.seedToLeaf(ctx.sessionManager.getBranch());
			ctx.ui.notify(normalized ? `Saved project advisor instructions. (${path})` : `Cleared project advisor instructions. (${path})`, "info");
			return;
		}

		// Friendly shorthand: `/advisor instructions prefer tests first`.
		writeProjectInstructions(ctx.cwd, input);
		runtime?.reset();
		runtime?.seedToLeaf(ctx.sessionManager.getBranch());
		ctx.ui.notify(`Saved project advisor instructions. (${path})`, "info");
	} catch (error) {
		ctx.ui.notify(`Could not update advisor instructions: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}
function handleGlobalInstructions(ctx: ExtensionCommandContext, tail: string[]): Promise<void> | void {
	const [sub, ...rest] = tail;
	const subAction = sub?.toLowerCase() || "show";
	const path = getGlobalInstructionsPath();
	try {
		if (subAction === "show") {
			const current = readGlobalInstructions();
			ctx.ui.notify(current ? `Global advisor instructions:\n\n${current}\n\n${path}` : `No global advisor instructions set.\n${path}`, "info");
			return;
		}
		if (subAction === "clear" || subAction === "remove" || subAction === "reset") {
			const existed = clearGlobalInstructions();
			runtime?.reset();
			runtime?.seedToLeaf(ctx.sessionManager.getBranch());
			ctx.ui.notify(existed ? `Cleared global advisor instructions. (${path})` : `No global advisor instructions to clear. (${path})`, "info");
			return;
		}
		if (subAction === "set" || subAction === "add") {
			const text = rest.join(" ").trim();
			if (!text) {
				ctx.ui.notify("Usage: /advisor instructions global set <text>", "warning");
				return;
			}
			writeGlobalInstructions(text);
			runtime?.reset();
			runtime?.seedToLeaf(ctx.sessionManager.getBranch());
			ctx.ui.notify(`Saved global advisor instructions. (${path})`, "info");
			return;
		}
		if (subAction === "edit") {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive editing is unavailable. Use /advisor instructions global set <text>.", "error");
				return;
			}
			return (async () => {
				const current = readGlobalInstructions();
				const edited = await ctx.ui.editor("Global advisor instructions (submit empty to clear)", current);
				if (edited === undefined) {
					ctx.ui.notify("Global advisor instructions unchanged.", "info");
					return;
				}
				const normalized = edited.trim();
				writeGlobalInstructions(normalized);
				runtime?.reset();
				runtime?.seedToLeaf(ctx.sessionManager.getBranch());
				ctx.ui.notify(normalized ? `Saved global advisor instructions. (${path})` : `Cleared global advisor instructions. (${path})`, "info");
			})();
		}
		ctx.ui.notify(`Unknown action: "${subAction}". Use show, set <text>, edit, or clear.`, "warning");
	} catch (error) {
		ctx.ui.notify(`Could not update global advisor instructions: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function handleInstructionsMode(ctx: ExtensionCommandContext, arg: string): void {
	const mode = arg.trim().toLowerCase();
	if (!mode) {
		const gpath = getGlobalInstructionsPath();
		const ppath = getProjectInstructionsPath(ctx.cwd);
		ctx.ui.notify(
			[
				`Instructions mode: ${config.instructionsMode}`,
				`  project → per-repo file: ${ppath}`,
				`  global  → per-user file: ${gpath}${hasGlobalInstructions() ? " (set)" : " (not set)"}`,
				`  none    → no instructions`,
				"Usage: /advisor instructions mode <project|global|none>",
			].join("\n"),
			"info",
		);
		return;
	}
	if (mode !== "project" && mode !== "global" && mode !== "none") {
		ctx.ui.notify(`Unknown mode: "${mode}". Use project, global, or none.`, "error");
		return;
	}
	if (mode === "global" && !hasGlobalInstructions()) {
		ctx.ui.notify(`No global instructions are set. Save some with /advisor instructions global set <text> first, or it will be silent.`, "warning");
	}
	updateConfig(ctx, (c) => ({ ...c, instructionsMode: mode }), `Instructions mode set to ${mode}.`);
}

/** Toggle-menu for review triggers (multi-select). A fuzzy-searchable,
 *  scrollable TUI (built on pi-tui): up/down to move, tab to toggle a row,
 *  enter/ctrl+s to save, esc to cancel. Persisted to the global config.
 *  Capture always runs on turn_end; these only gate scheduling. */
async function handleTriggers(ctx: ExtensionCommandContext, _rest: string): Promise<void> {
	if (!ctx.hasUI) {
		const list = ADVISOR_TRIGGERS.map((t) => `[${config.triggers.includes(t) ? "x" : " "}] ${t} — ${ADVISOR_TRIGGER_LABELS[t]}`);
		ctx.ui.notify(`Triggers (interactive menu needs a TTY):\n${list.join("\n")}\nUse /advisor triggers <name> to toggle a single trigger.`, "info");
		return;
	}

	// Single-trigger shorthand: /advisor triggers <name>
	const rest = _rest.trim().toLowerCase() as AdvisorTrigger;
	if (rest) {
		if (!ADVISOR_TRIGGERS.includes(rest)) {
			ctx.ui.notify(`Unknown trigger: "${_rest}". Options: ${ADVISOR_TRIGGERS.join(", ")}.`, "error");
			return;
		}
		const has = config.triggers.includes(rest);
		const next = has ? config.triggers.filter((x) => x !== rest) : [...config.triggers, rest];
		if (next.length === 0) {
			ctx.ui.notify("At least one trigger must stay enabled.", "warning");
			return;
		}
		// Lightweight write: no buffer reset — the runtime reads config.triggers
		// live via #has(), so the change takes effect on the next event.
		config.triggers = next;
		writeConfig(config);
		ctx.ui.notify(`Trigger "${rest}" ${next.includes(rest) ? "enabled" : "disabled"}. Active: ${next.join(", ")}.`, "info");
		return;
	}

	const result = await ctx.ui.custom<TriggersSelectorResult>(
		(
			_tui: TUI,
			theme: Theme,
			_kb: KeybindingsManager,
			done: (result: TriggersSelectorResult) => void,
		) => {
			return new TriggersSelectorComponent(theme, config.triggers, done);
		},
	);
	if (result.cancelled) {
		ctx.ui.notify("Triggers unchanged.", "info");
		return;
	}
	// The component guarantees ≥1; write live (no reset, runtime reads it live).
	config.triggers = result.triggers;
	writeConfig(config);
	ctx.ui.notify(`Triggers: ${result.triggers.join(", ")}.`, "info");
}
function handleThinking(ctx: ExtensionCommandContext, rest: string): void {
	const arg = rest.trim().toLowerCase();
	if (!arg) {
		ctx.ui.notify(
			`Thinking: ${config.thinking ? `on (${config.thinkingLevel})` : "off"}.\n` +
				`Usage: /advisor thinking <off|minimal|low|medium|high|xhigh>`,
			"info",
		);
		return;
	}
	if (arg === "off") {
		updateConfig(ctx, (c) => ({ ...c, thinking: false }), "Advisor thinking off.");
		return;
	}
	const levels = ["minimal", "low", "medium", "high", "xhigh"] as const;
	if (!(levels as readonly string[]).includes(arg)) {
		ctx.ui.notify(`Unknown thinking level: "${arg}". Use off, minimal, low, medium, high, or xhigh.`, "error");
		return;
	}
	updateConfig(
		ctx,
		(c) => ({ ...c, thinking: true, thinkingLevel: arg as AdvisorConfig["thinkingLevel"] }),
		`Advisor thinking on (${arg}).`,
	);
}

/** Toggle whether ALL advice interrupts (triggers a new agent turn immediately)
 *  or only concern/blocker do (nit lands silently for next turn). Default: on. */
function handleInterrupting(ctx: ExtensionCommandContext, rest: string): void {
	const arg = rest.trim().toLowerCase();
	if (!arg) {
		// No arg = toggle.
		const next = !config.interrupting;
		updateConfig(
			ctx,
			(c) => ({ ...c, interrupting: next }),
			`Advisor interrupting ${next ? "on" : "off"}.`,
		);
		return;
	}
	if (arg === "on" || arg === "yes" || arg === "true") {
		updateConfig(ctx, (c) => ({ ...c, interrupting: true }), "Advisor interrupting on — all advice triggers a turn.");
		return;
	}
	if (arg === "off" || arg === "no" || arg === "false") {
		updateConfig(ctx, (c) => ({ ...c, interrupting: false }), "Advisor interrupting off — nit lands silently, concern/blocker still interrupt.");
		return;
	}
	ctx.ui.notify(`Usage: /advisor interrupting [on|off]. Current: ${config.interrupting ? "on" : "off"}.`, "warning");
}

/** Configure the rolling transcript window. Accepts raw chars or k suffix. */
function handleContext(ctx: ExtensionCommandContext, rest: string): void {
	const arg = rest.trim().toLowerCase();
	if (!arg) {
		ctx.ui.notify(
			`Advisor context: ${config.contextChars.toLocaleString()} characters (~${Math.round(config.contextChars / 4).toLocaleString()} tokens).\n` +
				`Recommended/default: ${RECOMMENDED_CONTEXT_CHARS.toLocaleString()} characters.\n` +
				`Usage: /advisor context <chars|Nk|default>  (range ${MIN_CONTEXT_CHARS.toLocaleString()}-${MAX_CONTEXT_CHARS.toLocaleString()})`,
			"info",
		);
		return;
	}

	const chars = parseAdvisorContextSize(arg);
	if (chars === null) {
		ctx.ui.notify(
			`Context size must be between ${MIN_CONTEXT_CHARS.toLocaleString()} and ${MAX_CONTEXT_CHARS.toLocaleString()} characters.`,
			"error",
		);
		return;
	}

	updateConfig(
		ctx,
		(c) => ({ ...c, contextChars: chars }),
		`Advisor context set to ${chars.toLocaleString()} characters (~${Math.round(chars / 4).toLocaleString()} tokens).`,
	);
}

/** Set how far the advisor may fall behind (in turns) before the main agent
 *  WAITS for it at the `turn_start` boundary. 0 = never wait (default, advisor
 *  reviews fully in the background); 1 = wait after every turn (synchronous);
 *  2..6 = allow a bounded backlog. Clamped to 0..6. */
function handleSync(ctx: ExtensionCommandContext, rest: string): void {
	const arg = rest.trim().toLowerCase();
	if (!arg) {
		ctx.ui.notify(
			`Sync lag: ${config.syncLag} turn(s).\n` +
				`Usage: /advisor sync <0-6>  (0 = never wait, 1 = after every turn, 2-6 = bounded backlog)`,
			"info",
		);
		return;
	}
	const n = Number(arg);
	if (!Number.isFinite(n) || n < 0 || n > 6 || !Number.isInteger(n)) {
		ctx.ui.notify(`Invalid sync lag: "${arg}". Use an integer 0-6 (0 = off).`, "error");
		return;
	}
	updateConfig(
		ctx,
		(c) => ({ ...c, syncLag: n }),
		n === 0
			? `Advisor sync off — advisor reviews in the background.`
			: `Advisor sync on — main agent waits when the advisor falls ${n} turn(s) behind.`,
	);
}

/** Interactive model picker. A fuzzy-searchable, scrollable TUI (built on
 *  pi-tui) listing every available model — reasoning-capable + current ones
 *  float to the top, the current model is marked ✓, and a leading "None"
 *  row clears the advisor. Replaces the old flat ctx.ui.select list that was
 *  too long to scan. */
async function showPicker(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/advisor requires interactive mode.", "error");
		return;
	}

	const models = ctx.modelRegistry.getAvailable();
	if (models.length === 0) {
		ctx.ui.notify("No models available. Configure a provider/API key first.", "warning");
		return;
	}

	const current = config.advisorModel;
	const result = await ctx.ui.custom<ModelSelectorResult>(
		(
			_tui: TUI,
			theme: Theme,
			_kb: KeybindingsManager,
			done: (result: ModelSelectorResult) => void,
		) => {
			return new AdvisorModelSelectorComponent(theme, models, current, done);
		},
	);

	if (result.cancelled) {
		ctx.ui.notify("Advisor picker cancelled.", "info");
		return;
	}
	if (result.ref === null) {
		// "None" row: disable without erasing the stored ref, so toggling back is cheap.
		updateConfig(ctx, (c) => ({ ...c, enabled: false }), "Advisor disabled.");
		return;
	}
	const parsed = parseModelRef(result.ref);
	if (!parsed) {
		ctx.ui.notify(`Could not parse selection: "${result.ref}".`, "error");
		return;
	}
	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!model) {
		ctx.ui.notify(`Model not found: ${result.ref}.`, "error");
		return;
	}
	const finalRef = formatModelRef(parsed.provider, parsed.id);
	updateConfig(ctx, (c) => ({ ...c, advisorModel: finalRef, enabled: true }), `Advisor model set to ${finalRef}.`);
}

function showStatus(ctx: ExtensionCommandContext): void {
	const lines: string[] = [];
	lines.push(`Advisor: ${config.enabled ? "enabled" : "disabled"}`);
	lines.push(`Advisor model: ${config.advisorModel ?? "(none — pick one with /advisor)"}`);
	lines.push(`Thinking: ${config.thinking ? `on (${config.thinkingLevel})` : "off"}`);
	lines.push(`Triggers: ${config.triggers.join(", ")}`);
	const projectTrusted = ctx.isProjectTrusted();
	const instructions = projectInstructions(ctx.cwd, projectTrusted);
	lines.push(`Instructions mode: ${config.instructionsMode}`);
	lines.push(`Project instructions: ${projectTrusted ? (instructions ? `active (${instructions.length} chars)` : "none") : "ignored (project not trusted)"} (${getProjectInstructionsPath(ctx.cwd)})`);
	lines.push(`Global instructions: ${hasGlobalInstructions() ? `set (${readGlobalInstructions().length} chars)` : "not set"} (${getGlobalInstructionsPath()})`);
	lines.push(`Context window: ~${config.contextChars.toLocaleString()} chars (~${Math.round(config.contextChars / 4).toLocaleString()} tokens) · max ${config.maxToolRounds} tool rounds${config.cooldownMs > 0 ? ` · cooldown ${config.cooldownMs}ms` : ""}`);
	lines.push(`Delivery: ${config.interrupting ? "ALL advice interrupts" : "nit → non-interrupting, concern/blocker → interrupting"} (steer${config.interrupting ? " + triggerTurn" : " + triggerTurn for concern/blocker"})`);

	// Sync lag: show the setting, the live backlog (if the runtime has started),
	// and a one-line recommendation so the value is actionable at a glance.
	// Rationale: sync=0 (fire-and-forget) is the recommended default — the
	// advisor's interrupting advice already pulls the agent on urgent notes, and
	// waiting every turn doubles wall-clock when the advisor is a slow / strong
	// model. sync=2 is the sweet spot for long unattended runs (catches a wrong
	// direction before the next step); sync=1 only pays off with a fast advisor.
	const syncHint = config.syncLag === 0
		? "off — advisor reviews in background (default; recommended unless on a long run)"
		: config.syncLag === 1
			? "on — waits after every turn (fully sync; only worth it with a fast advisor model)"
			: `on — pauses when ≥ ${config.syncLag} turns behind (good for long unattended runs; try 2)`;
	lines.push(`Sync lag: ${syncHint}`);
	if (runtime) {
		lines.push(`  backlog now: ${runtime.lag} turn(s)${runtime.isBusy ? " (review in flight)" : ""}`);
	}
	lines.push(
		`Cache retention: ${config.cacheRetention ?? "short (pi-ai default)"}` +
			(config.cacheRetention === "long" ? " — 1h TTL where supported (good for sparse review cadences)" : ""),
	);

	const active = config.enabled && !!config.advisorModel;
	lines.push(`Active: ${active ? "yes" : "no"}`);

	const rt = runtime;
	if (rt) {
		lines.push(`Busy: ${rt.isBusy ? "yes (reviewing)" : "no"}`);
		lines.push(summarizeResult(rt.lastResult));
		// Token usage of the last completed review round, with the cache split —
		// makes prompt-cache effectiveness visible at a glance (cache-read high =
		// the append-only conversation prefix is hitting).
		const usage = rt.lastUsage;
		if (usage) {
			const fmt = (n: number) => n.toLocaleString();
			const cache = usage.cacheRead > 0 || usage.cacheWrite > 0
				? ` · cache ${fmt(usage.cacheRead)} read / ${fmt(usage.cacheWrite)} write`
					: " · cache 0 (provider did not report prompt caching)";
			lines.push(`Last review usage: ${fmt(usage.input)} in${cache} · ${fmt(usage.output)} out tokens`);
		}
		// Session-wide aggregate: the cache-hit rate across every review round is
		// the number that actually reflects the append-only prefix design.
		const totals = rt.usageTotals;
		if (totals.reviews > 0) {
			const fmt = (n: number) => n.toLocaleString();
			const hitRate = totals.input > 0 ? Math.round((totals.cacheRead / totals.input) * 100) : 0;
			lines.push(
				`Session totals: ${totals.reviews} review round(s) · ${fmt(totals.input)} in ` +
				`(${fmt(totals.cacheRead)} from cache · ${hitRate}% hit) · ${fmt(totals.output)} out tokens`,
			);
		}
	} else {
		lines.push("Runtime: not started yet (no turn reviewed)");
	}

	ctx.ui.notify(lines.join("\n"), "info");
}
