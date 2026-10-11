import { posix, win32 } from "node:path";
import { isFullyQualifiedWindowsPath, validateWindowsPath } from "@shared/target-native-path";
import type { PathFlavor } from "./types";

export function detectPathFlavor(path: string): PathFlavor {
	const value = path;
	return /^[a-zA-Z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || value.includes("\\")
		? "windows"
		: "posix";
}

export function normalizePathKey(
	path: string,
	flavor: PathFlavor = detectPathFlavor(path),
): string {
	const value = path;
	if (!value) throw new Error("Directory rule path cannot be empty");
	if (flavor === "windows") {
		validateWindowsPath(value);
		const normalized = win32.normalize(value).replaceAll("\\", "/");
		const root = win32.parse(value).root.replaceAll("\\", "/");
		return normalized === root ? normalized : normalized.replace(/\/+$/u, "");
	}
	const normalized = posix.normalize(value);
	return normalized === "/" ? normalized : normalized.replace(/\/+$/u, "");
}

export function normalizeDirectoryPath(
	path: string,
	pathFlavor?: PathFlavor | null,
): { path: string; pathFlavor: PathFlavor; pathKey: string } {
	const normalizedPath = path;
	const flavor = pathFlavor ?? detectPathFlavor(normalizedPath);
	const absolute =
		flavor === "windows"
			? isFullyQualifiedWindowsPath(normalizedPath)
			: posix.isAbsolute(normalizedPath);
	if (!absolute) throw new Error(`Directory rule path must be absolute for ${flavor} targets`);
	return {
		path: normalizedPath,
		pathFlavor: flavor,
		pathKey: normalizePathKey(normalizedPath, flavor),
	};
}

export function pathKeyContains(parentKey: string, childKey: string, flavor: PathFlavor): boolean {
	if (parentKey === childKey) return true;
	if (flavor === "windows" && /^[a-z]:\/$/iu.test(parentKey)) return childKey.startsWith(parentKey);
	if (flavor === "posix" && parentKey === "/") return childKey.startsWith("/");
	return childKey.startsWith(`${parentKey}/`);
}
