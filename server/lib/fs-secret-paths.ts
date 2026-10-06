/**
 * fs-secret-paths.ts — refuse to serve credential-bearing files over `/api/fs/*`.
 *
 * ## Why a deny-list rather than an allow-list
 *
 * `/api/fs/preview` and `/api/fs/download` take an absolute path and serve it. An
 * allow-list is the shape one wants, and it is not available here: a project's
 * `gitPath` is arbitrary (the user picks it in the directory browser), worktrees
 * live under it, and the file viewer also legitimately opens platform files
 * OUTSIDE any project — request dumps under `~/.narrafork/malformed-request-dumps`,
 * truncated tool output, subagent conclusions. Enumerating "everything a viewer may
 * open" would either break those paths or grow into a second copy of the whole data
 * layout.
 *
 * So this bounds the blast radius instead: the files whose disclosure escalates a
 * logged-in reader into the platform's own credentials. Those DO have a small,
 * stable, enumerable shape, because this repo writes them.
 *
 * ## What this is not
 *
 * Not a sandbox. A reader authenticated with a session JWT can still fetch ordinary
 * files anywhere the server process can read, which is the existing (deliberate)
 * trust model of the file browser — `/api/fs/browse` has always listed the whole
 * filesystem. This only ensures that "read any file" cannot be turned into "become
 * the platform": tokens, the JWT signing secret, and the database that holds every
 * user's password hash.
 *
 * Applied to preview AND download. Preview's 1MB text cap is not a mitigation —
 * `settings.json` and a credentials file are a few KB.
 */

import { relative as relativePath, resolve } from "node:path";
import { isInsidePath } from "./platform-path";
import { narraforkDir } from "./settings";

/**
 * Files under the NarraFork home whose contents are credentials.
 *
 * Matched on the resolved basename within the home directory rather than by suffix,
 * so a project file that happens to be called `settings.json` stays readable.
 *
 * `narrafork.db` covers `-wal` / `-shm` / `.bak` through the prefix check below:
 * the WAL holds recently written rows verbatim, so serving it discloses the same
 * password hashes and OAuth grants the main file does.
 */
const SECRET_HOME_FILES: readonly string[] = [
	"settings.json", // holds auth.jwtSecret — forging any user's session
	"codex-credentials.json",
	"update-server.json",
	"update-server-test.json",
	"narrafork.lock",
];

/** Private protocol state must not be exposed or rewritten through generic file APIs.
 * Editor transfers include other users' immutable documents and durable recovery metadata;
 * the dedicated authenticated/versioned routes are their only browser entry. */
const SECRET_HOME_DIRS: readonly string[] = ["editor-transfers"];

/** Home-relative prefixes: the database and every sidecar spelling of it. */
const SECRET_HOME_PREFIXES: readonly string[] = ["narrafork.db"];

/**
 * A path whose bytes would hand over platform credentials.
 *
 * `dir` is injectable so the tests do not depend on the runner's real home.
 */
export function isSecretPlatformPath(absPath: string, dir: string = narraforkDir): boolean {
	const home = resolve(dir);
	const target = resolve(absPath);
	// Outside the NarraFork home there is nothing this module claims to know about.
	// `isInsidePath` is the repo's own boundary check, so a symlinked or
	// differently-cased spelling of the home resolves the same way it does elsewhere.
	if (!isInsidePath(home, target)) return false;

	// `path.relative` rather than slicing by length: `isInsidePath` compares
	// NORMALIZED paths, so a case- or separator-differing spelling can pass the
	// boundary check while its raw length no longer lines up with the home's.
	const relative = relativePath(home, target);
	if (!relative) return false;
	const segments = relative.split(/[\\/]/);
	const first = segments[0] ?? "";

	if (segments.length === 1) {
		if (SECRET_HOME_FILES.includes(first)) return true;
		if (SECRET_HOME_PREFIXES.some((prefix) => first.startsWith(prefix))) return true;
		return false;
	}
	// A directory match covers everything beneath it: a token store's layout is the
	// provider's business and may gain files this list has never heard of.
	return SECRET_HOME_DIRS.includes(first);
}

/**
 * Also refuse the well-known credential stores of OTHER tools in the user's home.
 *
 * The server runs as the user, so `~/.ssh/id_rsa` and `~/.aws/credentials` are as
 * readable as anything else. They are not NarraFork's secrets, but serving them
 * through an authenticated endpoint of NarraFork's makes NarraFork the vector.
 *
 * Deliberately short and matched on directory: the goal is the handful of stores
 * whose disclosure is immediately catastrophic, not a general secret scanner.
 */
const SECRET_USER_DIRS: readonly string[] = [".ssh", ".aws", ".gnupg", ".kube"];

/** A path inside a well-known third-party credential store under `home`. */
export function isSecretUserPath(absPath: string, home: string): boolean {
	const base = resolve(home);
	const target = resolve(absPath);
	if (!isInsidePath(base, target)) return false;
	const relative = relativePath(base, target);
	if (!relative) return false;
	const first = relative.split(/[\\/]/)[0] ?? "";
	// Only when it is a real path segment, so a file literally named `.ssh` in the
	// home directory is not mistaken for the directory.
	return SECRET_USER_DIRS.includes(first) && relative.length > first.length;
}

/** Message used by both routes, so the two cannot describe the refusal differently. */
export const SECRET_PATH_REFUSAL = "This file is not readable through the file API";
