/**
 * The advisor's hard-isolated read-only toolset.
 *
 * oh-my-pi gives its advisor exactly `read`, `search`, `find`, and `advise`,
 * built against a *distinct* tool session so the advisor never shares the
 * primary agent's file snapshots, edit/yield, or conflict state. This extension
 * can't reach pi's internal tool session, so it re-implements the same three
 * read-only primitives against the filesystem directly (bounded + read-only by
 * construction — there is no write/edit capability here at all). The `advise`
 * tool is the only side-effect: it captures a note + severity for delivery.
 *
 * Tool definitions use pi-ai's `Tool` shape (typebox `TSchema` parameters) so
 * they can be passed straight to `complete({ tools })`.
 */

import { Type } from "@earendil-works/pi-ai";
import type { Api, Model, Tool } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AdvisorSeverity } from "./index.js";

/** Hard cap on a single `read` result (chars). Mirrors pi core's read truncation. */
const READ_MAX_CHARS = 50_000;
/** Max lines a single `read` returns when no limit is given. */
const READ_DEFAULT_LIMIT = 2000;
/** Max files `find` returns. */
const FIND_MAX_RESULTS = 200;
/** Max matches `grep` returns. */
const GREP_MAX_MATCHES = 200;
/** Max chars of a single grep match line. */
const GREP_LINE_MAX_CHARS = 500;
/** Max bytes `grep` will read from one file. */
const GREP_FILE_MAX_BYTES = 1_000_000;

/** Resolve a path argument against the advisor's cwd, refusing escapes via `..`
 *  past the cwd root. The advisor is a reviewer; it must not wander outside the
 *  project it is reviewing. */
export function resolveReadonlyPath(path: string, cwd: string): string {
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	const normalized = resolve(abs);
	const root = resolve(cwd);
	if (normalized !== root && !normalized.startsWith(root + sep)) {
		throw new Error(`Path "${path}" escapes the project root (${root}).`);
	}
	return normalized;
}

/** The `read` tool — read a text file's contents, optionally a line slice. */
export const readTool: Tool = {
	name: "read",
	description:
		"Read the contents of a text file. Supports a line offset and limit. Output is truncated to a bounded size. Paths are confined to the project root.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the file to read (relative to the project root or absolute)." }),
		offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed). Default 1." })),
		limit: Type.Optional(Type.Number({ description: `Maximum number of lines to return. Default ${READ_DEFAULT_LIMIT}.` })),
	}),
};

/** The `grep` tool — search file contents for a pattern (regex or literal). */
export const grepTool: Tool = {
	name: "grep",
	description:
		"Search file contents for a pattern (JavaScript regex by default, or a literal substring). Returns matching lines with file:line prefixes. Respects a path/glob to scope the search. Bounded result count.",
	parameters: Type.Object({
		pattern: Type.String({ description: "Pattern to search for. Interpreted as a JavaScript regular expression unless `literal` is true." }),
		path: Type.Optional(Type.String({ description: "File or directory to search. Defaults to the project root." })),
		literal: Type.Optional(Type.Boolean({ description: "Treat `pattern` as a literal substring instead of a regex." })),
		caseInsensitive: Type.Optional(Type.Boolean({ description: "Case-insensitive match." })),
	}),
};

/** The `find` tool — find files by name (substring or glob). */
export const findTool: Tool = {
	name: "find",
	description:
		"Find files whose path or name matches a substring or glob pattern. Walks the project root recursively, skipping common junk/hidden dirs. Bounded result count.",
	parameters: Type.Object({
		pattern: Type.String({ description: "Substring or glob (e.g. *.ts) to match against the file path." }),
		path: Type.Optional(Type.String({ description: "Directory to search under. Defaults to the project root." })),
		glob: Type.Optional(Type.Boolean({ description: "Treat `pattern` as a glob (supports * and ?). Default true when the pattern contains * or ?." })),
	}),
};

/** The `advise` tool — the ONLY side-effecting tool. Captures a note + severity
 *  for delivery into the primary session. Mirrors oh-my-pi's AdviseTool schema. */
export const adviseToolSchema = Type.Object({
	note: Type.String({
		description: "One concrete piece of advice for the agent you are watching. Terse, specific, actionable.",
	}),
	severity: Type.Optional(
		Type.Union([Type.Literal("nit"), Type.Literal("concern"), Type.Literal("blocker")], {
			description: "How strongly to weigh this. Omit for a plain nit.",
		}),
	),
});

export const adviseTool: Tool = {
	name: "advise",
	description: "Send one concrete, terse piece of advice to the agent you are watching.",
	parameters: adviseToolSchema,
};

/** All tools the advisor sees, in the order oh-my-pi presents them. */
export function advisorTools(): Tool[] {
	return [readTool, grepTool, findTool, adviseTool];
}

/** The result of executing the advisor's `advise` tool. */
export interface AdviseCapture {
	note: string;
	severity?: AdvisorSeverity;
}

/** Outcome of one advisor tool execution. */
export interface AdvisorToolResult {
	/** Text content to feed back to the advisor as the tool result. */
	content: string;
	/** When the tool was `advise`, the captured note (ends the advisor loop). */
	advise?: AdviseCapture;
	/** True if the tool call was malformed or failed (sets isError on the result). */
	isError?: boolean;
}

/** Execute one advisor tool call. Read-only for read/grep/find; `advise` captures. */
export async function executeAdvisorTool(
	name: string,
	args: Record<string, unknown>,
	cwd: string,
): Promise<AdvisorToolResult> {
	switch (name) {
		case "read":
			return readExecute(args, cwd);
		case "grep":
			return grepExecute(args, cwd);
		case "find":
			return findExecute(args, cwd);
		case "advise": {
			const note = typeof args.note === "string" ? args.note : "";
			const severity = args.severity;
			if (!note.trim()) {
				return { content: "advise requires a non-empty note.", isError: true };
			}
			return {
				content: "Recorded.",
				advise: {
					note,
					severity:
						severity === "nit" || severity === "concern" || severity === "blocker"
							? (severity as AdvisorSeverity)
							: undefined,
				},
			};
		}
		default:
			return { content: `Unknown tool: ${name}`, isError: true };
	}
}

async function readExecute(args: Record<string, unknown>, cwd: string): Promise<AdvisorToolResult> {
	const path = typeof args.path === "string" ? args.path : "";
	if (!path) return { content: "read requires a 'path'.", isError: true };
	const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1;
	const limit =
		typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : READ_DEFAULT_LIMIT;
	try {
		const abs = resolveReadonlyPath(path, cwd);
		const content = await readFile(abs, "utf8");
		const lines = content.split("\n");
		const sliced = lines.slice(offset - 1, offset - 1 + limit);
		let out = sliced.join("\n");
		if (out.length > READ_MAX_CHARS) {
			out = out.slice(0, READ_MAX_CHARS) + `\n\n[... truncated at ${READ_MAX_CHARS} chars]`;
		}
		if (offset + limit - 1 < lines.length) {
			out += `\n\n[${offset + sliced.length - 1}/${lines.length} lines shown]`;
		} else {
			out += `\n\n[${lines.length}/${lines.length} lines]`;
		}
		return { content: out || "(empty file)" };
	} catch (err) {
		return { content: `read failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
}

async function grepExecute(args: Record<string, unknown>, cwd: string): Promise<AdvisorToolResult> {
	const pattern = typeof args.pattern === "string" ? args.pattern : "";
	if (!pattern) return { content: "grep requires a 'pattern'.", isError: true };
	const path = typeof args.path === "string" ? args.path : ".";
	const literal = args.literal === true;
	const caseInsensitive = args.caseInsensitive === true;
	try {
		const abs = resolveReadonlyPath(path, cwd);
		const flags = caseInsensitive ? "gi" : "g";
		const regex = literal ? new RegExp(escapeRegex(pattern), flags) : new RegExp(pattern, flags);
		// Prefer ripgrep when available: far faster and respects .gitignore.
		const rgResult = await tryRipgrep(abs, pattern, { literal, caseInsensitive });
		if (rgResult !== null) return { content: rgResult };
		const matches: string[] = [];
		await walkFiles(abs, async (file) => {
			if (matches.length >= GREP_MAX_MATCHES) return;
			try {
				const stat = await statFile(file);
				if (!stat || !stat.isFile() || stat.size > GREP_FILE_MAX_BYTES) return;
				const content = await readFile(file, "utf8");
				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (matches.length >= GREP_MAX_MATCHES) break;
					const re = new RegExp(regex.source, regex.flags.replace("g", ""));
					if (re.test(lines[i])) {
						const line = lines[i].length > GREP_LINE_MAX_CHARS
							? lines[i].slice(0, GREP_LINE_MAX_CHARS) + "…"
							: lines[i];
						matches.push(`${relative(cwd, file)}:${i + 1}:${line}`);
					}
				}
			} catch {
				// binary or unreadable — skip
			}
		});
		if (matches.length === 0) return { content: "No matches." };
		const trailer = matches.length >= GREP_MAX_MATCHES ? `\n\n[... truncated at ${GREP_MAX_MATCHES} matches]` : "";
		return { content: matches.join("\n") + trailer };
	} catch (err) {
		return { content: `grep failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
}

async function findExecute(args: Record<string, unknown>, cwd: string): Promise<AdvisorToolResult> {
	const pattern = typeof args.pattern === "string" ? args.pattern : "";
	if (!pattern) return { content: "find requires a 'pattern'.", isError: true };
	const path = typeof args.path === "string" ? args.path : ".";
	const hasWildcard = pattern.includes("*") || pattern.includes("?");
	const glob = args.glob === undefined ? hasWildcard : args.glob === true;
	try {
		const abs = resolveReadonlyPath(path, cwd);
		const matcher = glob ? globToRegex(pattern) : (s: string) => s.includes(pattern);
		const results: string[] = [];
		await walkFiles(abs, async (file) => {
			if (results.length >= FIND_MAX_RESULTS) return;
			const rel = relative(cwd, file);
			if (matcher(rel) || matcher(rel.split(sep).pop() ?? "")) {
				results.push(rel);
			}
		});
		if (results.length === 0) return { content: "No files found." };
		const trailer = results.length >= FIND_MAX_RESULTS ? `\n\n[... truncated at ${FIND_MAX_RESULTS} results]` : "";
		return { content: results.join("\n") + trailer };
	} catch (err) {
		return { content: `find failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
}

/** Directories `find`/`grep` skip (VCS, build output, deps, caches). */
const SKIP_DIRS = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".next",
	".nuxt",
	"dist",
	"build",
	"out",
	"target",
	".cache",
	".turbo",
	".gradle",
	".m2",
	"coverage",
	".pytest_cache",
]);

async function walkFiles(root: string, visit: (file: string) => Promise<void>): Promise<void> {
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return;
	}
	for (const name of names) {
		if (SKIP_DIRS.has(name)) continue;
		const full = join(root, name);
		let s;
		try {
			s = await stat(full);
		} catch {
			continue;
		}
		if (s.isDirectory()) {
			// Skip hidden directories (VCS, IDE, caches) to keep exploration lean.
			if (name.startsWith(".")) continue;
			await walkFiles(full, visit);
		} else if (s.isFile()) {
			await visit(full);
		}
	}
}

async function statFile(file: string) {
	try {
		return await stat(file);
	} catch {
		return null;
	}
}

/** Try ripgrep; return formatted matches, or null if rg is unavailable. */
async function tryRipgrep(
	abs: string,
	pattern: string,
	opts: { literal: boolean; caseInsensitive: boolean },
): Promise<string | null> {
	return new Promise((resolve) => {
		const args = [
			"--no-heading",
			"--line-number",
			"--color=never",
			"--max-count",
			String(GREP_MAX_MATCHES),
		];
		if (opts.caseInsensitive) args.push("-i");
		if (opts.literal) {
			args.push("--fixed-strings");
		} else {
			// rg uses Rust regex, not JS regex. Most patterns are compatible; if a
			// pattern uses JS-only features rg errors and we fall back to the node walk.
			args.push("--regexp", pattern);
		}
		args.push(abs);
		const child = execFile("rg", args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
			if (err) {
				// rg not installed (ENOENT) or pattern unsupported — fall back.
				const code = (err as NodeJS.ErrnoException)?.code;
				if (code === "ENOENT") return resolve(null);
				// Other rg errors: fall back to node walk rather than surfacing rg's error.
				return resolve(null);
			}
			const trimmed = stdout.replace(/\n$/, "");
			resolve(trimmed || "No matches.");
		});
		child.on("error", () => resolve(null));
	});
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): (s: string) => boolean {
	const re = new RegExp(
		"^" +
			pattern
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, ".*")
				.replace(/\?/g, ".") +
			"$",
	);
	return (s: string) => re.test(s);
}

/** Resolve the reasoning level to pass to `complete()` for the advisor model,
 *  or undefined to leave thinking off. Mirrors pi core's guard: don't send a
 *  reasoning level to a non-reasoning model. */
export function resolveAdvisorReasoning(
	model: Model<Api>,
	thinking: boolean,
	level: "minimal" | "low" | "medium" | "high" | "xhigh",
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
	if (!thinking) return undefined;
	if (!model.reasoning) return undefined;
	return level;
}

// Keep a reference so unused-but-exported helpers aren't tree-shaken from type views.
void join;
