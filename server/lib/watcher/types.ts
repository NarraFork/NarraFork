/**
 * Watcher type definitions.
 *
 * Modelled after VS Code's watcher interfaces
 * (`vs/platform/files/common/watcher.ts`), simplified for NarraFork's
 * single use-case: recursive worktree monitoring via @parcel/watcher.
 */

// ── File change types ───────────────────────────────────────────────────────

export const FileChangeType = {
	ADDED: 1,
	UPDATED: 2,
	DELETED: 3,
} as const;

export type FileChangeType = (typeof FileChangeType)[keyof typeof FileChangeType];

export interface IFileChange {
	readonly type: FileChangeType;
	readonly path: string;
}

// ── Log message ─────────────────────────────────────────────────────────────

export interface ILogMessage {
	readonly level: "trace" | "warn" | "error" | "info" | "debug";
	readonly message: string;
}
