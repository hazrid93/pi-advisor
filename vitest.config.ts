import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["__tests__/**/*.test.ts"],
		// The advisor's tools use node:fs, node:child_process — run serially so
		// parallel file-walk tests don't contend on the same temp dirs.
		pool: "forks",
		singleFork: true,
	},
});
