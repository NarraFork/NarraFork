/**
 * Which paths a human edit may be written to.
 *
 * Writing is an allow-list, unlike reading (see `fs-secret-paths.ts`, which is
 * explicitly not a sandbox). These tests pin the cases where a permissive answer is a
 * remote code execution path rather than a mere information leak: a symlink out of the
 * worktree, a `..` traversal, and a sibling directory sharing a name prefix.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWriteBoundary, type WriteBoundaryDecision } from "../fs-write-boundary";
import { getNarraforkHome } from "../narrafork-home";

let root: string;
let worktree: string;
let outside: string;

/** Bun caches homedir(): isolate HOME before a child starts, not in the test process. */
async function credentialLinkDecision(
	fixture: "existing" | "missing-file" | "dangling",
): Promise<WriteBoundaryDecision> {
	const home = mkdtempSync(join(root, "credential-home-"));
	const moduleUrl = new URL("../fs-write-boundary.ts", import.meta.url).href;
	const source = `
		import { strict as assert } from "node:assert";
		import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
		import { homedir } from "node:os";
		import { join, resolve } from "node:path";
		import { checkWriteBoundary } from ${JSON.stringify(moduleUrl)};
		const home = homedir();
		assert.equal(resolve(home), resolve(process.env.FS_BOUNDARY_TEST_HOME));
		const worktree = join(home, "worktree");
		mkdirSync(worktree);
		const ssh = join(home, ".ssh");
		const fixture = ${JSON.stringify(fixture)};
		if (fixture !== "dangling") mkdirSync(ssh);
		if (fixture === "existing") writeFileSync(join(ssh, "authorized_keys"), "fixture only");
		const link = join(worktree, "keys");
		symlinkSync(ssh, link, process.platform === "win32" ? "junction" : "dir");
		console.log(JSON.stringify(checkWriteBoundary(join(link, "authorized_keys"), [worktree])));
	`;
	try {
		const child = Bun.spawn([process.execPath, "--eval", source], {
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				NARRAFORK_HOME: join(home, ".narrafork"),
				FS_BOUNDARY_TEST_HOME: home,
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		return JSON.parse(stdout) as WriteBoundaryDecision;
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "nf-write-boundary-"));
	worktree = join(root, "worktree");
	outside = join(root, "outside");
	mkdirSync(join(worktree, "src"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(worktree, "src", "a.ts"), "x\n");
	writeFileSync(join(outside, "secret.txt"), "x\n");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("paths inside the allowed root", () => {
	test("allows an existing file", () => {
		expect(checkWriteBoundary(join(worktree, "src", "a.ts"), [worktree]).allowed).toBe(true);
	});

	test("allows a file that does not exist yet", () => {
		// Saving may create the file, so `realpathSync` cannot be called on it directly —
		// the deepest existing ancestor is resolved instead.
		const decision = checkWriteBoundary(join(worktree, "src", "new.ts"), [worktree]);

		expect(decision.allowed).toBe(true);
	});

	test("allows a file in a directory that does not exist yet", () => {
		const decision = checkWriteBoundary(join(worktree, "fresh", "deep", "x.ts"), [worktree]);

		expect(decision.allowed).toBe(true);
	});

	test("writes a permitted new file through an ordinary existing parent", () => {
		const candidate = join(worktree, "src", "written-new.ts");
		const decision = checkWriteBoundary(candidate, [worktree]);

		expect(decision.allowed).toBe(true);
		expect(decision.physicalPath).toBe(join(realpathSync(join(worktree, "src")), "written-new.ts"));
		writeFileSync(decision.physicalPath ?? "", "permitted fixture\n");
		expect(readFileSync(candidate, "utf8")).toBe("permitted fixture\n");
	});

	test("writes a permitted new file through an internal directory link", () => {
		const link = join(worktree, "internal-dir");
		symlinkSync(join(worktree, "src"), link, process.platform === "win32" ? "junction" : "dir");
		try {
			const candidate = join(link, "written-via-link.ts");
			const decision = checkWriteBoundary(candidate, [worktree]);

			expect(decision.allowed).toBe(true);
			expect(decision.physicalPath).toBe(
				join(realpathSync(join(worktree, "src")), "written-via-link.ts"),
			);
			writeFileSync(decision.physicalPath ?? "", "permitted link fixture\n");
			expect(readFileSync(candidate, "utf8")).toBe("permitted link fixture\n");
		} finally {
			rmSync(link, { force: true });
		}
	});

	test("reports the physical path it would write", () => {
		const decision = checkWriteBoundary(join(worktree, "src", "a.ts"), [worktree]);

		expect(decision.physicalPath).toContain("a.ts");
	});
});

describe("paths outside the allowed roots", () => {
	test("refuses a sibling directory", () => {
		const decision = checkWriteBoundary(join(outside, "secret.txt"), [worktree]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("outside-allowed-roots");
	});

	test("refuses a `..` traversal out of the root", () => {
		const decision = checkWriteBoundary(join(worktree, "..", "outside", "secret.txt"), [worktree]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("outside-allowed-roots");
	});

	test("refuses a sibling whose name merely shares a prefix", () => {
		// The bug a `startsWith` check has: `/x/worktree-evil` is not inside `/x/worktree`,
		// but the shared prefix does not end at a separator.
		const evil = `${worktree}-evil`;
		mkdirSync(evil, { recursive: true });
		try {
			const decision = checkWriteBoundary(join(evil, "x.ts"), [worktree]);

			expect(decision.allowed).toBe(false);
			expect(decision.reason).toBe("outside-allowed-roots");
		} finally {
			rmSync(evil, { recursive: true, force: true });
		}
	});

	test("refuses everything when no root is allowed", () => {
		// A session with no workspace has no business writing anywhere.
		const decision = checkWriteBoundary(join(worktree, "src", "a.ts"), []);

		expect(decision.allowed).toBe(false);
	});
});

describe("symlink escapes", () => {
	test("refuses a symlinked FILE pointing outside the root", () => {
		// The case that makes a lexical check useless for a writer: `writeFile` follows
		// the link, so this is a write to `outside/secret.txt`.
		const link = join(worktree, "innocent.txt");
		symlinkSync(join(outside, "secret.txt"), link);
		try {
			const decision = checkWriteBoundary(link, [worktree]);

			expect(decision.allowed).toBe(false);
			expect(decision.reason).toBe("escapes-via-symlink");
		} finally {
			rmSync(link, { force: true });
		}
	});

	test("refuses a file under a symlinked DIRECTORY pointing outside", () => {
		const link = join(worktree, "linked-dir");
		symlinkSync(outside, link);
		try {
			const decision = checkWriteBoundary(join(link, "anything.txt"), [worktree]);

			expect(decision.allowed).toBe(false);
			expect(decision.reason).toBe("escapes-via-symlink");
		} finally {
			rmSync(link, { force: true });
		}
	});

	test("refuses a dangling file link instead of treating it as a new file", () => {
		const link = join(worktree, "dangling.txt");
		symlinkSync(join(worktree, "src", "missing-target.txt"), link);
		try {
			const decision = checkWriteBoundary(link, [worktree]);

			expect(decision.allowed).toBe(false);
			expect(decision.reason).toBe("unresolvable");
			expect(decision.confirmable).toBeUndefined();
			expect(decision.physicalPath).toBeUndefined();
		} finally {
			rmSync(link, { force: true });
		}
	});

	test("refuses missing descendants of a dangling directory link", () => {
		const link = join(worktree, "dangling-dir");
		symlinkSync(
			join(outside, "missing-dir"),
			link,
			process.platform === "win32" ? "junction" : "dir",
		);
		try {
			const decision = checkWriteBoundary(join(link, "deep", "new.txt"), [worktree]);

			expect(decision.allowed).toBe(false);
			expect(decision.reason).toBe("unresolvable");
			expect(decision.confirmable).toBeUndefined();
			expect(decision.physicalPath).toBeUndefined();
		} finally {
			rmSync(link, { force: true });
		}
	});

	test("refuses a symlink loop and its missing descendants", () => {
		const first = join(worktree, "loop-first");
		const second = join(worktree, "loop-second");
		symlinkSync(second, first, process.platform === "win32" ? "junction" : "dir");
		symlinkSync(first, second, process.platform === "win32" ? "junction" : "dir");
		try {
			for (const candidate of [first, join(first, "deep", "new.txt")]) {
				const decision = checkWriteBoundary(candidate, [worktree]);

				expect(decision.allowed).toBe(false);
				expect(decision.reason).toBe("unresolvable");
				expect(decision.confirmable).toBeUndefined();
				expect(decision.physicalPath).toBeUndefined();
			}
		} finally {
			rmSync(first, { force: true });
			rmSync(second, { force: true });
		}
	});

	test("a dangling link outside roots is not confirmable", () => {
		const link = join(outside, "dangling.txt");
		symlinkSync(join(outside, "missing-target.txt"), link);
		try {
			const decision = checkWriteBoundary(link, [worktree]);

			expect(decision.allowed).toBe(false);
			expect(decision.reason).toBe("unresolvable");
			expect(decision.confirmable).toBeUndefined();
			expect(decision.physicalPath).toBeUndefined();
		} finally {
			rmSync(link, { force: true });
		}
	});

	test("allows a symlink that stays inside the root", () => {
		// The user's own arrangement within their workspace must keep working.
		const link = join(worktree, "alias.ts");
		symlinkSync(join(worktree, "src", "a.ts"), link);
		try {
			expect(checkWriteBoundary(link, [worktree]).allowed).toBe(true);
		} finally {
			rmSync(link, { force: true });
		}
	});

	test("allows a root that is itself reached through a symlink", () => {
		// `/home/u` → `/mnt/data/u` is a normal layout; resolving only the candidate would
		// make every path on such a system look like an escape.
		const linkedRoot = join(root, "linked-root");
		symlinkSync(worktree, linkedRoot);
		try {
			const decision = checkWriteBoundary(join(linkedRoot, "src", "a.ts"), [linkedRoot]);

			expect(decision.allowed).toBe(true);
		} finally {
			rmSync(linkedRoot, { force: true });
		}
	});
});

describe("multiple allowed roots", () => {
	test("allows a path inside any declared root", () => {
		const decision = checkWriteBoundary(join(outside, "secret.txt"), [worktree, outside]);

		expect(decision.allowed).toBe(true);
	});

	test("still refuses a path in neither", () => {
		const decision = checkWriteBoundary(join(root, "elsewhere.txt"), [worktree, outside]);

		expect(decision.allowed).toBe(false);
	});
});

describe("credential paths are refused even inside an allowed root", () => {
	test("refuses a link that resolves into a third-party credential store", async () => {
		// Existing credential directory, missing file; never consult the real ~/.ssh.
		const decision = await credentialLinkDecision("missing-file");

		expect(decision.allowed).toBe(false);
		// Either refusal is correct here; both are boundary violations.
		expect(["secret-path", "escapes-via-symlink"]).toContain(decision.reason ?? "");
		expect(decision.confirmable).toBeUndefined();
	});

	test("refuses a link to an existing credential fixture", async () => {
		const decision = await credentialLinkDecision("existing");

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("secret-path");
		expect(decision.confirmable).toBeUndefined();
	});

	test("refuses a dangling link to a missing credential directory", async () => {
		const decision = await credentialLinkDecision("dangling");

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("unresolvable");
		expect(decision.confirmable).toBeUndefined();
		expect(decision.physicalPath).toBeUndefined();
	});

	test("refuses the platform settings file when its directory is an allowed root", () => {
		// A misconfigured root must not make the JWT signing secret writable.
		//
		// Anchored on the ACTIVE NarraFork home rather than `~/.narrafork`: the test
		// harness redirects `NARRAFORK_HOME` to an isolated directory, so the literal
		// path under the real home is not the platform home here and would be allowed —
		// correctly, since it holds no running instance's secrets.
		const platformHome = getNarraforkHome();
		const decision = checkWriteBoundary(join(platformHome, "settings.json"), [platformHome]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("secret-path");
	});

	test("refuses the database even inside an allowed root", () => {
		const platformHome = getNarraforkHome();
		const decision = checkWriteBoundary(join(platformHome, "narrafork.db"), [platformHome]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("secret-path");
	});
});

/**
 * The git directory is the case the allow-list gets wrong on its own: `.git/` sits
 * INSIDE the worktree, so every containment test says yes, while a file written there
 * is executed by the next commit. A permissive answer here is remote code execution as
 * the server's user, reachable by anyone with write access to one narrator.
 */
describe("the git directory is refused inside an allowed root", () => {
	test("refuses a hook — the next commit would execute it", () => {
		const hooks = join(worktree, ".git", "hooks");
		mkdirSync(hooks, { recursive: true });
		try {
			const decision = checkWriteBoundary(join(hooks, "pre-commit"), [worktree]);

			expect(decision.allowed).toBe(false);
			expect(decision.reason).toBe("git-internal");
		} finally {
			rmSync(join(worktree, ".git"), { recursive: true, force: true });
		}
	});

	test("refuses a hook that does not exist yet", () => {
		// The dangerous write is the one that CREATES the hook: a repo with no
		// `pre-commit` is the normal case, so a check that only fired for existing
		// files would miss every real attack.
		const decision = checkWriteBoundary(join(worktree, ".git", "hooks", "post-checkout"), [
			worktree,
		]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("git-internal");
	});

	test("refuses `.git/config` — it names commands git runs", () => {
		// `core.pager`, `core.fsmonitor`, `core.sshCommand` and `[alias]` are all
		// command-valued, so config is an execution surface as much as `hooks/` is.
		const decision = checkWriteBoundary(join(worktree, ".git", "config"), [worktree]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("git-internal");
	});

	test("refuses the worktree's `.git` pointer FILE itself", () => {
		// A worktree's `.git` is a file holding `gitdir: <main>/.git/worktrees/<name>`.
		// Overwriting it redirects the whole worktree at a git directory of the
		// attacker's choosing, which is the same escalation one level up.
		const decision = checkWriteBoundary(join(worktree, ".git"), [worktree]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("git-internal");
	});

	test("refuses the MAIN repo's per-worktree git dir, reached through the gitdir pointer", () => {
		// The git directory a worktree write really targets lives under the main repo,
		// outside the worktree. Declared as an extra writable root here to prove the
		// refusal does not depend on the path being outside the roots — with the root
		// allowed, containment says yes and only the git check refuses.
		const mainGitDir = join(root, "main", ".git", "worktrees", "wt");
		mkdirSync(mainGitDir, { recursive: true });
		try {
			const decision = checkWriteBoundary(join(mainGitDir, "config.worktree"), [
				worktree,
				join(root, "main"),
			]);

			expect(decision.allowed).toBe(false);
			expect(decision.reason).toBe("git-internal");
		} finally {
			rmSync(join(root, "main"), { recursive: true, force: true });
		}
	});

	test("refuses a symlink that resolves INTO the git directory", () => {
		// The requested path has no `.git` segment at all, so a check on the requested
		// spelling alone would permit it. `writeFile` follows the link.
		const gitHooks = join(worktree, ".git", "hooks");
		mkdirSync(gitHooks, { recursive: true });
		const link = join(worktree, "notes");
		symlinkSync(gitHooks, link);
		try {
			const decision = checkWriteBoundary(join(link, "pre-push"), [worktree]);

			expect(decision.allowed).toBe(false);
			expect(decision.reason).toBe("git-internal");
		} finally {
			rmSync(link, { force: true });
			rmSync(join(worktree, ".git"), { recursive: true, force: true });
		}
	});

	test("git-internal is NEVER confirmable, even when also outside every root", () => {
		// The ordering that makes this hold: if `confirmable` were decided before the
		// git check, the user would be offered "confirm writing a text file" for a
		// path whose real effect is code execution — consent they cannot give
		// meaningfully because the dialog cannot express it.
		const strayGit = join(outside, "repo", ".git", "hooks");
		mkdirSync(strayGit, { recursive: true });
		try {
			const decision = checkWriteBoundary(join(strayGit, "pre-commit"), [worktree]);

			expect(decision.allowed).toBe(false);
			expect(decision.reason).toBe("git-internal");
			expect(decision.confirmable).toBeUndefined();
		} finally {
			rmSync(join(outside, "repo"), { recursive: true, force: true });
		}
	});

	test("refuses a case-differing spelling — macOS and Windows resolve it to the git dir", () => {
		const decision = checkWriteBoundary(join(worktree, ".GIT", "hooks", "pre-commit"), [worktree]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("git-internal");
	});

	test("still allows ordinary dotfiles and files whose name merely contains 'git'", () => {
		// The check is on a path SEGMENT equal to `.git`, not a substring: refusing
		// `.gitignore` or `gitlab-ci.yml` would break editing files a user routinely
		// edits, and a boundary that blocks normal work gets turned off.
		expect(checkWriteBoundary(join(worktree, ".gitignore"), [worktree]).allowed).toBe(true);
		expect(checkWriteBoundary(join(worktree, ".gitattributes"), [worktree]).allowed).toBe(true);
		expect(checkWriteBoundary(join(worktree, "src", ".gitkeep"), [worktree]).allowed).toBe(true);
		expect(checkWriteBoundary(join(worktree, "git", "notes.md"), [worktree]).allowed).toBe(true);
		expect(checkWriteBoundary(join(worktree, "src", "github.ts"), [worktree]).allowed).toBe(true);
	});
});

describe("unresolvable filesystem entries", () => {
	test("refuses descendants of an ordinary file (ENOTDIR)", () => {
		const decision = checkWriteBoundary(join(worktree, "src", "a.ts", "new.txt"), [worktree]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("unresolvable");
		expect(decision.confirmable).toBeUndefined();
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"refuses an inaccessible ancestor (EACCES)",
		() => {
			const locked = join(worktree, "locked");
			mkdirSync(locked);
			writeFileSync(join(locked, "existing.txt"), "fixture only");
			chmodSync(locked, 0);
			try {
				for (const name of ["existing.txt", "new.txt"]) {
					const candidate = join(locked, name);
					expect(() => realpathSync(candidate)).toThrow();
					const decision = checkWriteBoundary(candidate, [worktree]);

					expect(decision.allowed).toBe(false);
					expect(decision.reason).toBe("unresolvable");
					expect(decision.confirmable).toBeUndefined();
				}
			} finally {
				chmodSync(locked, 0o700);
				rmSync(locked, { recursive: true, force: true });
			}
		},
	);
});

describe("malformed input", () => {
	test("refuses an empty path", () => {
		expect(checkWriteBoundary("   ", [worktree]).reason).toBe("unresolvable");
	});

	test("refuses a path naming a directory", () => {
		expect(checkWriteBoundary(`${worktree}/src/`, [worktree]).reason).toBe("unresolvable");
	});

	/**
	 * A NUL byte makes the checked path and the acted-on path differ.
	 *
	 * The OS reads a path as a C string, so `ok.txt\0.png` names `ok.txt`. Node/Bun refuse
	 * such a path in `writeFile`, so this was never an escape — but the refusal arrives as a
	 * TypeError from inside the write, long after this function answered `allowed: true` and
	 * the route opened a write claim on the truncated name. The verdict must not depend on a
	 * downstream layer happening to be strict.
	 */
	test("refuses a path containing a NUL byte", () => {
		// Inside the worktree and otherwise perfectly ordinary: only the NUL is wrong.
		const inside = checkWriteBoundary(`${worktree}/src/ok.txt\0.png`, [worktree]);
		expect(inside.allowed).toBe(false);
		expect(inside.reason).toBe("unresolvable");
		// Never confirmable: there is no meaningful path to show the user for consent.
		expect(inside.confirmable).toBeUndefined();
		expect(inside.physicalPath).toBeUndefined();
	});

	test("a NUL byte cannot smuggle a traversal past the boundary", () => {
		// Without the guard `resolve()` collapses the `..` segments after the NUL and this
		// answered `confirmable: true` with `physicalPath: "/etc/passwd"`.
		const decision = checkWriteBoundary(`${worktree}/a\0/../../../etc/passwd`, [worktree]);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("unresolvable");
		expect(decision.confirmable).toBeUndefined();
		expect(decision.physicalPath).toBeUndefined();
	});
});

describe("confirmable outside-roots decisions", () => {
	test("a path outside allowed roots but otherwise safe is confirmable", () => {
		const decision = checkWriteBoundary(join(outside, "secret.txt"), [worktree]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("outside-allowed-roots");
		expect(decision.confirmable).toBe(true);
		// Must report the physical path so the confirmation dialog can show it.
		expect(decision.physicalPath).toBeTruthy();
	});

	test("a `..` traversal that lands in a real, non-secret path is confirmable", () => {
		const decision = checkWriteBoundary(join(worktree, "..", "outside", "secret.txt"), [worktree]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("outside-allowed-roots");
		expect(decision.confirmable).toBe(true);
	});

	test("secret-path is NEVER confirmable even when also outside roots", () => {
		// This is the critical safety assertion: a path that is both outside the
		// worktree AND a secret must get a hard refusal. If checkWriteBoundary ran the
		// outside-roots test first and returned early, confirmable would be set on a
		// path that points at credentials.
		const platformHome = getNarraforkHome();
		const decision = checkWriteBoundary(join(platformHome, "settings.json"), [worktree]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("secret-path");
		expect(decision.confirmable).toBeUndefined();
	});

	test("secret database path is never confirmable", () => {
		const platformHome = getNarraforkHome();
		const decision = checkWriteBoundary(join(platformHome, "narrafork.db"), [worktree]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("secret-path");
		expect(decision.confirmable).toBeUndefined();
	});

	test("symlink escape is never confirmable", () => {
		// A symlink inside the worktree pointing outside: the user sees a worktree path
		// but the bytes land elsewhere. Confirmation would be consenting to a destination
		// the user cannot see.
		const link = join(worktree, "sneaky-escape.txt");
		symlinkSync(join(outside, "secret.txt"), link);
		try {
			const decision = checkWriteBoundary(link, [worktree]);

			expect(decision.allowed).toBe(false);
			expect(decision.reason).toBe("escapes-via-symlink");
			expect(decision.confirmable).toBeUndefined();
		} finally {
			rmSync(link, { force: true });
		}
	});

	test("confirmable is decided AFTER physical resolution and secret check", () => {
		// Pin the ordering guarantee: a path that is a secret AND outside roots must
		// hit the secret check first. If the outside-roots check ran first, the
		// `confirmable` flag would be set — letting a UI confirmation override the
		// hard secret refusal.
		const platformHome = getNarraforkHome();
		const decision = checkWriteBoundary(
			join(platformHome, "settings.json"),
			// Pass an unrelated root so the empty-roots shortcut does not mask the
			// ordering test.
			[worktree],
		);

		// Must be secret-path, never outside-allowed-roots.
		expect(decision.reason).toBe("secret-path");
		expect(decision.confirmable).toBeUndefined();
	});

	test("unresolvable path is not confirmable", () => {
		const decision = checkWriteBoundary("   ", [worktree]);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("unresolvable");
		expect(decision.confirmable).toBeUndefined();
	});

	test("empty roots produce outside-allowed-roots without confirmable", () => {
		// No workspace means no business writing anywhere — nothing to confirm against.
		const decision = checkWriteBoundary(join(outside, "secret.txt"), []);

		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("outside-allowed-roots");
		// Not confirmable: there is no root to be "outside of" in a meaningful sense.
		expect(decision.confirmable).toBeUndefined();
	});
});
