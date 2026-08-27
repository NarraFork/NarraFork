/**
 * standalone-narrator-cwd.test.ts
 *
 * This decides where a narrator's files actually get written, so its failure modes
 * are all quiet ones: a narrator created in the wrong directory still works, it just
 * puts the user's work somewhere they did not ask for. Two branches carry real risk
 * and neither is comfortable to provoke against a live filesystem — which is why the
 * effects are injected:
 *
 *   - a configured default that cannot be created (missing parent, no permission)
 *     must degrade to home rather than fail creation or strand the session in an
 *     erroring cwd;
 *   - a chapter-bound narrator must be left ALONE, because its unset cwd is what
 *     makes session start bind it to the worktree. Filling it in here would silently
 *     detach every chapter narrator from its own checkout.
 */

import { describe, expect, test } from "bun:test";
import {
	resolveStandaloneNarratorCwd,
	type StandaloneNarratorCwdDeps,
} from "../standalone-narrator-cwd";

const HOME = "/home/tester";

function deps(overrides: Partial<StandaloneNarratorCwdDeps> = {}): StandaloneNarratorCwdDeps {
	return {
		home: HOME,
		configuredDir: undefined,
		ensureDir: () => {},
		// Enough of node:path resolve for these inputs; the real one is wired in the route.
		toAbsolute: (path) => (path.startsWith("/") ? path.replace(/\/+$/, "") : `/cwd/${path}`),
		...overrides,
	};
}

describe("an explicit cwd from the client", () => {
	test("wins over everything and is trimmed", () => {
		const resolved = resolveStandaloneNarratorCwd(
			{ cwd: "  /srv/work  " },
			deps({ configuredDir: "/home/tester/projects" }),
		);
		expect(resolved).toBe("/srv/work");
	});

	test("a whitespace-only cwd is treated as absent", () => {
		const resolved = resolveStandaloneNarratorCwd({ cwd: "   " }, deps());
		expect(resolved).toBe(HOME);
	});
});

describe("chapter-bound narrators", () => {
	test("are left unset so session start binds the worktree", () => {
		const created: string[] = [];
		const resolved = resolveStandaloneNarratorCwd(
			{ chapterId: "ch1" },
			deps({
				configuredDir: "/home/tester/projects",
				ensureDir: (path) => created.push(path),
			}),
		);
		expect(resolved).toBeUndefined();
		// And nothing is created on their behalf: the worktree already exists.
		expect(created).toEqual([]);
	});

	test("still honour an explicit cwd", () => {
		const resolved = resolveStandaloneNarratorCwd({ cwd: "/srv/work", chapterId: "ch1" }, deps());
		expect(resolved).toBe("/srv/work");
	});
});

describe("the configured default project directory", () => {
	test("is used and created when set", () => {
		const created: string[] = [];
		const resolved = resolveStandaloneNarratorCwd(
			{},
			deps({
				configuredDir: "/data/projects",
				ensureDir: (path) => created.push(path),
			}),
		);
		expect(resolved).toBe("/data/projects");
		expect(created).toEqual(["/data/projects"]);
	});

	test("expands a bare ~ and a ~/ prefix", () => {
		expect(resolveStandaloneNarratorCwd({}, deps({ configuredDir: "~" }))).toBe(HOME);
		expect(resolveStandaloneNarratorCwd({}, deps({ configuredDir: "~/projects" }))).toBe(
			`${HOME}/projects`,
		);
	});

	test("does NOT invent a directory for an unresolvable ~user form", () => {
		// `~other` cannot be resolved from here, and expanding it naively would create a
		// literal directory named "~other" in the process cwd — a confusing artefact
		// that looks like corruption.
		const created: string[] = [];
		const resolved = resolveStandaloneNarratorCwd(
			{},
			deps({ configuredDir: "~other/projects", ensureDir: (path) => created.push(path) }),
		);
		expect(resolved).toBe(HOME);
		expect(created).toEqual([]);
	});

	test("falls back to home when the directory cannot be created", () => {
		const failures: string[] = [];
		const resolved = resolveStandaloneNarratorCwd(
			{},
			deps({
				configuredDir: "/forbidden/projects",
				ensureDir: () => {
					throw new Error("EACCES");
				},
				onEnsureFailed: (path) => failures.push(path),
			}),
		);
		// Degrading beats rejecting a narrator the user asked to create, and beats
		// persisting a cwd every later tool call would fail on.
		expect(resolved).toBe(HOME);
		expect(failures).toEqual(["/forbidden/projects"]);
	});

	test("falls back to home when unset or blank", () => {
		expect(resolveStandaloneNarratorCwd({}, deps({ configuredDir: undefined }))).toBe(HOME);
		expect(resolveStandaloneNarratorCwd({}, deps({ configuredDir: "   " }))).toBe(HOME);
	});

	test("makes a relative configured path absolute", () => {
		// A relative cwd would resolve against whatever directory the server happens to
		// have been started from.
		const resolved = resolveStandaloneNarratorCwd({}, deps({ configuredDir: "projects" }));
		expect(resolved).toBe("/cwd/projects");
	});
});
