/**
 * Unified terminal runtime interface.
 *
 * Both the Bun.Terminal (Unix) and bun-pty (Windows) backends implement this
 * so that terminal-service never touches platform-specific PTY APIs directly.
 */

export interface TerminalRuntime {
	/** Write data to the PTY stdin. */
	write(data: string | Uint8Array): void;
	/** Resize the PTY. */
	resize(cols: number, rows: number): void;
	/** Close the PTY (release resources). */
	close(): void;
	/** Kill the child process. */
	kill(): void;
	/** PID of the child process (null if not yet spawned or already exited). */
	readonly pid: number | null;
	/** Resolves when the child process exits. */
	readonly exited: Promise<number | null>;
	/** Optional startup barrier used by remote runtimes before input may be sent. */
	readonly ready?: Promise<void>;
}

export interface TerminalSpawnOptions {
	cmd: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	cols: number;
	rows: number;
	onData: (data: string) => void;
}
