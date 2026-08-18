import { describe, expect, test } from "bun:test";
import { EXECUTOR_PLATFORMS, type ExecutorPlatform } from "@shared/remote-executor";
import { ValidationError } from "../errors";
import {
	buildExecutorInstallOneLiner,
	buildExecutorInstallScript,
	type ExecutorInstallScriptInput,
	powershellSingleQuote,
	shellSingleQuote,
} from "../executor-install-script";

const SHA256 = "a".repeat(64);
const TICKET = "b".repeat(64);

function input(overrides: Partial<ExecutorInstallScriptInput> = {}): ExecutorInstallScriptInput {
	const platform: ExecutorPlatform = overrides.platform ?? "linux-amd64";
	return {
		platform,
		mode: "system",
		serverBaseUrl: "https://nf.example.com",
		deviceWsUrl: "wss://nf.example.com/ws/device",
		deviceSlug: "build-server",
		deviceName: "Build Server",
		connectionMode: "reverse",
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
		// Holds for BOTH delivery modes: enroll fetches the key at runtime, prompt reads
		// it from the terminal, and neither may ever put it in argv or in the file the
		// operator copies around.
		for (const platform of EXECUTOR_PLATFORMS) {
			for (const mode of ["system", "user"] as const) {
				for (const tokenDelivery of ["prompt", "enroll"] as const) {
					const { script } = buildExecutorInstallScript(input({ platform, mode, tokenDelivery }));
					expect(script).not.toContain("--token ");
					expect(script).not.toContain("rdev_");
					expect(script).toContain("--token-file");
				}
			}
		}
	});

	test("prompt mode asks a human for the key", () => {
		for (const platform of EXECUTOR_PLATFORMS) {
			const { script } = buildExecutorInstallScript(input({ platform, tokenDelivery: "prompt" }));
			expect(script).toMatch(/Paste the device registration key/);
			// A prompt-mode script must never reach the enroll endpoint: its whole value
			// is that the script text carries no credential.
			expect(script).not.toContain("/api/executor/enroll/");
		}
	});

	test("prompt mode is the default when delivery is unspecified", () => {
		// Callers that predate automated enrollment must keep their old behaviour rather
		// than silently start shipping a credential-bearing script.
		const base = input();
		delete base.tokenDelivery;
		expect(buildExecutorInstallScript(base).script).toMatch(/Paste the device registration key/);
	});

	test("unix scripts disable terminal echo and write the key with mode 600", () => {
		const { script } = buildExecutorInstallScript(input({ tokenDelivery: "prompt" }));
		expect(script).toContain("stty -echo");
		expect(script).toContain("install -m 600");
		expect(script).toContain("umask 077");
		// A non-interactive run cannot prompt safely, so it must refuse.
		expect(script).toContain("if [ ! -t 0 ]; then");
	});

	test("windows scripts read the key as a SecureString and lock the ACL down", () => {
		const { script } = buildExecutorInstallScript(
			input({ platform: "windows-amd64", tokenDelivery: "prompt" }),
		);
		expect(script).toContain("-AsSecureString");
		expect(script).toContain("SetAccessRuleProtection($true, $false)");
		expect(script).toContain("Set-Acl -LiteralPath $tokenFile");
	});
});

describe("enroll-mode key delivery", () => {
	test("unix scripts POST to the enroll endpoint with the ticket", () => {
		const { script } = buildExecutorInstallScript(input({ tokenDelivery: "enroll" }));
		expect(script).toContain(
			`https://nf.example.com/api/executor/enroll/linux-amd64?ticket=${TICKET}`,
		);
		expect(script).toContain("-X POST");
	});

	test("the wget fallback spells POST as --post-data, the only form BusyBox shares", () => {
		// BusyBox wget has no --method (it is a GNU extension), so the previous
		// spelling made the fallback a guaranteed failure on exactly the minimal
		// hosts it exists for. An empty --post-data still forces POST, on both.
		const { script } = buildExecutorInstallScript(input({ tokenDelivery: "enroll" }));
		expect(script).toContain("--post-data=''");
		expect(script).not.toContain("--method=POST");
	});

	test("enroll mode drops the terminal requirement", () => {
		// The `[ -t 0 ]` guard exists only to protect an interactive read. Leaving it in
		// would defeat the entire point of a pasteable one-liner, which may well run
		// where stdin is not a terminal.
		const script = buildExecutorInstallScript(input({ tokenDelivery: "enroll" })).script;
		expect(script).not.toContain("if [ ! -t 0 ]; then");
		expect(script).not.toContain("stty -echo");
	});

	test("enroll mode still lands the key in a 0600 file", () => {
		// Automating the fetch must not weaken where the key ends up.
		const { script } = buildExecutorInstallScript(input({ tokenDelivery: "enroll" }));
		expect(script).toContain("umask 077");
		expect(script).toContain("install -m 600");
	});

	test("the key response is parsed without jq", () => {
		// A minimal host reliably has sed and often lacks jq. Discovering that after the
		// binary is installed would leave a machine that can never authenticate.
		const { script } = buildExecutorInstallScript(input({ tokenDelivery: "enroll" }));
		expect(script).toContain("sed -n");
		expect(script).not.toContain("jq");
	});

	test("the key response file is created private and removed afterwards", () => {
		const { script } = buildExecutorInstallScript(input({ tokenDelivery: "enroll" }));
		const enrollUmask = script.indexOf("umask 077");
		const mktemp = script.indexOf("narrafork-enroll.XXXXXX");
		// Restrictive umask must precede creating the file the key lands in.
		expect(enrollUmask).toBeGreaterThan(-1);
		expect(mktemp).toBeGreaterThan(enrollUmask);
		expect(script).toContain('rm -f "$TMP_ENROLL"');
		// And a crash mid-way must not leave it behind either.
		expect(script).toContain('trap \'rm -f "$TMP_BINARY" "$TMP_ENROLL"\' EXIT INT TERM');
	});

	test("a failed exchange explains that the ticket is one-shot", () => {
		// The most likely failure is an expired or already-redeemed ticket, and the only
		// fix is a fresh install command. Saying so on the target machine saves a
		// round trip to the docs.
		for (const platform of ["linux-amd64", "windows-amd64"] as const) {
			const { script } = buildExecutorInstallScript(input({ platform, tokenDelivery: "enroll" }));
			expect(script.toLowerCase()).toContain("works once");
		}
	});

	test("windows scripts use Invoke-RestMethod and verify a key came back", () => {
		const { script } = buildExecutorInstallScript(
			input({ platform: "windows-amd64", tokenDelivery: "enroll" }),
		);
		expect(script).toContain("Invoke-RestMethod -Method Post");
		expect(script).toContain("$plainToken = $enrollResponse.token");
		expect(script).toContain("IsNullOrWhiteSpace($plainToken)");
		expect(script).not.toContain("-AsSecureString");
	});
});

describe("the one-line install command", () => {
	test("unix uses command substitution, never a pipe", () => {
		/*
		 * This is the regression that matters most in this file.
		 *
		 * `curl … | sh` puts the script body on stdin. System mode runs sudo, and sudo
		 * with occupied stdin falls back to /dev/tty — which works in an interactive
		 * ssh session and fails outright with no controlling terminal (CI,
		 * `ssh host 'cmd'`, provisioning agents). System mode is the recommended
		 * default, so the pipe form breaks the common path exactly where a one-liner is
		 * most useful, and it fails in a way that looks like a sudo problem.
		 */
		const oneLiner = buildExecutorInstallOneLiner({
			scriptUrl: "https://nf.example.com/api/executor/install/linux-amd64?ticket=abc",
			shell: "sh",
		});
		expect(oneLiner).toStartWith(
			`sh -c "$(curl -fsSL 'https://nf.example.com/api/executor/install/linux-amd64?ticket=abc'`,
		);
		expect(oneLiner).not.toContain("| sh");
	});

	/**
	 * Command substitution discards the fetch's exit status — the command reports the
	 * INNER shell's. With `curl -f` an expired ticket yields an empty body, so a bare
	 * `sh -c "$(curl …)"` runs `sh -c ""` and exits 0: the operator sees one line of
	 * curl stderr next to a success, which reads as "installed fine".
	 *
	 * Verified directly against a 403 before this guard existed: exit status was 0.
	 *
	 * The fallback emits shell code for the outer shell to run, so a lapsed command
	 * explains itself and exits non-zero. Asserting on the exit path rather than the
	 * exact string, since the wording is expected to change.
	 */
	test("a failed fetch exits non-zero instead of running an empty script", () => {
		const oneLiner = buildExecutorInstallOneLiner({
			scriptUrl: "https://nf.example.com/api/executor/install/linux-amd64?ticket=abc",
			shell: "sh",
		});
		expect(oneLiner).toContain("|| echo ");
		expect(oneLiner).toContain("exit 1");
		expect(oneLiner).toContain(">&2");
	});

	/**
	 * Executes the generated command for real, because the property at stake is a
	 * shell exit status and no string assertion can establish it. `false` stands in
	 * for a failing fetch: same "substitution produced nothing" shape, no network.
	 */
	test("the generated command really exits non-zero when the fetch fails", async () => {
		const oneLiner = buildExecutorInstallOneLiner({
			scriptUrl: "https://nf.example.com/api/executor/install/linux-amd64?ticket=abc",
			shell: "sh",
		});
		// Swap the fetch for `false`: the fallback branch is what is under test, and the
		// URL's quoting is already pinned by the assertions above.
		const failing = oneLiner.replace(/curl -fsSL '[^']*'/, "false");
		const failed = Bun.spawnSync(["/bin/sh", "-c", failing]);
		expect(failed.exitCode).toBe(1);
		expect(new TextDecoder().decode(failed.stderr)).toContain("NarraFork");

		// And the success path still runs the fetched body untouched.
		const succeeding = oneLiner.replace(/curl -fsSL '[^']*'/, `echo 'exit 0'`);
		expect(Bun.spawnSync(["/bin/sh", "-c", succeeding]).exitCode).toBe(0);
	});

	test("windows pipes into iex, which never reads stdin", () => {
		// PowerShell elevation is a pre-flight role check that fails via Write-Error, so
		// nothing on this path depends on stdin being a terminal.
		expect(
			buildExecutorInstallOneLiner({
				scriptUrl: "https://nf.example.com/api/executor/install/windows-amd64?ticket=abc",
				shell: "powershell",
			}),
		).toBe(`irm 'https://nf.example.com/api/executor/install/windows-amd64?ticket=abc' | iex`);
	});

	test("the script URL is quoted for its shell", () => {
		// The URL carries a query string; unquoted, `&` or `?` would be interpreted.
		expect(
			buildExecutorInstallOneLiner({ scriptUrl: "https://h/x?a=1&b=2", shell: "sh" }),
		).toContain(`'https://h/x?a=1&b=2'`);
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

describe("path guard defaults", () => {
	test("the generated config leaves path rules empty so the guard starts unrestricted", () => {
		// Path rules are configured after install, from the device page, where the
		// operator can browse the machine's real directories. Emitting a guessed
		// path here would bake in a value nobody could verify at install time.
		const { script } = buildExecutorInstallScript(input());
		const configLine = script
			.split("\n")
			.find((line) => line.includes("pathRules"))
			?.trim();
		expect(configLine).toBe(`"pathRules": [],`);
	});

	test("the windows config also starts with an empty rule list", () => {
		const { script } = buildExecutorInstallScript(input({ platform: "windows-amd64" }));
		expect(script).toContain("pathRules = @()");
	});

	test("no script asks for or embeds an allow-root", () => {
		for (const platform of EXECUTOR_PLATFORMS) {
			const { script } = buildExecutorInstallScript(input({ platform }));
			expect(script).not.toContain("--allow-root");
			expect(script).not.toContain("allowRoots");
		}
	});
});

describe("injection resistance", () => {
	test("shell metacharacters in the device name stay inert", () => {
		// deviceName is operator input that lands in both script bodies, so it is
		// the surface these escaping guarantees now have to hold for.
		const { script } = buildExecutorInstallScript(input({ deviceName: "'; rm -rf / #" }));
		expect(script).toContain("# Device: '; rm -rf / # (build-server)");
		// The comment is the only place it appears, and a comment cannot execute.
		const executable = script
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"))
			.join("\n");
		expect(executable).not.toContain("rm -rf /");
	});

	test("command substitution in the device name cannot execute", () => {
		const { script } = buildExecutorInstallScript(input({ deviceName: "$(id > /tmp/pwned)" }));
		// Present only on a comment line; nothing outside comments may carry it.
		const executable = script
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"))
			.join("\n");
		expect(executable).not.toContain("$(id");
	});

	test("the config heredoc delimiter is quoted so config values never expand", () => {
		// Even with no operator-supplied paths left in the config body, the quoted
		// delimiter is what keeps future additions inert by default.
		const { script } = buildExecutorInstallScript(input());
		expect(script).toContain(`<<'CONFEOF'`);
	});

	test("single quotes in a windows device name are doubled for PowerShell", () => {
		const { script } = buildExecutorInstallScript(
			input({ platform: "windows-amd64", deviceName: "dev's box" }),
		);
		// Appears in a comment here, but the quoting helper is the shared guarantee.
		expect(powershellSingleQuote("C:\\dev's box\\code")).toBe("'C:\\dev''s box\\code'");
		expect(script).toContain("dev's box");
	});

	test("newlines and control characters are rejected rather than escaped", () => {
		expect(() => buildExecutorInstallScript(input({ deviceName: "evil\nname" }))).toThrow(
			ValidationError,
		);
		expect(() => buildExecutorInstallScript(input({ deviceName: "evil\u0000name" }))).toThrow(
			ValidationError,
		);
		expect(() =>
			buildExecutorInstallScript(input({ executorVersion: "0.5.24\nrm -rf /" })),
		).toThrow(ValidationError);
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
