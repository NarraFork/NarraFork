import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { logger } from "./logger";

/**
 * Filenames scanned for project-level instructions, in priority order.
 *
 * `AGENTS.override.md` is the Codex convention for a local-only override that
 * is not committed. `AGENTS.md` is the cross-tool standard (OpenAI-originated,
 * now stewarded by the Linux Foundation's Agentic AI Foundation). `AGENT.md`
 * (singular) is a deprecated early proposal kept for backward compatibility,
 * and `CLAUDE.md` is the Claude Code name.
 */
export const PROJECT_PROMPT_FILENAMES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENT.md",
	"CLAUDE.md",
] as const;

/**
 * Whether `candidate` is `root` itself or sits underneath it.
 *
 * Same shape as `plugin-ui-assets`'s `contained` and `uploads`'s `isWithinDir`, and for
 * the same reason: a `startsWith` prefix test accepts `/home/foo-evil` as being inside
 * `/home/foo`, because the shared prefix does not end at a separator. `relative()` gives
 * the answer with the boundary built in — anything outside comes back starting with
 * `..${sep}` (or being exactly `..`).
 */
function isContained(root: string, candidate: string): boolean {
	const remainder = relative(resolve(root), resolve(candidate));
	return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

/**
 * The physical path `candidate` names, with every symlink in it resolved.
 *
 * A candidate need not exist — the write path creates it — so `realpathSync` cannot be
 * called on it directly. The deepest existing ANCESTOR is resolved instead and the
 * missing tail re-appended. That is sound rather than approximate: the tail's segments do
 * not exist, so none of them can be a symlink, and `resolve()` has already collapsed
 * every `..`, so no segment can climb back out.
 *
 * The candidate itself is resolved when it exists, because a symlinked FILE is the case
 * that matters most here: `writeFile` follows it, so `~/.agents/AGENTS.md → /etc/passwd`
 * writes to `/etc/passwd` while every directory on the way stayed inside home.
 *
 * Returns null when nothing on the path can be resolved (an unreadable ancestor), which
 * callers must treat as "not provably contained" rather than as containment.
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
			// Root reached without resolving anything.
			if (parent === current) return null;
			tail.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * Whether `candidate` is inside the home directory both lexically and physically.
 *
 * The lexical test alone is not a boundary for anything that WRITES: `relative()` judges
 * the string it is given, so a symlink anywhere along the path — `~/.agents` pointing at
 * `/etc`, or `~/.agents/AGENTS.md` pointing at a systemd unit — satisfies it while naming
 * a file outside home.
 *
 * Both tests are kept rather than only the physical one: `realpathSync` reports where a
 * path lands and cannot, on its own, tell an escape apart from a resolution failure. The
 * lexical check is what rejects a path whose ancestors are unreadable, where
 * {@link physicalPath} returns null.
 */
function isInsideHome(candidate: string): boolean {
	const home = homedir();
	if (!isContained(home, candidate)) return false;
	const physical = physicalPath(candidate);
	if (physical === null) return false;
	// The home directory itself may be reached through a symlink (`/home/u` →
	// `/mnt/data/u`), so the root is resolved too, or every candidate would look like an
	// escape on such a system.
	const physicalHome = physicalPath(home);
	if (physicalHome === null) return false;
	return isContained(physicalHome, physical);
}

/**
 * Whether the global prompt endpoint may WRITE to `candidate`.
 *
 * Separate from {@link getGlobalPromptCandidates} on purpose, because reading and writing
 * do not deserve the same rule:
 *
 *   - Reading a symlink that leaves home is the user's own arrangement. Keeping the
 *     instruction file in a dotfiles checkout outside `$HOME` and linking it into
 *     `~/.agents/` is a normal setup, and refusing to READ it would break a working
 *     configuration to protect nothing — the content is already the user's to supply.
 *   - Writing through that same symlink is an arbitrary-file write. `writeFile` follows
 *     the link, so a target that resolves to `/etc/crontab` is a write to `/etc/crontab`
 *     performed by the server process, with a body taken straight from the request.
 *
 * So the candidate list stays permissive and this predicate guards the PUT. A refusal is
 * a 4xx the admin can act on, not a silent redirect to a different file: overwriting a
 * path the caller did not name would be the worse failure of the two.
 *
 * Membership in the candidate list is checked here as well, so the route cannot satisfy
 * one half of the rule and forget the other.
 */
export function isWritableGlobalPromptPath(candidate: string): boolean {
	const absolute = resolve(candidate);
	if (!getGlobalPromptCandidates().includes(absolute)) return false;
	return isInsideHome(absolute);
}

/**
 * Resolve the Codex home directory, honoring `CODEX_HOME` when set.
 * Mirrors how `skill-service` discovers `~/.codex/skills`.
 *
 * The override is constrained to the user's home directory, because this list is the
 * starting point for the write allowlist of `PUT /api/routines/global-prompt`: an
 * unconstrained `CODEX_HOME` (`/etc`, `/usr/lib/systemd/system`, a git hooks directory)
 * would put those directories one step away from being writable. Traversal is covered by
 * the same check, since `resolve()` has already collapsed `..` segments before containment
 * is judged.
 *
 * A rejected override is ignored rather than fatal: the default `~/.codex` remains a
 * correct answer, and refusing to start the server over a misconfigured environment
 * variable would be a worse outcome than reading the standard location. It is logged
 * because the alternative is a silently ignored setting.
 *
 * The test here is lexical, and that is now sufficient: writes are additionally gated by
 * {@link isWritableGlobalPromptPath}, which resolves symlinks. Judging the override
 * physically as well would refuse to READ a perfectly ordinary setup — an instruction file
 * kept in a dotfiles checkout outside `$HOME` and linked into place — for no gain, since
 * the content is the user's own either way.
 */
function codexHome(): string {
	const fallback = join(homedir(), ".codex");
	const override = process.env.CODEX_HOME?.trim();
	if (!override) return fallback;
	const resolved = resolve(override);
	if (!isContained(homedir(), resolved)) {
		logger.warn("Ignoring CODEX_HOME: it resolves outside the home directory", {
			codexHome: override,
			resolved,
			home: homedir(),
			// Named so the log says WHY it matters rather than only that it happened.
			reason: "global prompt candidates feed the write allowlist",
		});
		return fallback;
	}
	return resolved;
}

/**
 * Global instruction file candidates, in priority order. The first existing
 * file wins.
 *
 * Order rationale: `.agents/` is the emerging vendor-neutral directory
 * convention and holds the canonical global location per the Agents Standard,
 * so it leads. `.codex/` follows because Codex reads `AGENTS.override.md` then
 * `AGENTS.md` from `$CODEX_HOME` (default `~/.codex`). `.claude/CLAUDE.md`
 * comes last as the tool-specific legacy name.
 *
 * Computed per call rather than cached at module load so that a `CODEX_HOME`
 * change is picked up without a restart.
 *
 * This is a READ order. It is not sufficient as a write allowlist on its own — see
 * {@link isWritableGlobalPromptPath}, which the PUT handler must use.
 */
export function getGlobalPromptCandidates(): string[] {
	const home = homedir();
	const codex = codexHome();
	const candidates = [
		join(home, ".agents", "AGENTS.override.md"),
		join(home, ".agents", "AGENTS.md"),
		join(home, ".agents", "AGENT.md"),
		join(codex, "AGENTS.override.md"),
		join(codex, "AGENTS.md"),
		join(home, ".claude", "CLAUDE.md"),
	];
	// A custom CODEX_HOME could collide with one of the other roots.
	return [...new Set(candidates)];
}
