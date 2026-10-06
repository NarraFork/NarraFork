import type { SubagentFileChangesData } from "../measure/measure-subagent";

type FileLocation = Pick<
	SubagentFileChangesData["files"][number],
	"deviceId" | "workspacePath" | "filePath"
>;
type LocationLabels = { unknownDevice: string; unknownWorkspace: string };

/** Display only: never use these normalized strings as file/scope identity. */
function isWindowsPath(path: string): boolean {
	return /^[a-z]:[\\/]/i.test(path) || (!path.startsWith("/") && path.includes("\\"));
}

function slashPath(path: string): string {
	return isWindowsPath(path) ? path.replaceAll("\\", "/") : path;
}

function isRooted(path: string): boolean {
	return /^[\\/]/.test(path) || /^[a-z]:[\\/]/i.test(path);
}

/** Strip only a proven lexical directory boundary, never a look-alike prefix. */
function relativeFilePath(filePath: string, workspace: string | null | undefined): string {
	if (!workspace || !isRooted(workspace) || !isRooted(filePath)) return filePath;
	const file = slashPath(filePath);
	const root = slashPath(workspace).replace(/\/+$/, "");
	// Resolving `..` would need filesystem knowledge (symlinks, case sensitivity).
	if (file.split("/").includes("..") || root.split("/").includes("..")) return filePath;
	const prefix = `${root}/`;
	if (!file.startsWith(prefix) || file.length <= prefix.length) return filePath;
	const relative = filePath.slice(prefix.length);
	// An extra separator must not turn a shortened path into an apparent absolute path.
	return isRooted(relative) ? filePath : relative;
}

function fullFilePath(file: FileLocation): string {
	if (!file.workspacePath || isRooted(file.filePath) || /^[a-z]:/i.test(file.filePath)) {
		return file.filePath;
	}
	const root = file.workspacePath;
	const windows = isWindowsPath(root);
	const separator = windows && root.includes("\\") ? "\\" : "/";
	const hasSeparator = root.endsWith("/") || (windows && root.endsWith("\\"));
	return `${root}${hasSeparator ? "" : separator}${file.filePath}`;
}

/** Shortest distinct trailing directory sequence, with the full root as fallback. */
function workspaceNames(workspaces: string[]): Map<string, string> {
	const candidates = new Map<string, string[]>();
	const counts = new Map<string, number>();
	for (const workspace of workspaces) {
		const normalized = slashPath(workspace).replace(/\/+$/, "");
		const segments = normalized.split("/").filter(Boolean);
		const names = new Set<string>();
		for (let depth = 1; depth <= segments.length; depth++) {
			names.add(segments.slice(-depth).join("/"));
		}
		names.add(normalized || "/");
		candidates.set(workspace, [...names]);
		for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return new Map(
		workspaces.map((workspace) => [
			workspace,
			candidates.get(workspace)?.find((name) => counts.get(name) === 1) ?? workspace,
		]),
	);
}

/**
 * Derive labels from the FULL list before slicing visible rows, so expansion cannot
 * rename the first five files. Unknown location remains explicit, not assumed local.
 * Device IDs have no display-name metadata here, so keep them intact when needed.
 */
export function subagentFilePathDisplays(files: readonly FileLocation[], labels: LocationLabels) {
	const devices = new Set(files.map((file) => file.deviceId || null));
	const workspaces = new Set(files.map((file) => file.workspacePath || null));
	const names = workspaceNames([...workspaces].filter((path): path is string => path != null));
	return files.map((file) => {
		const location: string[] = [];
		if (!file.deviceId || devices.size > 1) {
			location.push(file.deviceId || labels.unknownDevice);
		}
		if (!file.workspacePath || workspaces.size > 1) {
			location.push(
				file.workspacePath
					? (names.get(file.workspacePath) ?? file.workspacePath)
					: labels.unknownWorkspace,
			);
		}
		return {
			path: relativeFilePath(file.filePath, file.workspacePath),
			location: location.join(" · "),
			title: `${file.deviceId || labels.unknownDevice} · ${file.workspacePath || labels.unknownWorkspace} · ${fullFilePath(file)}`,
		};
	});
}
