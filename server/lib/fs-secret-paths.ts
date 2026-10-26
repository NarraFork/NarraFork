/**
 * fs-secret-paths.ts — refuse platform secrets and private state over generic file APIs.
 *
 * ## Why a deny-list rather than an allow-list
 *
 * `/api/fs/preview` and `/api/fs/download` take an absolute path and serve it. An
 * allow-list is the shape one wants, and it is not available here: a project's
 * `gitPath` is arbitrary (the user picks it in the directory browser), worktrees
 * live under it, and the file viewer also legitimately opens platform files
 * OUTSIDE any project — legacy request dumps under `~/.narrafork/malformed-request-dumps`,
 * truncated tool output, subagent conclusions. Enumerating "everything a viewer may
 * open" would either break those paths or grow into a second copy of the whole data
 * layout.
 *
 * So this bounds the blast radius instead: the files whose disclosure escalates a
 * logged-in reader into the platform's own credentials, plus platform-managed
 * private state whose dedicated routes enforce narrator ACLs. These have a small,
 * stable, enumerable shape, because this repo writes them.
 *
 * ## What this is not
 *
 * Not a sandbox. A reader authenticated with a session token can still fetch ordinary
 * files anywhere the server process can read, which is the existing (deliberate)
 * trust model of the file browser — `/api/fs/browse` has always listed the whole
 * filesystem. This only ensures that "read any file" cannot be turned into "become
 * the platform": tokens, the JWT signing secret, and the database that holds every
 * user's password hash. Private request recordings are also denied: serving them
 * through a generic path would bypass the owning narrator's ACL.
 *
 * Applied to preview AND download. Preview's 1MB text cap is not a mitigation —
 * `settings.json` and a credentials file are a few KB.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, relative as relativePath, resolve } from "node:path";
import { isInsidePath } from "./platform-path";
import { REQUEST_RECORDING_DIR, REQUEST_RECORDING_SAVED_DIR } from "./request-recorder-protocol";
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
	"settings.json", // holds auth.jwtSecret — forging MFA challenges and internal signatures
	"codex-credentials.json",
	"update-server.json",
	"update-server-test.json",
	"narrafork.lock",
];

/** Recorder contents span private narrators; only the narrator-ACL download API may serve them. */
const PRIVATE_RECORDING_DIRS: readonly string[] = [
	REQUEST_RECORDING_DIR,
	REQUEST_RECORDING_SAVED_DIR,
	// Legacy cross-user maintenance data; private until the startup cleanup removes it.
	"token-repair-jobs",
];

/** Private protocol state must not be exposed or rewritten through generic file APIs.
 * Editor transfers include other users' immutable documents and durable recovery metadata;
 * recording directories contain private conversations across the whole instance. */
const SECRET_HOME_DIRS: readonly string[] = [
	"editor-transfers",
	"editor-native",
	"editor-native-operations",
	...PRIVATE_RECORDING_DIRS,
];

function physicalOrLexicalPath(path: string): string {
	let current = resolve(path);
	const suffix: string[] = [];
	// A missing leaf must not hide an existing symlinked parent from a write/share guard.
	for (let depth = 0; depth <= 128; depth++) {
		try {
			return resolve(realpathSync(current), ...suffix);
		} catch {
			const parent = dirname(current);
			if (parent === current) break;
			suffix.unshift(basename(current));
			current = parent;
		}
	}
	return resolve(path);
}

/** Also checks physical targets, so a symlink outside the home cannot bypass the recording ACL.
 * Sharing an ancestor directory must be refused too, because its archive includes private data. */
// Historical name retained for share API callers; this covers all private
// platform protocol directories, not only request recordings.
export function isPrivateRequestRecordingPath(
	absPath: string,
	dir: string = narraforkDir,
	includeAncestors = false,
): boolean {
	const target = resolve(absPath);
	const physicalTarget = physicalOrLexicalPath(target);
	const physicalHome = physicalOrLexicalPath(dir);
	return SECRET_HOME_DIRS.some((name) => {
		const root = resolve(dir, name);
		const physicalRoot = physicalOrLexicalPath(resolve(physicalHome, name));
		return (
			isInsidePath(root, target) ||
			isInsidePath(physicalRoot, physicalTarget) ||
			(includeAncestors &&
				(isInsidePath(target, root) || isInsidePath(physicalTarget, physicalRoot)))
		);
	});
}

/** Home-relative prefixes: the database and every sidecar spelling of it. */
const SECRET_HOME_PREFIXES: readonly string[] = ["narrafork.db"];

// Case-folded forms of the secret leaves. The Win32 path layer opens `Settings.json`,
// `settings.json.` (trailing dot) and `settings.json ` (trailing space) as the same
// file, and NTFS alternate data streams (`settings.json::$DATA`) read the file's own
// bytes — a case-sensitive, verbatim basename comparison missed all of them.
const SECRET_HOME_FILES_LOWER: ReadonlySet<string> = new Set(
	SECRET_HOME_FILES.map((name) => name.toLowerCase()),
);
const SECRET_HOME_PREFIXES_LOWER: readonly string[] = SECRET_HOME_PREFIXES.map((prefix) =>
	prefix.toLowerCase(),
);
const SECRET_HOME_DIRS_LOWER: ReadonlySet<string> = new Set(
	SECRET_HOME_DIRS.map((name) => name.toLowerCase()),
);

/**
 * Collapse a path leaf to the name the filesystem would actually open, then fold case.
 *
 * Strips an NTFS alternate-data-stream suffix (`name::$DATA`, `name:stream`) and the
 * trailing dots/spaces the Win32 layer discards before opening, so every spelling that
 * resolves to a secret file compares equal to it. Over-matching here is deliberate: a
 * POSIX file literally named `settings.json:x` is not a legitimate platform file, and
 * refusing it fails closed.
 */
function normalizeSecretLeaf(name: string): string {
	let leaf = name;
	const streamIndex = leaf.indexOf(":");
	if (streamIndex >= 0) leaf = leaf.slice(0, streamIndex);
	leaf = leaf.replace(/[. ]+$/, "");
	return leaf.toLowerCase();
}

/** Whether `target` is a secret leaf/prefix/dir directly under the NarraFork `home`. */
function matchesSecretHomeLeaf(home: string, target: string): boolean {
	// `isInsidePath` is the repo's own boundary check, so a symlinked or
	// differently-cased spelling of the home resolves the same way it does elsewhere.
	if (!isInsidePath(home, target)) return false;

	// `path.relative` rather than slicing by length: `isInsidePath` compares
	// NORMALIZED paths, so a case- or separator-differing spelling can pass the
	// boundary check while its raw length no longer lines up with the home's.
	const relative = relativePath(home, target);
	if (!relative) return false;
	const segments = relative.split(/[\\/]/);
	const first = normalizeSecretLeaf(segments[0] ?? "");
	if (!first) return false;

	if (segments.length === 1) {
		if (SECRET_HOME_FILES_LOWER.has(first)) return true;
		if (SECRET_HOME_PREFIXES_LOWER.some((prefix) => first.startsWith(prefix))) return true;
		return false;
	}
	// A directory match covers everything beneath it: a token store's layout is the
	// provider's business and may gain files this list has never heard of.
	return SECRET_HOME_DIRS_LOWER.has(first);
}

/**
 * A path whose bytes would hand over platform credentials.
 *
 * `dir` is injectable so the tests do not depend on the runner's real home.
 *
 * Checked against BOTH the lexical path and its real (symlink/junction-resolved)
 * physical path: a link or an 8.3 short name (`SETTIN~1.JSO`) whose real target is a
 * secret file must be refused by the name the filesystem would actually open, not only
 * by the spelling the caller passed.
 */
export function isSecretPlatformPath(absPath: string, dir: string = narraforkDir): boolean {
	if (isPrivateRequestRecordingPath(absPath, dir)) return true;
	// Outside the NarraFork home there is nothing this module claims to know about.
	const lexicalHome = resolve(dir);
	const lexicalTarget = resolve(absPath);
	if (matchesSecretHomeLeaf(lexicalHome, lexicalTarget)) return true;

	const physicalHome = physicalOrLexicalPath(dir);
	const physicalTarget = physicalOrLexicalPath(absPath);
	return matchesSecretHomeLeaf(physicalHome, physicalTarget);
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

/**
 * Refusal surfaced to the agent when a tool call targets a platform secret.
 *
 * This is an application authorization guard, not an OS sandbox: it is enforced in
 * EVERY permission mode (bypassPermissions included), because disclosing these bytes
 * escalates the agent into the platform's own credentials.
 */
export const SECRET_PATH_TOOL_REFUSAL =
	"Access to NarraFork platform secrets (settings.json, narrafork.db, credential stores) is not permitted.";
