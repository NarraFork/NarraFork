import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashReleaseFile } from "../../scripts/lib/ci-release-io";
import {
	assertTaskkillTreeExited,
	descendantPids,
	SmokeProcessScope,
	taskkillPids,
} from "../../scripts/lib/ci-release-smoke-process";
import {
	assertFrontendJavaScript,
	assertHealthIdentity,
	assertMigratedDatabase,
	hasPtyMarker,
	parseSmokeArgs,
	removeSmokeDirectory,
	resolveFrontendAssetPath,
	SmokeDiagnostic,
	type SmokeOptions,
	smokeEnvironment,
	smokeFailure,
	smokePty,
	smokeReleaseBinary,
	validateSmokeMetadata,
	WatcherInbox,
} from "../../scripts/smoke-release-binary";

const roots: string[] = [];
async function temporary(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "nf-ci-smoke-test-"));
	roots.push(root);
	return root;
}
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const commit = "0123456789abcdef0123456789abcdef01234567";
const options: SmokeOptions = {
	target: "linux-x64",
	binary: "narrafork-1.2.3-linux-x64",
	metadata: "binary.metadata.json",
	commit,
	version: "1.2.3",
	output: "smoke.json",
};
const args = Object.entries(options).map(([key, value]) => `--${key}=${value}`);
const hash = { size: 100, sha256: "a".repeat(64), sha512: Buffer.alloc(64, 4).toString("base64") };
const metadata = {
	name: options.binary,
	target: "bun-linux-x64",
	platform: "linux-x64",
	version: options.version,
	commit: commit.slice(0, 8),
	buildDate: "2026-10-08T00:00:00Z",
	...hash,
};

describe("release smoke input and identity", () => {
	test("requires exact CLI contract and full commit", () => {
		expect(parseSmokeArgs(args)).toEqual(options);
		for (const invalid of [
			args.slice(1),
			[...args, "--target=linux-x64"],
			[...args, "--skip-pty=true"],
			args.map((arg) => (arg.startsWith("--commit=") ? "--commit=1234567" : arg)),
			args.map((arg) => (arg.startsWith("--target=") ? "--target=linux-arm" : arg)),
		]) {
			expect(() => parseSmokeArgs(invalid)).toThrow();
		}
	});
	test("binds name, platform, version, commit, size and both hashes", () => {
		expect(validateSmokeMetadata(metadata, options, hash)).toEqual(metadata);
		for (const changed of [
			{ name: "another" },
			{ platform: "linux-x64-baseline" },
			{ target: "bun-windows-x64" },
			{ version: "1.2.4" },
			{ commit: "abc" },
			{ commit: "f".repeat(8) },
			{ size: 99 },
			{ sha256: "b".repeat(64) },
			{ sha512: "bad" },
		]) {
			expect(() => validateSmokeMetadata({ ...metadata, ...changed }, options, hash)).toThrow();
		}
	});
	test("health must attest a ready build, not merely return HTTP 200", () => {
		const health = {
			status: "ok",
			readiness: "ready",
			commit: commit.slice(0, 8),
			version: `1.2.3+${commit.slice(0, 8)}`,
			gitAvailable: true,
		};
		expect(() => assertHealthIdentity(health, options)).not.toThrow();
		for (const changed of [
			{ readiness: "recovering" },
			{ status: "failed" },
			{ commit: "f".repeat(8) },
			{ version: "1.2.3" },
			{ gitAvailable: false },
		])
			expect(() => assertHealthIdentity({ ...health, ...changed }, options)).toThrow();
	});
	test("does not inherit credentials, source resolution or production data configuration", () => {
		const env = smokeEnvironment("/isolated", {
			PATH: "/usr/bin:/checkout/node_modules/.bin",
			NODE_PATH: "/checkout/node_modules",
			NODE_OPTIONS: "--preload=evil",
			GH_TOKEN: "secret",
			ANTHROPIC_API_KEY: "secret",
			NARRAFORK_HOME: "/real",
			NF_DATABASE_URL: "postgres://real",
			HOME: "/real",
			PORT: "7779",
		});
		expect(env.HOME).toBe(join("/isolated", "home"));
		expect(env.NARRAFORK_HOME).toBe(join("/isolated", "data"));
		expect(env.NF_DATABASE_BACKEND).toBe("sqlite");
		for (const key of [
			"GH_TOKEN",
			"NODE_PATH",
			"NODE_OPTIONS",
			"NF_DATABASE_URL",
			"ANTHROPIC_API_KEY",
			"PORT",
		])
			expect(env[key]).toBeUndefined();
		expect(env.PATH).not.toContain("node_modules");
	});
});

describe("embedded frontend entry resolution", () => {
	const origin = "http://127.0.0.1:54321";
	test("resolves Vite relative entry and same-origin injected base", () => {
		for (const src of [
			"./assets/index-Ab_12.js",
			"assets/index-Ab_12.js",
			"/assets/index-Ab_12.js",
		]) {
			expect(
				resolveFrontendAssetPath(
					`<base href="/"><script type="module" crossorigin src="${src}"></script>`,
					origin,
				),
			).toBe("/assets/index-Ab_12.js");
		}
		expect(
			resolveFrontendAssetPath(
				`<!-- <base href="https://bad.example/"> --><script src = './assets/index.js' type = 'module'></script>`,
				origin,
			),
		).toBe("/assets/index.js");
	});
	test("rejects HTML fallback or empty content even if HTTP status is 200", () => {
		const script = 'console.log("real bundled frontend entry");'.repeat(4);
		expect(() =>
			assertFrontendJavaScript("application/javascript; charset=utf-8", script),
		).not.toThrow();
		expect(() => assertFrontendJavaScript("text/html", script)).toThrow();
		expect(() =>
			assertFrontendJavaScript("application/javascript", `<html>${"fallback".repeat(30)}</html>`),
		).toThrow();
		expect(() => assertFrontendJavaScript("application/javascript", "")).toThrow();
	});
	test("uses the actual built frontend relative entry format", async () => {
		const html = await readFile(new URL("../../dist/frontend/index.html", import.meta.url), "utf8");
		expect(resolveFrontendAssetPath(html, origin)).toMatch(/^\/assets\/index-[A-Za-z0-9_-]+\.js$/);
	});
	test("rejects missing, remote, escaping and non-JavaScript module entries", () => {
		for (const src of [
			"https://bad.example/assets/index.js",
			"//bad.example/assets/index.js",
			"./assets/../assets/index.js",
			"./assets/%2e%2e/assets/index.js",
			"./assets/index.css",
			"./api/health",
			"./assets/index.js?remote=1",
			"./assets/index.js#entry",
			"./assets\\index.js",
		]) {
			expect(() =>
				resolveFrontendAssetPath(`<script type="module" src="${src}"></script>`, origin),
			).toThrow();
		}
		expect(() =>
			resolveFrontendAssetPath('<script src="./assets/index.js"></script>', origin),
		).toThrow();
		expect(() =>
			resolveFrontendAssetPath(
				'<base href="https://bad.example/"><script type="module" src="./assets/index.js"></script>',
				origin,
			),
		).toThrow("same-origin");
		expect(() =>
			resolveFrontendAssetPath(
				'<!-- <script type="module" src="./assets/index.js"></script> -->',
				origin,
			),
		).toThrow();
	});
});

describe("real process lifecycle", () => {
	test("handles actual child input/output and successful exit", async () => {
		const root = await temporary();
		const scope = new SmokeProcessScope(root, process.env);
		let output = "";
		try {
			const child = scope.spawn(
				[
					process.execPath,
					"-e",
					'process.stdin.once("data", d => { console.log(JSON.parse(d).value); process.exit(0); });',
				],
				(chunk) => {
					output += chunk.toString();
				},
			);
			child.send({ value: "real-roundtrip" });
			expect(await scope.until("child exit", () => child.status)).toBe(0);
			expect(output).toContain("real-roundtrip");
		} finally {
			await scope.close();
		}
	});
	test("kills owned process after deadline and preserves unrelated live process", async () => {
		const root = await temporary();
		const control = new SmokeProcessScope(root, process.env);
		const scope = new SmokeProcessScope(root, process.env, { timeoutMs: 200 });
		const unrelated = control.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
		const owned = scope.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
		try {
			await expect(scope.until("never ready", () => undefined)).rejects.toThrow();
			await scope.close();
			expect(owned.status).not.toBeUndefined();
			expect(unrelated.status).toBeUndefined();
			const pid = unrelated.process.pid;
			if (!pid) throw new Error("Missing control PID");
			expect(() => process.kill(pid, 0)).not.toThrow();
		} finally {
			await scope.close();
			await control.close();
		}
	});
	test("honors cancellation and refuses pre-aborted spawn", async () => {
		const root = await temporary();
		const controller = new AbortController();
		const scope = new SmokeProcessScope(root, process.env, { signal: controller.signal });
		const child = scope.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
		try {
			controller.abort(new Error("fixture cancelled"));
			await expect(scope.until("never", () => undefined)).rejects.toThrow("fixture cancelled");
			expect(() => scope.spawn([process.execPath])).toThrow("fixture cancelled");
		} finally {
			await scope.close();
		}
		expect(child.status).not.toBeUndefined();
	});
	test("bounds noisy child output before collecting it", async () => {
		const root = await temporary();
		const scope = new SmokeProcessScope(root, process.env, { maxOutputBytes: 1024 });
		const child = scope.spawn([
			process.execPath,
			"-e",
			'setInterval(() => process.stdout.write("x".repeat(2048)), 5)',
		]);
		try {
			await expect(scope.until("never", () => undefined)).rejects.toThrow();
			expect(scope.signal.aborted).toBe(true);
			expect(scope.diagnostic.length).toBeLessThan(32769);
		} finally {
			await scope.close();
		}
		expect(child.status).not.toBeUndefined();
	});
	test("reclaims a real descendant in a separate PTY-like session", async () => {
		const root = await temporary();
		const heartbeat = join(root, "heartbeat");
		const scope = new SmokeProcessScope(root, process.env);
		const worker = `const fs = require("node:fs"); setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 10);`;
		const parent = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { detached: ${process.platform !== "win32"}, stdio: "ignore" }); setInterval(() => {}, 1000);`;
		const child = scope.spawn([process.execPath, "-e", parent]);
		try {
			let ready = false;
			const timer = setInterval(() => {
				void readFile(heartbeat).then(
					() => {
						ready = true;
					},
					() => {},
				);
			}, 10);
			try {
				await scope.until("descendant heartbeat", () => (ready ? true : undefined));
			} finally {
				clearInterval(timer);
			}
			await scope.close();
			expect(child.status).not.toBeUndefined();
			const stopped = await readFile(heartbeat, "utf8");
			await new Promise((done) => setTimeout(done, 100));
			expect(await readFile(heartbeat, "utf8")).toBe(stopped);
		} finally {
			await scope.close();
		}
	});
	test("follows only root descendants even across process groups", () => {
		expect(descendantPids("20 10\n30 20\n10 1\n40 1\n50 40\n", 10)).toEqual([30, 20]);
	});
	test("reads every PID taskkill names, in any locale, except the caller", () => {
		const english =
			"SUCCESS: The process with PID 20 (child process of PID 10) has been terminated.\r\nERROR: The process with PID 30 (child process of PID 20) could not be terminated.\r\nReason: The operation is not supported.\r\nSUCCESS: The process with PID 10 (child process of PID 7) has been terminated.";
		const chinese =
			"成功: 已终止 PID 20 (属于 PID 10 子进程)的进程。\r\n错误: 无法终止 PID 30 (属于 PID 20 子进程)的进程。\r\n原因: 操作不被支持。";
		expect(taskkillPids(english, 7)).toEqual([20, 10, 30]);
		expect(taskkillPids(chinese, 7)).toEqual([20, 10, 30]);
		expect(taskkillPids('ERROR: The process "10" not found.', 7)).toEqual([]);
	});
	test.skipIf(process.platform !== "win32")(
		"judges a non-zero taskkill by which named processes still run",
		async () => {
			const root = await temporary();
			const scope = new SmokeProcessScope(root, process.env);
			try {
				const exited = scope.spawn([process.execPath, "-e", "process.exit(0)"]);
				await scope.until("short-lived child close", () => (exited.closed ? true : undefined));
				// Any later process reusing that PID was created after this cutoff.
				const exitedAt = Date.now();
				const live = scope.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
				const livePid = live.process.pid;
				const exitedPid = exited.process.pid;
				if (!livePid || !exitedPid) throw new Error("Missing fixture PID");
				await new Promise((done) => setTimeout(done, 300));
				const report = (pid: number) =>
					`ERROR: The process with PID ${pid} (child process of PID ${process.pid}) could not be terminated.`;
				// Already gone: the non-zero exit code was only the race, cleanup succeeded.
				await assertTaskkillTreeExited(report(exitedPid), exitedAt);
				// Still running from before taskkill finished: a real leak.
				await expect(assertTaskkillTreeExited(report(livePid), Date.now())).rejects.toThrow(
					`Owned processes survived cleanup: ${livePid}`,
				);
				// The same PID created after taskkill finished belongs to someone else.
				await assertTaskkillTreeExited(report(livePid), Date.now() - 3_600_000);
				// A report naming no process cannot be verified and still fails closed.
				await expect(
					assertTaskkillTreeExited('ERROR: The process "1" not found.', Date.now()),
				).rejects.toThrow("taskkill failed");
			} finally {
				await scope.close();
			}
		},
		60_000,
	);
	test("a tree whose children keep exiting is cleaned up without a false failure", async () => {
		// taskkill /T /F exits non-zero for members that are already exiting, even though the
		// whole tree is gone afterwards. Cleanup must judge the tree, not that exit code.
		const root = await temporary();
		const heartbeat = join(root, "heartbeat");
		const scope = new SmokeProcessScope(root, process.env);
		const worker = `const fs = require("node:fs"); setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 10);`;
		const parent = [
			'const { spawn } = require("node:child_process");',
			`spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { detached: ${process.platform !== "win32"}, stdio: "ignore" });`,
			'setInterval(() => spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" }), 40);',
			"setInterval(() => {}, 1000);",
		].join("\n");
		const child = scope.spawn([process.execPath, "-e", parent]);
		try {
			let ready = false;
			const timer = setInterval(() => {
				void readFile(heartbeat).then(
					() => {
						ready = true;
					},
					() => {},
				);
			}, 10);
			try {
				await scope.until("descendant heartbeat", () => (ready ? true : undefined));
			} finally {
				clearInterval(timer);
			}
			// Let several short-lived children be mid-exit when cleanup runs.
			await new Promise((done) => setTimeout(done, 400));
			await scope.close();
			expect(child.closed).toBe(true);
			const stopped = await readFile(heartbeat, "utf8");
			await new Promise((done) => setTimeout(done, 150));
			expect(await readFile(heartbeat, "utf8")).toBe(stopped);
		} finally {
			await scope.close().catch(() => {});
		}
	}, 60_000);
	test("observes spawn failure instead of hanging until global timeout", async () => {
		const root = await temporary();
		const scope = new SmokeProcessScope(root, process.env);
		try {
			const child = scope.spawn([join(root, "absent-executable")]);
			expect(await scope.until("failed spawn", () => child.status)).toBe(1);
			expect(() => child.assertRunning()).toThrow("exited");
		} finally {
			await scope.close();
		}
	});
});

describe("native protocol and database assertions", () => {
	test("assembles split JSONL messages and rejects native errors/oversize input", () => {
		const inbox = new WatcherInbox();
		inbox.push(Buffer.from('{"type":"ready",'));
		expect(inbox.take(() => true)).toBeUndefined();
		inbox.push(Buffer.from('"pid":123}\n{"type":"watch_ack","requestId":"a"}\n'));
		expect(inbox.take((message) => message.type === "watch_ack")?.requestId).toBe("a");
		expect(inbox.take((message) => message.type === "ready")?.pid).toBe(123);
		expect(() =>
			inbox.push(Buffer.from('{"type":"error","error":"missing native binding"}\n')),
		).toThrow("missing native binding");
		expect(() => new WatcherInbox().push(Buffer.alloc(65537, 120))).toThrow("budget");
	});
	test("does not accept echoed PTY input as a completed shell round trip", () => {
		expect(hasPtyMarker("$ echo NF_MARKER\r\n", "NF_MARKER")).toBe(false);
		expect(hasPtyMarker("echo NF_MARKER\r\n\u001b[32mNF_MARKER\u001b[0m\r\n$ ", "NF_MARKER")).toBe(
			true,
		);
		expect(hasPtyMarker("echo NF_MARKER\r\nNF_MARK", "NF_MARKER")).toBe(false);
		expect(hasPtyMarker("$ printf '\\n%s\\n' 'NF_MARKER'\r\n$ ", "NF_MARKER")).toBe(false);
		expect(hasPtyMarker("$ NF_MARKER\r\n$ ", "NF_MARKER")).toBe(false);
	});
	test("checks real SQLite migration evidence and persisted bootstrap user read-only", async () => {
		const root = await temporary();
		const file = join(root, "fixture.db");
		const db = new Database(file);
		db.exec(
			"CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER); CREATE TABLE users (username TEXT, role TEXT); CREATE TABLE narrators (id TEXT); CREATE TABLE narrator_messages (id TEXT); CREATE TABLE terminals (id TEXT);",
		);
		db.query("INSERT INTO __drizzle_migrations VALUES (1, ?, 1780000000000)").run("a".repeat(64));
		db.query("INSERT INTO users VALUES (?, 'admin')").run("smoke-user");
		db.close();
		const before = await readFile(file);
		expect(() => assertMigratedDatabase(file, "smoke-user")).not.toThrow();
		expect(() => assertMigratedDatabase(file, "other-user")).toThrow("persisted");
		expect(await readFile(file)).toEqual(before);
	});
});

async function executableFixture(sourceText: string, directory?: string) {
	const root = directory ?? (await temporary());
	const platform = process.platform === "win32" ? "windows" : process.platform;
	const binary = join(
		root,
		`narrafork-1.2.3-${platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`,
	);
	// Compile a genuine standalone fixture; not a mocked spawn/result.
	const source = join(root, "fixture.ts");
	await writeFile(source, sourceText);
	const builder = new SmokeProcessScope(root, process.env);
	try {
		await builder.command(
			[process.execPath, "build", source, "--compile", `--outfile=${binary}`],
			30_000,
		);
	} finally {
		await builder.close();
	}
	const measured = await hashReleaseFile(binary);
	const fixtureOptions = {
		...options,
		target: `${platform}-${process.arch}`,
		binary,
		metadata: `${binary}.metadata.json`,
		output: join(root, "smoke.json"),
	};
	await writeFile(
		fixtureOptions.metadata,
		JSON.stringify({
			...metadata,
			...measured,
			name: binary.split(/[\\/]/).pop(),
			target: `bun-${fixtureOptions.target}`,
			platform: fixtureOptions.target.replace("windows-", "win-"),
		}),
	);
	return { root, binary, measured, fixtureOptions };
}

test("failed real executable smoke never writes a success artifact", async () => {
	const { root, binary, measured, fixtureOptions } = await executableFixture(
		'console.error("intentional binary fixture failure"); process.exit(37);',
	);
	await expect(smokeReleaseBinary(fixtureOptions)).rejects.toThrow(
		"intentional binary fixture failure",
	);
	await expect(readFile(fixtureOptions.output)).rejects.toThrow();
	expect(await hashReleaseFile(binary)).toEqual(measured);
	const diagnostic = JSON.parse(await readFile(join(root, "smoke-diagnostic.json"), "utf8"));
	expect(diagnostic.kind).toBe("release-smoke-diagnostic");
	expect(diagnostic.identity).toEqual({
		target: fixtureOptions.target,
		commit,
		version: options.version,
	});
	expect(diagnostic.firstFailureStage).toBe("startup");
	expect(diagnostic.stages.product).toBe("failed");
	expect(diagnostic.stages["directory-cleanup"]).toBe("passed");
	expect(diagnostic.completedStages).toContain("binary-preparation");
	expect(diagnostic.processLog).toContain("intentional binary fixture failure");
	expect(diagnostic.checks).toBeUndefined();
}, 60_000);

test("diagnostic filesystem fault preserves primary executable failure", async () => {
	const root = await temporary();
	const blocked = join(root, "smoke-diagnostic.json");
	const fixture = await executableFixture(
		`import { mkdirSync, writeFileSync } from "node:fs";
		mkdirSync(${JSON.stringify(blocked)});
		writeFileSync(${JSON.stringify(join(blocked, "sentinel"))}, "sentinel");
		console.error("primary fixture failure"); process.exit(37);`,
		root,
	);
	let failure: unknown;
	try {
		await smokeReleaseBinary(fixture.fixtureOptions);
	} catch (error) {
		failure = error;
	}
	expect(String(failure)).toContain("primary fixture failure");
	expect(String(failure)).toContain("Smoke diagnostic output failed");
	expect(await readFile(join(blocked, "sentinel"), "utf8")).toBe("sentinel");
	await expect(readFile(fixture.fixtureOptions.output)).rejects.toThrow();
}, 60_000);

test("preflight refuses existing success or diagnostic without writes", async () => {
	const root = await temporary();
	const platform = process.platform === "win32" ? "windows" : process.platform;
	const nativeOptions = { ...options, target: `${platform}-${process.arch}` };
	for (const name of ["smoke.json", "smoke-diagnostic.json"]) {
		const directory = join(root, name);
		await mkdir(directory);
		const existing = join(directory, name);
		await writeFile(existing, "existing-result");
		const output = join(directory, "smoke.json");
		await expect(smokeReleaseBinary({ ...nativeOptions, output })).rejects.toThrow("overwrite");
		expect(await readFile(existing, "utf8")).toBe("existing-result");
		const absent = join(directory, name === "smoke.json" ? "smoke-diagnostic.json" : "smoke.json");
		await expect(readFile(absent)).rejects.toThrow();
	}
	const output = join(root, "invalid", "smoke.json");
	await expect(smokeReleaseBinary({ ...nativeOptions, output, commit: "bad" })).rejects.toThrow(
		"commit",
	);
	await expect(lstat(join(root, "invalid"))).rejects.toThrow();
	await expect(smokeReleaseBinary({ ...nativeOptions, output: "" })).rejects.toThrow("output");
	const alias = join(root, "rejected", "smoke-diagnostic.json");
	await expect(smokeReleaseBinary({ ...nativeOptions, output: alias })).rejects.toThrow(
		"diagnostic path",
	);
	await expect(lstat(join(root, "rejected"))).rejects.toThrow();
});

test("diagnostic text, filesystem names and real child logs are bounded and credential-free", async () => {
	const root = await temporary();
	const scope = new SmokeProcessScope(root, process.env);
	try {
		const child = scope.spawn([
			process.execPath,
			"-e",
			'console.log("x".repeat(100000) + " token: fixturesecret password: passwordvalue");',
		]);
		await scope.until("diagnostic fixture exit", () => (child.closed ? true : undefined));
		await scope.close();
		const diagnostic = new SmokeDiagnostic({ ...options, output: join(root, "smoke.json") });
		diagnostic.secrets.push("fixturesecret", "passwordvalue");
		diagnostic.passed("product");
		diagnostic.failed("directory cleanup", new Error("HTTP response token=fixturesecret"));
		const lockedPath = "C:\\owned\\fixturesecret\\passwordvalue\\AppData\\Edge\\Cache\\database";
		diagnostic.failed(
			"directory cleanup",
			Object.assign(new Error("never persist fixturesecret"), {
				code: "EBUSY",
				syscall: "unlink",
				path: lockedPath,
			}),
		);
		diagnostic.failed(
			"directory cleanup",
			Object.assign(new Error("never persist passwordvalue"), {
				code: "EBUSY",
				syscall: "unlink",
				path: `${"x".repeat(5_000)}/passwordvalue/Edge/database`,
			}),
		);
		diagnostic.passed("directory cleanup"); // A later retry cannot erase the recorded failure.
		diagnostic.remainingPaths = Array.from({ length: 40 }, () => "f".repeat(2000));
		for (let index = 0; index < 20; index++)
			diagnostic.failed("directory cleanup", new Error("fixturesecret"));
		await diagnostic.write(scope.diagnostic);
		const text = await readFile(join(root, "smoke-diagnostic.json"), "utf8");
		const value = JSON.parse(text);
		expect(value.firstFailureStage).toBe("directory-cleanup");
		expect(value.stages.product).toBe("passed");
		expect(value.stages["directory-cleanup"]).toBe("failed");
		expect(value.processLog.length).toBeLessThanOrEqual(32 * 1024);
		expect(value.remainingPaths.length).toBe(32);
		expect(value.remainingPaths.every((path: string) => path.length <= 512)).toBe(true);
		expect(value.failures.length).toBe(8);
		expect(value.failures[0].path).toBeUndefined();
		expect(value.failures[1]).toMatchObject({
			code: "EBUSY",
			syscall: "unlink",
			path: lockedPath
				.replaceAll("fixturesecret", "[REDACTED]")
				.replaceAll("passwordvalue", "[REDACTED]"),
		});
		expect(value.failures[2].path.length).toBe(2_048);
		expect(value.failures[2].path.endsWith("/[REDACTED]/Edge/database")).toBe(true);
		expect(
			value.failures.every(
				(failure: { path?: string }) => !failure.path || failure.path.length <= 2_048,
			),
		).toBe(true);
		expect(text).not.toContain("never persist");
		expect(text.length).toBeLessThan(64 * 1024);
		expect(text).not.toContain("fixturesecret");
		expect(text).not.toContain("passwordvalue");
		expect(text).not.toContain("HTTP response");
		await expect(diagnostic.write(scope.diagnostic)).rejects.toThrow("EEXIST");
		expect(await readFile(join(root, "smoke-diagnostic.json"), "utf8")).toBe(text);
	} finally {
		await scope.close();
	}
});

test("signal cancellation records a failure and cleans up without a success artifact", async () => {
	const fixture = await executableFixture("setInterval(() => {}, 1000);");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("fixturesecret cancellation")), 1000);
	try {
		await expect(smokeReleaseBinary(fixture.fixtureOptions, controller.signal)).rejects.toThrow();
		expect(controller.signal.aborted).toBe(true);
		await expect(readFile(fixture.fixtureOptions.output)).rejects.toThrow();
		const text = await readFile(join(fixture.root, "smoke-diagnostic.json"), "utf8");
		const diagnostic = JSON.parse(text);
		expect(["binary-preparation", "startup"]).toContain(diagnostic.firstFailureStage);
		expect(diagnostic.stages.product).toBe("failed");
		expect(diagnostic.stages["process-shutdown"]).toBe("passed");
		expect(diagnostic.stages["directory-cleanup"]).toBe("passed");
		expect(text).not.toContain("fixturesecret");
	} finally {
		clearTimeout(timeout);
	}
}, 60_000);

function nativeSmokeFixture(configuration: string, evidence: string): string {
	return `
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const mode = readFileSync(${JSON.stringify(configuration)}, "utf8");
const root = dirname(process.cwd());
if (process.argv.includes("--narrafork-watcher-worker")) {
  const send = value => console.log(JSON.stringify(value));
  const backend = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "fs-events" : "inotify";
  send({ type: "ready", pid: process.pid, backend });
  let handle;
  for await (const line of console) {
    const message = JSON.parse(line);
    if (message.type === "watch") {
      handle = watch(message.path, (_, name) => {
        const file = join(message.path, String(name));
        send({ type: "events", id: message.id, path: message.path, events: [{ path: file, type: existsSync(file) ? 1 : 3 }] });
      });
      send({ type: "watch_ack", requestId: message.requestId, id: message.id });
    } else if (message.type === "unwatch") {
      handle.close();
      send({ type: "unwatch_ack", requestId: message.requestId });
    } else if (message.type === "shutdown") process.exit(0);
  }
} else {
  if (!process.argv.includes("--serve")) throw new Error("Fixture requires direct server mode, not the Windows manager");
  writeFileSync(${JSON.stringify(evidence)}, root);
  const settings = JSON.parse(readFileSync(join(process.env.NARRAFORK_HOME, "settings.json"), "utf8"));
  if (settings.server?.openBrowser !== "off") throw new Error("Fixture requires a headless isolated configuration");
  const port = Number(process.argv.find(value => value.startsWith("--port=")).split("=")[1]);
  const database = new Database(join(process.env.NARRAFORK_HOME, "narrafork.db"));
  database.exec("CREATE TABLE __drizzle_migrations (id INTEGER, hash TEXT, created_at INTEGER); CREATE TABLE users (username TEXT, role TEXT); CREATE TABLE narrators (id TEXT); CREATE TABLE narrator_messages (id TEXT); CREATE TABLE terminals (id TEXT)");
  database.query("INSERT INTO __drizzle_migrations VALUES (1, ?, 1)").run("a".repeat(64));
  Bun.serve({ hostname: "127.0.0.1", port,
    async fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/ws/terminal" && server.upgrade(request)) return;
      if (path === "/api/health") return Response.json({ status: "ok", readiness: "ready", commit: ${JSON.stringify(commit.slice(0, 8))}, version: ${JSON.stringify(`1.2.3+${commit.slice(0, 8)}`)}, gitAvailable: true });
      if (path === "/") return new Response('<div id="root"></div><script type="module" src="/assets/index-fixture.js"></script>', { headers: { "Content-Type": "text/html" } });
      if (path === "/assets/index-fixture.js") return new Response("export const fixture = true;" + "/* fixture */".repeat(20), { headers: { "Content-Type": "application/javascript" } });
      if (path === "/api/auth/register") {
        const body = await request.json();
        if (mode === "product") return Response.json({ token: "fixturesecret", password: body.password }, { status: 500 });
        database.query("INSERT INTO users VALUES (?, 'admin')").run(body.username);
        console.log("token: fixturesecret password: " + body.password);
        return Response.json({ token: "fixturesecret" });
      }
      if (path === "/api/settings") return Response.json({ server: { openBrowser: mode === "browser" ? "browser" : settings.server.openBrowser }, update: { source: "github", githubRepository: "fixture/repository" } });
      if (request.method === "POST" && path === "/api/terminals") return Response.json({ id: "owned-terminal" });
      if (request.method === "DELETE" && path === "/api/terminals/owned-terminal") {
        if (mode === "cleanup") chmodSync(root, 0o500);
        if (mode === "diagnostic-fault") {
          const blocked = join(dirname(${JSON.stringify(configuration)}), mode, "smoke-diagnostic.json");
          mkdirSync(blocked, { recursive: true });
          writeFileSync(join(blocked, "sentinel"), "keep");
        }
        if (mode === "integrity") {
          const platform = process.platform === "win32" ? "windows" : process.platform;
          const binary = join(dirname(${JSON.stringify(configuration)}), "narrafork-1.2.3-" + platform + "-" + process.arch + (process.platform === "win32" ? ".exe" : ""));
          appendFileSync(binary, "tampered-original-package");
        }
        return Response.json({});
      }
      return new Response("fixturesecret", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw));
        const send = (type, fields = {}) => ws.send(JSON.stringify({ type, terminalId: "owned-terminal", ...fields }));
        if (message.type === "subscribe") {
          send("scrollback", { data: "fixture shell prompt" });
          send("bufferState", { activeBuffer: "normal" });
        } else if (message.type === "input") {
          if (message.data === "exit\\r") { send("exit", { code: 0 }); return; }
          const command = process.platform === "win32"
            ? /^echo (NF_RELEASE_PTY_[a-f0-9]{32})\\r$/
            : /^printf '\\\\n%s\\\\n' '(NF_RELEASE_PTY_[a-f0-9]{32})'\\r$/;
          const marker = command.exec(message.data)?.[1];
          if (!marker) { send("error", { message: "invalid marker command" }); return; }
          send("output", { data: (process.platform === "win32" ? "" : "\\r\\n") + marker + "\\r\\n" });
        }
      }
    }
  });
}
`;
}

test("native fixture separates complete smoke, product failure and cleanup-only failure", async () => {
	const root = await temporary();
	const configuration = join(root, "mode.txt");
	const evidence = join(root, "owned-root.txt");
	const fixture = await executableFixture(nativeSmokeFixture(configuration, evidence), root);
	const fixturePath = join(root, "fixture-path");
	await mkdir(fixturePath);
	if (process.platform !== "win32") {
		const ps = Bun.which("ps");
		if (!ps) throw new Error("Native fixture needs the existing process-table command");
		await symlink(ps, join(fixturePath, "ps"));
	}
	await writeFile(
		fixture.fixtureOptions.metadata,
		JSON.stringify({
			...JSON.parse(await readFile(fixture.fixtureOptions.metadata, "utf8")),
			repository: "fixture/repository",
		}),
	);
	for (const mode of [
		"pass",
		"browser",
		"product",
		"cleanup",
		"diagnostic-fault",
		"integrity",
	] as const) {
		// Windows directory permissions do not create the POSIX EACCES fault used here.
		if (mode === "cleanup" && (process.platform === "win32" || process.getuid?.() === 0)) continue;
		await writeFile(configuration, mode);
		const output = join(root, mode, "smoke.json");
		const originalPath = process.env.PATH;
		// The protocol fixture needs no optional dtach daemon; keep real owned-process cleanup.
		if (process.platform !== "win32") process.env.PATH = fixturePath;
		const run = smokeReleaseBinary({
			...fixture.fixtureOptions,
			repository: "fixture/repository",
			output,
		});
		let ownedRoot: string | undefined;
		try {
			if (mode === "pass") {
				const result = await run;
				expect(JSON.parse(await readFile(output, "utf8"))).toEqual(result);
				expect(result.checks.pty).toBe(true);
			} else
				await expect(run).rejects.toThrow(
					mode === "cleanup"
						? "directory cleanup"
						: mode === "diagnostic-fault"
							? "Smoke diagnostic output failed"
							: mode === "integrity"
								? "Binary was modified"
								: mode === "browser"
									? "disable automatic browser startup"
									: "HTTP /api/auth/register: 500",
				);
			ownedRoot = await readFile(evidence, "utf8");
			if (mode === "diagnostic-fault") {
				await expect(readFile(output)).rejects.toThrow();
				expect(await readFile(join(root, mode, "smoke-diagnostic.json", "sentinel"), "utf8")).toBe(
					"keep",
				);
				await expect(lstat(ownedRoot)).rejects.toThrow();
				continue;
			}
			const text = await readFile(join(root, mode, "smoke-diagnostic.json"), "utf8");
			const diagnostic = JSON.parse(text);
			expect(diagnostic.identity.repository).toBe("fixture/repository");
			expect(text).not.toContain("fixturesecret");
			expect(text).not.toContain("NARRAFORK_HOME");
			if (mode !== "product") expect(diagnostic.processLog).toContain("password: [REDACTED]");
			expect(diagnostic.stages.product).toBe(
				mode === "product" || mode === "browser" ? "failed" : "passed",
			);
			expect(diagnostic.firstFailureStage).toBe(
				mode === "pass"
					? null
					: mode === "cleanup"
						? "directory-cleanup"
						: mode === "integrity"
							? "post-run-integrity"
							: "bootstrap-registration",
			);
			expect(diagnostic.stages["process-shutdown"]).toBe("passed");
			if (mode !== "pass") await expect(readFile(output)).rejects.toThrow();
			if (mode === "cleanup") {
				expect(diagnostic.stages["post-run-integrity"]).toBe("passed");
				expect(diagnostic.stages["directory-cleanup"]).toBe("failed");
				expect(diagnostic.failures[0].code).toBe("EACCES");
				expect(diagnostic.remainingPaths.length).toBeGreaterThan(0);
			} else {
				expect(diagnostic.stages["directory-cleanup"]).toBe("passed");
				await expect(lstat(ownedRoot)).rejects.toThrow();
			}
			if (mode === "pass") expect(diagnostic.stages["final-integrity"]).toBe("passed");
			if (mode === "integrity") {
				expect(diagnostic.stages["post-run-integrity"]).toBe("failed");
				expect(await hashReleaseFile(fixture.binary)).not.toEqual(fixture.measured);
			}
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			ownedRoot ??= await readFile(evidence, "utf8").catch(() => undefined);
			if (ownedRoot) {
				await chmod(ownedRoot, 0o700).catch(() => {});
				await rm(ownedRoot, { recursive: true, force: true });
			}
		}
	}
}, 90_000);

async function ptyFixture(
	mode:
		| "pass"
		| "late-prompt"
		| "prompt-marker"
		| "echo"
		| "replay"
		| "exit"
		| "oversize"
		| "hang-exit"
		| "bad-exit",
	deleteStatus = 200,
) {
	let deleted = 0;
	let inputs = 0;
	let input = "";
	let exits = 0;
	let resized = 0;
	let ready = false;
	const timers: ReturnType<typeof setTimeout>[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			const path = new URL(request.url).pathname;
			if (path === "/ws/terminal" && server.upgrade(request)) return;
			if (request.method === "POST" && path === "/api/terminals")
				return Response.json({ id: "owned-terminal" });
			if (request.method === "DELETE" && path === "/api/terminals/owned-terminal") {
				deleted++;
				return new Response("{}", { status: deleteStatus });
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(ws, raw) {
				const message = JSON.parse(String(raw));
				const send = (type: string, extra: Record<string, unknown> = {}) =>
					ws.send(JSON.stringify({ type, terminalId: "owned-terminal", ...extra }));
				if (message.type === "subscribe") {
					timers.push(
						setTimeout(() => {
							ready = true;
							send("scrollback", { data: "initial shell prompt\r\n" });
							send("bufferState", { activeBuffer: "normal" });
						}, 30),
					);
				} else if (message.type === "resize") resized++;
				else if (message.type === "input") {
					if (message.data === "exit\r") {
						exits++;
						if (mode !== "hang-exit") send("exit", { code: mode === "bad-exit" ? 37 : 0 });
						return;
					}
					inputs++;
					input = message.data;
					if (!ready) {
						send("error", { message: "input raced subscription" });
						return;
					}
					const command =
						process.platform === "win32"
							? /^echo (NF_RELEASE_PTY_[a-f0-9]{32})\r$/
							: /^printf '\\n%s\\n' '(NF_RELEASE_PTY_[a-f0-9]{32})'\r$/;
					const marker = command.exec(message.data)?.[1];
					if (!marker) {
						send("error", { message: "invalid marker command" });
						return;
					}
					send("requestResize");
					if (mode === "oversize") {
						send("output", { data: "x".repeat(65_537) });
						return;
					}
					send("output", { data: `$ ${message.data}\n` });
					if (mode === "exit") {
						send("exit", { code: 37 });
						return;
					}
					if (mode === "replay") {
						send("scrollback", { data: `${marker}\r\n` });
						return;
					}
					if (mode === "prompt-marker") {
						send("output", { data: `$ ${marker}\r\n$ ` });
						return;
					}
					if (
						mode === "pass" ||
						mode === "late-prompt" ||
						mode === "hang-exit" ||
						mode === "bad-exit"
					) {
						send("output", { terminalId: "other-terminal", data: "foreign-output\r\n" });
						if (mode === "late-prompt") send("output", { data: "$ " });
						if (process.platform !== "win32") send("output", { data: "\r\n" });
						send("output", { data: marker.slice(0, 12) });
						send("output", { data: `${marker.slice(12)}\r\n$ ` });
					}
				}
			},
		},
	});
	return {
		origin: server.url.origin,
		get deleted() {
			return deleted;
		},
		get inputs() {
			return inputs;
		},
		get input() {
			return input;
		},
		get exits() {
			return exits;
		},
		get resized() {
			return resized;
		},
		close() {
			for (const timer of timers) clearTimeout(timer);
			server.stop(true);
		},
	};
}

describe("PTY subscription and cleanup regression", () => {
	test("waits for subscription replay, handles resize and requires the live split marker", async () => {
		const fixture = await ptyFixture("pass");
		const scope = new SmokeProcessScope(await temporary(), { PATH: "" }, { timeoutMs: 2_000 });
		try {
			await smokePty(fixture.origin, "isolated-token", scope);
			expect(fixture.inputs).toBe(1);
			expect(fixture.exits).toBe(1);
			expect(fixture.resized).toBeGreaterThanOrEqual(2);
			expect(fixture.deleted).toBe(1);
		} finally {
			await scope.close();
			fixture.close();
		}
	});
	test.skipIf(process.platform === "win32")(
		"Unix probe isolates a late prompt with a newline and works in a real shell",
		async () => {
			const fixture = await ptyFixture("late-prompt");
			const scope = new SmokeProcessScope(await temporary(), { PATH: "" }, { timeoutMs: 2_000 });
			try {
				await smokePty(fixture.origin, "isolated-token", scope);
				const marker = /'(NF_RELEASE_PTY_[a-f0-9]{32})'\r$/.exec(fixture.input)?.[1];
				if (!marker) throw new Error("Missing Unix probe marker");
				let output = "";
				const child = scope.spawn(
					["/bin/sh", "-c", `printf '$ '; ${fixture.input.trimEnd()}`],
					(chunk) => {
						output += chunk.toString();
					},
				);
				expect(await scope.until("probe shell exit", () => child.status)).toBe(0);
				expect(output).toBe(`$ \n${marker}\n`);
				expect(hasPtyMarker(output, marker)).toBe(true);
				expect(fixture.exits).toBe(1);
				expect(fixture.deleted).toBe(1);
			} finally {
				await scope.close();
				fixture.close();
			}
		},
	);
	for (const mode of ["hang-exit", "bad-exit"] as const) {
		test(`${mode} never passes cleanup just because the marker was received`, async () => {
			const fixture = await ptyFixture(mode);
			const scope = new SmokeProcessScope(await temporary(), { PATH: "" }, { timeoutMs: 400 });
			try {
				await expect(smokePty(fixture.origin, "isolated-token", scope)).rejects.toThrow(
					"PTY stage=shell shutdown",
				);
				expect(fixture.inputs).toBe(1);
				expect(fixture.exits).toBe(1);
				expect(fixture.deleted).toBe(1);
			} finally {
				await scope.close();
				fixture.close();
			}
		});
	}
	for (const mode of ["echo", "replay", "prompt-marker"] as const) {
		test(`${mode} alone never attests a completed live shell round trip`, async () => {
			const fixture = await ptyFixture(mode);
			const scope = new SmokeProcessScope(await temporary(), { PATH: "" }, { timeoutMs: 300 });
			try {
				await expect(smokePty(fixture.origin, "isolated-token", scope)).rejects.toThrow(
					"PTY stage=round-trip",
				);
				expect(fixture.inputs).toBe(1);
				expect(fixture.deleted).toBe(1);
			} finally {
				await scope.close();
				fixture.close();
			}
		});
	}
	test("preserves a native exit and its diagnostics when terminal deletion also fails", async () => {
		const fixture = await ptyFixture("exit", 500);
		const scope = new SmokeProcessScope(await temporary(), { PATH: "" }, { timeoutMs: 2_000 });
		try {
			let failure: unknown;
			try {
				await smokePty(fixture.origin, "isolated-token", scope);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			expect(String(failure)).toContain("PTY exited before marker (37)");
			expect(String(failure)).toContain("PTY stage=round-trip");
			expect(String(failure)).toContain("Failed to delete owned smoke PTY: 500");
			expect(fixture.deleted).toBe(1);
		} finally {
			await scope.close();
			fixture.close();
		}
	});
	test("oversize live output fails instead of collecting an unbounded transcript", async () => {
		const fixture = await ptyFixture("oversize");
		const scope = new SmokeProcessScope(await temporary(), { PATH: "" }, { timeoutMs: 2_000 });
		try {
			await expect(smokePty(fixture.origin, "isolated-token", scope)).rejects.toThrow(
				"message exceeds budget",
			);
			expect(fixture.deleted).toBe(1);
		} finally {
			await scope.close();
			fixture.close();
		}
	});
});

describe("smoke close and error aggregation", () => {
	test("concurrent cleanup callers wait for one close and actual stdio release", async () => {
		const scope = new SmokeProcessScope(await temporary(), process.env);
		const child = scope.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
		const first = scope.close();
		const second = scope.close();
		expect(second).toBe(first);
		await Promise.all([first, second]);
		expect(child.closed).toBe(true);
		expect(child.status).not.toBeUndefined();
		expect(child.process.stdin.destroyed).toBe(true);
		expect(child.process.stdout.destroyed).toBe(true);
		expect(child.process.stderr.destroyed).toBe(true);
		expect(scope.close()).toBe(first);
	});
	test("cleanup cannot hide the primary failure and filesystem error fields", () => {
		const primary = new Error("native validation failed");
		const cleanup = Object.assign(new Error("resource busy"), {
			code: "EBUSY",
			syscall: "rm",
			path: "/isolated/run/executable",
		});
		const failure = smokeFailure("Release smoke failed", [primary, cleanup]);
		expect(failure.message).toContain(primary.message);
		expect(failure.message).toContain("EBUSY; rm; /isolated/run/executable");
		expect(failure.cause).toBeInstanceOf(AggregateError);
		expect((failure.cause as AggregateError).errors).toEqual([primary, cleanup]);
		expect(
			smokeFailure("bounded", [new Error("x".repeat(100_000))]).message.length,
		).toBeLessThanOrEqual(16_384);
	});
});

describe("owned Windows junction cleanup regression", () => {
	test("removes nested links without deleting an outside target or sentinel", async () => {
		const root = await temporary();
		const outside = await temporary();
		const sentinel = join(outside, "sentinel.txt");
		await writeFile(sentinel, "outside-owned-cleanup");
		await mkdir(join(root, "home", "AppData", "cache"), { recursive: true });
		await writeFile(join(root, "owned.txt"), "owned");
		const link = join(root, "home", "AppData", "cache", "Content.IE5");
		await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
		await removeSmokeDirectory(root, true);
		await expect(lstat(root)).rejects.toThrow();
		expect(await readFile(sentinel, "utf8")).toBe("outside-owned-cleanup");
		await removeSmokeDirectory(root, true); // Already absent is idempotent.
	});
	test("a cleanup-root link is refused rather than traversed", async () => {
		const directory = await temporary();
		const target = await temporary();
		await writeFile(join(target, "sentinel.txt"), "keep");
		const link = join(directory, "root-link");
		await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
		await expect(removeSmokeDirectory(link, true)).rejects.toThrow("not a real directory");
		expect(await readFile(join(target, "sentinel.txt"), "utf8")).toBe("keep");
	});
	test("depth overflow fails closed rather than walking an unbounded tree", async () => {
		const root = await temporary();
		await mkdir(join(root, ...Array.from({ length: 34 }, () => "d")), { recursive: true });
		await expect(removeSmokeDirectory(root, true)).rejects.toThrow("cleanup budget exceeded");
	});
});
