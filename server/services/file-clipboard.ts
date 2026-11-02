/**
 * file-clipboard.ts — put a server-side file on the clipboard of the machine NarraFork runs on.
 *
 * Why this is server work at all: browsers cannot put an arbitrary file on the clipboard.
 * `navigator.clipboard.write` accepts only a handful of MIME types (text, HTML, PNG), so a
 * `.jar`, a `.zip` or a `.pdf` can never be copied from the page — while the same file can be
 * copied with one OS call by the process that already has it on disk. The result is a real file
 * on the clipboard (`CF_HDROP` on Windows, a file URL elsewhere): something the user can paste
 * into Explorer / Finder / a file manager and get the file itself.
 *
 * That also fixes the visibility rule. The clipboard written here belongs to the machine the
 * SERVER runs on, so from a remote browser the user would see nothing happen. The menu item is
 * therefore only offered when the browser is local (`frontend/lib/local-origin.ts`), and the
 * route refuses a request that did not arrive from this machine.
 *
 * Every branch is bounded: no shell (arguments are passed as an argv array), a hard timeout, a
 * capped stderr capture, and a typed failure the route turns into an API error.
 */

import { IS_LINUX, IS_MACOS, IS_WINDOWS } from "../lib/platform";

/** Clipboard helpers talk to a desktop's IPC: slow, but never this slow. */
const CLIPBOARD_TIMEOUT_MS = 8_000;

/** How long a finished helper may keep its stderr open (xclip forks and keeps the fd). */
const STDERR_GRACE_MS = 300;

/** Cap on captured stderr. These tools print one line, not a log. */
const MAX_STDERR_CHARS = 2_048;

/** What Nautilus and Thunar paste as a file. `text/uri-list` alone is ignored by Nautilus. */
const GNOME_COPIED_FILES = "x-special/gnome-copied-files";

/** What Dolphin and most non-GNOME receivers paste as a file. */
const URI_LIST = "text/uri-list";

export class ClipboardCopyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClipboardCopyError";
	}
}

export interface ClipboardCommand {
	command: string;
	args: string[];
	/** Fed to the child's stdin, which is then closed. */
	stdin?: string;
}

export interface ClipboardCommandOptions {
	platform?: string;
	which?: (name: string) => string | null;
	/** Session variables. Defaults to the process environment. */
	env?: NodeJS.ProcessEnv;
}

/** PowerShell single-quoted literal: the value is taken verbatim, quotes doubled. */
function powershellLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** AppleScript double-quoted literal: backslash-escape the two characters it cannot hold. */
function appleScriptLiteral(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `file://` URL for a POSIX path, with every non-safe byte percent-encoded. */
function fileUrl(path: string): string {
	const encoded = path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `file://${encoded}`;
}

function desktopNames(env: NodeJS.ProcessEnv): string {
	return [env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.join(":")
		.toLowerCase();
}

/** KDE pastes `text/uri-list`. GNOME Files does not; it wants the gnome-copied-files target. */
function prefersUriList(env: NodeJS.ProcessEnv): boolean {
	const names = desktopNames(env);
	return names.includes("kde") || names.includes("plasma");
}

function linuxClipboardBody(path: string, env: NodeJS.ProcessEnv): { type: string; body: string } {
	const uri = fileUrl(path);
	if (prefersUriList(env)) return { type: URI_LIST, body: `${uri}\r\n` };
	// `copy` is the operation. A trailing newline is part of the format Nautilus writes.
	return { type: GNOME_COPIED_FILES, body: `copy\n${uri}\n` };
}

/**
 * Windows: put the file in the clipboard's file drop list (`CF_HDROP`), which is what makes a
 * paste in Explorer copy the file rather than its path.
 *
 * Not `Set-Clipboard -LiteralPath`, the obvious call, for two measured reasons: Windows
 * PowerShell 5.1 has it but PowerShell 7 does not (`-Path` is gone from 7 as well — it only
 * accepts `-Value`), so the same script cannot serve both shells. The WinForms call works in
 * both, and treats the value as a literal path (no wildcard expansion, unlike `-Path`).
 * `-STA` is required: PowerShell 7 starts in MTA, and `Clipboard.SetFileDropList` throws unless
 * the thread is STA. Windows PowerShell 5.1 accepts the same flag.
 */
function windowsClipboardScript(path: string): string {
	return [
		"Add-Type -AssemblyName System.Windows.Forms",
		"$files = New-Object System.Collections.Specialized.StringCollection",
		`[void]$files.Add(${powershellLiteral(path)})`,
		"[System.Windows.Forms.Clipboard]::SetFileDropList($files)",
	].join("; ");
}

function linuxCommands(
	path: string,
	which: (name: string) => string | null,
	env: NodeJS.ProcessEnv,
): ClipboardCommand[] {
	const { type, body } = linuxClipboardBody(path, env);
	const wlCopy = which("wl-copy");
	const xclip = which("xclip");
	const wayland = wlCopy ? { command: wlCopy, args: ["--type", type], stdin: body } : null;
	const x11 = xclip
		? { command: xclip, args: ["-selection", "clipboard", "-t", type], stdin: body }
		: null;

	// Prefer the helper that matches the session. The other is only a fallback when the first
	// exits non-zero: installing wl-copy on an X11 box must not steal the clipboard attempt.
	const waylandSession = Boolean(env.WAYLAND_DISPLAY);
	const x11Session = Boolean(env.DISPLAY);
	const ordered: Array<ClipboardCommand | null> =
		waylandSession || !x11Session ? [wayland, x11] : [x11, wayland];
	const commands = ordered.filter((command): command is ClipboardCommand => command !== null);
	if (commands.length === 0) {
		throw new ClipboardCopyError(
			"Copying a file needs wl-copy (Wayland) or xclip (X11); neither is installed",
		);
	}
	return commands;
}

/**
 * The commands that put `path` on this machine's clipboard, in the order they should be tried.
 *
 * Exported for tests: the argv shape decides whether a path containing quotes, spaces or a
 * leading dash is copied or silently mangled, and which MIME type a file manager will paste.
 */
export function buildClipboardCommands(
	path: string,
	options: ClipboardCommandOptions = {},
): ClipboardCommand[] {
	const platform = options.platform ?? process.platform;
	const which = options.which ?? ((name: string) => Bun.which(name));
	const env = options.env ?? process.env;

	if (platform === "win32") {
		// Windows PowerShell is on every install; pwsh is the fallback for hosts that removed it.
		const shell = which("powershell.exe") ?? which("pwsh") ?? "powershell.exe";
		return [
			{
				command: shell,
				args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", windowsClipboardScript(path)],
			},
		];
	}

	if (platform === "darwin") {
		// `POSIX file` puts a file reference (furl) on the pasteboard: pasting in Finder copies it.
		return [
			{
				command: "osascript",
				args: ["-e", `set the clipboard to (POSIX file ${appleScriptLiteral(path)})`],
			},
		];
	}

	if (platform === "linux") return linuxCommands(path, which, env);

	throw new ClipboardCopyError(`Copying a file to the clipboard is not supported on ${platform}`);
}

/** The first command `buildClipboardCommands` would try. */
export function buildClipboardCommand(
	path: string,
	options: ClipboardCommandOptions = {},
): ClipboardCommand {
	const [command] = buildClipboardCommands(path, options);
	if (!command) {
		throw new ClipboardCopyError(`Copying a file to the clipboard is not supported`);
	}
	return command;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one helper to completion, bounded in time and in captured output.
 *
 * stdout is discarded and stderr is read as a capped string that is never awaited past a short
 * grace period: xclip fork()s and the serving child inherits our pipe, so waiting for the fd to
 * close would hang until the clipboard is taken. Only the helper's own exit decides the result.
 */
async function run(command: ClipboardCommand, path: string): Promise<void> {
	const encoder = new TextEncoder();
	let stderr = "";
	const child = (() => {
		try {
			return Bun.spawn([command.command, ...command.args], {
				// No shell: the path is data, never syntax.
				stdin: command.stdin === undefined ? "ignore" : encoder.encode(command.stdin),
				stdout: "ignore",
				stderr: "pipe",
			});
		} catch (error) {
			throw new ClipboardCopyError(
				`Could not run ${command.command}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	})();

	const drain = (async () => {
		try {
			for await (const chunk of child.stderr) {
				if (stderr.length >= MAX_STDERR_CHARS) continue;
				stderr += new TextDecoder().decode(chunk).slice(0, MAX_STDERR_CHARS - stderr.length);
			}
		} catch {
			// A truncated or reset pipe only costs the diagnostic text below.
		}
	})();

	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {
				// Already gone; the timeout message below is the real outcome.
			}
			resolve(null);
		}, CLIPBOARD_TIMEOUT_MS);
	});

	const exitCode = await Promise.race([child.exited, timeout]);
	if (timer) clearTimeout(timer);
	// Let a normal helper's stderr land, without waiting on one that forked.
	await Promise.race([drain, delay(STDERR_GRACE_MS)]);

	if (timedOut || exitCode === null) {
		throw new ClipboardCopyError(
			`${command.command} did not finish within ${CLIPBOARD_TIMEOUT_MS / 1_000}s`,
		);
	}
	if (exitCode !== 0) {
		const detail = stderr.trim();
		throw new ClipboardCopyError(
			`${command.command} exited with code ${exitCode} while copying ${path}${detail ? `: ${detail}` : ""}`,
		);
	}
}

/**
 * Copy `path` to this machine's clipboard.
 *
 * The caller must already have established that the request came from a browser on this machine
 * and that `path` is an existing file; this function only performs the copy. On Linux the first
 * helper that exits 0 wins, so a Wayland session does not stop at a failing `xclip`.
 */
export async function copyFileToSystemClipboard(path: string): Promise<void> {
	const commands = buildClipboardCommands(path);
	let lastError: Error | undefined;
	for (const command of commands) {
		try {
			await run(command, path);
			return;
		} catch (error) {
			lastError = error instanceof Error ? error : new ClipboardCopyError(String(error));
		}
	}
	throw lastError ?? new ClipboardCopyError("Could not copy the file to the clipboard");
}

/** Whether this platform has a clipboard helper to call at all (the menu gate). */
export function clipboardPlatformSupported(): boolean {
	return IS_WINDOWS || IS_MACOS || IS_LINUX;
}
