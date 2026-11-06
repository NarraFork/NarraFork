/**
 * Per-execution-device working directories for one narrator.
 *
 * A narrator keeps one directory *per execution device*. Switching from the
 * server to a remote machine has to restore whatever directory was last used on
 * that machine instead of reusing a path that only exists on the other one, so
 * the map is both the restore source for a switch and the only thing the UI may
 * consult to decide whether a device still needs its directory entered.
 *
 * `narrators.cwd` / `narrators.defaultDeviceId` keep their existing meaning —
 * "the currently effective directory / device" — so every pre-existing reader
 * (project index, revert planner, permission-rule paths) is unaffected.
 *
 * Deliberately dependency-free: this module is imported by both the server and
 * the frontend, so it must not reach for `node:path` or any Bun API.
 */

/** Path grammar of one device. Persisted, never re-derived from the host OS. */
export type WorkspacePathFlavor = "posix" | "windows";

export interface WorkspaceDirectoryEntry {
	/** Absolute path in that device's own grammar. */
	cwd: string;
	/**
	 * Grammar the path was recorded under.
	 *
	 * Stored rather than derived at read time because the device may be offline
	 * when the entry is used, and a Windows path must never be validated with
	 * POSIX rules (a posix `isAbsolute("C:\\a")` is false, which used to make a
	 * remote Windows cwd look like a relative path).
	 */
	pathFlavor: WorkspacePathFlavor;
}

/** deviceId → that device's working directory. The server itself is `"local"`. */
export type WorkspaceDirectoryMap = Record<string, WorkspaceDirectoryEntry>;

/** Drive-letter (`C:\a`, `C:/a`), UNC (`\\server\share`) or rooted (`\a`) path. */
const WINDOWS_ABSOLUTE_PATTERN = /^(?:[a-zA-Z]:[\\/]|[\\/])/;

/** Normalize an untrusted flavor value; unknown values mean POSIX. */
export function normalizeWorkspacePathFlavor(value: unknown): WorkspacePathFlavor {
	return value === "windows" ? "windows" : "posix";
}

/**
 * Whether `cwd` is absolute in the given grammar.
 *
 * Pure string check on purpose: callers use it to decide *which* device's rules
 * apply before any device round-trip, and the local `isAbsolute` would answer a
 * different question for remote Windows paths.
 */
export function isAbsoluteForFlavor(cwd: string, flavor: WorkspacePathFlavor): boolean {
	if (!cwd) return false;
	if (flavor === "windows") return WINDOWS_ABSOLUTE_PATTERN.test(cwd);
	return cwd.startsWith("/");
}

/**
 * Best-effort guess for legacy entries that predate `pathFlavor`.
 *
 * A leading `/` is *not* evidence of Windows: it is a rooted Windows path but
 * also the only POSIX absolute form. Only a drive letter or a backslash is.
 */
function inferFlavorFromPath(cwd: string): WorkspacePathFlavor {
	return /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.includes("\\") ? "windows" : "posix";
}

function parseEntry(raw: unknown): WorkspaceDirectoryEntry | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
	if (!cwd) return null;
	const flavor =
		record.pathFlavor === "windows" || record.pathFlavor === "posix"
			? record.pathFlavor
			: inferFlavorFromPath(cwd);
	return { cwd, pathFlavor: flavor };
}

function parseJsonSource(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

/**
 * Tolerant reader for the persisted JSON column.
 *
 * Never throws: a malformed map must degrade to "no device has a directory"
 * (which the switch path turns into an explicit prompt) rather than break every
 * workspace read. Entries without a usable absolute-looking `cwd` are dropped.
 */
export function parseWorkspaceDirectoryMap(value: unknown): WorkspaceDirectoryMap {
	const source = typeof value === "string" ? parseJsonSource(value) : value;
	if (!source || typeof source !== "object" || Array.isArray(source)) return {};
	const result: WorkspaceDirectoryMap = {};
	for (const [deviceId, raw] of Object.entries(source as Record<string, unknown>)) {
		const key = deviceId.trim();
		if (!key) continue;
		const entry = parseEntry(raw);
		if (entry) result[key] = entry;
	}
	return result;
}

/** The recorded directory for one device, or null when it has none yet. */
export function readDeviceDirectory(
	map: WorkspaceDirectoryMap | null | undefined,
	deviceId: string,
): WorkspaceDirectoryEntry | null {
	const entry = map?.[deviceId];
	if (!entry?.cwd) return null;
	return { cwd: entry.cwd, pathFlavor: normalizeWorkspacePathFlavor(entry.pathFlavor) };
}

/** Immutable upsert; returns a new map and never mutates the input. */
export function withDeviceDirectory(
	map: WorkspaceDirectoryMap | null | undefined,
	deviceId: string,
	entry: WorkspaceDirectoryEntry,
): WorkspaceDirectoryMap {
	return {
		...parseWorkspaceDirectoryMap(map),
		[deviceId]: {
			cwd: entry.cwd,
			pathFlavor: normalizeWorkspacePathFlavor(entry.pathFlavor),
		},
	};
}

/** Immutable delete; returns a new map and never mutates the input. */
export function withoutDeviceDirectory(
	map: WorkspaceDirectoryMap | null | undefined,
	deviceId: string,
): WorkspaceDirectoryMap {
	const next = parseWorkspaceDirectoryMap(map);
	delete next[deviceId];
	return next;
}
