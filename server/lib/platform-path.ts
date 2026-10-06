/**
 * Cross-platform path utilities.
 *
 * `node:path` `normalize()` / `resolve()` return OS-native separators
 * (`\` on Windows, `/` elsewhere).  Many places in the codebase compare
 * resolved paths with hard-coded `/` which silently breaks on Windows.
 *
 * Existing callers use `toForwardSlash()` to present host-native paths with `/`.
 * Canonical identity comparisons must use `pathsEqualForOS()` so POSIX filename
 * backslashes remain literal while Windows keeps its separator/case semantics.
 */

/**
 * Replace every `\\` with `/`.
 *
 * Use for existing host-native/display comparisons. Do not use it for a
 * canonical identity comparison when the target OS may be POSIX.
 */
export function toForwardSlash(p: string): string {
	return p.replaceAll("\\", "/");
}

/**
 * Strip trailing slashes (both `/` and `\`) from a path string.
 * Preserves filesystem roots such as `/` and `C:/`.
 */
export function stripTrailingSlash(p: string): string {
	const normalized = toForwardSlash(p);
	if (normalized === "/") return "/";
	if (/^[a-zA-Z]:\/$/.test(normalized)) return normalized;
	return normalized.replace(/\/+$/, "");
}

/**
 * Resolve + normalise a path, then convert to forward slashes.
 * Drop-in replacement for `normalize(resolve(base, rel))` that is
 * safe for cross-platform string comparison.
 */
import { normalize, posix, resolve, win32 } from "node:path";

export function resolvePath(...segments: string[]): string {
	return toForwardSlash(normalize(resolve(...segments)));
}

/**
 * Normalize a path for string comparison.
 * On Windows (or Windows-style paths), comparisons should be case-insensitive.
 */
export function normalizePathForComparison(p: string): string {
	const normalized = stripTrailingSlash(resolvePath(p));
	if (
		process.platform === "win32" ||
		/^[a-zA-Z]:/.test(normalized) ||
		normalized.startsWith("//")
	) {
		return normalized.toLowerCase();
	}
	return normalized;
}

/** Compare two paths using platform-aware normalization rules. */
export function pathsEqual(a: string, b: string): boolean {
	return normalizePathForComparison(a) === normalizePathForComparison(b);
}

/**
 * Normalize a canonical path using the path grammar of the backend OS.
 *
 * Unlike `toForwardSlash`, POSIX mode preserves `\\` because it is a valid
 * filename character. Windows mode accepts both separators and folds case.
 */
export function normalizePathForOS(path: string, os: string): string {
	const windows = os === "win32" || os === "windows";
	const pathImpl = windows ? win32 : posix;
	const normalized = pathImpl.normalize(path);
	const comparable = windows ? normalized.replaceAll("\\", "/") : normalized;
	const root = pathImpl.parse(normalized).root;
	const comparableRoot = windows ? root.replaceAll("\\", "/") : root;
	const withoutTrailing =
		comparable === comparableRoot ? comparable : comparable.replace(/\/+$/, "");
	return windows ? withoutTrailing.toLowerCase() : withoutTrailing;
}

/** Compare canonical paths using the target backend's path grammar. */
export function pathsEqualForOS(a: string, b: string, os: string): boolean {
	return normalizePathForOS(a, os) === normalizePathForOS(b, os);
}

/**
 * Check whether `child` is equal to or nested inside `parent`.
 * Both paths are resolved & normalised with forward slashes first.
 */
export function isInsidePath(parent: string, child: string): boolean {
	const p = normalizePathForComparison(parent);
	const c = normalizePathForComparison(child);
	if (c === p) return true;
	// Filesystem roots already end with "/" — avoid double-slash in prefix check
	if (p === "/" || /^[a-zA-Z]:\/$/.test(p)) return c.startsWith(p);
	return c.startsWith(`${p}/`);
}
