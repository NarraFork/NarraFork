/**
 * What a Terminal `write` will run, as far as NarraFork can tell (Project Teams S2, review
 * round 2). Best-effort by nature: a terminal is an interactive line editor, so whatever cannot
 * be reconstructed with certainty is reported as unknown, and the permission layer asks a
 * person for unknown input in every mode, bypassPermissions included.
 *
 * - **Line buffer.** Per terminal, the line being typed is rebuilt across writes: printable
 *   text, backspace, Ctrl-U and Ctrl-W are applied; Ctrl-C discards the line; Enter (CR or LF)
 *   runs it. A line ending in `\` continues on the next. History, completion, cursor movement
 *   and any other control key or escape sequence (bracketed-paste markers excepted) make the
 *   line unknown until it runs.
 * - **Working directory.** Starts at the terminal's directory. A line that is exactly `cd DIR`
 *   with a literal DIR moves it; any other line that could change directory (`cd` in a chain or
 *   subshell, `pushd`, `popd`, `source`, `exec`, `cd -`, a variable) or that ran unknown makes it
 *   unknown, until a literal `cd /absolute/path` anchors it again.
 * - **Foreground program.** Input only reaches the shell when the shell is the terminal's
 *   foreground process (`ps` stat `+`). Otherwise (a REPL, an editor, a dev server) or when that
 *   cannot be told (remote device, Windows, no process), the input goes somewhere NarraFork
 *   cannot judge.
 * - **Script on stdin.** A here-document or here-string, or a shell or language interpreter
 *   reading its program from stdin (piped, redirected, `-`/`-s`, or started with no arguments)
 *   runs text the line itself does not show.
 *
 * The state is updated when a write is actually sent (the tool and the terminal WebSocket),
 * never when a write is only being judged. People's own keystrokes update it too; because a
 * person may use any key or type into any program, what they leave on the line is unknown and
 * a line they run leaves the directory unknown. Ctrl-C starts a known, empty line again.
 */
import { isAbsolute, posix } from "node:path";
import { getHome } from "../lib/platform";

export type TerminalForeground = "shell" | "program" | "unknown";

export interface TerminalLine {
	/** The command line as it will run (continuations joined). */
	text: string;
	/** Edited with keys whose effect cannot be reconstructed. */
	unknown: boolean;
}

interface LineState {
	line: string;
	unknown: boolean;
	/** Earlier physical lines of a command continued with a trailing backslash. */
	continuation: string;
	/** The shell's directory as tracked; null when it cannot be known. */
	cwd: string | null;
}

/** Terminals tracked per process; the oldest go first past this many. */
const STATE_LIMIT = 500;
const states = new Map<string, LineState>();

function fresh(cwd: string | null): LineState {
	return { line: "", unknown: false, continuation: "", cwd };
}

/** The tracked state of a terminal (a copy), starting at its creation directory. */
export function readTerminalLineState(terminalId: string, initialCwd: string | null): LineState {
	const state = states.get(terminalId) ?? fresh(initialCwd);
	return { ...state };
}

/** Drop a terminal's state (it exited or was closed). */
export function forgetTerminalLineState(terminalId: string): void {
	states.delete(terminalId);
}

/** Tests only. */
export function resetTerminalLineStatesForTest(): void {
	states.clear();
}

function store(terminalId: string, state: LineState): void {
	states.delete(terminalId);
	states.set(terminalId, state);
	while (states.size > STATE_LIMIT) {
		const oldest = states.keys().next().value;
		if (oldest === undefined) break;
		states.delete(oldest);
	}
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences
const BRACKETED_PASTE = /^\x1b\[20[01]~/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences
const ESCAPE_SEQUENCE = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|[\]P^_][^\x07\x1b]*(?:\x07|\x1b\\)?|.)?/;

/**
 * Apply typed bytes to a line state: the lines they run, and the state after. Pure.
 */
export function simulateTerminalInput(
	state: LineState,
	data: string,
): { executed: TerminalLine[]; next: LineState } {
	const next = { ...state };
	const executed: TerminalLine[] = [];
	let index = 0;
	while (index < data.length) {
		const char = data[index];
		if (char === "\x1b") {
			const paste = BRACKETED_PASTE.exec(data.slice(index));
			if (paste) {
				index += paste[0].length;
				continue;
			}
			const sequence = ESCAPE_SEQUENCE.exec(data.slice(index));
			next.unknown = true;
			index += Math.max(1, sequence?.[0].length ?? 1);
			continue;
		}
		index++;
		if (char === "\r" || char === "\n") {
			if (char === "\r" && data[index] === "\n") index++;
			// An odd run of trailing backslashes escapes the newline: the command continues.
			if ((/\\+$/.exec(next.line)?.[0].length ?? 0) % 2 === 1 && !next.unknown) {
				next.continuation += next.line.slice(0, -1);
				next.line = "";
				continue;
			}
			// An open quote keeps the shell reading: the newline becomes part of the command.
			if (!next.unknown && hasOpenQuote(next.continuation + next.line)) {
				next.continuation += `${next.line}\n`;
				next.line = "";
				continue;
			}
			executed.push({ text: next.continuation + next.line, unknown: next.unknown });
			next.line = "";
			next.continuation = "";
			next.unknown = false;
			continue;
		}
		if (char === "\x7f" || char === "\b") {
			next.line = next.line.slice(0, -1);
			continue;
		}
		if (char === "\x15") {
			next.line = "";
			continue;
		}
		if (char === "\x17") {
			next.line = next.line.replace(/\S*\s*$/, "");
			continue;
		}
		if (char === "\x03") {
			next.line = "";
			next.continuation = "";
			next.unknown = false;
			continue;
		}
		const code = char.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) {
			// Tab, Ctrl-R, Ctrl-A/E, history keys, Ctrl-D ...: the line is no longer known.
			next.unknown = true;
			continue;
		}
		next.line += char;
	}
	return { executed, next };
}

/** Whether a command text leaves a quote open (the shell would keep reading lines). */
export function hasOpenQuote(text: string): boolean {
	let quote: "'" | '"' | "`" | null = null;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote === "'") {
			if (char === "'") quote = null;
			continue;
		}
		if (char === "\\") {
			index++;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === "#" && (index === 0 || /\s/.test(text[index - 1]))) {
			const newline = text.indexOf("\n", index);
			if (newline === -1) return false;
			index = newline;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") quote = char;
	}
	return quote !== null;
}

/** Whether `data` types only printable text, with no Enter and no control key. */
export function isPlainTypedText(data: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control keys are not plain text
	return !/[\x00-\x1f\x7f]/.test(data);
}

/** Whether `data` is only interrupts (Ctrl-C), which run nothing. */
export function isInterruptOnly(data: string): boolean {
	return data.length > 0 && [...data].every((char) => char === "\x03");
}

const DIRECTORY_CHANGERS = /(?:^|[\s;&|(`$])(?:cd|pushd|popd|source|exec|\.)(?:$|[\s;&|)])/;
const LITERAL_CD = /^\s*cd\s+([^\s;&|<>()`$"'\\*?[\]{}!#]+)\s*$/;

/**
 * The shell's directory after `line` ran from `cwd`: moved by a literal `cd DIR`, unknown after
 * anything else that may change it, unchanged otherwise. `home` resolves `~`; null leaves it
 * unknown.
 */
export function directoryAfter(
	cwd: string | null,
	line: TerminalLine,
	home: string | null,
): string | null {
	if (line.unknown) return null;
	const literal = LITERAL_CD.exec(line.text);
	if (literal) {
		let target = literal[1];
		if (target === "-") return null;
		if (target === "~" || target.startsWith("~/")) {
			if (!home) return null;
			target = home + target.slice(1);
		} else if (target.startsWith("~")) return null;
		if (isAbsolute(target)) return posix.normalize(target);
		return cwd ? posix.resolve(cwd, target) : null;
	}
	if (/^\s*cd\s*$/.test(line.text)) return home;
	return DIRECTORY_CHANGERS.test(line.text) ? null : cwd;
}

const INTERPRETERS = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"csh",
	"tcsh",
	"python",
	"python2",
	"python3",
	"node",
	"deno",
	"bun",
	"perl",
	"ruby",
	"php",
	"lua",
	"tclsh",
	"irb",
	"ipython",
	"osascript",
	"pwsh",
	"powershell",
]);

function interpreterName(token: string | undefined): string | null {
	if (!token) return null;
	const base = token.split("/").pop() ?? token;
	if (INTERPRETERS.has(base)) return base;
	const unversioned = base.replace(/[\d.]+$/, "");
	return INTERPRETERS.has(unversioned) ? unversioned : null;
}

/** Words that run the next word as the command (`sudo bash`, `env X=1 python`). */
const COMMAND_WRAPPERS = new Set(["sudo", "env", "exec", "command", "nohup", "time", "nice"]);

/** The command word of one pipeline segment, past assignments and wrappers. */
function segmentCommand(segment: string): string | undefined {
	for (const word of segment.trim().split(/\s+/)) {
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || COMMAND_WRAPPERS.has(word) || word.startsWith("-"))
			continue;
		return word;
	}
	return undefined;
}

/**
 * Whether a line runs a program text the line does not show: a here-document or here-string,
 * or an interpreter reading its program from stdin (after a pipe, with `<`, with `-`/`-s`, or
 * started without arguments, when it reads the following keystrokes).
 */
export function readsProgramFromStdin(
	text: string,
	commands: ReadonlyArray<{ tokens: string[]; fullText: string }>,
): boolean {
	if (text.includes("<<")) return true;
	// Pipes, not `||`: every segment after the first reads the previous one's output.
	const segments = text.replace(/\|\|/g, ";").split("|");
	for (const segment of segments.slice(1))
		if (interpreterName(segmentCommand(segment.split(/[;&]/)[0] ?? ""))) return true;
	for (const command of commands) {
		if (!interpreterName(command.tokens[0])) continue;
		const args = command.tokens.slice(1);
		if (args.length === 0 || args.includes("-") || args.includes("-s")) return true;
		if (/(?:^|[^<>&0-9])<(?!\()/.test(command.fullText)) return true;
	}
	return false;
}

/**
 * Record bytes an agent actually sent to a terminal: its line buffer and directory move on.
 * `foreground` is who received them: input to a program leaves the shell's line alone, input
 * to an unknown receiver leaves the line and the directory unknown.
 */
export function commitTerminalInput(
	terminalId: string,
	data: string,
	options: { initialCwd: string | null; foreground: TerminalForeground; home: string | null },
): void {
	const state = readTerminalLineState(terminalId, options.initialCwd);
	if (options.foreground === "program") {
		store(terminalId, state);
		return;
	}
	const { executed, next } = simulateTerminalInput(state, data);
	let cwd = state.cwd;
	for (const line of executed)
		cwd = options.foreground === "shell" ? directoryAfter(cwd, line, options.home) : null;
	if (options.foreground === "unknown") {
		cwd = null;
		next.unknown ||= next.line.length > 0 || next.continuation.length > 0;
	}
	store(terminalId, { ...next, cwd });
}

/**
 * Record a person's keystrokes (the terminal WebSocket). They may go to any program and use
 * any key, so the line they leave is unknown and a line they run leaves the directory unknown.
 */
export function commitPersonTerminalInput(terminalId: string, data: string): void {
	const state = readTerminalLineState(terminalId, null);
	const { executed, next } = simulateTerminalInput(state, data);
	store(terminalId, {
		...next,
		unknown: next.unknown || next.line.length > 0 || next.continuation.length > 0,
		cwd: executed.length > 0 ? null : state.cwd,
	});
}

/** The home directory a local terminal's shell starts with; remote ones are unknown. */
export function terminalHome(deviceId: string | null): string | null {
	if (deviceId && deviceId !== "local") return null;
	return process.env.HOME || getHome() || null;
}

/**
 * Who receives a terminal's input now: the shell when it is the foreground process, a program
 * when another process holds the foreground, unknown when that cannot be read.
 */
export async function probeTerminalForeground(terminalId: string): Promise<TerminalForeground> {
	try {
		const { terminalService } = await import("./terminal-service");
		const processes = await terminalService.getProcesses(terminalId);
		const [shell, ...descendants] = processes;
		if (!shell) return "unknown";
		if (shell.state.includes("+")) return "shell";
		return descendants.some((process) => process.state.includes("+")) ? "program" : "unknown";
	} catch {
		return "unknown";
	}
}
