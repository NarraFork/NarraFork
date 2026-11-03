/**
 * The argv each platform receives, which is where a path can be mangled or turned into syntax.
 * Nothing here runs a clipboard helper: only the command shape is asserted.
 */

import { describe, expect, test } from "bun:test";
import {
	buildClipboardCommand,
	buildClipboardCommands,
	ClipboardCopyError,
} from "../file-clipboard";

const none = () => null;
const whichAmong =
	(names: string[]) =>
	(name: string): string | null =>
		names.includes(name) ? `/usr/bin/${name}` : null;

describe("buildClipboardCommand", () => {
	test("windows copies the FILE through the clipboard file drop list", () => {
		const command = buildClipboardCommand("C:\\build\\libs\\CDK-Lite.jar", {
			platform: "win32",
			which: none,
		});
		expect(command.command).toBe("powershell.exe");
		expect(command.args.slice(0, 4)).toEqual(["-NoProfile", "-NonInteractive", "-STA", "-Command"]);
		const script = command.args[4] ?? "";
		// A file drop list is what makes a paste in Explorer copy the file, and the WinForms call
		// is the only form that exists in both Windows PowerShell 5.1 and PowerShell 7.
		expect(script).toContain("[System.Windows.Forms.Clipboard]::SetFileDropList($files)");
		expect(script).toContain("[void]$files.Add('C:\\build\\libs\\CDK-Lite.jar')");
		// Nothing is piped: the file is named by the command, not by stdin.
		expect(command.stdin).toBeUndefined();
	});

	test("windows prefers Windows PowerShell, falling back to pwsh", () => {
		expect(
			buildClipboardCommand("C:\\a.jar", { platform: "win32", which: whichAmong(["pwsh"]) })
				.command,
		).toBe("/usr/bin/pwsh");
		expect(
			buildClipboardCommand("C:\\a.jar", {
				platform: "win32",
				which: whichAmong(["pwsh", "powershell.exe"]),
			}).command,
		).toBe("/usr/bin/powershell.exe");
	});

	test("a quote in the path is doubled, not able to end the PowerShell literal", () => {
		const command = buildClipboardCommand("C:\\it's here\\a.jar", {
			platform: "win32",
			which: none,
		});
		expect(command.args.at(-1)).toContain("[void]$files.Add('C:\\it''s here\\a.jar')");
	});

	test("macOS keeps the file as a pasteboard file reference", () => {
		const command = buildClipboardCommand("/Users/me/a b.jar", {
			platform: "darwin",
			which: none,
		});
		expect(command.command).toBe("osascript");
		expect(command.args).toEqual(["-e", 'set the clipboard to (POSIX file "/Users/me/a b.jar")']);
	});

	test("macOS escapes the two characters an AppleScript literal cannot hold", () => {
		const command = buildClipboardCommand('/Users/me/say "hi"\\a.jar', {
			platform: "darwin",
			which: none,
		});
		expect(command.args).toEqual([
			"-e",
			'set the clipboard to (POSIX file "/Users/me/say \\"hi\\"\\\\a.jar")',
		]);
	});

	test("linux Wayland on GNOME offers the target Nautilus pastes as a file", () => {
		const commands = buildClipboardCommands("/home/me/a b.jar", {
			platform: "linux",
			which: whichAmong(["wl-copy", "xclip"]),
			env: { WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
		});
		expect(commands.map((command) => command.command)).toEqual([
			"/usr/bin/wl-copy",
			"/usr/bin/xclip",
		]);
		expect(commands[0]?.args).toEqual(["--type", "x-special/gnome-copied-files"]);
		expect(commands[0]?.stdin).toBe("copy\nfile:///home/me/a%20b.jar\n");
	});

	test("linux KDE keeps a CRLF uri-list", () => {
		const command = buildClipboardCommand("/home/me/a b.jar", {
			platform: "linux",
			which: whichAmong(["wl-copy"]),
			env: { WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "KDE" },
		});
		expect(command.command).toBe("/usr/bin/wl-copy");
		expect(command.args).toEqual(["--type", "text/uri-list"]);
		expect(command.stdin).toBe("file:///home/me/a%20b.jar\r\n");
	});

	test("an X11 session tries xclip before wl-copy", () => {
		const commands = buildClipboardCommands("/home/me/a.jar", {
			platform: "linux",
			which: whichAmong(["wl-copy", "xclip"]),
			env: { DISPLAY: ":0", XDG_SESSION_DESKTOP: "gnome" },
		});
		expect(commands.map((command) => command.command)).toEqual([
			"/usr/bin/xclip",
			"/usr/bin/wl-copy",
		]);
		expect(commands[0]?.args).toEqual([
			"-selection",
			"clipboard",
			"-t",
			"x-special/gnome-copied-files",
		]);
		expect(commands[0]?.stdin).toBe("copy\nfile:///home/me/a.jar\n");
	});

	test("linux X11 with only xclip still offers the gnome target", () => {
		const command = buildClipboardCommand("/home/me/a.jar", {
			platform: "linux",
			which: whichAmong(["xclip"]),
			env: { DISPLAY: ":0" },
		});
		expect(command.command).toBe("/usr/bin/xclip");
		expect(command.args).toEqual(["-selection", "clipboard", "-t", "x-special/gnome-copied-files"]);
		expect(command.stdin).toBe("copy\nfile:///home/me/a.jar\n");
	});

	test("linux without either helper reports what to install instead of silently doing nothing", () => {
		expect(() =>
			buildClipboardCommand("/home/me/a.jar", { platform: "linux", which: none }),
		).toThrow(ClipboardCopyError);
		expect(() =>
			buildClipboardCommand("/home/me/a.jar", { platform: "linux", which: none }),
		).toThrow(/wl-copy .* xclip/);
	});

	test("an unsupported platform is a typed refusal, not a spawn attempt", () => {
		expect(() => buildClipboardCommand("/a.jar", { platform: "aix", which: none })).toThrow(
			ClipboardCopyError,
		);
	});
});
