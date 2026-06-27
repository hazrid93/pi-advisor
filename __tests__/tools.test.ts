/**
 * Unit tests for the advisor's read-only toolset (src/tools.ts).
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	advisorTools,
	executeAdvisorTool,
	resolveAdvisorReasoning,
	resolveReadonlyPath,
} from "../src/tools.js";
import { fakeModel } from "./helpers.js";

let dirs: string[] = [];
function tmpProject(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-advisor-test-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

describe("advisorTools", () => {
	it("exposes exactly read, grep, find, advise", () => {
		const names = advisorTools().map((t) => t.name).sort();
		expect(names).toEqual(["advise", "find", "grep", "read"]);
	});
});

describe("resolveReadonlyPath", () => {
	it("resolves a relative path against cwd", () => {
		const cwd = tmpProject();
		writeFileSync(join(cwd, "a.txt"), "x");
		expect(resolveReadonlyPath("a.txt", cwd)).toBe(join(cwd, "a.txt"));
	});
	it("accepts an absolute path inside cwd", () => {
		const cwd = tmpProject();
		expect(resolveReadonlyPath(join(cwd, "sub", "b.txt"), cwd)).toBe(join(cwd, "sub", "b.txt"));
	});
	it("rejects a path that escapes the project root via ..", () => {
		const cwd = tmpProject();
		expect(() => resolveReadonlyPath("../../etc/passwd", cwd)).toThrow(/escapes the project root/);
	});
});

describe("executeAdvisorTool: read", () => {
	it("reads file contents", async () => {
		const cwd = tmpProject();
		writeFileSync(join(cwd, "foo.txt"), "line1\nline2\nline3\n");
		const r = await executeAdvisorTool("read", { path: "foo.txt" }, cwd);
		expect(r.isError).toBeFalsy();
		expect(r.content).toContain("line1");
		expect(r.content).toContain("line2");
		expect(r.content).toContain("line3");
	});

	it("honors offset + limit", async () => {
		const cwd = tmpProject();
		writeFileSync(join(cwd, "n.txt"), "a\nb\nc\nd\ne\n");
		const r = await executeAdvisorTool("read", { path: "n.txt", offset: 2, limit: 2 }, cwd);
		expect(r.content).toContain("b");
		expect(r.content).toContain("c");
		expect(r.content).not.toContain("a\n");
		// d should be excluded by the limit (only offset..offset+limit-1).
		expect(r.content).not.toMatch(/^d$/m);
	});

	it("errors on a missing path", async () => {
		const cwd = tmpProject();
		const r = await executeAdvisorTool("read", { path: "nope.txt" }, cwd);
		expect(r.isError).toBe(true);
		expect(r.content).toContain("read failed");
	});

	it("errors when path is missing", async () => {
		const cwd = tmpProject();
		const r = await executeAdvisorTool("read", {}, cwd);
		expect(r.isError).toBe(true);
	});

	it("bails on a binary file instead of decoding it as utf8 (G6b)", async () => {
		const cwd = tmpProject();
		// A GIF header + binary payload — must not be split as text.
		const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...new Array(2000).fill(0)]);
		writeFileSync(join(cwd, "img.gif"), buf);
		const r = await executeAdvisorTool("read", { path: "img.gif" }, cwd);
		expect(r.isError).toBe(true);
		expect(r.content).toContain("binary");
	});
});

describe("executeAdvisorTool: find", () => {
	it("finds files by extension glob", async () => {
		const cwd = tmpProject();
		writeFileSync(join(cwd, "a.ts"), "");
		writeFileSync(join(cwd, "b.ts"), "");
		writeFileSync(join(cwd, "c.md"), "");
		mkdirSync(join(cwd, "node_modules"));
		writeFileSync(join(cwd, "node_modules", "skip.ts"), "");
		const r = await executeAdvisorTool("find", { pattern: "*.ts" }, cwd);
		expect(r.isError).toBeFalsy();
		expect(r.content).toContain("a.ts");
		expect(r.content).toContain("b.ts");
		expect(r.content).not.toContain("skip.ts"); // node_modules skipped
		expect(r.content).not.toContain("c.md");
	});
});

describe("executeAdvisorTool: grep", () => {
	it("finds literal matches with file:line prefixes", async () => {
		const cwd = tmpProject();
		writeFileSync(join(cwd, "a.txt"), "hello world\nsecond line\n");
		writeFileSync(join(cwd, "b.txt"), "no match here\n");
		const r = await executeAdvisorTool("grep", { pattern: "world", literal: true }, cwd);
		expect(r.isError).toBeFalsy();
		expect(r.content).toContain("a.txt:1");
		expect(r.content).toContain("hello world");
		expect(r.content).not.toContain("b.txt");
	});

	it("supports case-insensitive regex", async () => {
		const cwd = tmpProject();
		writeFileSync(join(cwd, "a.txt"), "Hello\nHELLO\nworld\n");
		const r = await executeAdvisorTool("grep", { pattern: "hello", caseInsensitive: true }, cwd);
		// Should match both Hello and HELLO.
		const lines = r.content.split("\n");
		const matches = lines.filter((l) => l.includes("Hello") || l.includes("HELLO"));
		expect(matches.length).toBeGreaterThanOrEqual(2);
	});

	it("reports no matches cleanly", async () => {
		const cwd = tmpProject();
		writeFileSync(join(cwd, "a.txt"), "nothing here\n");
		const r = await executeAdvisorTool("grep", { pattern: "zzz", literal: true }, cwd);
		expect(r.content).toBe("No matches.");
	});
});

describe("executeAdvisorTool: advise", () => {
	it("captures a note + severity", async () => {
		const r = await executeAdvisorTool("advise", { note: "be careful", severity: "concern" }, "/tmp");
		expect(r.isError).toBeFalsy();
		expect(r.advise).toEqual({ note: "be careful", severity: "concern" });
		expect(r.content).toBe("Recorded.");
	});

	it("defaults severity to undefined when omitted", async () => {
		const r = await executeAdvisorTool("advise", { note: "tiny nit" }, "/tmp");
		expect(r.advise).toEqual({ note: "tiny nit", severity: undefined });
	});

	it("rejects an empty note", async () => {
		const r = await executeAdvisorTool("advise", { note: "   " }, "/tmp");
		expect(r.isError).toBe(true);
		expect(r.advise).toBeUndefined();
	});
});

describe("executeAdvisorTool: unknown tool", () => {
	it("errors on an unrecognized tool name", async () => {
		const r = await executeAdvisorTool("bogus", {}, "/tmp");
		expect(r.isError).toBe(true);
		expect(r.content).toContain("Unknown tool");
	});
});

describe("resolveAdvisorReasoning", () => {
	it("returns undefined when thinking is off", () => {
		expect(resolveAdvisorReasoning(fakeModel({ reasoning: true }), false, "high")).toBeUndefined();
	});
	it("returns undefined when the model can't reason", () => {
		expect(resolveAdvisorReasoning(fakeModel({ reasoning: false }), true, "high")).toBeUndefined();
	});
	it("returns the level when both thinking is on and the model supports it", () => {
		expect(resolveAdvisorReasoning(fakeModel({ reasoning: true }), true, "medium")).toBe("medium");
	});
});
