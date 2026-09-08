import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXECUTOR_PLATFORMS } from "@shared/remote-executor";
import { generate } from "selfsigned";
import {
	buildExecutorInstallOneLiner,
	buildExecutorInstallScript,
	type ExecutorInstallScriptInput,
} from "../executor-install-script";

// Bootstrap and a sandboxed installer prefix execute; service setup is never run.
// Fixtures and HOME/TMPDIR stay under this test directory; no real device or service is touched.
const TICKET = "0123456789abcdef".repeat(4);
const STDIN = "original stdin: spaces, 'quotes', $dollar and \\backslash";
const MAX_OUTPUT_BYTES = 32 * 1024;
const PROCESS_TIMEOUT_MS = 8_000;
const unixTest = process.platform === "win32" ? test.skip : test;
type Certificate = Awaited<ReturnType<typeof generate>>;
let trusted: Certificate;
let wrong: Certificate;
let mismatched: Certificate;

async function certificate(includeIp: boolean): Promise<Certificate> {
	return generate([{ name: "commonName", value: "localhost" }], {
		keyType: "ec",
		algorithm: "sha256",
		notBeforeDate: new Date(Date.now() - 60_000),
		notAfterDate: new Date(Date.now() + 86_400_000),
		extensions: [
			{ name: "basicConstraints", cA: true, critical: true },
			{ name: "keyUsage", keyCertSign: true, digitalSignature: true, critical: true },
			{ name: "extKeyUsage", serverAuth: true },
			{
				name: "subjectAltName",
				altNames: [
					{ type: 2, value: "localhost" },
					...(includeIp ? [{ type: 7 as const, ip: "127.0.0.1" }] : []),
				],
			},
		],
	});
}

beforeAll(async () => {
	[trusted, wrong, mismatched] = await Promise.all([
		certificate(true),
		certificate(true), // Same subject, different signing key: names alone do not establish trust.
		certificate(false),
	]);
}, 15_000);

/** Drain both pipes concurrently, retaining at most 32 KiB per pipe, and bound the whole process tree. */
async function runShell(args: string[], cwd: string, env: Record<string, string>, stdin = "") {
	const child = Bun.spawn(["sh", ...args], {
		cwd,
		env,
		stdin: new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
	let timedOut = false;
	let overflow = false;
	const killGroup = () => {
		try {
			// Noninteractive sh/curl descendants stay in this dedicated process group.
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill();
		}
	};
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup();
	}, PROCESS_TIMEOUT_MS);
	async function bounded(stream: ReadableStream<Uint8Array>) {
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				const remaining = MAX_OUTPUT_BYTES - bytes;
				if (remaining > 0) chunks.push(value.subarray(0, remaining));
				bytes += value.byteLength;
				if (bytes > MAX_OUTPUT_BYTES) {
					overflow = true;
					killGroup();
				}
			}
		} finally {
			reader.releaseLock();
		}
		return Buffer.concat(chunks).toString("utf8");
	}
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			bounded(child.stdout),
			bounded(child.stderr),
		]);
		expect(timedOut).toBe(false);
		expect(overflow).toBe(false);
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) {
			killGroup();
			await child.exited;
		}
	}
}

async function withFixture<T>(run: (dir: string, env: Record<string, string>) => Promise<T>) {
	const dir = await mkdtemp(join(import.meta.dir, ".executor-ca-bootstrap-"));
	try {
		const home = join(dir, "home");
		const temp = join(dir, "temp with spaces");
		const certDir = join(dir, "empty-cert-dir");
		await Promise.all([mkdir(home), mkdir(temp), mkdir(certDir)]);
		const unrelatedBundle = join(dir, "unrelated-ca.pem");
		await writeFile(unrelatedBundle, wrong.cert);
		// Deliberately do not inherit proxies, user curlrc, TLS overrides, or shell hooks.
		return await run(dir, {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			CURL_HOME: home,
			XDG_CONFIG_HOME: home,
			TMPDIR: temp,
			CURL_CA_BUNDLE: unrelatedBundle,
			SSL_CERT_FILE: unrelatedBundle,
			SSL_CERT_DIR: certDir,
			NO_PROXY: "*",
			no_proxy: "*",
			LC_ALL: "C",
			NF_TEST_EXECUTED: join(dir, "executed"),
			NF_TEST_STDIN: join(dir, "stdin"),
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const HARMLESS_SCRIPT = [
	"#!/bin/sh",
	"set -eu",
	': > "$NF_TEST_EXECUTED"',
	"IFS= read -r original_stdin",
	'printf "%s" "$original_stdin" > "$NF_TEST_STDIN"',
	"",
].join("\n");

function input(overrides: Partial<ExecutorInstallScriptInput> = {}): ExecutorInstallScriptInput {
	return {
		platform: "linux-amd64",
		mode: "user",
		serverBaseUrl: "https://127.0.0.1:1",
		deviceWsUrl: "wss://127.0.0.1:1/ws/device",
		deviceSlug: "ca-bootstrap-fixture",
		deviceName: "CA bootstrap fixture",
		connectionMode: "reverse",
		disableShell: false,
		artifactFilename: "narrafork-executor-fixture",
		expectedSha256: "a".repeat(64),
		executorVersion: "0.0.0",
		ticket: TICKET,
		tokenDelivery: "enroll",
		caCertPem: trusted.cert,
		...overrides,
	};
}

function expectSecureCurl(script: string) {
	expect(script).toContain("--cacert");
	expect(script).not.toMatch(/--insecure|--no-check-certificate|--ssl-no-revoke/);
	// Restrict short-option checks to curl invocations, not PowerShell's -TaskName.
	for (const curl of script.matchAll(/(?:\bcurl(?:\.exe)?|& \$nfCurl)\s+[^;\n]+/g)) {
		expect(curl[0]).not.toMatch(/(?:^|\s)-[a-zA-Z]*k[a-zA-Z]*(?:\s|$)/);
	}
	expect(script).not.toMatch(/SkipCertificateCheck|ServerCertificateValidationCallback/);
}

describe("custom CA bootstrap: real localhost TLS and curl (Unix only)", () => {
	for (const scenario of ["trusted", "wrong CA", "hostname mismatch", "no CA"] as const) {
		unixTest(
			`${scenario}: validates TLS before exposing the ticket or executing, and cleans temporary trust`,
			async () => {
				await withFixture(async (dir, env) => {
					const cert = scenario === "hostname mismatch" ? mismatched : trusted;
					const requests: string[] = [];
					const caFiles: string[] = [];
					const caModes: number[] = [];
					const directoryModes: number[] = [];
					const server = Bun.serve({
						hostname: "127.0.0.1",
						port: 0,
						tls: { key: cert.private, cert: cert.cert },
						async fetch(request) {
							requests.push(request.url);
							// Inspect only our fixture TMPDIR while curl is active, before its EXIT trap.
							for (const entry of await readdir(env.TMPDIR)) {
								const path = join(env.TMPDIR, entry);
								const info = await stat(path);
								if (info.isDirectory()) {
									directoryModes.push(info.mode & 0o777);
									for (const file of await readdir(path)) {
										const candidate = join(path, file);
										if (file.endsWith(".pem")) {
											caFiles.push(await readFile(candidate, "utf8"));
											caModes.push((await stat(candidate)).mode & 0o777);
										}
									}
								}
							}
							return new Response(HARMLESS_SCRIPT);
						},
					});
					try {
						const scriptUrl = `https://127.0.0.1:${server.port}/install.sh?ticket=${TICKET}`;
						const caCertPem =
							scenario === "no CA" ? undefined : scenario === "wrong CA" ? wrong.cert : cert.cert;
						const command = buildExecutorInstallOneLiner({ scriptUrl, shell: "sh", caCertPem });
						const result = await runShell(["-c", command], dir, env, `${STDIN}\n`);
						expect(result.stdout + result.stderr).not.toContain(TICKET);
						if (scenario === "trusted") {
							expect(result.exitCode).toBe(0);
							expect(requests).toEqual([scriptUrl]);
							expect(existsSync(env.NF_TEST_EXECUTED)).toBe(true);
							expect(await readFile(env.NF_TEST_STDIN, "utf8")).toBe(STDIN);
							expect(caFiles.map((pem) => pem.trim())).toEqual([trusted.cert.trim()]);
							expect(caModes).toEqual([0o600]);
							expect(directoryModes).toEqual([0o700]);
						} else {
							expect(result.exitCode).not.toBe(0);
							// No HTTP handler invocation means TLS never released the credential-bearing URL.
							expect(requests).toEqual([]);
							expect(result.stderr).toMatch(/curl: \(60\)/);
							expect(existsSync(env.NF_TEST_EXECUTED)).toBe(false);
							expect(existsSync(env.NF_TEST_STDIN)).toBe(false);
						}
						expect(await readdir(env.TMPDIR)).toEqual([]);
					} finally {
						await server.stop(true);
					}
				});
			},
			15_000,
		);
	}

	for (const scenario of ["HTTP error", "empty response", "script failure"] as const) {
		unixTest(
			`${scenario}: exits nonzero and cleans temporary CA files`,
			async () => {
				await withFixture(async (dir, env) => {
					const server = Bun.serve({
						hostname: "127.0.0.1",
						port: 0,
						tls: { key: trusted.private, cert: trusted.cert },
						fetch() {
							if (scenario === "HTTP error") return new Response(HARMLESS_SCRIPT, { status: 403 });
							return new Response(scenario === "empty response" ? "" : "exit 37\n");
						},
					});
					try {
						const command = buildExecutorInstallOneLiner({
							scriptUrl: `https://127.0.0.1:${server.port}/install.sh?ticket=${TICKET}`,
							shell: "sh",
							caCertPem: trusted.cert,
						});
						const result = await runShell(["-c", command], dir, env, `${STDIN}\n`);
						expect(result.exitCode).not.toBe(0);
						if (scenario === "script failure") expect(result.exitCode).toBe(37);
						expect(result.stdout + result.stderr).not.toContain(TICKET);
						expect(existsSync(env.NF_TEST_EXECUTED)).toBe(false);
						expect(await readdir(env.TMPDIR)).toEqual([]);
					} finally {
						await server.stop(true);
					}
				});
			},
			15_000,
		);
	}
});

describe("custom CA provisioning prefix (sandbox, no service setup)", () => {
	for (const capable of [true, false]) {
		(process.platform === "linux" ? test : test.skip)(
			`downloads over TLS and ${capable ? "persists trust before connection" : "rejects an old binary before enrollment"}`,
			async () => {
				await withFixture(async (dir, env) => {
					const binary = `#!/bin/sh\nprintf '%s\\n' '${capable ? "-ca-file string" : "-config string"}' >&2\nexit 1\n`;
					const requests: string[] = [];
					let script = "";
					const server = Bun.serve({
						hostname: "127.0.0.1",
						port: 0,
						tls: { key: trusted.private, cert: trusted.cert },
						fetch(request) {
							const path = new URL(request.url).pathname;
							requests.push(`${request.method} ${path}`);
							if (path === "/install.sh") return new Response(script);
							if (path.includes("/download/")) return new Response(binary);
							if (path.includes("/enroll/")) return Response.json({ token: "rdev_fixture" });
							return new Response("Not found", { status: 404 });
						},
					});
					try {
						const baseUrl = `https://127.0.0.1:${server.port}`;
						const generated = buildExecutorInstallScript(
							input({
								platform: process.arch === "arm64" ? "linux-arm64" : "linux-amd64",
								serverBaseUrl: baseUrl,
								deviceWsUrl: `${baseUrl.replace("https:", "wss:")}/ws/device`,
								expectedSha256: createHash("sha256").update(binary).digest("hex"),
							}),
						).script;
						// Trim BEFORE service setup. The sandbox contains only a harmless --help fixture.
						const boundary = 'echo "Config written to $CONFIG_FILE"';
						const end = generated.indexOf(boundary);
						expect(end).toBeGreaterThan(0);
						script = `${generated.slice(0, end + boundary.length)}\n`;
						expect(script).not.toContain("systemctl");
						expect(script).not.toContain("launchctl");
						const command = buildExecutorInstallOneLiner({
							scriptUrl: `${baseUrl}/install.sh?ticket=${TICKET}`,
							shell: "sh",
							caCertPem: trusted.cert,
						});
						const result = await runShell(["-c", command], dir, env);
						if (capable) {
							expect(result.exitCode).toBe(0);
							const configDir = join(env.HOME, ".config/narrafork");
							const config = JSON.parse(await readFile(join(configDir, "executor.json"), "utf8"));
							expect(config.caFile).toBe("server-ca.pem");
							expect((await readFile(join(configDir, config.caFile), "utf8")).trim()).toBe(
								trusted.cert.trim(),
							);
							expect(await readFile(join(configDir, "device-token"), "utf8")).toBe("rdev_fixture");
							expect((await stat(join(configDir, "device-token"))).mode & 0o777).toBe(0o600);
							expect(requests).toHaveLength(3);
							expect(requests[2]).toStartWith("POST /api/executor/enroll/");
						} else {
							expect(result.exitCode).not.toBe(0);
							expect(result.stderr).toContain("does not support custom CA trust");
							expect(requests).toHaveLength(2);
						}
						expect(result.stdout + result.stderr).not.toContain("rdev_fixture");
						expect(await readdir(env.TMPDIR)).toEqual([]);
					} finally {
						await server.stop(true);
					}
				});
			},
			15_000,
		);
	}
});

describe("custom CA installer generation (never executes installers)", () => {
	test("rejects malformed, oversized, injected or private PEM content", () => {
		for (const caCertPem of [
			"not PEM",
			trusted.private,
			`${trusted.cert}\n${trusted.private}`,
			`${trusted.cert}\n$(touch unexpected)`,
			trusted.cert.repeat(100),
			"-----BEGIN CERTIFICATE-----\nBAD\n-----END CERTIFICATE-----",
		]) {
			expect(() => buildExecutorInstallScript(input({ caCertPem }))).toThrow();
			expect(() =>
				buildExecutorInstallOneLiner({
					scriptUrl: "https://localhost/install",
					shell: "sh",
					caCertPem,
				}),
			).toThrow();
		}
	});

	test("refuses custom trust over plaintext and keeps direct listener trust separate", () => {
		expect(() => buildExecutorInstallScript(input({ serverBaseUrl: "http://localhost" }))).toThrow(
			"HTTPS",
		);
		expect(() =>
			buildExecutorInstallScript(input({ deviceWsUrl: "ws://localhost/ws/device" })),
		).toThrow("WSS");
		expect(() =>
			buildExecutorInstallOneLiner({
				scriptUrl: "http://localhost/install",
				shell: "sh",
				caCertPem: trusted.cert,
			}),
		).toThrow();
		for (const platform of EXECUTOR_PLATFORMS) {
			const script = buildExecutorInstallScript(
				input({ platform, connectionMode: "direct" }),
			).script;
			expectSecureCurl(script);
			expect(script).not.toContain('"caFile":');
			expect(script).not.toContain("  caFile =");
		}
	});

	for (const platform of EXECUTOR_PLATFORMS.filter((value) => !value.startsWith("windows"))) {
		unixTest(
			`${platform}: sh -n accepts CA mode for both scopes and token delivery modes`,
			async () => {
				await withFixture(async (dir, env) => {
					for (const mode of ["system", "user"] as const) {
						for (const tokenDelivery of ["prompt", "enroll"] as const) {
							const { script } = buildExecutorInstallScript(
								input({ platform, mode, tokenDelivery }),
							);
							expectSecureCurl(script);
							const curls = script.split("\n").filter((line) => /^\s*curl\s/.test(line));
							expect(curls.length).toBe(tokenDelivery === "enroll" ? 2 : 1);
							for (const curl of curls) expect(curl).toContain("--cacert");
							const result = await runShell(["-n"], dir, env, script);
							expect(result.exitCode).toBe(0);
							expect(result.stderr).toBe("");
						}
					}
				});
			},
			15_000,
		);
	}

	test("Windows generation only: all CA requests share the probed executable and Schannel policy", () => {
		const oneLiner = buildExecutorInstallOneLiner({
			scriptUrl: `https://127.0.0.1:1/install.ps1?ticket=${TICKET}`,
			shell: "powershell",
			caCertPem: trusted.cert,
		});
		expectSecureCurl(oneLiner);
		expect(oneLiner).toMatch(/& \$nfCurl --disable[^;]+@nfCurlCaFlags[^;]+--cacert/);
		expect(oneLiner).toContain("$LASTEXITCODE");
		expect(oneLiner).toMatch(/finally\s*\{\s*Remove-Item/);
		const setupStart = "$nfCurl = (Get-Command curl.exe";
		const setup = oneLiner.slice(oneLiner.indexOf(setupStart), oneLiner.indexOf("; $nfCa ="));
		expect(setup).toStartWith(setupStart);
		expect(setup).toContain("-CommandType Application -ErrorAction Stop).Source");
		expect(setup).toContain("$nfCurlVersion = @(& $nfCurl --disable --version)");
		expect(setup).toContain("$LASTEXITCODE -ne 0 -or $nfCurlVersion.Count -eq 0");
		expect(setup).toContain("throw 'Cannot determine curl TLS backend.'");
		expect(setup).toContain("$nfCurlCaFlags = @()");
		expect(setup).toContain("& $nfCurl --disable --ssl-revoke-best-effort --version | Out-Null");
		expect(setup).toContain(
			"if ($LASTEXITCODE -ne 0) { throw 'Custom CA installation requires Schannel curl 7.70.0",
		);
		expect(setup.indexOf("--ssl-revoke-best-effort --version")).toBeLessThan(
			setup.indexOf("$nfCurlCaFlags = @('--ssl-revoke-best-effort')"),
		);
		expect(setup).not.toContain("https:"); // Capability probes must never spend a ticket.
		for (const platform of ["windows-amd64", "windows-arm64"] as const) {
			for (const mode of ["system", "user"] as const) {
				for (const tokenDelivery of ["prompt", "enroll"] as const) {
					for (const connectionMode of ["direct", "reverse"] as const) {
						const { script } = buildExecutorInstallScript(
							input({ platform, mode, tokenDelivery, connectionMode }),
						);
						expectSecureCurl(script);
						expect(script.replaceAll("\n", "; ")).toContain(setup);
						const curls = script.split("\n").filter((line) => /& \$nfCurl .*--cacert/.test(line));
						expect(curls).toHaveLength(tokenDelivery === "enroll" ? 2 : 1);
						for (const curl of curls) {
							expect(curl).toContain("& $nfCurl --disable");
							expect(curl).toContain("@nfCurlCaFlags");
							expect(curl).toContain('--proto "=https" --proto-redir "=https"');
						}
						expect(script).not.toContain("& curl.exe");
						expect(script).not.toContain("Invoke-WebRequest");
						expect(script).not.toContain("Invoke-RestMethod");
						expect(script).toContain("WriteAllText($configFile");
						expect(script).not.toContain("Set-Content -LiteralPath $configFile");
						if (connectionMode === "reverse") {
							expect(script).toContain("  caFile = 'server-ca.pem'");
							if (tokenDelivery === "enroll") {
								expect(script.indexOf("does not support custom CA trust")).toBeLessThan(
									script.indexOf("/api/executor/enroll/"),
								);
							}
						}
						expect(script.indexOf("$nfCurlCaFlags = @('--ssl-revoke-best-effort')")).toBeLessThan(
							script.indexOf("/api/executor/download/"),
						);
					}
				}
			}
		}
	});

	test("Windows generation only: Schannel detection ignores inactive MultiSSL backends", () => {
		const { script } = buildExecutorInstallScript(input({ platform: "windows-amd64" }));
		// Exercise the emitted regex contract, NOT PowerShell execution or a Schannel handshake.
		const condition = script.match(
			/if \(\(\$nfCurlVersion\[0\] -replace '([^']+)', ''\) -match '([^']+)'\) \{/,
		);
		expect(condition).not.toBeNull();
		if (!condition) throw new Error("Missing Schannel backend guard");
		const inactive = new RegExp(condition[1], "g");
		const schannel = new RegExp(condition[2], "i");
		for (const [version, expected] of [
			["curl 8.10.1 (Windows) libcurl/8.10.1 Schannel zlib/1.3", true],
			["curl 8.10.1 (Windows) libcurl/8.10.1 Schannel (OpenSSL/3.3.2)", true],
			["curl 8.10.1 (Windows) libcurl/8.10.1 OpenSSL/3.3.2 (Schannel)", false],
			["curl 8.10.1 (Windows) libcurl/8.10.1 OpenSSL/3.3.2", false],
			["curl 7.69.1 (Windows) libcurl/7.69.1 Schannel", true],
		] as const) {
			expect(schannel.test(version.replace(inactive, ""))).toBe(expected);
		}
	});

	test("Schannel policy never leaks into Unix or non-custom-CA paths", () => {
		for (const platform of EXECUTOR_PLATFORMS) {
			for (const caCertPem of [undefined, trusted.cert]) {
				if (platform.startsWith("windows") && caCertPem) continue;
				const { script, shell } = buildExecutorInstallScript(input({ platform, caCertPem }));
				const oneLiner = buildExecutorInstallOneLiner({
					scriptUrl: "https://localhost/install",
					shell,
					caCertPem,
				});
				for (const generated of [script, oneLiner]) {
					expect(generated).not.toContain("ssl-revoke-best-effort");
					expect(generated).not.toContain("$nfCurl");
				}
			}
		}
	});
});
