import { describe, expect, test } from "bun:test";
import {
	commandUsesSudo,
	decideSudoPasswordBlocked,
	INSTALL_COMMANDS_FOR_TESTS,
	type SudoAvailability,
} from "../dependency-service";

/**
 * The one-click install path runs commands through `safeSpawn`, which hands the
 * child `/dev/null` on stdin and no controlling terminal. sudo reads its password
 * from `/dev/tty`, not stdin, so on any host where sudo prompts, a sudo-prefixed
 * install command cannot succeed — it dies with "no tty present and no askpass
 * program specified", which tells the user nothing actionable.
 *
 * The decision is tested as a pure function because the runtime probe answer is
 * host-dependent: a NOPASSWD machine can never reach the blocking branch, and a
 * password-requiring machine can never reach the allowing one. Asserting against
 * the live probe would silently test only whichever half this host happens to be.
 */

const base: SudoAvailability = {
	usesSudo: true,
	hasAskpass: false,
	passwordlessSudo: false,
	isWindows: false,
};

describe("sudo password gate", () => {
	test("blocks a sudo command when sudo would prompt for a password", () => {
		expect(decideSudoPasswordBlocked(base)).toBe(true);
	});

	test("allows sudo when it currently needs no password", () => {
		// NOPASSWD, or a still-valid sudo timestamp.
		expect(decideSudoPasswordBlocked({ ...base, passwordlessSudo: true })).toBe(false);
	});

	test("allows sudo when an askpass helper can supply the password without a tty", () => {
		expect(decideSudoPasswordBlocked({ ...base, hasAskpass: true })).toBe(false);
	});

	test("never blocks a command that does not use sudo", () => {
		// Termux/apt-root/brew/winget commands are all sudo-less; gating them would
		// break installs that work fine.
		expect(decideSudoPasswordBlocked({ ...base, usesSudo: false })).toBe(false);
		expect(decideSudoPasswordBlocked({ ...base, usesSudo: false, passwordlessSudo: null })).toBe(
			false,
		);
	});

	test("blocks when sudo could not be probed at all", () => {
		// sudo missing or unspawnable: the command cannot work either way, so the
		// terminal path (where the user can adapt) is the honest recommendation.
		expect(decideSudoPasswordBlocked({ ...base, passwordlessSudo: null })).toBe(true);
	});

	test("does not gate on Windows, which has no tty/sudo problem here", () => {
		expect(decideSudoPasswordBlocked({ ...base, isWindows: true })).toBe(false);
	});
});

describe("sudo detection in install commands", () => {
	test("matches sudo as a command word, including after a shell operator", () => {
		expect(commandUsesSudo("sudo apt-get install -y git")).toBe(true);
		// The real apt command chains two sudo invocations with &&.
		expect(commandUsesSudo("sudo apt-get update && sudo apt-get install -y git")).toBe(true);
		expect(commandUsesSudo("apt-get update; sudo apt-get install -y git")).toBe(true);
	});

	test("does not match sudo as a substring or a path component", () => {
		// A false positive would block a working install behind a sudo warning.
		expect(commandUsesSudo("pkg install sudoku")).toBe(false);
		expect(commandUsesSudo("brew install git")).toBe(false);
		expect(commandUsesSudo("winget install -e --id Git.Git")).toBe(false);
		expect(commandUsesSudo("apt-get install -y git")).toBe(false);
	});

	test("the shipped command matrix agrees about which package managers need sudo", () => {
		// Guards the matrix itself: if a sudo were added to (or dropped from) a
		// command, the gate's behaviour for that package manager changes silently.
		for (const dep of ["git", "rg", "dtach"]) {
			const commands = INSTALL_COMMANDS_FOR_TESTS[dep];
			expect(commands).toBeDefined();
			for (const pm of ["apt", "dnf", "pacman", "zypper"]) {
				const cmd = commands[pm];
				if (cmd) expect(commandUsesSudo(cmd)).toBe(true);
			}
			// Root/user-scoped managers must stay sudo-free.
			for (const pm of ["termux", "apt-root", "brew", "winget", "scoop", "choco"]) {
				const cmd = commands[pm];
				if (cmd) expect(commandUsesSudo(cmd)).toBe(false);
			}
		}
	});
});
