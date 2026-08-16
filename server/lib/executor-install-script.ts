/**
 * Remote executor install script generation.
 *
 * The device settings page hands the operator a script with the real server URL,
 * device slug, platform and expected digest already filled in, so enrollment does
 * not depend on them transcribing flags correctly.
 *
 * Two rules shape everything here:
 *
 * 1. The registration token is never written into the script, argv, or the
 *    environment. The script prompts for it with echo disabled and writes it to a
 *    0600 file (Unix) or an ACL-restricted file (Windows).
 * 2. Every interpolated value is quoted for its shell. Callers supply operator
 *    input (allow-root paths, install directories), so values are validated and
 *    then escaped rather than trusted.
 */
import {
	type ExecutorPlatform,
	executorInstalledFilename,
	getExecutorPlatformInfo,
} from "@shared/remote-executor";
import { ValidationError } from "./errors";

export type ExecutorInstallMode = "system" | "user";

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
	/** Directory the executor is allowed to touch (--allow-root). */
	allowRoot: string;
	/** Remove the Bash/PTY surfaces (--disable-shell). */
	disableShell: boolean;
	/** Published artifact filename, used for the download URL path. */
	artifactFilename: string;
	/** Lowercase hex SHA-256 the script verifies before installing. */
	expectedSha256: string;
	executorVersion: string;
	/** One-time download ticket. Authorizes the binary fetch only. */
	ticket: string;
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

function validateAllowRoot(platform: ExecutorPlatform, value: string): string {
	const trimmed = value.trim();
	assertEmbeddable("Allow-root path", trimmed);
	if (!trimmed) throw new ValidationError("An allow-root directory is required");
	const isWindows = getExecutorPlatformInfo(platform).os === "windows";
	const looksAbsolute = isWindows
		? /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")
		: trimmed.startsWith("/");
	if (!looksAbsolute) {
		throw new ValidationError("The allow-root directory must be an absolute path");
	}
	return trimmed;
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
	installDir: string;
	configDir: string;
	tokenPath: string;
	configPath: string;
	binaryName: string;
}

function resolvePaths(input: ExecutorInstallScriptInput): ResolvedInput {
	const info = getExecutorPlatformInfo(input.platform);
	const serverBaseUrl = validateUrl("Server URL", input.serverBaseUrl, ["http:", "https:"]);
	const deviceWsUrl = validateUrl("Device WebSocket URL", input.deviceWsUrl, ["ws:", "wss:"]);
	const deviceSlug = validateSlug(input.deviceSlug);
	const allowRoot = validateAllowRoot(input.platform, input.allowRoot);
	const expectedSha256 = validateSha256(input.expectedSha256);
	const ticket = validateTicket(input.ticket);
	const artifactFilename = validateArtifactFilename(input.artifactFilename);
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
		serverBaseUrl,
		deviceWsUrl,
		deviceSlug,
		allowRoot,
		expectedSha256,
		ticket,
		artifactFilename,
		downloadUrl: `${serverBaseUrl}/api/executor/download/${input.platform}?ticket=${ticket}`,
		installDir,
		configDir,
		tokenPath: isWindows ? `${configDir}\\device-token` : `${configDir}/device-token`,
		configPath: isWindows ? `${configDir}\\executor.json` : `${configDir}/executor.json`,
		binaryName,
	};
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

function buildUnixScript(input: ResolvedInput): string {
	const info = getExecutorPlatformInfo(input.platform);
	const q = shellSingleQuote;
	const system = input.mode === "system";
	const sudo = system ? "sudo " : "";
	const unameArches = info.unameArches.map(q).join(" ");
	const serviceName = "narrafork-executor";

	const serviceSetup = system
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
		"# The registration key is NOT in this script. You will be prompted for it and",
		"# it is written to a 0600 file, so it never reaches argv or shell history.",
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
		"if command -v curl >/dev/null 2>&1; then",
		`  curl -fsSL ${q(input.downloadUrl)} -o "$TMP_BINARY"`,
		"elif command -v wget >/dev/null 2>&1; then",
		`  wget -qO "$TMP_BINARY" ${q(input.downloadUrl)}`,
		"else",
		'  echo "Neither curl nor wget is available." >&2',
		"  exit 1",
		"fi",
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
		'echo "Installed $BINARY"',
		"",
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
		// Quoted delimiter: the body is already fully literal, and the allow-root
		// path is operator input, so no parameter or command substitution may run.
		`${sudo}tee "$CONFIG_FILE" >/dev/null <<'CONFEOF'`,
		"{",
		`  "serverUrl": ${JSON.stringify(input.deviceWsUrl)},`,
		`  "deviceRef": ${JSON.stringify(input.deviceSlug)},`,
		`  "allowRoots": [${JSON.stringify(input.allowRoot)}],`,
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
		"# The registration key is NOT in this script. You will be prompted for it and",
		"# it is written to an ACL-restricted file, so it never reaches argv or history.",
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
		"",
		`Write-Host "Downloading narrafork-executor v${input.executorVersion} (${input.platform})…"`,
		"$tempBinary = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())",
		"try {",
		`  Invoke-WebRequest -Uri ${q(input.downloadUrl)} -OutFile $tempBinary -UseBasicParsing`,
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
		"",
		"$secureToken = Read-Host -Prompt 'Paste the device registration key' -AsSecureString",
		"$plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(",
		"  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken))",
		"if ([string]::IsNullOrWhiteSpace($plainToken)) { Write-Error 'No key entered.' }",
		"# UTF8 without BOM: the executor reads the file as a raw token string.",
		"[System.IO.File]::WriteAllText($tokenFile, $plainToken, (New-Object System.Text.UTF8Encoding($false)))",
		"$plainToken = $null",
		"",
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
		`  deviceRef = ${q(input.deviceSlug)}`,
		`  allowRoots = @(${q(input.allowRoot)})`,
		`  disableShell = $${input.disableShell ? "true" : "false"}`,
		"}",
		"$config | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $configFile -Encoding utf8",
		'Write-Host "Config written to $configFile"',
		"",
		...(system
			? [
					`$existing = Get-Service -Name ${q(serviceName)} -ErrorAction SilentlyContinue`,
					"if ($existing) {",
					`  Stop-Service -Name ${q(serviceName)} -Force -ErrorAction SilentlyContinue`,
					`  sc.exe delete ${serviceName} | Out-Null`,
					"  Start-Sleep -Seconds 2",
					"}",
					"$binPath = '\"' + $binary + '\" --config \"' + $configFile + '\" --token-file \"' + $tokenFile + '\"'",
					`New-Service -Name ${q(serviceName)} -BinaryPathName $binPath -DisplayName 'NarraFork Remote Executor' -StartupType Automatic | Out-Null`,
					`Start-Service -Name ${q(serviceName)}`,
					`Get-Service -Name ${q(serviceName)} | Format-List Name, Status, StartType`,
				]
			: [
					"# User-level install: run at logon via a scheduled task (no service rights needed).",
					"$action = New-ScheduledTaskAction -Execute $binary -Argument (",
					"  '--config \"' + $configFile + '\" --token-file \"' + $tokenFile + '\"')",
					"$trigger = New-ScheduledTaskTrigger -AtLogOn",
					"$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)",
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
