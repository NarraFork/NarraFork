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
 * Returns `"/"` (or the drive root on Windows, e.g. `"C:/"`) when the
 * input is a root path.
 */
export function stripTrailingSlash(p: string): string {
	return p.replace(/[/\\]+$/, "") || "/";
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
 * Check whether `child` is equal to or nested inside `parent`.
 * Both paths are resolved & normalised with forward slashes first.
 */
export function isInsidePath(parent: string, child: string): boolean {
	const p = stripTrailingSlash(resolvePath(parent));
	const c = resolvePath(child);
	return c === p || c.startsWith(`${p}/`);
}
