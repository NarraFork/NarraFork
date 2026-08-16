import { describe, expect, test } from "bun:test";
import { EXECUTOR_PLATFORMS, type ExecutorPlatform } from "@shared/remote-executor";
import { ValidationError } from "../errors";
import {
	buildExecutorInstallScript,
	type ExecutorInstallScriptInput,
	powershellSingleQuote,
	shellSingleQuote,
} from "../executor-install-script";

const SHA256 = "a".repeat(64);
const TICKET = "b".repeat(64);

function input(overrides: Partial<ExecutorInstallScriptInput> = {}): ExecutorInstallScriptInput {
	const platform: ExecutorPlatform = overrides.platform ?? "linux-amd64";
	// Windows targets require a Windows-shaped absolute path, so the default has to
	// follow the platform unless a test overrides it explicitly.
	const defaultAllowRoot = platform.startsWith("windows-")
		? "C:\\work\\projects"
		: "/home/dev/projects";
	return {
		platform,
		mode: "system",
		serverBaseUrl: "https://nf.example.com",
		deviceWsUrl: "wss://nf.example.com/ws/device",
		deviceSlug: "build-server",
		deviceName: "Build Server",
		connectionMode: "reverse",
		allowRoot: defaultAllowRoot,
		disableShell: false,
		artifactFilename: "narrafork-executor-0.5.24-linux-amd64",
		expectedSha256: SHA256,
		executorVersion: "0.5.24",
		ticket: TICKET,
		...overrides,
	};
}

describe("token handling", () => {
	test("no script embeds the registration key or passes it in argv", () => {
		for (const platform of EXECUTOR_PLATFORMS) {
			for (const mode of ["system", "user"] as const) {
				const { script } = buildExecutorInstallScript(input({ platform, mode }));
				// The token must be read interactively and referenced only as a file.
				expect(script).not.toContain("--token ");
				expect(script).not.toContain("rdev_");
				expect(script).toContain("--token-file");
				expect(script).toMatch(/Paste the device registration key/);
			}
		}
	});

	test("unix scripts disable terminal echo and write the key with mode 600", () => {
		const { script } = buildExecutorInstallScript(input());
		expect(script).toContain("stty -echo");
		expect(script).toContain("install -m 600");
		expect(script).toContain("umask 077");
		// A non-interactive run cannot prompt safely, so it must refuse.
		expect(script).toContain("if [ ! -t 0 ]; then");
	});

	test("windows scripts read the key as a SecureString and lock the ACL down", () => {
		const { script } = buildExecutorInstallScript(input({ platform: "windows-amd64" }));
		expect(script).toContain("-AsSecureString");
		expect(script).toContain("SetAccessRuleProtection($true, $false)");
		expect(script).toContain("Set-Acl -LiteralPath $tokenFile");
	});
});

describe("integrity verification", () => {
	test("every script verifies the published digest before installing", () => {
		for (const platform of EXECUTOR_PLATFORMS) {
			const { script } = buildExecutorInstallScript(input({ platform }));
			expect(script).toContain(SHA256);
			expect(script.toLowerCase()).toContain("checksum");
		}
	});

	test("unix scripts fail closed when no sha256 tool exists", () => {
		const { script } = buildExecutorInstallScript(input());
		expect(script).toContain("refusing to install unverified binary");
	});
});

describe("platform self-checks", () => {
	test("unix scripts reject a mismatched OS and arch", () => {
		const { script } = buildExecutorInstallScript(input({ platform: "linux-arm64" }));
		expect(script).toContain("uname -s");
		expect(script).toContain("uname -m");
		expect(script).toContain("'aarch64'");
		expect(script).toContain("'arm64'");
	});

	test("windows scripts compare PROCESSOR_ARCHITECTURE", () => {
		const amd64 = buildExecutorInstallScript(input({ platform: "windows-amd64" })).script;
		expect(amd64).toContain("$env:PROCESSOR_ARCHITECTURE");
		expect(amd64).toContain("'AMD64'");
		const arm64 = buildExecutorInstallScript(input({ platform: "windows-arm64" })).script;
		expect(arm64).toContain("'ARM64'");
	});

	test("windows scripts warn that terminals are unavailable", () => {
		const windows = buildExecutorInstallScript(input({ platform: "windows-amd64" })).script;
		expect(windows).toContain("ConPTY is not implemented");
		const linux = buildExecutorInstallScript(input()).script;
		expect(linux).not.toContain("ConPTY");
	});

	test("direct-mode devices are told they still need listener and TLS config", () => {
		const direct = buildExecutorInstallScript(input({ connectionMode: "direct" })).script;
		expect(direct).toContain("DIRECT mode");
		expect(direct).toContain("tlsCert");
		const reverse = buildExecutorInstallScript(input()).script;
		expect(reverse).not.toContain("DIRECT mode");
	});
});

describe("install locations and service wiring", () => {
	test("system mode installs a machine-wide service under a dedicated account", () => {
		const { script } = buildExecutorInstallScript(input({ mode: "system" }));
		expect(script).toContain("/usr/local/bin");
		expect(script).toContain("/etc/narrafork");
		expect(script).toContain("/etc/systemd/system/narrafork-executor.service");
		expect(script).toContain("useradd --system");
		expect(script).toContain("NoNewPrivileges=true");
	});

	test("user mode stays inside the invoking account and never uses sudo", () => {
		const { script } = buildExecutorInstallScript(input({ mode: "user" }));
		expect(script).toContain("$HOME/.local/bin");
		expect(script).toContain("$HOME/.config/narrafork");
		expect(script).toContain("systemctl --user enable --now");
		expect(script).not.toContain("sudo ");
	});

	test("macOS uses launchd rather than systemd", () => {
		const daemon = buildExecutorInstallScript(
			input({ platform: "darwin-arm64", mode: "system" }),
		).script;
		expect(daemon).toContain("/Library/LaunchDaemons/com.narrafork.executor.plist");
		expect(daemon).not.toContain("systemctl");
		const agent = buildExecutorInstallScript(
			input({ platform: "darwin-arm64", mode: "user" }),
		).script;
		expect(agent).toContain("LaunchAgents");
	});

	test("windows system mode requires elevation, user mode uses a scheduled task", () => {
		const service = buildExecutorInstallScript(
			input({ platform: "windows-amd64", mode: "system" }),
		).script;
		expect(service).toContain("WindowsBuiltInRole]::Administrator");
		expect(service).toContain("New-Service");
		const task = buildExecutorInstallScript(
			input({ platform: "windows-amd64", mode: "user" }),
		).script;
		expect(task).toContain("Register-ScheduledTask");
		expect(task).not.toContain("New-Service");
	});

	test("filenames and shells match the platform", () => {
		const unix = buildExecutorInstallScript(input());
		expect(unix.shell).toBe("sh");
		expect(unix.filename).toBe("install-narrafork-executor-build-server.sh");
		const windows = buildExecutorInstallScript(input({ platform: "windows-arm64" }));
		expect(windows.shell).toBe("powershell");
		expect(windows.filename).toBe("install-narrafork-executor-build-server.ps1");
	});

	test("disable-shell is threaded into the generated config", () => {
		expect(buildExecutorInstallScript(input({ disableShell: true })).script).toContain(
			'"disableShell": true',
		);
		expect(buildExecutorInstallScript(input({ disableShell: false })).script).toContain(
			'"disableShell": false',
		);
		expect(
			buildExecutorInstallScript(input({ platform: "windows-amd64", disableShell: true })).script,
		).toContain("disableShell = $true");
	});
});

describe("injection resistance", () => {
	test("shell metacharacters in the allow-root path stay a single literal argument", () => {
		const evil = "/home/dev/'; rm -rf / #";
		const { script } = buildExecutorInstallScript(input({ allowRoot: evil }));
		// Inside a quoted heredoc the text is inert data, and it is JSON-escaped so
		// it cannot break out of the config value either.
		const configLine = script
			.split("\n")
			.find((line) => line.includes("allowRoots"))
			?.trim();
		expect(configLine).toBe(`"allowRoots": ["/home/dev/'; rm -rf / #"],`);
		// The heredoc delimiter must be quoted, otherwise $(…) in a path would run.
		expect(script).toContain(`<<'CONFEOF'`);
	});

	test("command substitution in the allow-root path cannot execute", () => {
		const { script } = buildExecutorInstallScript(
			input({ allowRoot: "/home/dev/$(id > /tmp/pwned)" }),
		);
		const heredocStart = script.indexOf("<<'CONFEOF'");
		const heredocEnd = script.indexOf("\nCONFEOF", heredocStart);
		expect(heredocStart).toBeGreaterThan(-1);
		const body = script.slice(heredocStart, heredocEnd);
		// Present as literal text, but only inside a quoted heredoc where the shell
		// performs no substitution at all.
		expect(body).toContain("$(id > /tmp/pwned)");
		expect(script.slice(0, heredocStart)).not.toContain("$(id");
	});

	test("double quotes and backslashes in the allow-root path are JSON-escaped", () => {
		const { script } = buildExecutorInstallScript(
			input({ platform: "windows-amd64", allowRoot: "C:\\work\\proj" }),
		);
		expect(script).toContain("@('C:\\work\\proj')");
	});

	test("single quotes in a windows path are doubled for PowerShell", () => {
		const { script } = buildExecutorInstallScript(
			input({ platform: "windows-amd64", allowRoot: "C:\\dev's box\\code" }),
		);
		expect(script).toContain("'C:\\dev''s box\\code'");
	});

	test("newlines and control characters are rejected rather than escaped", () => {
		expect(() => buildExecutorInstallScript(input({ allowRoot: "/tmp\nrm -rf /" }))).toThrow(
			ValidationError,
		);
		expect(() => buildExecutorInstallScript(input({ deviceName: "evil\nname" }))).toThrow(
			ValidationError,
		);
		expect(() => buildExecutorInstallScript(input({ allowRoot: "/tmp\u0000/x" }))).toThrow(
			ValidationError,
		);
	});

	test("relative allow-root paths are rejected", () => {
		expect(() => buildExecutorInstallScript(input({ allowRoot: "projects" }))).toThrow(
			/absolute path/,
		);
		expect(() => buildExecutorInstallScript(input({ allowRoot: "" }))).toThrow(ValidationError);
		expect(() =>
			buildExecutorInstallScript(input({ platform: "windows-amd64", allowRoot: "/home/dev" })),
		).toThrow(/absolute path/);
		// UNC paths are legitimate absolute Windows paths.
		expect(() =>
			buildExecutorInstallScript(
				input({ platform: "windows-amd64", allowRoot: "\\\\fileserver\\share" }),
			),
		).not.toThrow();
	});

	test("malformed slugs, digests, tickets and URLs are rejected", () => {
		expect(() => buildExecutorInstallScript(input({ deviceSlug: "Bad Slug" }))).toThrow(
			ValidationError,
		);
		expect(() => buildExecutorInstallScript(input({ expectedSha256: "xyz" }))).toThrow(
			ValidationError,
		);
		expect(() => buildExecutorInstallScript(input({ expectedSha256: "A".repeat(64) }))).toThrow(
			ValidationError,
		);
		expect(() => buildExecutorInstallScript(input({ ticket: "short" }))).toThrow(ValidationError);
		expect(() => buildExecutorInstallScript(input({ serverBaseUrl: "not a url" }))).toThrow(
			ValidationError,
		);
		// The device URL must be a WebSocket URL, not http(s).
		expect(() =>
			buildExecutorInstallScript(input({ deviceWsUrl: "https://nf.example.com/ws/device" })),
		).toThrow(ValidationError);
		// A path-bearing artifact filename would rewrite the download route.
		expect(() => buildExecutorInstallScript(input({ artifactFilename: "../../secret" }))).toThrow(
			ValidationError,
		);
	});

	test("the download URL carries the ticket and the real server host", () => {
		const { script } = buildExecutorInstallScript(input());
		expect(script).toContain(
			`https://nf.example.com/api/executor/download/linux-amd64?ticket=${TICKET}`,
		);
		expect(script).not.toContain("<narrafork-host>");
	});
});

describe("quoting helpers", () => {
	test("shellSingleQuote survives embedded single quotes", () => {
		expect(shellSingleQuote("plain")).toBe("'plain'");
		expect(shellSingleQuote("it's")).toBe(`'it'\\''s'`);
	});

	test("powershellSingleQuote doubles embedded single quotes", () => {
		expect(powershellSingleQuote("plain")).toBe("'plain'");
		expect(powershellSingleQuote("it's")).toBe("'it''s'");
	});
});
