/**
 * Unit tests for config + <advisory> framing (src/index.ts).
 */

import { describe, expect, it } from "vitest";
import {
	ADVISOR_CUSTOM_TYPE,
	formatAdvisorBatchContent,
	isInterruptingSeverity,
	normalizeConfig,
	parseAdvisorContextSize,
	parseAdvisorCooldownMs,
	parseModelRef,
	formatModelRef,
	DEFAULT_CONFIG,
	DEFAULT_TRIGGERS,
	DEFAULT_MID_PAUSE_MS,
	MIN_MID_PAUSE_MS,
	MAX_MID_PAUSE_MS,
	escapeXmlText,
	MAX_CONTEXT_CHARS,
	MIN_CONTEXT_CHARS,
	RECOMMENDED_CONTEXT_CHARS,
	type AdvisorTrigger,
} from "../src/index.js";

describe("parseModelRef / formatModelRef", () => {
	it("parses a provider/id", () => {
		expect(parseModelRef("anthropic/claude-sonnet-4-5")).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-4-5",
		});
	});

	it("rejects malformed refs", () => {
		expect(parseModelRef("")).toBeNull();
		expect(parseModelRef("noseparator")).toBeNull();
		expect(parseModelRef("/leadingslash")).toBeNull();
		expect(parseModelRef("trailingslash/")).toBeNull();
	});

	it("round-trips via formatModelRef", () => {
		expect(formatModelRef("anthropic", "claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5");
	});
});

describe("normalizeConfig", () => {
	it("returns defaults for a non-object", () => {
		expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
		expect(normalizeConfig("oops")).toEqual(DEFAULT_CONFIG);
	});

	it("drops an invalid advisorModel (keeps it null)", () => {
		const c = normalizeConfig({ advisorModel: "no-slash" });
		expect(c.advisorModel).toBeNull();
	});

	it("keeps a valid advisorModel", () => {
		const c = normalizeConfig({ advisorModel: "openai/gpt-4o" });
		expect(c.advisorModel).toBe("openai/gpt-4o");
	});

	it("clamps bad numerics to defaults", () => {
		const c = normalizeConfig({ contextEntries: -5, maxToolRounds: "nope" as unknown as number });
		// contextEntries is no longer on the interface (replaced by contextChars);
		// an old -5 is silently swallowed and doesn't perturb contextChars.
		expect(c.contextChars).toBe(DEFAULT_CONFIG.contextChars);
		expect(c.maxToolRounds).toBe(DEFAULT_CONFIG.maxToolRounds);
	});

	it("accepts valid thinking levels", () => {
		const c = normalizeConfig({ thinking: true, thinkingLevel: "high" });
		expect(c.thinking).toBe(true);
		expect(c.thinkingLevel).toBe("high");
	});

	it("interrupting defaults to true (all advice interrupts)", () => {
		expect(DEFAULT_CONFIG.interrupting).toBe(true);
		expect(normalizeConfig(null).interrupting).toBe(true);
	});

	it("respects an explicit interrupting: false", () => {
		const c = normalizeConfig({ interrupting: false });
		expect(c.interrupting).toBe(false);
	});

	it("ignores a non-boolean interrupting value", () => {
		const c = normalizeConfig({ interrupting: "yes" as unknown as boolean });
		expect(c.interrupting).toBe(true); // stays at default
	});
});

describe("advisor context size", () => {
	it("defaults to the recommended 24k character window", () => {
		expect(RECOMMENDED_CONTEXT_CHARS).toBe(24_000);
		expect(DEFAULT_CONFIG.contextChars).toBe(RECOMMENDED_CONTEXT_CHARS);
	});

	it("parses raw characters, k suffixes, and the default alias", () => {
		expect(parseAdvisorContextSize("24000")).toBe(24_000);
		expect(parseAdvisorContextSize("24k")).toBe(24_000);
		expect(parseAdvisorContextSize("24 KB")).toBe(24_000);
		expect(parseAdvisorContextSize("default")).toBe(RECOMMENDED_CONTEXT_CHARS);
		expect(parseAdvisorContextSize("recommended")).toBe(RECOMMENDED_CONTEXT_CHARS);
	});

	it("rejects malformed and out-of-range command values", () => {
		expect(parseAdvisorContextSize("large")).toBeNull();
		expect(parseAdvisorContextSize(String(MIN_CONTEXT_CHARS - 1))).toBeNull();
		expect(parseAdvisorContextSize(String(MAX_CONTEXT_CHARS + 1))).toBeNull();
	});

	it("clamps directly edited config values to safe bounds", () => {
		expect(normalizeConfig({ contextChars: 1 }).contextChars).toBe(MIN_CONTEXT_CHARS);
		expect(normalizeConfig({ contextChars: 999_999 }).contextChars).toBe(MAX_CONTEXT_CHARS);
		expect(normalizeConfig({ contextChars: 50_000.9 }).contextChars).toBe(50_000);
	});
});
describe("syncLag", () => {
	it("defaults to 0 (off — advisor reviews in the background)", () => {
		expect(DEFAULT_CONFIG.syncLag).toBe(0);
		expect(normalizeConfig(null).syncLag).toBe(0);
	});

	it("accepts a valid value 0-6", () => {
		expect(normalizeConfig({ syncLag: 0 }).syncLag).toBe(0);
		expect(normalizeConfig({ syncLag: 1 }).syncLag).toBe(1);
		expect(normalizeConfig({ syncLag: 6 }).syncLag).toBe(6);
	});

	it("clamps values above 6 down to 6", () => {
		expect(normalizeConfig({ syncLag: 99 }).syncLag).toBe(6);
	});

	it("clamps negative values up to 0", () => {
		expect(normalizeConfig({ syncLag: -3 }).syncLag).toBe(0);
	});

	it("floors fractional values", () => {
		expect(normalizeConfig({ syncLag: 2.7 }).syncLag).toBe(2);
	});

	it("ignores a non-number syncLag (stays at default)", () => {
		expect(normalizeConfig({ syncLag: "high" as unknown as number }).syncLag).toBe(0);
		expect(normalizeConfig({ syncLag: NaN }).syncLag).toBe(0);
	});
});

describe("isInterruptingSeverity", () => {
	it("nit is non-interrupting", () => {
		expect(isInterruptingSeverity("nit")).toBe(false);
		expect(isInterruptingSeverity(undefined)).toBe(false);
	});
	it("concern and blocker are interrupting", () => {
		expect(isInterruptingSeverity("concern")).toBe(true);
		expect(isInterruptingSeverity("blocker")).toBe(true);
	});
});

describe("formatAdvisorBatchContent", () => {
	it("renders one <advisory> per note with severity + guidance framing", () => {
		const out = formatAdvisorBatchContent([{ note: "watch the queue", severity: "concern" }]);
		expect(out).toContain('<advisory severity="concern"');
		expect(out).toContain('guidance="weigh, don\'t blindly obey"');
		expect(out).toContain("watch the queue");
	});

	it("omits the severity attribute for a plain nit", () => {
		const out = formatAdvisorBatchContent([{ note: "tiny nit" }]);
		expect(out).toContain("<advisory ");
		expect(out).not.toContain("severity=");
	});

	it("XML-escapes note bodies so they can't break the wrapper", () => {
		const out = formatAdvisorBatchContent([{ note: "use <script> & don't break out </advisory>" }]);
		// The raw closing tag must not appear unescaped inside the body.
		expect(out).not.toContain("script>");
		expect(out).toContain("&lt;");
		expect(out).toContain("&amp;");
		// There must be exactly one real closing </advisory> (the wrapper's).
		expect(out.split("</advisory>").length - 1).toBe(1);
	});
});

describe("escapeXmlText", () => {
	it("escapes the three significant chars", () => {
		expect(escapeXmlText("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
	});
});

it("ADVISOR_CUSTOM_TYPE is the stable customType string", () => {
	expect(ADVISOR_CUSTOM_TYPE).toBe("advisor");
});

describe("triggers", () => {
	it("defaults to [turn_end, tool_error]", () => {
		expect(DEFAULT_CONFIG.triggers).toEqual(["turn_end", "tool_error"]);
		expect(DEFAULT_TRIGGERS).toEqual(["turn_end", "tool_error"]);
		expect(normalizeConfig(null).triggers).toEqual(["turn_end", "tool_error"]);
	});

	it("preserves a non-default trigger set through normalizeConfig (round-trip)", () => {
		// A globally-saved menu selection must survive a reload, not revert to defaults.
		const custom: AdvisorTrigger[] = ["agent_settled", "mid_pause"];
		const c = normalizeConfig({ triggers: custom });
		expect(c.triggers).toEqual(["agent_settled", "mid_pause"]);
		// And survives a second normalization (simulating read -> write -> read).
		expect(normalizeConfig({ triggers: c.triggers }).triggers).toEqual(custom);
	});

	it("drops unknown trigger entries and de-duplicates", () => {
		const c = normalizeConfig({ triggers: ["turn_end", "bogus", "turn_end", "agent_settled"] });
		expect(c.triggers).toEqual(["turn_end", "agent_settled"]);
	});

	it("falls back to defaults when the array is empty or all-invalid", () => {
		expect(normalizeConfig({ triggers: [] }).triggers).toEqual(["turn_end", "tool_error"]);
		expect(normalizeConfig({ triggers: ["nope"] }).triggers).toEqual(["turn_end", "tool_error"]);
	});

	it("does NOT fall back when an old config file omits the field entirely", () => {
		// An old config (pre-triggers) normalized must still get a valid set.
		expect(normalizeConfig({ enabled: true }).triggers).toEqual(["turn_end", "tool_error"]);
	});
});

describe("midPauseMs", () => {
	it("defaults to the recommended quiet period", () => {
		expect(DEFAULT_CONFIG.midPauseMs).toBe(DEFAULT_MID_PAUSE_MS);
		expect(normalizeConfig(null).midPauseMs).toBe(DEFAULT_MID_PAUSE_MS);
	});

	it("preserves a valid value", () => {
		expect(normalizeConfig({ midPauseMs: 7000 }).midPauseMs).toBe(7000);
	});

	it("clamps out-of-range values to safe bounds", () => {
		expect(normalizeConfig({ midPauseMs: 1 }).midPauseMs).toBe(MIN_MID_PAUSE_MS);
		expect(normalizeConfig({ midPauseMs: 999_999 }).midPauseMs).toBe(MAX_MID_PAUSE_MS);
	});

	it("ignores a non-number (stays at default)", () => {
		expect(normalizeConfig({ midPauseMs: "slow" as unknown as number }).midPauseMs).toBe(DEFAULT_MID_PAUSE_MS);
		expect(normalizeConfig({ midPauseMs: NaN }).midPauseMs).toBe(DEFAULT_MID_PAUSE_MS);
	});
});

describe("instructionsMode", () => {
	it("defaults to project (opt-out of global)", () => {
		expect(DEFAULT_CONFIG.instructionsMode).toBe("project");
		expect(normalizeConfig(null).instructionsMode).toBe("project");
	});

	it("preserves an explicit global/none selection through normalizeConfig", () => {
		expect(normalizeConfig({ instructionsMode: "global" }).instructionsMode).toBe("global");
		expect(normalizeConfig({ instructionsMode: "none" }).instructionsMode).toBe("none");
		expect(normalizeConfig({ instructionsMode: "project" }).instructionsMode).toBe("project");
	});

	it("falls back to project for unknown/absent values", () => {
		expect(normalizeConfig({ instructionsMode: "bogus" as unknown as "project" }).instructionsMode).toBe("project");
		expect(normalizeConfig({ enabled: true }).instructionsMode).toBe("project");
	});
});

describe("cacheRetention", () => {
	it("is unset by default (pi-ai's default / PI_CACHE_RETENTION env applies)", () => {
		expect(DEFAULT_CONFIG.cacheRetention).toBeUndefined();
		expect(normalizeConfig(null).cacheRetention).toBeUndefined();
		expect(normalizeConfig({ enabled: true }).cacheRetention).toBeUndefined();
	});

	it("honors valid values", () => {
		expect(normalizeConfig({ cacheRetention: "short" }).cacheRetention).toBe("short");
		expect(normalizeConfig({ cacheRetention: "long" }).cacheRetention).toBe("long");
		expect(normalizeConfig({ cacheRetention: "none" }).cacheRetention).toBe("none");
	});

	it("ignores unknown values (leaves the default in place)", () => {
		expect(normalizeConfig({ cacheRetention: "forever" as unknown as "long" }).cacheRetention).toBeUndefined();
		expect(normalizeConfig({ cacheRetention: 5 as unknown as "long" }).cacheRetention).toBeUndefined();
	});
});

describe("parseAdvisorCooldownMs", () => {
	it("parses milliseconds, seconds, and minutes", () => {
		expect(parseAdvisorCooldownMs("30000")).toBe(30_000);
		expect(parseAdvisorCooldownMs("500ms")).toBe(500);
		expect(parseAdvisorCooldownMs("30s")).toBe(30_000);
		expect(parseAdvisorCooldownMs("1m")).toBe(60_000);
		expect(parseAdvisorCooldownMs("1.5m")).toBe(90_000);
	});

	it("off synonyms map to 0 (review every turn)", () => {
		expect(parseAdvisorCooldownMs("0")).toBe(0);
		expect(parseAdvisorCooldownMs("off")).toBe(0);
		expect(parseAdvisorCooldownMs("none")).toBe(0);
		expect(parseAdvisorCooldownMs("default")).toBe(0);
	});

	it("rejects invalid or out-of-range values", () => {
		expect(parseAdvisorCooldownMs("soon")).toBeNull();
		expect(parseAdvisorCooldownMs("-5s")).toBeNull();
		expect(parseAdvisorCooldownMs("999m")).toBeNull(); // beyond MAX_COOLDOWN_MS
		expect(parseAdvisorCooldownMs("")).toBeNull();
	});
});
