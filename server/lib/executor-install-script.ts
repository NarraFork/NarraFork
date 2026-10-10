/**
 * Remote executor install script generation.
 *
 * The device settings page hands the operator a script with the real server URL,
 * device slug, platform and expected digest already filled in, so enrollment does
 * not depend on them transcribing flags correctly.
 *
 * Three rules shape everything here:
 *
 * 1. The registration token is never written into the script, argv, or the
 *    environment. It reaches the machine one of two ways (`tokenDelivery`), and
 *    both end with it in a 0600 file (Unix) or an ACL-restricted file (Windows):
 *      - `prompt` — the script asks for it with echo disabled. The script itself
 *        carries no credential, so it can be forwarded freely. Works over plain
 *        http. Requires a human and a terminal.
 *      - `enroll` — the script exchanges its one-time ticket for the key against
 *        the public bootstrap endpoint. No human step, which is what makes a
 *        copy-paste one-liner possible; in return the *command* becomes the
 *        credential, so the route layer restricts it to https/loopback/opt-in LAN
 *        (see `executor-enrollment-policy.ts`).
 * 2. Every interpolated value is quoted for its shell. Callers supply operator
 *    input (allow-root paths, install directories), so values are validated and
 *    then escaped rather than trusted.
 * 3. Nothing is parsed with a tool the target may not have. The enroll response is
 *    read with `sed`, not `jq`, because a fresh minimal host has one and not the
 *    other — and a missing parser at that point would leave the binary installed
 *    but the service unable to authenticate.
 */
import { X509Certificate } from "node:crypto";
import {
	type ExecutorPlatform,
	executorInstalledFilename,
	executorPublishedFilename,
	getExecutorPlatformInfo,
} from "@shared/remote-executor";
import { DEVICE_PROTOCOL_VERSION } from "./agent/execution/rpc-types";
import { ValidationError } from "./errors";
import { APP_VERSION } from "./version";

export type ExecutorInstallMode = "system" | "user";

/**
 * How the device key reaches the target machine.
 *
 * `enroll` is the default the UI offers because it removes the manual copy step
 * that made enrollment tedious. `prompt` remains the only option when the key
 * cannot be transported safely (plaintext http on a routable address) and the
 * stronger option when the operator would rather the script carry nothing.
 */
export type ExecutorTokenDelivery = "prompt" | "enroll";

export interface ExecutorInstallScriptInput {
	platform: ExecutorPlatform;
	/** Install as a machine-wide service or under the invoking user's account. */
	mode: ExecutorInstallMode;
	/** Absolute base URL of this NarraFork instance, e.g. https://nf.example.com. */
	serverBaseUrl: string;
	/** WebSocket URL the executor dials in reverse mode. */
	deviceWsUrl: string;
	/** Device slug used with --device. */
	deviceSlug: string;
	deviceName: string;
	connectionMode: "reverse" | "direct";
	/** Remove the Bash/PTY surfaces (--disable-shell). */
	disableShell: boolean;
	/** Published artifact filename, used for the download URL path. */
	artifactFilename: string;
	/** Lowercase hex SHA-256 the script verifies before installing. */
	expectedSha256: string;
	executorVersion: string;
	executorProtocolVersion?: number;
	/**
	 * Enrollment ticket. Authorizes the binary fetch, and — only when the ticket
	 * was issued with token delivery enabled — the key exchange.
	 */
	ticket: string;
	/** Defaults to "prompt", the behaviour that predates automated enrollment. */
	tokenDelivery?: ExecutorTokenDelivery;
	/** Public deployment CA, delivered via the already-trusted management session. */
	caCertPem?: string;
}

export interface GeneratedExecutorInstallScript {
	/** Script body, ready to paste into a shell on the target machine. */
	script: string;
	/** Suggested filename when saving the script. */
	filename: string;
	/** Interpreter the operator should run it with. */
	shell: "sh" | "powershell";
}

/**
 * The single command an operator pastes on the target machine.
 *
 * ## Unix: command substitution, never a pipe
 *
 * `sh -c "$(curl ...)"` — NOT `curl ... | sh`.
 *
 * With a pipe, the script body *is* stdin. The system-mode script runs `sudo`, and
 * sudo with an occupied stdin falls back to reading the password from `/dev/tty`.
 * That works in an interactive ssh session and fails outright wherever no
 * controlling terminal exists (CI, `ssh host 'cmd'`, some provisioning agents) —
 * and system mode is the recommended default, so the pipe form breaks the common
 * path in exactly the environments where a one-liner is most useful.
 *
 * Command substitution fetches the script first and executes it with stdin left
 * as the operator's terminal, so sudo can prompt normally.
 *
 * This looks like something worth "simplifying" back into a pipe. It is not:
 * doing so reintroduces a silent failure in system mode on non-tty hosts.
 *
 * ## Why the `|| echo` fallback is not optional
 *
 * Command substitution discards the fetch's exit status: the command's status is
 * the INNER shell's. With `curl -f`, an expired ticket (403) yields empty output,
 * so `sh -c ""` succeeds and the operator sees only curl's one-line stderr next to
 * a zero exit — indistinguishable from "installed fine". Measured directly:
 * `sh -c "$(curl -fsSL <403 url>)"` exits 0.
 *
 * So the failure branch emits SHELL CODE, which the outer `sh` then runs: it
 * explains what happened and exits non-zero. Deleting it restores a silent
 * no-op on the single most likely failure — a lapsed command.
 *
 * Not covered on purpose: a 2xx response with an empty body. Guarding it needs an
 * intermediate variable, which lengthens the one-liner and risks its quoting, and
 * the only way to reach it is a server bug rather than the ordinary expiry path.
 *
 * ## Windows: pipe is fine
 *
 * `irm ... | iex` — elevation is a pre-flight `WindowsBuiltInRole::Administrator`
 * check that fails via `Write-Error` and never reads stdin, so nothing here
 * depends on stdin being a terminal. No fallback is needed either:
 * `Invoke-RestMethod` treats an HTTP error status as a terminating error, so a
 * lapsed ticket surfaces as a visible PowerShell error rather than a silent no-op.
 */
const UNIX_FETCH_FAILURE_FALLBACK = [
	'echo "NarraFork: could not fetch the install script (see the error above)." >&2',
	'echo "Install commands are short-lived and work once; generate a fresh one in ' +
		'NarraFork (Settings -> Remote devices) and retry." >&2',
	"exit 1",
].join("; ");

// PEM is public, but accepting arbitrary text here could turn a certificate into
// shell code (or accidentally ship a private key). Normalize exactly one certificate.
function normalizeInstallCa(pem: string | undefined): string | undefined {
	if (pem === undefined) return undefined;
	if (
		pem.length > 64 * 1024 ||
		!/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem)
	) {
		throw new ValidationError("Installation CA must contain one public PEM certificate only");
	}
	try {
		return `${new X509Certificate(pem).toString().trim()}\n`;
	} catch {
		throw new ValidationError("Installation CA certificate is invalid");
	}
}

// curl is deliberately required for custom trust. BusyBox wget cannot reliably
// load a CA file; falling back to --no-check-certificate would expose the ticket.
const CA_CURL_FLAGS =
	'--disable --fail --silent --show-error --location --max-redirs 5 --proto "=https" --proto-redir "=https" --connect-timeout 15 --max-time 300';

// Built-in/private CAs may have no CRL, or its distribution point may be offline.
// Schannel best-effort (curl >= 7.70.0) tolerates only unavailable revocation data;
// certificate chain/hostname checks and known-revoked rejection remain enabled.
// Resolve the executable once: Windows PATH can contain OpenSSL/MultiSSL curl too.
// In --version, inactive MultiSSL backends are parenthesized, so ignore those.
// Probe option support without a URL BEFORE sending any ticket; never downgrade an
// unsupported Schannel build to disabled verification or silently omit the policy.
const WINDOWS_CA_CURL_SETUP = [
	"$nfCurl = (Get-Command curl.exe -CommandType Application -ErrorAction Stop).Source",
	"$nfCurlVersion = @(& $nfCurl --disable --version)",
	"if ($LASTEXITCODE -ne 0 -or $nfCurlVersion.Count -eq 0 -or $nfCurlVersion[0] -notmatch '^curl [0-9]+\\.') { throw 'Cannot determine curl TLS backend.' }",
	"$nfCurlCaFlags = @()",
	"if (($nfCurlVersion[0] -replace '\\([^)]*\\)', '') -match '\\bSchannel\\b') { " +
		"& $nfCurl --disable --ssl-revoke-best-effort --version | Out-Null; " +
		"if ($LASTEXITCODE -ne 0) { throw 'Custom CA installation requires Schannel curl 7.70.0 or newer with --ssl-revoke-best-effort support. Upgrade curl and retry.' }; " +
		"$nfCurlCaFlags = @('--ssl-revoke-best-effort') }",
];
const WINDOWS_CA_CURL_FLAGS = `${CA_CURL_FLAGS} @nfCurlCaFlags`;

export function buildExecutorInstallOneLiner(input: {
	scriptUrl: string;
	shell: "sh" | "powershell";
	caCertPem?: string;
}): string {
	const ca = normalizeInstallCa(input.caCertPem);
	if (ca) {
		validateUrl("Install script URL", input.scriptUrl, ["https:"]);
		if (input.shell === "powershell") {
			const q = powershellSingleQuote;
			return [
				"& { $ErrorActionPreference = 'Stop'",
				...WINDOWS_CA_CURL_SETUP,
				"$nfCa = [System.IO.Path]::GetTempFileName()",
				"try {",
				`[System.IO.File]::WriteAllBytes($nfCa, [Convert]::FromBase64String('${Buffer.from(ca).toString("base64")}'))`,
				`$nfScript = & $nfCurl ${WINDOWS_CA_CURL_FLAGS} --max-filesize 1048576 --cacert $nfCa ${q(input.scriptUrl)}`,
				"if ($LASTEXITCODE -ne 0) { throw 'NarraFork install script download failed; check TLS trust and ticket expiry.' }",
				"if (-not $nfScript) { throw 'NarraFork returned an empty install script.' }",
				"& ([scriptblock]::Create(($nfScript -join [Environment]::NewLine)))",
				"} finally { Remove-Item -LiteralPath $nfCa -Force -ErrorAction SilentlyContinue } }",
			]
				.join("; ")
				.replace("try {;", "try {");
		}
		const q = shellSingleQuote;
		const body = [
			"set -eu",
			'command -v curl >/dev/null 2>&1 || { echo "NarraFork custom CA installation requires curl." >&2; exit 1; }',
			"umask 077",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion
			'd=$(mktemp -d "${TMPDIR:-/tmp}/narrafork-bootstrap.XXXXXX")',
			`trap 'rm -rf "$d"' EXIT`,
			"trap 'exit 130' INT",
			"trap 'exit 143' TERM",
			`printf '%b' ${q(ca.replaceAll("\n", "\\n"))} > "$d/ca.pem"`,
			`curl ${CA_CURL_FLAGS} --max-filesize 1048576 --cacert "$d/ca.pem" ${q(input.scriptUrl)} -o "$d/install.sh" || { ${UNIX_FETCH_FAILURE_FALLBACK}; }`,
			'[ -s "$d/install.sh" ] || { echo "NarraFork returned an empty install script." >&2; exit 1; }',
			'sh "$d/install.sh"',
		].join("; ");
		return `sh -c ${q(body)}`;
	}
	if (input.shell === "powershell") {
		return `irm ${powershellSingleQuote(input.scriptUrl)} | iex`;
	}
	// The inner curl is single-quoted for sh; the outer layer is a double-quoted
	// command substitution so the fetched text is executed, not word-split. The
	// fallback is quoted the same way, because it too is text the outer shell runs.
	return (
		`sh -c "$(curl -fsSL ${shellSingleQuote(input.scriptUrl)}` +
		` || echo ${shellSingleQuote(UNIX_FETCH_FAILURE_FALLBACK)})"`
	);
}

/**
 * Reject control characters outright: no amount of quoting makes them safe to
 * embed in a generated script. Matching them explicitly is the whole point here.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control characters is the intent
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function assertEmbeddable(label: string, value: string): string {
	if (CONTROL_CHARS_RE.test(value)) {
		throw new ValidationError(`${label} must not contain control characters or newlines`);
	}
	return value;
}

/** Single-quote for POSIX sh: close, escape, reopen. */
export function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Single-quote for PowerShell, where '' is a literal quote. */
export function powershellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function validateUrl(label: string, value: string, protocols: readonly string[]): string {
	assertEmbeddable(label, value);
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new ValidationError(`${label} must be a valid URL`);
	}
	if (!protocols.includes(parsed.protocol)) {
		throw new ValidationError(`${label} must use one of: ${protocols.join(", ")}`);
	}
	return parsed.href.replace(/\/+$/, "");
}

function validateSlug(value: string): string {
	if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(value)) {
		throw new ValidationError("Device slug has an unexpected format");
	}
	return value;
}

function validateSha256(value: string): string {
	if (!/^[0-9a-f]{64}$/.test(value)) {
		throw new ValidationError("Expected SHA-256 digest is malformed");
	}
	return value;
}

function validateTicket(value: string): string {
	if (!/^[0-9a-f]{16,256}$/.test(value)) {
		throw new ValidationError("Download ticket is malformed");
	}
	return value;
}

function validateArtifactFilename(value: string): string {
	// Becomes a URL path segment; anything with separators would change the route.
	if (!/^[A-Za-z0-9._-]+$/.test(value)) {
		throw new ValidationError("Artifact filename is malformed");
	}
	return value;
}

interface ResolvedInput extends ExecutorInstallScriptInput {
	downloadUrl: string;
	enrollUrl: string;
	tokenDelivery: ExecutorTokenDelivery;
	installDir: string;
	configDir: string;
	tokenPath: string;
	configPath: string;
	binaryName: string;
}

function resolvePaths(input: ExecutorInstallScriptInput): ResolvedInput {
	if (
		input.executorVersion !== APP_VERSION ||
		(input.executorProtocolVersion ?? DEVICE_PROTOCOL_VERSION) !== DEVICE_PROTOCOL_VERSION ||
		input.artifactFilename !== executorPublishedFilename(input.executorVersion, input.platform)
	) {
		throw new ValidationError(
			"Executor version/protocol/artifact does not match this NarraFork build",
		);
	}
	const info = getExecutorPlatformInfo(input.platform);
	const serverBaseUrl = validateUrl("Server URL", input.serverBaseUrl, ["http:", "https:"]);
	const deviceWsUrl = validateUrl("Device WebSocket URL", input.deviceWsUrl, ["ws:", "wss:"]);
	const deviceSlug = validateSlug(input.deviceSlug);
	const expectedSha256 = validateSha256(input.expectedSha256);
	const ticket = validateTicket(input.ticket);
	const artifactFilename = validateArtifactFilename(input.artifactFilename);
	const caCertPem = normalizeInstallCa(input.caCertPem);
	if (caCertPem && !serverBaseUrl.startsWith("https:")) {
		throw new ValidationError("Installation CA requires an HTTPS server URL");
	}
	if (caCertPem && input.connectionMode === "reverse" && !deviceWsUrl.startsWith("wss:")) {
		throw new ValidationError("Installation CA requires a WSS executor URL");
	}
	assertEmbeddable("Device name", input.deviceName);
	assertEmbeddable("Executor version", input.executorVersion);

	const binaryName = executorInstalledFilename(input.platform);
	const isWindows = info.os === "windows";
	const system = input.mode === "system";

	const installDir = isWindows
		? system
			? "$env:ProgramFiles\\NarraFork"
			: "$env:LOCALAPPDATA\\NarraFork"
		: system
			? "/usr/local/bin"
			: "$HOME/.local/bin";
	const configDir = isWindows
		? system
			? "$env:ProgramData\\NarraFork"
			: "$env:LOCALAPPDATA\\NarraFork"
		: system
			? "/etc/narrafork"
			: "$HOME/.config/narrafork";

	return {
		...input,
		caCertPem,
		serverBaseUrl,
		deviceWsUrl,
		deviceSlug,
		expectedSha256,
		ticket,
		artifactFilename,
		tokenDelivery: input.tokenDelivery ?? "prompt",
		downloadUrl: `${serverBaseUrl}/api/executor/download/${input.platform}?ticket=${ticket}`,
		enrollUrl: `${serverBaseUrl}/api/executor/enroll/${input.platform}?ticket=${ticket}`,
		installDir,
		configDir,
		tokenPath: isWindows ? `${configDir}\\device-token` : `${configDir}/device-token`,
		configPath: isWindows ? `${configDir}\\executor.json` : `${configDir}/executor.json`,
		binaryName,
	};
}

/**
 * The canonical "is systemd actually running" test — `sd_booted()` in shell form.
 *
 * `command -v systemctl` is NOT a substitute and was the original defect. Debian
 * images ship the systemd *binaries* as ordinary package content, so a PRoot /
 * proot-distro guest, a Docker image, or a WSL distro without systemd enabled all
 * have a working `/usr/bin/systemctl` that cannot reach any manager. There
 * `systemctl daemon-reload` exits 1, and under the installer's `set -eu` that
 * aborted the run *after* the binary, key and config were already in place: a
 * fully provisioned machine whose executor never starts, with the only clue being
 * a "Failed to connect to bus" line.
 */
const SYSTEMD_RUNNING_TEST = "[ -d /run/systemd/system ]";

/**
 * User mode needs a second check beyond `SYSTEMD_RUNNING_TEST`.
 *
 * A per-user manager is a separate thing from the system one: it is absent in an
 * ssh session on a host without lingering enabled, and inside containers that run
 * systemd only for PID 1. `show-environment` is the cheapest read-only probe that
 * actually touches the user bus, so it fails exactly when `--user enable --now`
 * would.
 */
const SYSTEMD_USER_BUS_TEST = "systemctl --user show-environment >/dev/null 2>&1";

/**
 * Relative to `$CONFIG_DIR`. Holds the supervisor pidfile and the bounded log,
 * i.e. the state systemd would otherwise own (journal + unit state).
 */
const SUPERVISOR_STATE_SUBDIR = "run";
const SUPERVISOR_CTL_NAME = "narrafork-executor-ctl";

/**
 * Markers around the autostart line appended to the login profile.
 *
 * Present so re-running the installer replaces nothing and appends nothing twice,
 * and so a human can find and delete the block. Without an init system the login
 * profile is the only "start it again next time" hook that exists.
 */
const AUTOSTART_BEGIN_MARKER = "# >>> narrafork-executor autostart >>>";
const AUTOSTART_END_MARKER = "# <<< narrafork-executor autostart <<<";

/**
 * A POSIX-sh process supervisor, installed next to the binary when the machine has
 * no service manager at all.
 *
 * It exists because "no systemd" is not a rare case: proot-distro guests on
 * Android, minimal container images, and WSL distros with systemd disabled all
 * land here, and on those machines the executor is otherwise a foreground process
 * that dies with the terminal that started it.
 *
 * Three properties are load-bearing:
 *
 * - **`setsid`, not just `nohup`.** nohup only ignores SIGHUP; the process stays
 *   in the invoking session and keeps its controlling terminal. `setsid` gives it
 *   a fresh session with no terminal, which is what lets it outlive the shell.
 *   Verified on a proot-distro guest: PPID becomes 1 and the process survives the
 *   parent shell exiting.
 * - **The log is size-bounded.** systemd would have handed stdout to a journal
 *   with its own rotation. Appending forever instead is a disk-filling bug on
 *   precisely the small devices this path targets.
 * - **Restart backoff resets after an uptime threshold.** A process that ran for a
 *   minute is working; carrying a penalty forward from an unrelated earlier crash
 *   would turn one bad restart into a permanently slow one.
 *
 * Emitted inside a QUOTED heredoc, so `$$`, `$!` and the local variables below
 * reach the file literally. The only values interpolated by JavaScript are
 * code-controlled paths (never operator input), and they are written in double
 * quotes so a `$HOME` inside them expands when the control script runs.
 */
function supervisorControlScript(input: ResolvedInput): string[] {
	const binaryPath = `${input.installDir}/${input.binaryName}`;
	const stateDir = `${input.configDir}/${SUPERVISOR_STATE_SUBDIR}`;
	return [
		"#!/bin/sh",
		"# NarraFork remote executor supervisor.",
		"#",
		"# Installed because this machine has no service manager (no running systemd).",
		"# Keeps one executor alive, restarts it with backoff, bounds its own log.",
		"#   start | stop | restart | status | log [lines]",
		"set -u",
		"",
		`BINARY="${binaryPath}"`,
		`CONFIG_FILE="${input.configPath}"`,
		`TOKEN_FILE="${input.tokenPath}"`,
		`STATE_DIR="${stateDir}"`,
		'SUPERVISOR_PID_FILE="$STATE_DIR/supervisor.pid"',
		'CHILD_PID_FILE="$STATE_DIR/executor.pid"',
		'LOG_FILE="$STATE_DIR/executor.log"',
		"# Bounded deliberately: this path exists for phones and small images, where an",
		"# append-forever log is a disk-filling bug rather than a debugging aid.",
		"LOG_MAX_BYTES=1048576",
		"# How often a RUNNING executor's log is checked against that bound.",
		"#",
		"# Checking only between restarts (which is all the first version did) bounds the",
		"# log of a crash-looping executor and does nothing at all for a healthy one — the",
		"# case that actually runs for weeks. Short interval also caps how long `stop`",
		"# takes to be acted on: the shell defers its TERM handler until the current",
		"# `sleep` returns.",
		"LOG_CHECK_SECONDS=5",
		"",
		'mkdir -p "$STATE_DIR" 2>/dev/null || true',
		'chmod 700 "$STATE_DIR" 2>/dev/null || true',
		"",
		"# Refuses anything non-numeric: a truncated or hand-edited pidfile must not",
		"# turn into a kill against an unrelated pid.",
		"read_pid() {",
		'  [ -f "$1" ] || return 1',
		'  _pid=$(cat "$1" 2>/dev/null) || return 1',
		'  case "$_pid" in',
		"    ''|*[!0-9]*) return 1 ;;",
		"  esac",
		"  printf '%s' \"$_pid\"",
		"}",
		"",
		"supervisor_running() {",
		'  _sp=$(read_pid "$SUPERVISOR_PID_FILE") || return 1',
		'  kill -0 "$_sp" 2>/dev/null',
		"}",
		"",
		"# Copy-then-truncate, NOT rename.",
		"#",
		"# The executor holds this file open for the whole run, so renaming it would",
		"# leave the process writing into the ROTATED file: executor.log.1 would then",
		"# grow without bound while the file the check looks at stays empty — the exact",
		"# bug the bound exists to prevent, now invisible. Truncating in place is safe",
		"# because the redirection is append mode, which recomputes the offset on every",
		"# write instead of keeping a stale one (no sparse gap).",
		"rotate_log() {",
		'  [ -f "$LOG_FILE" ] || return 0',
		// `tr` strips the padding some `wc` implementations emit; without it the numeric
		// guard below would reject a valid size and silently disable rotation.
		'  _size=$(wc -c < "$LOG_FILE" 2>/dev/null | tr -d "[:space:]")',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		'  case "${_size:-x}" in',
		"    ''|*[!0-9]*) return 0 ;;",
		"  esac",
		'  [ "$_size" -gt "$LOG_MAX_BYTES" ] || return 0',
		'  cp -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true',
		'  : > "$LOG_FILE" 2>/dev/null || true',
		"}",
		"",
		"# A healthy executor never exits, so checking the log only between restarts",
		"# bounds nothing on the machines that stay up. This runs the check on a timer",
		"# for as long as the supervisor lives.",
		"#",
		"# A background subshell rather than a poll around `wait`: an exited child stays",
		"# a zombie until it is reaped, and `kill -0` keeps succeeding on a zombie, so a",
		"# `kill -0` poll loop would spin forever instead of restarting the executor.",
		"start_rotator() {",
		'  ( while :; do sleep "$LOG_CHECK_SECONDS"; rotate_log; done ) &',
		"  ROTATOR_PID=$!",
		"}",
		"",
		"stop_rotator() {",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		'  [ -n "${ROTATOR_PID:-}" ] || return 0',
		'  kill -TERM "$ROTATOR_PID" 2>/dev/null || true',
		'  ROTATOR_PID=""',
		"}",
		"",
		"stop_child() {",
		'  _cp=$(read_pid "$CHILD_PID_FILE") || return 0',
		'  kill -TERM "$_cp" 2>/dev/null || return 0',
		"  _i=0",
		'  while [ "$_i" -lt 30 ]; do',
		'    kill -0 "$_cp" 2>/dev/null || return 0',
		"    sleep 1",
		"    _i=$((_i + 1))",
		"  done",
		'  kill -KILL "$_cp" 2>/dev/null || true',
		"}",
		"",
		"# Internal subcommand: the restart loop. Started detached by `start`.",
		"supervise() {",
		'  echo "$$" > "$SUPERVISOR_PID_FILE"',
		"  # The rotator is killed alongside the executor: leaving it behind would keep a",
		"  # timer running against a log nobody writes to any more.",
		'  trap \'stop_rotator; stop_child; rm -f "$SUPERVISOR_PID_FILE" "$CHILD_PID_FILE"; exit 0\' TERM INT',
		'  ROTATOR_PID=""',
		"  start_rotator",
		"  _delay=1",
		"  while :; do",
		"    rotate_log",
		"    _started=$(date +%s 2>/dev/null || echo 0)",
		'    "$BINARY" --config "$CONFIG_FILE" --token-file "$TOKEN_FILE" >> "$LOG_FILE" 2>&1 &',
		"    _child=$!",
		'    echo "$_child" > "$CHILD_PID_FILE"',
		'    wait "$_child" 2>/dev/null',
		'    rm -f "$CHILD_PID_FILE"',
		"    _now=$(date +%s 2>/dev/null || echo 0)",
		"    if [ $((_now - _started)) -ge 60 ]; then _delay=1; fi",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		'    echo "[supervisor] executor exited; restarting in ${_delay}s" >> "$LOG_FILE"',
		'    sleep "$_delay"',
		"    _delay=$((_delay * 2))",
		'    if [ "$_delay" -gt 30 ]; then _delay=30; fi',
		"  done",
		"}",
		"",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		'case "${1:-}" in',
		"  __supervise)",
		"    supervise",
		"    ;;",
		"  start)",
		"    if supervisor_running; then",
		'      echo "narrafork-executor is already running."',
		"      exit 0",
		"    fi",
		'    rm -f "$SUPERVISOR_PID_FILE" "$CHILD_PID_FILE"',
		"    # setsid, not bare nohup: nohup only ignores SIGHUP and leaves the process in",
		"    # this session with this terminal, so it still dies with the shell on some",
		"    # systems. A new session with no controlling terminal is the point.",
		"    if command -v setsid >/dev/null 2>&1; then",
		'      setsid "$0" __supervise >/dev/null 2>&1 < /dev/null &',
		"    else",
		'      nohup "$0" __supervise >/dev/null 2>&1 < /dev/null &',
		"    fi",
		"    _i=0",
		'    while [ "$_i" -lt 10 ]; do',
		"      if supervisor_running; then break; fi",
		"      sleep 1",
		"      _i=$((_i + 1))",
		"    done",
		"    if supervisor_running; then",
		'      echo "narrafork-executor started (log: $LOG_FILE)."',
		"    else",
		'      echo "narrafork-executor did not start; see $LOG_FILE" >&2',
		"      exit 1",
		"    fi",
		"    ;;",
		"  stop)",
		"    if supervisor_running; then",
		'      _sp=$(read_pid "$SUPERVISOR_PID_FILE")',
		"      # The supervisor's TERM handler stops the executor first, so signalling the",
		"      # supervisor alone must not leave an orphan behind.",
		'      kill -TERM "$_sp" 2>/dev/null || true',
		"      _i=0",
		'      while [ "$_i" -lt 35 ]; do',
		"        if ! supervisor_running; then break; fi",
		"        sleep 1",
		"        _i=$((_i + 1))",
		"      done",
		"    fi",
		"    stop_child",
		'    rm -f "$SUPERVISOR_PID_FILE" "$CHILD_PID_FILE"',
		'    echo "narrafork-executor stopped."',
		"    ;;",
		"  restart)",
		'    "$0" stop',
		'    "$0" start',
		"    ;;",
		"  status)",
		"    if supervisor_running; then",
		'      _cp=$(read_pid "$CHILD_PID_FILE") || _cp="-"',
		'      echo "running (supervisor $(read_pid "$SUPERVISOR_PID_FILE"), executor $_cp)"',
		"    else",
		'      echo "stopped"',
		"      exit 1",
		"    fi",
		"    ;;",
		"  log)",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		'    tail -n "${2:-50}" "$LOG_FILE" 2>/dev/null || echo "no log yet"',
		"    ;;",
		"  *)",
		'    echo "usage: $0 {start|stop|restart|status|log [lines]}" >&2',
		"    exit 2",
		"    ;;",
		"esac",
	];
}

/**
 * Install steps for the no-service-manager path: write the control script, hook
 * the login profile, start now, and verify it is actually up.
 *
 * The start is verified rather than assumed, for the same reason the Windows path
 * calls `Start-Service` instead of only registering one: a machine where the
 * executor cannot run must fail the install loudly, not report success and stay
 * offline.
 */
function supervisorFallbackSetup(input: ResolvedInput): string[] {
	const ctlPath = `${input.installDir}/${SUPERVISOR_CTL_NAME}`;
	const system = input.mode === "system";
	const sudo = system ? "sudo " : "";
	const q = shellSingleQuote;

	/*
	 * The autostart hook writes to the *invoking* user's profile, so it is only
	 * correct when that user can start the supervisor without elevation.
	 *
	 * In user mode that is always true. In system mode the config and key are
	 * root-owned 0600, so the supervisor has to run as root too — and a profile hook
	 * containing `sudo` would either prompt for a password at every login or fail
	 * silently in a non-interactive one. Rather than install something that
	 * misbehaves, system mode hooks the profile only when the installer is already
	 * running as root (the ordinary case for a container without systemd) and
	 * otherwise prints what to wire up manually.
	 */
	const autostartHook = [
		'PROFILE_FILE="$HOME/.profile"',
		'if [ -f "$HOME/.bash_profile" ]; then PROFILE_FILE="$HOME/.bash_profile"; fi',
		`if ! grep -qF ${q(AUTOSTART_BEGIN_MARKER)} "$PROFILE_FILE" 2>/dev/null; then`,
		"  {",
		'    echo ""',
		`    echo ${q(AUTOSTART_BEGIN_MARKER)}`,
		`    echo ${q(`[ -x "${ctlPath}" ] && "${ctlPath}" start >/dev/null 2>&1 || true`)}`,
		`    echo ${q(AUTOSTART_END_MARKER)}`,
		'  } >> "$PROFILE_FILE"',
		'  echo "Added an autostart block to $PROFILE_FILE (remove the marked lines to undo)."',
		"else",
		'  echo "Autostart block already present in $PROFILE_FILE."',
		"fi",
	];

	return [
		'echo "No running service manager detected (no systemd)."',
		'echo "Installing the bundled supervisor instead."',
		`CTL_PATH="${ctlPath}"`,
		// Written via a temp file + install(1) so the control script is never briefly
		// present with a partial body and an executable bit.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		'TMP_CTL=$(mktemp "${TMPDIR:-/tmp}/narrafork-ctl.XXXXXX")',
		"cat > \"$TMP_CTL\" <<'NFCTLEOF'",
		...supervisorControlScript(input),
		"NFCTLEOF",
		`${sudo}install -m 755 "$TMP_CTL" "$CTL_PATH"`,
		'rm -f "$TMP_CTL"',
		'echo "Supervisor installed at $CTL_PATH"',
		"",
		/*
		 * Without an init system there is no boot, so the login profile is the only
		 * hook available. On a proot-distro guest that is exactly right: entering the
		 * distro IS the boot, and `start` is a no-op when already running.
		 *
		 * Appended only when the marker is absent, so re-running the installer neither
		 * duplicates the block nor rewrites a profile the operator has since edited.
		 */
		...(system
			? [
					'if [ "$(id -u)" = "0" ]; then',
					...autostartHook.map((line) => `  ${line}`),
					"else",
					'  echo "Skipping the login autostart hook: this system-mode install keeps its"',
					'  echo "config root-owned, so the supervisor needs root. Start it at boot with"',
					'  echo "your own mechanism, or run: sudo $CTL_PATH start"',
					"fi",
				]
			: autostartHook),
		"",
		// restart, not start: a re-run must pick up the freshly written config and key
		// rather than leave an older process holding a now-rotated device key.
		`${sudo}"$CTL_PATH" restart`,
		"",
		'echo "NOTE: there is no init system here, so the executor cannot start at boot."',
		`echo "      Manage it with: ${sudo}$CTL_PATH {start|stop|restart|status|log}"`,
		/*
		 * State the privilege difference out loud, because the same install command
		 * produces materially different confinement depending on the target machine.
		 *
		 * The systemd unit runs the executor as a dedicated `narrafork-executor` account
		 * under NoNewPrivileges / ProtectSystem=full / RestrictSUIDSGID. None of that
		 * exists here — there is no manager to enforce it — so a system-mode fallback
		 * install runs as root with the executor's full reach (arbitrary file access and
		 * command execution over the wire). An operator who read the systemd path's
		 * hardening and assumed it applies everywhere would be wrong, and nothing in the
		 * output said so.
		 *
		 * Printed rather than blocked: on a container without systemd, running as root
		 * is often the only option, and refusing to install would just push the operator
		 * to a hand-rolled setup with no supervisor at all.
		 */
		...(system
			? [
					"",
					'echo "SECURITY: with no systemd, the executor runs as root here, WITHOUT the"',
					'echo "          unit hardening the systemd path applies (dedicated service"',
					'echo "          account, NoNewPrivileges, ProtectSystem, RestrictSUIDSGID)."',
					'echo "          The executor can read/write any path and run any command as"',
					'echo "          root. Prefer a user-mode install (--user) on such hosts, or"',
					'echo "          confine the device with the path rules in NarraFork."',
				]
			: []),
	];
}

function directModeNotice(input: ExecutorInstallScriptInput): string[] {
	if (input.connectionMode !== "direct") return [];
	return [
		"# NOTE: this device is registered in DIRECT mode, so NarraFork dials the",
		"# executor instead of the reverse. After this script finishes, edit the",
		"# generated config to add listenAddr plus tlsCert/tlsKey (a non-loopback",
		"# listener requires TLS), then restart the service.",
	];
}

function ptyNotice(platform: ExecutorPlatform): string[] {
	if (getExecutorPlatformInfo(platform).supportsPty) return [];
	return [
		"# NOTE: Windows ConPTY is not implemented yet, so this device cannot host",
		"# interactive terminals. File, search, transfer and Git operations work.",
	];
}

/**
 * The lines that put the device key into `$DEVICE_TOKEN`.
 *
 * Both branches end at the same place so the caller's write-to-0600-file logic is
 * shared; only the acquisition differs.
 *
 * The `prompt` branch keeps its `[ -t 0 ]` guard: it reads from stdin, so without a
 * terminal there is nothing to read and echo suppression is meaningless. The
 * `enroll` branch must NOT have that guard — it is the entire reason a piped or
 * non-interactive run can work at all.
 */
function unixDownload(input: ResolvedInput, enroll: boolean): string[] {
	const url = shellSingleQuote(enroll ? input.enrollUrl : input.downloadUrl);
	const target = enroll ? '"$TMP_ENROLL"' : '"$TMP_BINARY"';
	const failure = enroll ? " || ENROLL_FAILED=1" : "";
	if (input.caCertPem) {
		return [
			'command -v curl >/dev/null 2>&1 || { echo "NarraFork custom CA installation requires curl." >&2; exit 1; }',
			`curl ${CA_CURL_FLAGS} --max-filesize ${enroll ? 65536 : 134217728} --cacert "$TMP_CA" ${enroll ? "-X POST " : ""}${url} -o ${target}${failure}`,
		];
	}
	return [
		"if command -v curl >/dev/null 2>&1; then",
		`  curl -fsSL ${enroll ? "-X POST " : ""}${url} -o ${target}${failure}`,
		"elif command -v wget >/dev/null 2>&1; then",
		// Empty --post-data is shared by GNU and BusyBox wget; --method is not.
		enroll
			? `  wget -q --post-data='' -O ${target} ${url}${failure}`
			: `  wget -qO ${target} ${url}`,
		"else",
		'  echo "Neither curl nor wget is available." >&2',
		"  exit 1",
		"fi",
	];
}

function unixCleanupTrap(input: ResolvedInput, enroll = false): string {
	return `trap 'rm -f "$TMP_BINARY"${input.caCertPem ? ' "$TMP_CA"' : ""}${enroll ? ' "$TMP_ENROLL"' : ""}' EXIT INT TERM`;
}

function unixTokenAcquisition(input: ResolvedInput): string[] {
	if (input.tokenDelivery === "prompt") {
		return [
			"if [ ! -t 0 ]; then",
			'  echo "This script must run on a terminal so the key can be entered without" >&2',
			'  echo "appearing in argv or shell history." >&2',
			"  exit 1",
			"fi",
			'printf "Paste the device registration key (input hidden): "',
			"stty -echo 2>/dev/null || true",
			"IFS= read -r DEVICE_TOKEN",
			"stty echo 2>/dev/null || true",
			'printf "\\n"',
			'if [ -z "$DEVICE_TOKEN" ]; then',
			'  echo "No key entered." >&2',
			"  exit 1",
			"fi",
		];
	}

	return [
		'echo "Requesting the device key from NarraFork…"',
		// umask before the response file exists: the key lands in it, and a
		// world-readable temp file would defeat the 0600 destination.
		"UMASK_ENROLL_OLD=$(umask)",
		"umask 077",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		'TMP_ENROLL=$(mktemp "${TMPDIR:-/tmp}/narrafork-enroll.XXXXXX")',
		'umask "$UMASK_ENROLL_OLD"',
		// Chained onto the binary's trap so a failure here cannot leave the key
		// response behind on disk.
		unixCleanupTrap(input, true),
		...unixDownload(input, true),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		'if [ "${ENROLL_FAILED:-0}" = "1" ]; then',
		'  echo "Could not obtain the device key." >&2',
		'  echo "The enrollment ticket is short-lived and works once. Generate a fresh" >&2',
		'  echo "install command in NarraFork (Settings -> Remote devices) and retry." >&2',
		"  exit 1",
		"fi",
		// sed, not jq: a minimal host reliably has the former and often lacks the
		// latter, and discovering that after installing the binary would leave a
		// half-enrolled machine. The response shape is fixed and server-controlled.
		`DEVICE_TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$TMP_ENROLL")`,
		'rm -f "$TMP_ENROLL"',
		unixCleanupTrap(input),
		'if [ -z "$DEVICE_TOKEN" ]; then',
		'  echo "NarraFork did not return a device key." >&2',
		"  exit 1",
		"fi",
		'echo "Device key received."',
	];
}

function buildUnixScript(input: ResolvedInput): string {
	const info = getExecutorPlatformInfo(input.platform);
	const q = shellSingleQuote;
	const system = input.mode === "system";
	const sudo = system ? "sudo " : "";
	const unameArches = info.unameArches.map(q).join(" ");
	const serviceName = "narrafork-executor";

	const systemdSetup = system
		? [
				`SERVICE_PATH=/etc/systemd/system/${serviceName}.service`,
				`echo "Installing systemd unit at $SERVICE_PATH"`,
				// A dedicated account keeps the executor's filesystem reach separate from
				// the operator's; --allow-root is a path guard, not a sandbox.
				`if ! id -u ${serviceName} >/dev/null 2>&1; then`,
				`  ${sudo}useradd --system --no-create-home --shell /usr/sbin/nologin ${serviceName} || true`,
				`fi`,
				`${sudo}chown -R ${serviceName}:${serviceName} ${q(input.configDir)}`,
				`${sudo}tee "$SERVICE_PATH" >/dev/null <<'UNIT'`,
				"[Unit]",
				"Description=NarraFork Remote Executor",
				"Wants=network-online.target",
				"After=network-online.target",
				"",
				"[Service]",
				"Type=simple",
				`User=${serviceName}`,
				`Group=${serviceName}`,
				`ExecStart=${system ? "/usr/local/bin" : ""}/${input.binaryName} --config ${input.configPath} --token-file ${input.tokenPath}`,
				"Restart=always",
				"RestartSec=5s",
				"TimeoutStopSec=30s",
				"KillSignal=SIGTERM",
				"NoNewPrivileges=true",
				"PrivateTmp=true",
				"ProtectSystem=full",
				"ProtectControlGroups=true",
				"ProtectKernelModules=true",
				"ProtectKernelTunables=true",
				"LockPersonality=true",
				"RestrictSUIDSGID=true",
				"UMask=0077",
				"",
				"[Install]",
				"WantedBy=multi-user.target",
				"UNIT",
				`${sudo}systemctl daemon-reload`,
				`${sudo}systemctl enable --now ${serviceName}`,
				`${sudo}systemctl --no-pager status ${serviceName} || true`,
			]
		: [
				`SERVICE_DIR="$HOME/.config/systemd/user"`,
				`mkdir -p "$SERVICE_DIR"`,
				`SERVICE_PATH="$SERVICE_DIR/${serviceName}.service"`,
				`echo "Installing user systemd unit at $SERVICE_PATH"`,
				`cat > "$SERVICE_PATH" <<UNIT`,
				"[Unit]",
				"Description=NarraFork Remote Executor",
				"Wants=network-online.target",
				"After=network-online.target",
				"",
				"[Service]",
				"Type=simple",
				`ExecStart=${input.installDir}/${input.binaryName} --config ${input.configPath} --token-file ${input.tokenPath}`,
				"Restart=always",
				"RestartSec=5s",
				"UMask=0077",
				"",
				"[Install]",
				"WantedBy=default.target",
				"UNIT",
				`systemctl --user daemon-reload`,
				`systemctl --user enable --now ${serviceName}`,
				`systemctl --user --no-pager status ${serviceName} || true`,
			];

	/*
	 * Pick the service mechanism at RUN time, not at generation time.
	 *
	 * The server cannot know whether the target has a running init: the platform
	 * triple says `linux-arm64` for both a systemd VM and a proot-distro guest on a
	 * phone. So both paths are emitted and the script chooses.
	 *
	 * User mode additionally probes the per-user bus, because a system manager being
	 * up says nothing about whether *this* user has one (no lingering over ssh, or a
	 * container running systemd only as PID 1).
	 *
	 * Neither branch is indented, and must not be: both contain quoted heredocs
	 * (`<<'UNIT'`, `<<'NFCTLEOF'`), whose terminator only ends the body when it sits
	 * at column 0. Indenting for readability would silently swallow the rest of the
	 * script into a heredoc body.
	 */
	const serviceSetup = [
		`if ${SYSTEMD_RUNNING_TEST}${system ? "" : ` && ${SYSTEMD_USER_BUS_TEST}`}; then`,
		...systemdSetup,
		"else",
		...supervisorFallbackSetup(input),
		"fi",
	];

	const launchdSetup =
		input.mode === "system"
			? [
					`PLIST=/Library/LaunchDaemons/com.narrafork.executor.plist`,
					`echo "Installing launchd daemon at $PLIST"`,
					`${sudo}tee "$PLIST" >/dev/null <<PLISTEOF`,
					'<?xml version="1.0" encoding="UTF-8"?>',
					'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
					'<plist version="1.0">',
					"<dict>",
					"  <key>Label</key><string>com.narrafork.executor</string>",
					"  <key>ProgramArguments</key>",
					"  <array>",
					`    <string>${input.installDir}/${input.binaryName}</string>`,
					"    <string>--config</string>",
					`    <string>${input.configPath}</string>`,
					"    <string>--token-file</string>",
					`    <string>${input.tokenPath}</string>`,
					"  </array>",
					"  <key>RunAtLoad</key><true/>",
					"  <key>KeepAlive</key><true/>",
					"</dict>",
					"</plist>",
					"PLISTEOF",
					`${sudo}launchctl unload "$PLIST" 2>/dev/null || true`,
					`${sudo}launchctl load -w "$PLIST"`,
				]
			: [
					`PLIST="$HOME/Library/LaunchAgents/com.narrafork.executor.plist"`,
					`mkdir -p "$HOME/Library/LaunchAgents"`,
					`echo "Installing launchd agent at $PLIST"`,
					`cat > "$PLIST" <<PLISTEOF`,
					'<?xml version="1.0" encoding="UTF-8"?>',
					'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
					'<plist version="1.0">',
					"<dict>",
					"  <key>Label</key><string>com.narrafork.executor</string>",
					"  <key>ProgramArguments</key>",
					"  <array>",
					`    <string>${input.installDir}/${input.binaryName}</string>`,
					"    <string>--config</string>",
					`    <string>${input.configPath}</string>`,
					"    <string>--token-file</string>",
					`    <string>${input.tokenPath}</string>`,
					"  </array>",
					"  <key>RunAtLoad</key><true/>",
					"  <key>KeepAlive</key><true/>",
					"</dict>",
					"</plist>",
					"PLISTEOF",
					`launchctl unload "$PLIST" 2>/dev/null || true`,
					`launchctl load -w "$PLIST"`,
				];

	return [
		"#!/bin/sh",
		"# NarraFork remote executor installer",
		`# Device: ${input.deviceName} (${input.deviceSlug})`,
		`# Platform: ${input.platform} · Executor v${input.executorVersion}`,
		"#",
		...(input.tokenDelivery === "enroll"
			? [
					"# The registration key is NOT in this script. It is fetched once from",
					"# NarraFork using the one-time ticket in the URLs below, then written to a",
					"# 0600 file. The key never reaches argv or shell history.",
					"#",
					"# That ticket is a credential: it is valid for minutes, the key exchange",
					"# works exactly once, and redeeming it rotates the device key. If someone",
					"# else redeems it first, this script fails rather than silently sharing.",
				]
			: [
					"# The registration key is NOT in this script. You will be prompted for it and",
					"# it is written to a 0600 file, so it never reaches argv or shell history.",
				]),
		...ptyNotice(input.platform),
		...directModeNotice(input),
		"set -eu",
		"",
		`EXPECTED_OS=${q(info.os)}`,
		"ACTUAL_OS=$(uname -s | tr '[:upper:]' '[:lower:]')",
		`if [ "$ACTUAL_OS" != "$EXPECTED_OS" ]; then`,
		`  echo "This script targets ${info.os}, but this machine reports $ACTUAL_OS." >&2`,
		`  echo "Generate a script for the correct platform in NarraFork." >&2`,
		"  exit 1",
		"fi",
		"",
		"ACTUAL_ARCH=$(uname -m)",
		"ARCH_OK=0",
		`for candidate in ${unameArches}; do`,
		`  if [ "$ACTUAL_ARCH" = "$candidate" ]; then ARCH_OK=1; fi`,
		"done",
		`if [ "$ARCH_OK" -ne 1 ]; then`,
		`  echo "This script targets ${input.platform}, but this machine reports $ACTUAL_ARCH." >&2`,
		"  exit 1",
		"fi",
		"",
		`INSTALL_DIR="${input.installDir}"`,
		`CONFIG_DIR="${input.configDir}"`,
		`BINARY="$INSTALL_DIR/${input.binaryName}"`,
		`TOKEN_FILE="${input.tokenPath}"`,
		`CONFIG_FILE="${input.configPath}"`,
		`EXPECTED_SHA256=${q(input.expectedSha256)}`,
		"",
		`echo "Downloading narrafork-executor v${input.executorVersion} (${input.platform})…"`,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		'TMP_BINARY=$(mktemp "${TMPDIR:-/tmp}/narrafork-executor.XXXXXX")',
		"trap 'rm -f \"$TMP_BINARY\"' EXIT INT TERM",
		...(input.caCertPem
			? [
					// biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion
					'TMP_CA=$(mktemp "${TMPDIR:-/tmp}/narrafork-ca.XXXXXX")',
					unixCleanupTrap(input),
					`printf '%s' ${q(input.caCertPem)} > "$TMP_CA"`,
				]
			: []),
		...unixDownload(input, false),
		"",
		"# Verify the digest even though the download used TLS: this script may have",
		"# been forwarded, and the binary gains full access to the account it runs as.",
		"if command -v sha256sum >/dev/null 2>&1; then",
		'  ACTUAL_SHA256=$(sha256sum "$TMP_BINARY" | cut -d" " -f1)',
		"elif command -v shasum >/dev/null 2>&1; then",
		'  ACTUAL_SHA256=$(shasum -a 256 "$TMP_BINARY" | cut -d" " -f1)',
		"else",
		'  echo "No sha256 tool found; refusing to install unverified binary." >&2',
		"  exit 1",
		"fi",
		'if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then',
		'  echo "Checksum mismatch! expected $EXPECTED_SHA256, got $ACTUAL_SHA256" >&2',
		"  exit 1",
		"fi",
		'echo "Checksum verified."',
		"",
		`${sudo}mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"`,
		`${sudo}install -m 755 "$TMP_BINARY" "$BINARY"`,
		...(input.caCertPem && input.connectionMode === "reverse"
			? [`${sudo}install -m 644 "$TMP_CA" "$CONFIG_DIR/server-ca.pem"`]
			: []),
		'echo "Installed $BINARY"',
		...(input.caCertPem && input.connectionMode === "reverse"
			? [
					"# Older published executors silently ignore unknown JSON fields.",
					"# Refuse before redeeming the one-time enrollment ticket.",
					'EXECUTOR_HELP=$("$BINARY" --help 2>&1 || true)',
					'case "$EXECUTOR_HELP" in',
					"  *-ca-file*) ;;",
					'  *) echo "This executor release does not support custom CA trust. Publish an updated executor and generate a fresh install command." >&2; exit 1 ;;',
					"esac",
					"unset EXECUTOR_HELP",
				]
			: []),
		"",
		...unixTokenAcquisition(input),
		"",
		"UMASK_OLD=$(umask)",
		"umask 077",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
		'TMP_TOKEN=$(mktemp "${TMPDIR:-/tmp}/narrafork-token.XXXXXX")',
		'printf "%s" "$DEVICE_TOKEN" > "$TMP_TOKEN"',
		"unset DEVICE_TOKEN",
		`${sudo}install -m 600 "$TMP_TOKEN" "$TOKEN_FILE"`,
		'rm -f "$TMP_TOKEN"',
		'umask "$UMASK_OLD"',
		'echo "Key stored at $TOKEN_FILE (mode 600)"',
		"",
		// Quoted delimiter: the body is already fully literal, so no parameter or
		// command substitution may run even as values change.
		`${sudo}tee "$CONFIG_FILE" >/dev/null <<'CONFEOF'`,
		"{",
		`  "serverUrl": ${JSON.stringify(input.deviceWsUrl)},`,
		...(input.caCertPem && input.connectionMode === "reverse"
			? ['  "caFile": "server-ca.pem",']
			: []),
		`  "deviceRef": ${JSON.stringify(input.deviceSlug)},`,
		// Empty = unrestricted. Path rules are configured after install, from the
		// device page, where the operator can browse the machine's real directories.
		`  "pathRules": [],`,
		`  "disableShell": ${input.disableShell ? "true" : "false"}`,
		"}",
		"CONFEOF",
		`${sudo}chmod 600 "$CONFIG_FILE"`,
		'echo "Config written to $CONFIG_FILE"',
		"",
		...(info.os === "darwin" ? launchdSetup : serviceSetup),
		"",
		'"$BINARY" --version || true',
		'echo ""',
		'echo "Done. Open NarraFork → Settings → Remote devices and use \\"Test connection\\"."',
		"",
	].join("\n");
}

/**
 * PowerShell counterpart of `unixTokenAcquisition`. Leaves the key in
 * `$plainToken` for the shared ACL/write logic that follows.
 *
 * The enroll branch uses `Invoke-RestMethod`, which parses the JSON response
 * itself, so there is no equivalent of the sed-vs-jq concern here.
 */
function windowsTokenAcquisition(input: ResolvedInput): string[] {
	const q = powershellSingleQuote;
	if (input.tokenDelivery === "prompt") {
		return [
			"$secureToken = Read-Host -Prompt 'Paste the device registration key' -AsSecureString",
			"$plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(",
			"  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken))",
			"if ([string]::IsNullOrWhiteSpace($plainToken)) { Write-Error 'No key entered.' }",
		];
	}
	return [
		"Write-Host 'Requesting the device key from NarraFork…'",
		"try {",
		...(input.caCertPem
			? [
					`  $enrollJson = & $nfCurl ${WINDOWS_CA_CURL_FLAGS} --max-filesize 65536 --cacert $caFile -X POST ${q(input.enrollUrl)}`,
					"  if ($LASTEXITCODE -ne 0) { throw 'NarraFork enrollment request failed.' }",
					"  $enrollResponse = ($enrollJson -join [Environment]::NewLine) | ConvertFrom-Json",
				]
			: [
					`  $enrollResponse = Invoke-RestMethod -Method Post -Uri ${q(input.enrollUrl)} -UseBasicParsing`,
				]),
		"} catch {",
		"  Write-Error (",
		"    'Could not obtain the device key: ' + $_.Exception.Message + " +
			"' The enrollment ticket is short-lived and works once; generate a fresh " +
			"install command in NarraFork (Settings -> Remote devices) and retry.')",
		"}",
		"$plainToken = $enrollResponse.token",
		"if ([string]::IsNullOrWhiteSpace($plainToken)) {",
		"  Write-Error 'NarraFork did not return a device key.'",
		"}",
		"Write-Host 'Device key received.'",
	];
}

function buildWindowsScript(input: ResolvedInput): string {
	const info = getExecutorPlatformInfo(input.platform);
	const q = powershellSingleQuote;
	const serviceName = "NarraForkExecutor";
	const system = input.mode === "system";

	return [
		"# NarraFork remote executor installer (PowerShell)",
		`# Device: ${input.deviceName} (${input.deviceSlug})`,
		`# Platform: ${input.platform} · Executor v${input.executorVersion}`,
		"#",
		...(input.tokenDelivery === "enroll"
			? [
					"# The registration key is NOT in this script. It is fetched once from",
					"# NarraFork using the one-time ticket in the URLs below, then written to an",
					"# ACL-restricted file. The key never reaches argv or history.",
					"#",
					"# That ticket is a credential: it is valid for minutes, the key exchange",
					"# works exactly once, and redeeming it rotates the device key. If someone",
					"# else redeems it first, this script fails rather than silently sharing.",
				]
			: [
					"# The registration key is NOT in this script. You will be prompted for it and",
					"# it is written to an ACL-restricted file, so it never reaches argv or history.",
				]),
		...ptyNotice(input.platform),
		...directModeNotice(input),
		"$ErrorActionPreference = 'Stop'",
		"",
		`$expectedArch = ${q(info.arch === "amd64" ? "AMD64" : "ARM64")}`,
		"$actualArch = $env:PROCESSOR_ARCHITECTURE",
		"if ($actualArch -ne $expectedArch) {",
		`  Write-Error "This script targets ${input.platform} ($expectedArch), but this machine reports $actualArch."`,
		"}",
		"",
		...(system
			? [
					"$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
					"$principal = New-Object Security.Principal.WindowsPrincipal($identity)",
					"if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {",
					"  Write-Error 'Installing a Windows service requires an elevated PowerShell session.'",
					"}",
					"",
				]
			: []),
		// These are fixed, code-controlled paths containing an $env: reference, so
		// they use double quotes to let PowerShell expand the variable. Operator
		// input never reaches this line.
		`$installDir = "${input.installDir}"`,
		`$configDir = "${input.configDir}"`,
		`$binary = Join-Path $installDir ${q(input.binaryName)}`,
		`$tokenFile = Join-Path $configDir 'device-token'`,
		`$configFile = Join-Path $configDir 'executor.json'`,
		`$expectedSha256 = ${q(input.expectedSha256)}`,
		"",
		"New-Item -ItemType Directory -Force -Path $installDir | Out-Null",
		"New-Item -ItemType Directory -Force -Path $configDir | Out-Null",
		...(input.caCertPem
			? [
					...WINDOWS_CA_CURL_SETUP,
					"$caFile = Join-Path $configDir 'server-ca.pem'",
					`[System.IO.File]::WriteAllBytes($caFile, [Convert]::FromBase64String('${Buffer.from(input.caCertPem).toString("base64")}'))`,
				]
			: []),
		"",
		`Write-Host "Downloading narrafork-executor v${input.executorVersion} (${input.platform})…"`,
		"$tempBinary = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())",
		"try {",
		...(input.caCertPem
			? [
					`  & $nfCurl ${WINDOWS_CA_CURL_FLAGS} --max-filesize 134217728 --cacert $caFile ${q(input.downloadUrl)} -o $tempBinary`,
					"  if ($LASTEXITCODE -ne 0) { throw 'NarraFork executor download failed.' }",
				]
			: [`  Invoke-WebRequest -Uri ${q(input.downloadUrl)} -OutFile $tempBinary -UseBasicParsing`]),
		"",
		"  # Verify the digest even though the download used TLS: this script may have",
		"  # been forwarded, and the binary gains full access to the account it runs as.",
		"  $actualSha256 = (Get-FileHash -LiteralPath $tempBinary -Algorithm SHA256).Hash.ToLower()",
		"  if ($actualSha256 -ne $expectedSha256) {",
		'    Write-Error "Checksum mismatch! expected $expectedSha256, got $actualSha256"',
		"  }",
		"  Write-Host 'Checksum verified.'",
		"  Copy-Item -LiteralPath $tempBinary -Destination $binary -Force",
		"} finally {",
		"  Remove-Item -LiteralPath $tempBinary -Force -ErrorAction SilentlyContinue",
		"}",
		'Write-Host "Installed $binary"',
		...(input.caCertPem && input.connectionMode === "reverse"
			? [
					"# Verify capability before spending the one-time key exchange ticket.",
					"$helpProcess = New-Object System.Diagnostics.Process",
					"try {",
					"  $helpProcess.StartInfo.FileName = $binary",
					"  $helpProcess.StartInfo.Arguments = '--help'",
					"  $helpProcess.StartInfo.UseShellExecute = $false",
					"  $helpProcess.StartInfo.CreateNoWindow = $true",
					"  $helpProcess.StartInfo.RedirectStandardError = $true",
					"  $helpProcess.Start() | Out-Null",
					"  $helpOutput = $helpProcess.StandardError.ReadToEndAsync()",
					"  if (-not $helpProcess.WaitForExit(10000)) { $helpProcess.Kill(); throw 'Executor help timed out.' }",
					"  if ($helpOutput.GetAwaiter().GetResult() -notmatch '-ca-file') {",
					"    throw 'This executor release does not support custom CA trust. Publish an updated executor and generate a fresh install command.'",
					"  }",
					"} finally { $helpProcess.Dispose() }",
				]
			: []),
		"",
		...windowsTokenAcquisition(input),
		"# UTF8 without BOM: the executor reads the file as a raw token string.",
		"[System.IO.File]::WriteAllText($tokenFile, $plainToken, (New-Object System.Text.UTF8Encoding($false)))",
		"$plainToken = $null",
		"",
		// SYSTEM is included for a machine-wide install because the service runs as
		// LocalSystem; without it the service starts but cannot read its own key file.
		"# Restrict the key to this account (and SYSTEM for a service) only.",
		"$acl = Get-Acl -LiteralPath $tokenFile",
		"$acl.SetAccessRuleProtection($true, $false)",
		"foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }",
		"$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(",
		"  $env:USERNAME, 'FullControl', 'Allow')))",
		...(system
			? [
					"$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(",
					"  'NT AUTHORITY\\SYSTEM', 'FullControl', 'Allow')))",
				]
			: []),
		"Set-Acl -LiteralPath $tokenFile -AclObject $acl",
		'Write-Host "Key stored at $tokenFile (restricted ACL)"',
		"",
		"$config = [ordered]@{",
		`  serverUrl = ${q(input.deviceWsUrl)}`,
		...(input.caCertPem && input.connectionMode === "reverse"
			? ["  caFile = 'server-ca.pem'"]
			: []),
		`  deviceRef = ${q(input.deviceSlug)}`,
		// Empty = unrestricted; configured after install from the device page.
		"  pathRules = @()",
		`  disableShell = $${input.disableShell ? "true" : "false"}`,
		"}",
		// Windows PowerShell 5's Set-Content -Encoding utf8 adds a BOM, which Go's
		// JSON decoder rejects. Use the same BOM-free encoding as the token file.
		"[System.IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 3), (New-Object System.Text.UTF8Encoding($false)))",
		'Write-Host "Config written to $configFile"',
		"",
		/*
		 * system mode installs a real Windows service; user mode uses a scheduled task.
		 *
		 * The service path requires the executor to implement the service control
		 * dispatcher, which it does since v0.5.25 (`cmd/narrafork-executor/
		 * service_windows.go`): it detects an SCM launch with `svc.IsWindowsService()`
		 * and reports SERVICE_RUNNING once serving begins. Before that support existed,
		 * `New-Service` produced a service the SCM killed at startup with error 1053.
		 *
		 * That history is why the service is STARTED here rather than merely registered:
		 * if the installed binary cannot actually run as a service, the install must fail
		 * loudly at install time instead of leaving a service that fails at every boot.
		 *
		 * user mode stays a scheduled task on purpose — registering a service needs
		 * administrator rights, which is exactly what a user-level install avoids.
		 */
		...(system
			? [
					"# Machine-wide install: a Windows service, started under SYSTEM.",
					`$existing = Get-Service -Name ${q(serviceName)} -ErrorAction SilentlyContinue`,
					"if ($existing) {",
					`  Stop-Service -Name ${q(serviceName)} -Force -ErrorAction SilentlyContinue`,
					`  sc.exe delete ${serviceName} | Out-Null`,
					"  Start-Sleep -Seconds 2",
					"}",
					// An interim installer version registered a scheduled task for system mode.
					// Left behind it would run a second executor against the same device.
					`$staleTask = Get-ScheduledTask -TaskName ${q(serviceName)} -ErrorAction SilentlyContinue`,
					"if ($staleTask) {",
					"  Write-Host 'Removing the scheduled task from a previous install…'",
					`  Stop-ScheduledTask -TaskName ${q(serviceName)} -ErrorAction SilentlyContinue`,
					`  Unregister-ScheduledTask -TaskName ${q(serviceName)} -Confirm:$false -ErrorAction SilentlyContinue`,
					"}",
					"$binPath = '\"' + $binary + '\" --config \"' + $configFile + '\" --token-file \"' + $tokenFile + '\"'",
					`New-Service -Name ${q(serviceName)} -BinaryPathName $binPath -DisplayName 'NarraFork Remote Executor' -StartupType Automatic | Out-Null`,
					// Restart on failure, matching Restart=always in the systemd unit. Without
					// this the SCM gives up after the first crash and the device silently stays
					// offline until someone notices.
					`sc.exe failure ${serviceName} reset= 86400 actions= restart/5000/restart/5000/restart/60000 | Out-Null`,
					`sc.exe description ${serviceName} "Runs NarraFork file, search and command operations on this machine." | Out-Null`,
					// The service logs to the Application event log under this source
					// (`service_windows.go`). Registering the source makes Event Viewer render
					// the entries properly instead of "description for Event ID ... cannot be
					// found"; RegisterEventSource itself works unregistered, so this is cosmetic
					// — but an unexplainable log is what a failed service start becomes.
					// Idempotent: re-runs skip the registration when the source already exists.
					"if (-not [System.Diagnostics.EventLog]::SourceExists('NarraForkExecutor')) {",
					"  New-EventLog -LogName Application -Source 'NarraForkExecutor'",
					"}",
					`Start-Service -Name ${q(serviceName)}`,
					`Get-Service -Name ${q(serviceName)} | Format-List Name, Status, StartType`,
				]
			: [
					"# User-level install: run at logon via a scheduled task (no admin rights needed).",
					"$action = New-ScheduledTaskAction -Execute $binary -Argument (",
					"  '--config \"' + $configFile + '\" --token-file \"' + $tokenFile + '\"')",
					"$trigger = New-ScheduledTaskTrigger -AtLogOn",
					// Without an unlimited ExecutionTimeLimit a task is killed after 3 days by
					// default, which would look like a random disconnect long after install.
					"$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)",
					`Register-ScheduledTask -TaskName ${q(serviceName)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
					`Start-ScheduledTask -TaskName ${q(serviceName)}`,
					`Get-ScheduledTask -TaskName ${q(serviceName)} | Format-List TaskName, State`,
				]),
		"",
		"& $binary --version",
		"Write-Host ''",
		"Write-Host 'Done. Open NarraFork -> Settings -> Remote devices and use \"Test connection\".'",
		"",
	].join("\n");
}

/** Generate the install script for one device and platform. */
export function buildExecutorInstallScript(
	input: ExecutorInstallScriptInput,
): GeneratedExecutorInstallScript {
	const resolved = resolvePaths(input);
	const isWindows = getExecutorPlatformInfo(input.platform).os === "windows";
	return isWindows
		? {
				script: buildWindowsScript(resolved),
				filename: `install-narrafork-executor-${input.deviceSlug}.ps1`,
				shell: "powershell",
			}
		: {
				script: buildUnixScript(resolved),
				filename: `install-narrafork-executor-${input.deviceSlug}.sh`,
				shell: "sh",
			};
}
