/**
 * Wiring tests for `advisor.ts`'s pi event handlers.
 *
 * These handlers had no coverage at all, which is how the `input` handler came
 * to drop `event.source`: the runtime's "ignore extension-injected input" guard
 * was fully unit-tested, but nothing checked that the wiring layer actually
 * passed the field, so the guard was unreachable in production.
 *
 * The approach is deliberately blunt: fake `ExtensionAPI`, capture the
 * registered handlers, stub the runtime methods, and assert each handler
 * forwards the fields it is given.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The extension reads/writes the real global config file on import and on
// `updateConfig`. Pin it to an in-memory value so tests never touch ~/.pi.
const configState = vi.hoisted(() => ({
	value: {
		enabled: true,
		advisorModel: "fake/fake",
		thinking: false,
		thinkingLevel: "medium" as const,
		contextChars: 24_000,
		turnInterval: 1,
		maxToolRounds: 2,
		maxRetries: 3,
		interrupting: true,
		syncLag: 0,
		triggers: ["turn_end", "tool_error"],
		midPauseMs: 4000,
		instructionsMode: "project" as const,
	},
}));

vi.mock("../src/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/index.js")>();
	return {
		...actual,
		readConfig: () => ({ ...configState.value }),
		writeConfig: () => "/dev/null",
	};
});

/** Captured runtime calls, per instance-method. */
const rtCalls = vi.hoisted(() => ({
	onInput: [] as unknown[][],
	onTurnEnd: [] as unknown[][],
	onToolExecutionEnd: [] as unknown[][],
	onAgentSettled: [] as unknown[][],
}));

vi.mock("../src/runtime.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/runtime.js")>();
	class FakeRuntime {
		disposed = false;
		async onInput(...args: unknown[]) { rtCalls.onInput.push(args); }
		async onTurnEnd(...args: unknown[]) { rtCalls.onTurnEnd.push(args); }
		async onToolExecutionEnd(...args: unknown[]) { rtCalls.onToolExecutionEnd.push(args); }
		async onAgentSettled(...args: unknown[]) { rtCalls.onAgentSettled.push(args); }
		onMessageUpdate() {}
		reset() {}
		seedToLeaf() {}
		dispose() { this.disposed = true; }
		async waitForCatchUp() {}
	}
	return { ...actual, AdvisorRuntime: FakeRuntime, makeHost: () => ({ sendAdvice: async () => {} }) };
});

import activate from "../advisor.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function mountExtension() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, fn: Handler) => { handlers.set(name, fn); },
		registerCommand: () => {},
		sendMessage: async () => {},
	};
	activate(pi as never);
	return handlers;
}

function fakeCtx() {
	return {
		signal: new AbortController().signal,
		cwd: "/tmp",
		modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};
}

describe("advisor.ts input handler", () => {
	beforeEach(() => {
		rtCalls.onInput.length = 0;
	});

	it("forwards event.source to the runtime (the guard is only reachable if it does)", async () => {
		const handlers = mountExtension();
		const onInput = handlers.get("input")!;

		await onInput({ text: "injected by another extension", source: "extension" }, fakeCtx());

		expect(rtCalls.onInput).toHaveLength(1);
		expect(rtCalls.onInput[0][2]).toBe("extension");
	});

	it("forwards each input source verbatim", async () => {
		const handlers = mountExtension();
		const onInput = handlers.get("input")!;

		for (const source of ["interactive", "rpc", "extension"] as const) {
			await onInput({ text: "x", source }, fakeCtx());
		}

		expect(rtCalls.onInput.map((args) => args[2])).toEqual(["interactive", "rpc", "extension"]);
	});

	it("returns { action: 'continue' } so it never swallows the user's prompt", async () => {
		const handlers = mountExtension();
		const result = await handlers.get("input")!({ text: "hi", source: "interactive" }, fakeCtx());
		expect(result).toEqual({ action: "continue" });
	});

	it("still returns continue when the advisor is disabled", async () => {
		configState.value = { ...configState.value, enabled: false };
		try {
			const handlers = mountExtension();
			const result = await handlers.get("input")!({ text: "hi", source: "interactive" }, fakeCtx());
			expect(result).toEqual({ action: "continue" });
			expect(rtCalls.onInput).toHaveLength(0);
		} finally {
			configState.value = { ...configState.value, enabled: true };
		}
	});
});

describe("advisor.ts event payload forwarding", () => {
	beforeEach(() => {
		rtCalls.onTurnEnd.length = 0;
		rtCalls.onToolExecutionEnd.length = 0;
	});

	it("turn_end forwards the message and its toolResults", async () => {
		const handlers = mountExtension();
		const message = { role: "assistant", content: [] };
		const toolResults = [{ role: "toolResult", toolCallId: "t1" }];

		await handlers.get("turn_end")!({ message, toolResults }, fakeCtx());

		expect(rtCalls.onTurnEnd).toHaveLength(1);
		expect(rtCalls.onTurnEnd[0][0]).toBe(message);
		expect(rtCalls.onTurnEnd[0][1]).toBe(toolResults);
	});

	it("tool_execution_end forwards the tool identity, result and error flag", async () => {
		const handlers = mountExtension();

		await handlers.get("tool_execution_end")!(
			{ toolCallId: "call_1", toolName: "bash", result: "boom", isError: true },
			fakeCtx(),
		);

		expect(rtCalls.onToolExecutionEnd).toHaveLength(1);
		expect(rtCalls.onToolExecutionEnd[0][0]).toEqual({
			toolCallId: "call_1",
			toolName: "bash",
			result: "boom",
			isError: true,
		});
	});

	it("gates project instructions on isProjectTrusted()", async () => {
		const handlers = mountExtension();
		const ctx = { ...fakeCtx(), isProjectTrusted: () => false };

		await handlers.get("turn_end")!({ message: { role: "assistant", content: [] }, toolResults: [] }, ctx);

		const reviewCtx = rtCalls.onTurnEnd[0][3] as { projectInstructions?: string };
		expect(reviewCtx.projectInstructions).toBeUndefined();
	});
});
