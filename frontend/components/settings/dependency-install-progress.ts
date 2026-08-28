/**
 * Prompt-detection rules for the dependency install terminal.
 *
 * Kept out of the component so the sequencing can be verified without rendering
 * xterm: these rules decide whether the install command is ever sent, and the
 * failure mode is silent — a missed first prompt leaves an empty window that
 * looks like a broken terminal rather than a logic bug.
 */

/**
 * Shell prompt patterns: user@host:dir$ / root:/# / bash-5.1$ / PS> / zsh%.
 *
 * `$` and `#` need no guard — no package manager ends a progress line with them.
 * `>` and `%` do, because "50%" and "1024>" are ordinary apt/curl progress
 * output; the negative lookbehind rejects a terminator preceded by a digit or
 * whitespace, which is what separates "75%" from a real "user@h:/tmp%".
 *
 * The guard must sit immediately before the TERMINATOR. An earlier version wrote
 * `(?<!\d)` at the start of the pattern, where it only constrained where the
 * match began — the regex could simply start later in the line, so every
 * progress percentage matched. That mattered little while the command was never
 * being sent (nothing produced progress output); once the terminal works, a
 * mis-detected prompt closes the modal mid-download.
 */
export const PROMPT_RE = /(?:[\w@.\-~:/]+[$#]|[\w@.\-~:/]+(?<![\d\s])[>%])\s*$/;

export type InstallPhase = "awaiting-prompt" | "running" | "done";

/**
 * What to do with the line the cursor currently sits on.
 *
 * `send-command` fires on the FIRST prompt and `finish` on the second: the shell
 * prints a prompt when it starts and again when the install returns, so the same
 * predicate drives both transitions.
 *
 * The caller must run this for BOTH live output and replayed scrollback. The
 * shell emits its first prompt immediately — before this component has completed
 * an HTTP round trip and subscribed — so the server delivers that prompt as a
 * `scrollback` snapshot, never as live `output`. Inspecting only `output` means
 * the first prompt is never seen, the command is never sent, and the window stays
 * blank indefinitely.
 */
export type InstallAction = "send-command" | "finish" | "wait";

export function nextInstallAction(phase: InstallPhase, cursorLine: string | null): InstallAction {
	if (phase === "done") return "wait";
	if (cursorLine === null) return "wait";
	if (!PROMPT_RE.test(cursorLine)) return "wait";
	return phase === "awaiting-prompt" ? "send-command" : "finish";
}
