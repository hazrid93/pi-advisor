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
	formatModelRef,
	parseModelRef,
	readConfig,
	writeConfig,
	type AdvisorConfig,
} from "./src/index.js";
import { AdvisorRuntime, makeHost, summarizeResult } from "./src/runtime.js";

let config: AdvisorConfig = readConfig();
let runtime: AdvisorRuntime | null = null;

/** The full host wiring the runtime drives: transcript access, model/auth
 *  resolution, advice delivery, and user notification. */
function buildHost(pi: ExtensionAPI, ctxForBranch: () => ExtensionContext | null) {
	return {
		...makeHost(pi, () => config.interrupting),
		getBranch: () => ctxForBranch()?.sessionManager.getBranch() ?? [],
		resolveModel: (ref: string) => {
			const parsed = parseModelRef(ref);
			if (!parsed) return undefined;
			const c = ctxForBranch();
			return c?.modelRegistry.find(parsed.provider, parsed.id);
		},
		getApiKeyAndHeaders: async (model: Model<Api>) => {
			const c = ctxForBranch();
			if (!c) return { ok: false as const, error: "no session context" };
			return c.modelRegistry.getApiKeyAndHeaders(model);
		},
		notify: (message: string, type?: "info" | "warning" | "error") => {
			ctxForBranch()?.ui.notify(`pi-advisor: ${message}`, type);
		},
	};
}

/** Lazily create the runtime on first use (turn_end or command). Created late
 *  so `ctxForBranch` can resolve a live ExtensionContext. */
function ensureRuntime(pi: ExtensionAPI, ctxForBranch: () => ExtensionContext | null): AdvisorRuntime {
	if (runtime && !runtime.disposed) return runtime;
	runtime = new AdvisorRuntime(buildHost(pi, ctxForBranch), config);
	return runtime;
}

export default function (pi: ExtensionAPI) {
	config = readConfig();

	// The most recent event context. Event handlers fire sequentially per turn,
	// so capturing the latest ctx gives the runtime a live modelRegistry /
	// sessionManager / cwd for background reviews kicked from turn_end. This is
	// rebuilt on every event; the runtime only reads it when it runs a review.
	let latestCtx: ExtensionContext | null = null;
	const ctxForBranch = () => latestCtx;

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		// Pick up config changes made from another session/window.
		const next = readConfig();
		Object.assign(config, next);
		// Re-prime and seed to the current leaf so the advisor only reviews new
		// turns going forward (oh-my-pi's mid-session seed).
		const rt = ensureRuntime(pi, ctxForBranch);
		rt.reset();
		rt.setCwd(ctx.cwd);
		rt.seedToLeaf(ctx.sessionManager.getBranch());
	});

	pi.on("turn_end", async (_event, ctx) => {
		latestCtx = ctx;
		if (!config.enabled || !config.advisorModel) return;
		const rt = ensureRuntime(pi, ctxForBranch);
		rt.setCwd(ctx.cwd);
		rt.onTurnEnd(ctx.sessionManager.getBranch());
	});

	pi.on("session_shutdown", async () => {
		runtime?.dispose();
		runtime = null;
	});

	pi.registerCommand("advisor", {
		description: ADVISOR_COMMAND_DESCRIPTION,
		getArgumentCompletions(prefix: string) {
			const subs = ["model", "status", "enable", "disable", "thinking", "interrupting", "help", "review"];
			const matches = subs.filter((s) => s.startsWith(prefix));
			return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			await handleAdvisorCommand(pi, ctx, args.trim(), ctxForBranch);
		},
	});
}

async function handleAdvisorCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	ctxForBranch: () => ExtensionContext | null,
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
				"  /advisor thinking <off|minimal|low|medium|high|xhigh>",
				"                          Set the advisor's thinking effort (off = disabled)",
				"  /advisor review        Re-review the recent transcript now",
				"  /advisor help          This message",
				"",
				"Config: ~/.pi/agent/extensions/pi-advisor.json",
				"Advice is delivered as <advisory severity=...> notes: nit (non-interrupting when",,
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
		const rt = ensureRuntime(pi, ctxForBranch);
		rt.setCwd(ctx.cwd);
		ctx.ui.notify("Reviewing recent transcript…", "info");
		const result = await rt.reviewNow(ctx.sessionManager.getBranch());
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
	}
	ctx.ui.notify(`${message} (config: ${path})`, "info");
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

/** Interactive model picker. Lists every available (auth-configured) model,
 *  reasoning-capable and currently-selected ones first. */
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
	// Sort: current first, then reasoning-capable, then by provider/id.
	const sorted = [...models].sort((a, b) => {
		const aRef = formatModelRef(a.provider, a.id);
		const bRef = formatModelRef(b.provider, b.id);
		const aCur = aRef === current ? 0 : 1;
		const bCur = bRef === current ? 0 : 1;
		if (aCur !== bCur) return aCur - bCur;
		const aReason = a.reasoning ? 0 : 1;
		const bReason = b.reasoning ? 0 : 1;
		if (aReason !== bReason) return aReason - bReason;
		return aRef.localeCompare(bRef);
	});

	const options = sorted.map((m) => {
		const ref = formatModelRef(m.provider, m.id);
		const tags: string[] = [];
		if (m.reasoning) tags.push("reasoning");
		if (ref === current) tags.push("current");
		return tags.length > 0 ? `${ref}  [${tags.join(", ")}]` : ref;
	});

	const title =
		(current ? `Advisor model (current: ${current})` : "Pick an advisor model") +
		" — Enter to select, Esc to cancel";

	const choice = await ctx.ui.select(title, options);
	if (!choice) {
		ctx.ui.notify("Advisor picker cancelled.", "info");
		return;
	}

	// The option is the ref, optionally followed by a "  [tags]" suffix.
	const ref = choice.split(/\s+\[/)[0].trim();
	const parsed = parseModelRef(ref);
	if (!parsed) {
		ctx.ui.notify(`Could not parse selection: "${choice}".`, "error");
		return;
	}
	const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!model) {
		ctx.ui.notify(`Model not found: ${ref}.`, "error");
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
	lines.push(`Context window: last ${config.contextEntries} entries · max ${config.maxToolRounds} tool rounds`);
	lines.push(`Delivery: ${config.interrupting ? "ALL advice interrupts" : "nit → non-interrupting, concern/blocker → interrupting"} (steer${config.interrupting ? " + triggerTurn" : " + triggerTurn for concern/blocker"})`);

	const active = config.enabled && !!config.advisorModel;
	lines.push(`Active: ${active ? "yes" : "no"}`);

	const rt = runtime;
	if (rt) {
		lines.push(`Busy: ${rt.isBusy ? "yes (reviewing)" : "no"}`);
		lines.push(summarizeResult(rt.lastResult));
	} else {
		lines.push("Runtime: not started yet (no turn reviewed)");
	}

	ctx.ui.notify(lines.join("\n"), "info");
}
