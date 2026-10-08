import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashReleaseFile } from "../../scripts/lib/ci-release-io";
import { descendantPids, SmokeProcessScope } from "../../scripts/lib/ci-release-smoke-process";
import {
	assertFrontendJavaScript,
	assertHealthIdentity,
	assertMigratedDatabase,
	hasPtyMarker,
	parseSmokeArgs,
	resolveFrontendAssetPath,
	type SmokeOptions,
	smokeEnvironment,
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

test("failed real executable smoke never writes a success artifact", async () => {
	const root = await temporary();
	const platform = process.platform === "win32" ? "windows" : process.platform;
	const binary = join(
		root,
		`narrafork-1.2.3-${platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`,
	);
	// Compile a genuine standalone fixture which fails immediately; not a mocked spawn/result.
	const source = join(root, "fixture.ts");
	await writeFile(source, 'console.error("intentional binary fixture failure"); process.exit(37);');
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
	await expect(smokeReleaseBinary(fixtureOptions)).rejects.toThrow(
		"intentional binary fixture failure",
	);
	await expect(readFile(fixtureOptions.output)).rejects.toThrow();
	expect(await hashReleaseFile(binary)).toEqual(measured);
}, 60_000);
