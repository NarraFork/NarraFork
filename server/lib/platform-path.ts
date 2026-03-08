/**
 * Cross-platform path utilities.
 *
 * `node:path` `normalize()` / `resolve()` return OS-native separators
 * (`\` on Windows, `/` elsewhere).  Many places in the codebase compare
 * resolved paths with hard-coded `/` which silently breaks on Windows.
 *
 * This module provides a single `toForwardSlash()` helper that converts
 * **all** backslashes to forward slashes so that every path comparison
 * in the project can use `/` consistently, regardless of OS.
 */

/**
 * Replace every `\` with `/`.
 *
 * Call this on the result of `path.resolve()` / `path.normalize()` before
 * doing any string comparison (`===`, `startsWith`, etc.).
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
import { normalize, resolve } from "node:path";

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
 * Check whether `child` is equal to or nested inside `parent`.
 * Both paths are resolved & normalised with forward slashes first.
 */
export function isInsidePath(parent: string, child: string): boolean {
	const p = normalizePathForComparison(parent);
	const c = normalizePathForComparison(child);
	return c === p || c.startsWith(`${p}/`);
}
