import { describe, expect, test } from "bun:test";
import { type InstallPhase, nextInstallAction, PROMPT_RE } from "./dependency-install-progress";

/**
 * Drive the state machine over a sequence of cursor lines, recording the actions.
 *
 * Mirrors how the component consumes it: each terminal write (live output OR
 * replayed scrollback) yields one cursor line, and the phase advances only on the
 * resulting action.
 */
function run(lines: Array<string | null>): { actions: string[]; phase: InstallPhase } {
	let phase: InstallPhase = "awaiting-prompt";
	const actions: string[] = [];
	for (const line of lines) {
		const action = nextInstallAction(phase, line);
		actions.push(action);
		if (action === "send-command") phase = "running";
		if (action === "finish") phase = "done";
	}
	return { actions, phase };
}

describe("dependency install prompt sequencing", () => {
	test("the first prompt sends the command and the second finishes", () => {
		const { actions, phase } = run([
			"fulcrum@host:~$ ",
			"Reading package lists...",
			"fulcrum@host:~$ ",
		]);
		expect(actions).toEqual(["send-command", "wait", "finish"]);
		expect(phase).toBe("done");
	});

	test("a prompt that only ever arrives via scrollback still sends the command", () => {
		// This is the reported bug. The shell prints its prompt before the client
		// has subscribed, so the ONLY delivery is the replayed snapshot. If the
		// component inspects live output exclusively, this sequence produces no
		// prompt sighting at all: no command is sent and the window stays empty.
		const replayedPromptOnly = run(["fulcrum@host:~$ "]);
		expect(replayedPromptOnly.actions).toEqual(["send-command"]);

		// Contrast: a run that never inspects the replayed prompt sees only the
		// later output lines, and therefore never reaches "send-command".
		const ignoringReplay = run(["Reading package lists...", "Setting up dtach..."]);
		expect(ignoringReplay.actions).toEqual(["wait", "wait"]);
		expect(ignoringReplay.phase).toBe("awaiting-prompt");
	});

	test("nothing fires again once finished", () => {
		// The completion callback is scheduled on a timer; a second `finish` would
		// reset that timer and could close the modal mid-output.
		const { actions } = run(["host$ ", "host$ ", "host$ ", "host$ "]);
		expect(actions).toEqual(["send-command", "finish", "wait", "wait"]);
	});

	test("an absent cursor line is not treated as a prompt", () => {
		expect(nextInstallAction("awaiting-prompt", null)).toBe("wait");
		expect(nextInstallAction("running", null)).toBe("wait");
	});

	test("progress output is not mistaken for a prompt", () => {
		// Real apt/curl output. Any of these matching would finish the install while
		// it is still downloading and close the modal on the user.
		for (const line of [
			"50%",
			"100%",
			"Progress: 75%",
			"1024>",
			"Reading package lists... 50%",
			"Get:1 http://deb.debian.org bookworm 45%",
			"[####      ] 40%",
		]) {
			expect(PROMPT_RE.test(line)).toBe(false);
			expect(nextInstallAction("running", line)).toBe("wait");
		}
	});

	test("recognizes the common shell prompt shapes", () => {
		// Tightening the progress guard must not cost real prompts, including the
		// `>` and `%` terminators that the guard applies to.
		for (const line of [
			"fulcrum@host:~$ ",
			"root@box:/#",
			"bash-5.1$",
			"PS>",
			"user@h:/tmp%",
			"/tmp$",
			"zsh%",
		]) {
			expect(PROMPT_RE.test(line)).toBe(true);
			expect(nextInstallAction("awaiting-prompt", line)).toBe("send-command");
		}
	});
});
