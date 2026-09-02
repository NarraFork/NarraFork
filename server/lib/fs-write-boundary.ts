/**
 * fs-write-boundary.ts — which paths a human may WRITE through `/api/fs/*`.
 *
 * ## Why writing needs its own boundary
 *
 * `fs-secret-paths.ts` states plainly that it is not a sandbox: it is a deny-list whose
 * only promise is that "read any file" cannot escalate into "become the platform"
 * (the JWT signing secret, provider tokens, the password-hash database). That trade is
 * defensible for reads, because the file browser has always listed the whole
 * filesystem and the content is already the user's to see.
 *
 * It does NOT transfer to writes. A deny-list blocks `settings.json`; it does not block
 * `~/.bashrc`, `~/.profile`, a systemd unit, a git hook, or `~/.local/bin/git`. Any of
 * those turns "a logged-in reader can save a text file" into "a logged-in reader can
 * execute code as the server's user on its next login, commit, or timer". So writing is
 * an ALLOW-list, and this module is it.
 *
 * ## The two-test rule
 *
 * Every decision runs both a lexical and a physical containment test, exactly like
 * `global-prompt-paths.ts` and for the same reason:
 *
 *   - Lexical alone is not a boundary for a writer. `writeFile` follows symlinks, so
 *     `<worktree>/notes.md → /etc/crontab` satisfies any string comparison while naming
 *     a file outside the tree.
 *   - Physical alone cannot distinguish an escape from a resolution failure, and it
 *     needs the lexical test to reject paths whose ancestors are unreadable.
 *
 * Both roots are resolved too, since a worktree is commonly reached through a symlink
 * (`/home/u` → `/mnt/data/u`); resolving only the candidate would make every path on
 * such a system look like an escape.
 *
 * ## What is deliberately still refused inside an allowed root
 *
 * The secret deny-list is applied ON TOP of the allow-list rather than replaced by it.
 * A project can legitimately contain a `.env`, and a worktree could be configured with
 * the NarraFork home as its root; in both cases the allow-list would permit a write
 * that the read path already refuses to serve. Refusing writes to credential-bearing
 * paths is strictly narrower than refusing to read them, so the two never conflict.
 *
 * The git directory is refused for the same reason, and it is the case the allow-list
 * gets WRONG on its own: `.git/` sits inside the worktree, so containment says yes. But
 * `.git/hooks/pre-commit` is executed by the next commit and `.git/config` names
 * commands too (`core.pager`, `core.fsmonitor`, `core.sshCommand`), which is exactly
 * the "save a text file becomes run code as the server's user" escalation this module
 * exists to prevent — this file's own header listed a git hook as the threat while the
 * containment test happily permitted it. See {@link namesGitDirectory}.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isSecretPlatformPath, isSecretUserPath } from "./fs-secret-paths";

/** Why a write was refused, for a message the caller can act on. */
export type WriteRefusalReason =
	/** Not inside the narrator's worktree or any declared writable directory. */
	| "outside-allowed-roots"
	/** Lexically inside, but resolves through a symlink to somewhere outside. */
	| "escapes-via-symlink"
	/** Inside an allowed root, but the bytes are credentials. */
	| "secret-path"
	/** Inside the git directory, where a written file is executed by git. */
	| "git-internal"
	/** The path names no file, or its ancestors cannot be resolved. */
	| "unresolvable";

export interface WriteBoundaryDecision {
	allowed: boolean;
	reason?: WriteRefusalReason;
	/** The physical path that would be written, when allowed or confirmable. */
	physicalPath?: string;
	/**
	 * True only when the sole remaining objection is `outside-allowed-roots` AND every
	 * harder check (physical resolution, symlink escape, secret-path) has already passed.
	 *
	 * The caller may let the user confirm and then proceed. The ordering guarantee is
	 * load-bearing: if this flag were set before the secret/git/symlink checks ran, a
	 * confirmation would bypass a security boundary the user cannot meaningfully consent
	 * to (they cannot see where a symlink really lands, and "confirm to overwrite the JWT
	 * secret" is one misclick from platform compromise).
	 */
	confirmable?: true;
}

/**
 * Whether `candidate` is `root` itself or sits underneath it, lexically.
 *
 * `relative()` rather than `startsWith`: a prefix test accepts `/home/foo-evil` as being
 * inside `/home/foo`, because the shared prefix does not end at a separator.
 */
function isContained(root: string, candidate: string): boolean {
	const remainder = relative(resolve(root), resolve(candidate));
	return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

/**
 * The physical path `candidate` names, with every symlink resolved.
 *
 * The file need not exist — saving may create it — so `realpathSync` cannot be called on
 * it directly. The deepest existing ANCESTOR is resolved and the missing tail
 * re-appended. Sound rather than approximate: the tail's segments do not exist, so none
 * can be a symlink, and `resolve()` has already collapsed every `..`.
 *
 * An existing candidate is resolved itself, which is the case that matters most: a
 * symlinked FILE is followed by `writeFile`.
 *
 * Returns null when nothing resolves, which callers must treat as "not provably
 * contained" rather than as containment.
 */
function physicalPath(candidate: string): string | null {
	const absolute = resolve(candidate);
	const tail: string[] = [];
	let current = absolute;
	for (;;) {
		try {
			return join(realpathSync(current), ...tail);
		} catch {
			const parent = dirname(current);
			if (parent === current) return null;
			tail.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * Whether any segment of `absPath` is a git directory — including the path ITSELF.
 *
 * ## Why the whole git directory and not just `hooks/`
 *
 * `hooks/*` is the obvious executable surface, and it is not the only one. `config`
 * names commands git will run (`core.pager`, `core.fsmonitor`, `core.sshCommand`,
 * `[alias]`), and the object/ref store decides what a later checkout writes into the
 * working tree. There is no file in there a person needs to hand-edit through a web
 * editor, so the boundary is the directory rather than a list of filenames that would
 * have to keep pace with git's own configuration surface.
 *
 * ## Why every segment, not just the first
 *
 * A worktree's `.git` is a FILE holding `gitdir: <main>/.git/worktrees/<name>`, so the
 * real git directory for a worktree write lives under the MAIN repo — a path that is
 * outside the worktree and reached only after symlink/gitdir resolution. Matching any
 * segment covers three spellings at once: `<worktree>/.git` (the pointer file itself,
 * whose replacement redirects the whole worktree), `<worktree>/.git/...`, and
 * `<main>/.git/worktrees/<name>/...`.
 *
 * ## Case
 *
 * Compared case-insensitively on every platform. macOS and Windows filesystems are
 * case-insensitive by default, so `.GIT` there IS the git directory; refusing it on
 * Linux too costs a directory literally named `.GIT`, which is not a thing, and the
 * asymmetric mistake (permitting a hook write on macOS) is the one that matters.
 *
 * Known limit: only the conventional `.git` name is recognised. A repository whose git
 * directory is named something else (`GIT_DIR` pointed elsewhere, a bare clone used as
 * a worktree root) is not covered by this check. Those are not shapes NarraFork creates
 * — worktrees are made with plain `git worktree add` — and the allow-list still bounds
 * the write to the workspace.
 */
function namesGitDirectory(absPath: string): boolean {
	// Split on both separators: a POSIX filename may legitimately contain a backslash,
	// but treating it as a separator here can only ever refuse MORE, never less.
	return absPath.split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git");
}

/**
 * Decide whether a human edit may be written to `candidate`.
 *
 * @param candidate    Absolute path the caller wants to write.
 * @param allowedRoots Roots the write may land in: the narrator's worktree plus any
 *   directories the operator explicitly declared writable. An empty list refuses
 *   everything, which is the correct default — a session with no workspace has no
 *   business writing anywhere.
 */
export function checkWriteBoundary(
	candidate: string,
	allowedRoots: readonly string[],
): WriteBoundaryDecision {
	const trimmed = candidate.trim();
	if (!trimmed) return { allowed: false, reason: "unresolvable" };

	// A NUL byte terminates a C string, so the path the OS sees can be a PREFIX of the one
	// checked here. Node/Bun's own `writeFile` refuses such a path, so this is not currently
	// an escape — but the refusal would arrive as an unhandled TypeError from deep inside the
	// write, after this function had already answered `allowed: true` and after the caller
	// took a write claim on the truncated name. Refused here so the divergence between "the
	// path we validated" and "the path anything downstream would act on" cannot exist at all.
	if (trimmed.includes("\0")) return { allowed: false, reason: "unresolvable" };

	// A trailing separator means the caller named a DIRECTORY, which is not a file to
	// write. Tested on the raw input, before `resolve()`: resolve strips the separator, so
	// checking afterwards can never fire — the earlier version of this guard was dead
	// code that silently accepted `<worktree>/src/` and would have tried to write it.
	if (/[\\/]$/.test(trimmed)) return { allowed: false, reason: "unresolvable" };

	const absolute = resolve(trimmed);

	const roots = allowedRoots.map((root) => root.trim()).filter(Boolean);

	// ── Physical resolution ──────────────────────────────────────────────
	// Always resolved, even when the path is outside allowed roots. Without
	// this, a path that is BOTH outside-roots AND a secret/symlink-escape would
	// get the weaker `outside-allowed-roots` verdict (which is confirmable),
	// hiding the harder refusal behind it. The fix: resolve first, refuse hard
	// problems unconditionally, then decide allowed vs confirmable last.
	const physical = physicalPath(absolute);
	if (physical === null) return { allowed: false, reason: "unresolvable" };

	// ── Secret-path check (unconditional) ────────────────────────────────
	// Run on BOTH the resolved AND the requested spelling, before any
	// containment test. A secret path must never become confirmable — a user
	// "confirming" a write to the JWT secret is one misclick from platform
	// compromise, and for a symlinked path the user cannot even see where
	// the bytes really land.
	if (isSecretPlatformPath(physical) || isSecretUserPath(physical, homedir())) {
		return { allowed: false, reason: "secret-path" };
	}
	if (isSecretPlatformPath(absolute) || isSecretUserPath(absolute, homedir())) {
		return { allowed: false, reason: "secret-path" };
	}

	// ── Git directory check (unconditional) ──────────────────────────────
	// Alongside the secret check and before any containment test, for the same
	// two reasons: `.git/` is INSIDE the worktree, so containment would permit
	// it, and a hook write is not something a user can meaningfully consent to
	// (they see "a text file in my project", not "code git runs on my next
	// commit"). Both spellings are tested because a symlink can name the git
	// directory without `.git` appearing in the requested path, and a
	// requested `.git` path can resolve elsewhere.
	if (namesGitDirectory(physical) || namesGitDirectory(absolute)) {
		return { allowed: false, reason: "git-internal" };
	}

	// Empty roots after the hard checks: no workspace means no business writing,
	// and the path is not confirmable either (there is nothing to confirm against).
	if (roots.length === 0) return { allowed: false, reason: "outside-allowed-roots" };

	// ── Lexical containment ──────────────────────────────────────────────
	const lexicallyInside = roots.some((root) => isContained(root, absolute));

	// ── Physical containment against resolved roots ──────────────────────
	// Every root is tried: a path may be lexically inside root A while
	// physically landing inside root B, which is still a permitted destination.
	const physicallyContained = roots.some((root) => {
		const physicalRoot = physicalPath(root);
		return physicalRoot !== null && isContained(physicalRoot, physical);
	});

	// Lexically inside a root but physically outside: a symlink escape. This is
	// a hard refusal — the user sees a worktree-relative path but the bytes land
	// somewhere else, so "confirm" would be consenting to a destination they
	// cannot see.
	if (lexicallyInside && !physicallyContained) {
		return { allowed: false, reason: "escapes-via-symlink" };
	}

	// Fully contained (lexically + physically): the normal allowed case.
	if (lexicallyInside && physicallyContained) {
		return { allowed: true, physicalPath: physical };
	}

	// Not lexically inside any root. If the physical path IS inside a root, this
	// is still fine — a resolved symlink landing inside the worktree is safe.
	if (physicallyContained) {
		return { allowed: true, physicalPath: physical };
	}

	// Outside all roots both lexically and physically, but the path resolved
	// successfully and is not a secret. This is the one case where a user can
	// meaningfully consent: they see the real absolute path and choose to proceed.
	return {
		allowed: false,
		reason: "outside-allowed-roots",
		physicalPath: physical,
		confirmable: true,
	};
}

/** Human-facing explanation for a refusal, used in the 403 body. */
export function describeWriteRefusal(reason: WriteRefusalReason): string {
	switch (reason) {
		case "outside-allowed-roots":
			return "This path is outside the workspace and any directory configured as writable.";
		case "escapes-via-symlink":
			return "This path resolves through a link to a location outside the workspace.";
		case "secret-path":
			return "This file holds credentials and cannot be written through the file API.";
		case "git-internal":
			return "This path is inside the git directory, which cannot be written through the file API.";
		case "unresolvable":
			return "This path does not name a writable file.";
	}
}
