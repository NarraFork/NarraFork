/**
 * file-menu-target.ts — what a file row's menu acts on, and the paths derived from it.
 *
 * Split out of `FileContextMenu.tsx` so the derivation is testable as plain arithmetic:
 * the menu component itself pulls in Mantine, notifications and four API calls, and the
 * question "does paste land in the right directory" should not need any of that to answer.
 *
 * The tree composes paths as `${root}/${relativePath}` where `relativePath` is always
 * `/`-separated, but `root` is whatever the narrator's cwd is — on Windows that is
 * `E:\repo`, backslashes included. So the helpers below split on the `/` the tree itself
 * inserted and leave the root's own separators alone. `node:path` is not available in the
 * browser build, and normalizing the root here would change the path the server resolves.
 */

/** The row the menu was opened on. A file, never a directory — see `FileTreeContent`. */
export interface FileMenuTarget {
	/** Absolute path, as the tree composes it from its root and the entry's relative path. */
	absolutePath: string;
	/** Worktree-relative path, `/`-separated. */
	relativePath: string;
	name: string;
}

/**
 * The directory holding `absolutePath`, in the same mixed-separator spelling the tree
 * builds. A path with no separator is returned unchanged: there is no directory to name.
 */
export function fileMenuDirectory(absolutePath: string): string {
	const slash = absolutePath.lastIndexOf("/");
	return slash > 0 ? absolutePath.slice(0, slash) : absolutePath;
}

/** The tree-relative directory holding `relativePath`, or "" for the root level. */
export function fileMenuRelativeDirectory(relativePath: string): string {
	const slash = relativePath.lastIndexOf("/");
	return slash > 0 ? relativePath.slice(0, slash) : "";
}
