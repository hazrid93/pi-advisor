/**
 * Guards the pi-ai usage-shape invariant that /advisor status relies on:
 * providers normalize `usage.input` to UNCACHED tokens only
 * (input = prompt_tokens − cacheRead − cacheWrite), with cacheRead and
 * cacheWrite reported as separate buckets.
 *
 * If a future pi-ai release ever makes `input` raw again (or drops the
 * subtraction), this test fails loudly instead of letting the status line
 * silently report inflated/wrong cache-hit rates. It exercises the REAL
 * provider mapping code — openai-completions' parseChunkUsage — with a
 * synthetic usage payload shaped exactly like OpenAI/Kimi-via-LiteLLM
 * responses (prompt_tokens + prompt_tokens_details.cached_tokens).
 *
 * The function is module-internal (and calls calculateCost), so we read the
 * installed source and evaluate just the mapping block in isolation with a
 * stubbed cost calculator — no model/network involved.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

type RawUsage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	completion_tokens_details?: { reasoning_tokens?: number };
	prompt_cache_hit_tokens?: number;
	cached_tokens?: number;
};

function loadParseChunkUsage(): (rawUsage: RawUsage) => {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
} {
	// The package is ESM-only (exports has import+types, no require), so
	// require.resolve("@earendil-works/pi-ai") throws. Resolving the sibling
	// pi-agent-core's package.json works (no exports map there), then we step
	// over to pi-ai's directory.
	const agentCorePkg = require.resolve("@earendil-works/pi-agent-core/package.json");
	const piAiRoot = join(dirname(dirname(agentCorePkg)), "pi-ai");
	const source = readFileSync(join(piAiRoot, "dist", "api", "openai-completions.js"), "utf8");
	const start = source.indexOf("function parseChunkUsage(");
	if (start < 0) throw new Error("parseChunkUsage not found in openai-completions.js — pi-ai internals changed");
	const end = source.indexOf("\n}\n", start);
	if (end < 0) throw new Error("parseChunkUsage end not found");
	const fnSource = source.slice(start, end + 3);
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	const parseChunkUsage = new Function("calculateCost", `${fnSource}; return (rawUsage) => parseChunkUsage(rawUsage, null);`)(
		() => {}, // stub: cost math is irrelevant to the invariant
	) as ReturnType<typeof loadParseChunkUsage>;
	return parseChunkUsage;
}

describe("pi-ai usage shape invariant (openai-completions parseChunkUsage)", () => {
	it("input is uncached-only: prompt_tokens − cacheRead − cacheWrite", () => {
		const parseChunkUsage = loadParseChunkUsage();
		// Shaped like a real Kimi/OpenAI-via-LiteLLM warm-cache response:
		// 2000 prompt tokens, 1600 served from cache, 200 written, 200 fresh.
		const usage = parseChunkUsage({
			prompt_tokens: 2000,
			completion_tokens: 100,
			prompt_tokens_details: { cached_tokens: 1600, cache_write_tokens: 200 },
		});
		expect(usage.cacheRead).toBe(1600);
		expect(usage.cacheWrite).toBe(200);
		expect(usage.input).toBe(200); // ← the invariant: NOT 2000
		expect(usage.totalTokens).toBe(usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
	});

	it("cold-cache responses put everything in input", () => {
		const parseChunkUsage = loadParseChunkUsage();
		const usage = parseChunkUsage({
			prompt_tokens: 1000,
			completion_tokens: 30,
			prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
		});
		expect(usage.input).toBe(1000);
		expect(usage.cacheRead).toBe(0);
	});
});
