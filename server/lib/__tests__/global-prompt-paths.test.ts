import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	getGlobalPromptCandidates,
	isWritableGlobalPromptPath,
	PROJECT_PROMPT_FILENAMES,
} from "../global-prompt-paths";

const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;

afterEach(() => {
	if (ORIGINAL_CODEX_HOME === undefined) {
		delete process.env.CODEX_HOME;
	} else {
		process.env.CODEX_HOME = ORIGINAL_CODEX_HOME;
	}
});

describe("PROJECT_PROMPT_FILENAMES", () => {
	test("prefers the local override, then the AGENTS.md standard", () => {
		expect(PROJECT_PROMPT_FILENAMES[0]).toBe("AGENTS.override.md");
		expect(PROJECT_PROMPT_FILENAMES[1]).toBe("AGENTS.md");
	});

	test("keeps deprecated names as lower-priority fallbacks", () => {
		const names = [...PROJECT_PROMPT_FILENAMES];
		expect(names.indexOf("AGENTS.md")).toBeLessThan(names.indexOf("AGENT.md"));
		expect(names.indexOf("AGENT.md")).toBeLessThan(names.indexOf("CLAUDE.md"));
	});
});

describe("getGlobalPromptCandidates", () => {
	test("defaults to ~/.codex when CODEX_HOME is unset", () => {
		delete process.env.CODEX_HOME;
		const candidates = getGlobalPromptCandidates();
		expect(candidates).toContain(join(homedir(), ".codex", "AGENTS.md"));
	});

	test("honors CODEX_HOME over the default ~/.codex", () => {
		// Inside the home directory on purpose — an override that escapes it is refused,
		// which the containment suite below covers separately.
		const custom = join(homedir(), "custom-codex-home");
		process.env.CODEX_HOME = custom;
		const candidates = getGlobalPromptCandidates();
		expect(candidates).toContain(join(custom, "AGENTS.md"));
		expect(candidates).not.toContain(join(homedir(), ".codex", "AGENTS.md"));
	});

	test("ranks .agents above .codex above .claude", () => {
		delete process.env.CODEX_HOME;
		const candidates = getGlobalPromptCandidates();
		const agents = candidates.indexOf(join(homedir(), ".agents", "AGENTS.md"));
		const codex = candidates.indexOf(join(homedir(), ".codex", "AGENTS.md"));
		const claude = candidates.indexOf(join(homedir(), ".claude", "CLAUDE.md"));
		expect(agents).toBeGreaterThanOrEqual(0);
		expect(agents).toBeLessThan(codex);
		expect(codex).toBeLessThan(claude);
	});

	test("puts each override file ahead of its sibling AGENTS.md", () => {
		delete process.env.CODEX_HOME;
		const candidates = getGlobalPromptCandidates();
		for (const root of [".agents", ".codex"]) {
			const override = candidates.indexOf(join(homedir(), root, "AGENTS.override.md"));
			const standard = candidates.indexOf(join(homedir(), root, "AGENTS.md"));
			expect(override).toBeGreaterThanOrEqual(0);
			expect(override).toBeLessThan(standard);
		}
	});

	test("dedupes when CODEX_HOME collides with another root", () => {
		process.env.CODEX_HOME = join(homedir(), ".agents");
		const candidates = getGlobalPromptCandidates();
		expect(new Set(candidates).size).toBe(candidates.length);
	});

	test("returns only absolute paths", () => {
		delete process.env.CODEX_HOME;
		for (const candidate of getGlobalPromptCandidates()) {
			expect(candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate)).toBe(true);
		}
	});
});

/*
 * The containment rule, tested on its own because this array is not just a read order:
 * `PUT /api/routines/global-prompt` validates its target against it, so every path this
 * function is willing to return is a path an admin can write arbitrary bytes to. An
 * unconstrained `CODEX_HOME` therefore turned that endpoint into an arbitrary-file
 * writer, which is why an out-of-home override is DROPPED rather than honoured.
 *
 * Dropped, not fatal: `~/.codex` is still a correct answer, and refusing to serve the
 * settings page over a misconfigured environment variable would be the worse failure.
 */
describe("getGlobalPromptCandidates — CODEX_HOME containment", () => {
	const home = homedir();
	const defaultCodex = join(home, ".codex", "AGENTS.md");

	test("ignores an absolute CODEX_HOME outside the home directory", () => {
		// The concrete danger: `/etc` (or a systemd unit directory, or a git hooks dir)
		// becoming a writable target for anyone who can reach the PUT.
		process.env.CODEX_HOME = "/etc";
		const candidates = getGlobalPromptCandidates();
		expect(candidates).not.toContain(join("/etc", "AGENTS.md"));
		expect(candidates).not.toContain(join("/etc", "AGENTS.override.md"));
		// And the default is used instead, so the feature still works.
		expect(candidates).toContain(defaultCodex);
	});

	test("ignores a relative CODEX_HOME that traverses out of the home directory", () => {
		// `resolve()` collapses `..` against the process cwd, so a `..`-laden RELATIVE value
		// is a real escape and not a literal path — which is why containment is judged after
		// resolving, not on the raw string.
		//
		// Derived from the cwd rather than hard-coded as `../../etc`: how many levels it
		// takes to leave home depends on where the test runs from, and a fixed count either
		// under- or overshoots. `relative()` produces exactly the traversal that lands on
		// `/etc` from here.
		const traversal = relative(process.cwd(), "/etc");
		expect(traversal.startsWith("..")).toBe(true);
		process.env.CODEX_HOME = traversal;
		const candidates = getGlobalPromptCandidates();
		expect(candidates).not.toContain(join("/etc", "AGENTS.md"));
		expect(candidates).toContain(defaultCodex);
	});

	test("accepts a relative CODEX_HOME whose traversal stays inside the home directory", () => {
		// The counterpart: `..` is not itself suspicious, only leaving home is. This one
		// resolves to a directory under home and must be honoured.
		const inside = join(home, "codex-relative-ok");
		process.env.CODEX_HOME = relative(process.cwd(), inside);
		const candidates = getGlobalPromptCandidates();
		expect(candidates).toContain(join(inside, "AGENTS.md"));
	});

	test("ignores a traversal that starts inside the home directory and leaves it", () => {
		process.env.CODEX_HOME = join(home, "..", "..", "etc");
		const candidates = getGlobalPromptCandidates();
		expect(candidates).not.toContain(join(resolve(home, "..", "..", "etc"), "AGENTS.md"));
		expect(candidates).toContain(defaultCodex);
	});

	test("rejects a sibling directory that merely shares the home prefix", () => {
		// The reason containment is not a `startsWith` test: `/home/foo-evil` shares every
		// character of `/home/foo` without being inside it, because the common prefix does
		// not end at a separator.
		process.env.CODEX_HOME = `${home}-evil`;
		const candidates = getGlobalPromptCandidates();
		expect(candidates).not.toContain(join(`${home}-evil`, "AGENTS.md"));
		expect(candidates).toContain(defaultCodex);
	});

	test("accepts a nested directory inside the home directory", () => {
		// The legitimate use of the override must keep working; only escapes are refused.
		const nested = join(home, "work", "codex-home");
		process.env.CODEX_HOME = nested;
		const candidates = getGlobalPromptCandidates();
		expect(candidates).toContain(join(nested, "AGENTS.md"));
		expect(candidates).not.toContain(defaultCodex);
	});

	test("accepts a traversal that stays within the home directory", () => {
		// Normalization, not rejection, is the right answer here: the path really does
		// resolve inside home.
		process.env.CODEX_HOME = join(home, "work", "..", ".codex");
		const candidates = getGlobalPromptCandidates();
		expect(candidates).toContain(defaultCodex);
	});

	test("accepts the home directory itself", () => {
		// The boundary case for the containment helper: `relative()` returns "" here, which
		// must read as inside rather than as an escape.
		process.env.CODEX_HOME = home;
		const candidates = getGlobalPromptCandidates();
		expect(candidates).toContain(join(home, "AGENTS.md"));
	});

	test("treats a whitespace-only CODEX_HOME as unset", () => {
		process.env.CODEX_HOME = "   ";
		expect(getGlobalPromptCandidates()).toContain(defaultCodex);
	});
});

/*
 * The WRITE rule, which is deliberately stricter than the read order above.
 *
 * `writeFile` follows symlinks, so candidate membership alone is not a boundary: a link at
 * an approved path whose target sits outside home turns the PUT into a write to that
 * target. Membership is a string comparison; this is the check that looks at where the
 * path actually lands.
 *
 * Reading through such a link stays allowed on purpose — an instruction file kept in a
 * dotfiles checkout and linked into `~/.agents/` is an ordinary setup, and the content is
 * the user's own either way. Only the write is refused.
 *
 * Symlinks are created under a temp CODEX_HOME inside the real home directory, because
 * that is the only way to exercise a candidate path that is also a link. The directory is
 * removed afterwards.
 */
describe("isWritableGlobalPromptPath", () => {
	const created: string[] = [];

	afterEach(() => {
		for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	/** A directory inside the real home, so paths under it can be legitimate candidates. */
	function makeCodexHome(): string {
		const dir = mkdtempSync(join(homedir(), ".narrafork-global-prompt-test-"));
		created.push(dir);
		return dir;
	}

	test("accepts a plain candidate path inside the home directory", () => {
		const codex = makeCodexHome();
		process.env.CODEX_HOME = codex;
		expect(isWritableGlobalPromptPath(join(codex, "AGENTS.md"))).toBe(true);
	});

	test("refuses a path that is not a candidate at all", () => {
		delete process.env.CODEX_HOME;
		// Inside home, so containment passes; it is the membership half that must refuse.
		expect(isWritableGlobalPromptPath(join(homedir(), "somewhere", "AGENTS.md"))).toBe(false);
		expect(isWritableGlobalPromptPath("/etc/crontab")).toBe(false);
	});

	test("refuses a candidate whose own file is a symlink out of the home directory", () => {
		// The case the lexical check cannot see: every directory on the path is inside home,
		// and only the final component leaves. `writeFile` would follow it.
		const outside = mkdtempSync(join(tmpdir(), "nf-global-prompt-outside-"));
		created.push(outside);
		const target = join(outside, "hijacked.md");
		writeFileSync(target, "original", "utf-8");

		const codex = makeCodexHome();
		process.env.CODEX_HOME = codex;
		const candidate = join(codex, "AGENTS.md");
		symlinkSync(target, candidate);

		// Still a candidate — the read path is expected to serve it.
		expect(getGlobalPromptCandidates()).toContain(candidate);
		// But not writable, because the bytes would land outside home.
		expect(isWritableGlobalPromptPath(candidate)).toBe(false);
	});

	test("refuses a candidate whose parent directory is a symlink out of the home directory", () => {
		// The escape one level up: `$CODEX_HOME` itself is a link. `resolve()` cannot detect
		// this, which is why containment is judged physically.
		const outside = mkdtempSync(join(tmpdir(), "nf-global-prompt-outside-dir-"));
		created.push(outside);

		const link = join(homedir(), `.narrafork-global-prompt-link-${process.pid}`);
		created.push(link);
		symlinkSync(outside, link);

		process.env.CODEX_HOME = link;
		const candidate = join(link, "AGENTS.md");
		expect(getGlobalPromptCandidates()).toContain(candidate);
		expect(isWritableGlobalPromptPath(candidate)).toBe(false);
	});

	test("accepts a symlink that stays inside the home directory", () => {
		// Containment, not "no symlinks": a link the user set up within their own home is
		// their layout and must keep working.
		const inside = mkdtempSync(join(homedir(), ".narrafork-global-prompt-inside-"));
		created.push(inside);

		const link = join(homedir(), `.narrafork-global-prompt-inside-link-${process.pid}`);
		created.push(link);
		symlinkSync(inside, link);

		process.env.CODEX_HOME = link;
		expect(isWritableGlobalPromptPath(join(link, "AGENTS.md"))).toBe(true);
	});

	test("accepts a candidate whose directory does not exist yet", () => {
		// `mkdir -p` in the write handler creates it, so an unresolvable path must not be
		// refused for being absent — only for landing outside home. This is the case that
		// rules out a bare `realpathSync` on the candidate itself.
		const codex = join(homedir(), `.narrafork-global-prompt-absent-${process.pid}`);
		created.push(codex);
		process.env.CODEX_HOME = codex;
		const candidate = join(codex, "AGENTS.md");
		expect(getGlobalPromptCandidates()).toContain(candidate);
		expect(isWritableGlobalPromptPath(candidate)).toBe(true);

		// And the answer does not change once the directory is really there.
		mkdirSync(codex, { recursive: true });
		expect(isWritableGlobalPromptPath(candidate)).toBe(true);
	});

	test("refuses a relative path that resolves onto a candidate but escapes home", () => {
		// Resolution happens before both halves of the check, so a `..`-laden value cannot
		// smuggle a target past either one.
		delete process.env.CODEX_HOME;
		expect(isWritableGlobalPromptPath(relative(process.cwd(), "/etc/crontab"))).toBe(false);
	});
});
