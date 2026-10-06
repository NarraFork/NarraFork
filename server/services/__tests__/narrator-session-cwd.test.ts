import { describe, expect, test } from "bun:test";
import { resolveNarratorSessionCwd } from "../narrator-cwd";

describe("resolveNarratorSessionCwd", () => {
	test("prefers an explicit narrator cwd over the chapter worktree", () => {
		expect(
			resolveNarratorSessionCwd("/chosen/workspace", "/chapter/worktree", "/project", "/home"),
		).toBe("/chosen/workspace");
	});

	test("uses the chapter worktree when no override exists", () => {
		expect(resolveNarratorSessionCwd(null, "/chapter/worktree", "/project", "/home")).toBe(
			"/chapter/worktree",
		);
	});

	test("falls back to the project path for dormant chapters", () => {
		expect(resolveNarratorSessionCwd(null, null, "/project", "/home")).toBe("/project");
	});

	test("uses the supplied fallback when no persisted path exists", () => {
		expect(resolveNarratorSessionCwd(null, null, null, "/home")).toBe("/home");
	});
});
