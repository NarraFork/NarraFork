/**
 * Rollback drill for the Go beta backend.
 *
 * Flow:
 *   1. Start TS backend on a temporary HOME and register an admin.
 *   2. Stop TS, start the Go backend on the same HOME/DB.
 *   3. Stop Go, start TS again on the same HOME/DB.
 *
 * This verifies that the Go beta channel can coexist with the TS legacy path
 * and that the same database can be used when switching back.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	buildBinaryPath,
	findPreviousGoVersion,
	getGoTargets,
	hasFlag,
	loadGoArtifactManifest,
	parseArg,
} from "./go-backend-shared";

const args = process.argv.slice(2);
const version =
	parseArg(args, "version") ??
	JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")).version;
const outDir = resolve(
	parseArg(args, "out-dir") ?? join(import.meta.dir, "..", "dist", "go-backend"),
);
const platformArg = parseArg(args, "platform");
const dryRun = hasFlag(args, "dry-run");
const skipBuild = hasFlag(args, "skip-build");

function currentGoTarget(): {
	platform: string;
	goos: string;
	goarch: string;
	filenameSuffix: string;
} {
	if (platformArg) {
		const explicit = getGoTargets(platformArg)[0];
		if (!explicit) throw new Error(`Unknown platform: ${platformArg}`);
		return explicit;
	}
	const current = `${process.platform}-${process.arch}`;
	if (process.platform === "linux" && process.arch === "x64")
		return { platform: "linux-x64", goos: "linux", goarch: "amd64", filenameSuffix: "linux-x64" };
	if (process.platform === "linux" && process.arch === "arm64")
		return {
			platform: "linux-arm64",
			goos: "linux",
			goarch: "arm64",
			filenameSuffix: "linux-arm64",
		};
	if (process.platform === "darwin" && process.arch === "x64")
		return {
			platform: "darwin-x64",
			goos: "darwin",
			goarch: "amd64",
			filenameSuffix: "darwin-x64",
		};
	if (process.platform === "darwin" && process.arch === "arm64")
		return {
			platform: "darwin-arm64",
			goos: "darwin",
			goarch: "arm64",
			filenameSuffix: "darwin-arm64",
		};
	if (process.platform === "win32" && process.arch === "x64")
		return { platform: "win-x64", goos: "windows", goarch: "amd64", filenameSuffix: "win-x64.exe" };
	throw new Error(`Unsupported current platform for rollback drill: ${current}`);
}

async function freePort(): Promise<number> {
	return await new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("failed to allocate port"));
				return;
			}
			const port = addr.port;
			server.close(() => resolvePort(port));
		});
	});
}

async function waitForHealth(baseUrl: string, label: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 120_000;
	let lastErr = "";
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/api/health`);
			if (res.ok) return (await res.json()) as Record<string, unknown>;
			lastErr = `status ${res.status}`;
		} catch (err) {
			lastErr = err instanceof Error ? err.message : String(err);
		}
		await Bun.sleep(150);
	}
	throw new Error(`${label} did not become healthy: ${lastErr}`);
}

async function registerAdmin(baseUrl: string): Promise<string> {
	const username = `admin-${Date.now().toString(36)}`;
	const res = await fetch(`${baseUrl}/api/auth/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username, password: "password123", language: "en" }),
	});
	if (!res.ok) {
		throw new Error(`register failed: ${res.status} ${await res.text()}`);
	}
	const body = (await res.json()) as { token?: string };
	if (!body.token) {
		throw new Error("register response did not include token");
	}
	return body.token;
}

function spawnTsBackend(home: string, port: number): Bun.Subprocess {
	return Bun.spawn(["bun", "server/main.ts", `--port=${port}`, "--host=127.0.0.1"], {
		cwd: join(import.meta.dir, ".."),
		env: {
			...process.env,
			HOME: home,
			PORT: String(port),
			HOST: "127.0.0.1",
			NARRAFORK_ALLOW_MULTIPLE: "1",
			NARRAFORK_DISABLE_OPEN_BROWSER: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

function spawnGoBackend(home: string, port: number, binaryPath: string): Bun.Subprocess {
	return Bun.spawn([binaryPath, "-port", String(port), "-host", "127.0.0.1"], {
		cwd: join(import.meta.dir, ".."),
		env: {
			...process.env,
			HOME: home,
			PORT: String(port),
			HOST: "127.0.0.1",
			NARRAFORK_ALLOW_MULTIPLE: "1",
			NARRAFORK_DISABLE_OPEN_BROWSER: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function stopBackend(proc: Bun.Subprocess): Promise<void> {
	try {
		if (proc.exitCode === null) proc.kill("SIGTERM");
	} catch {
		// ignore
	}
	await Promise.race([proc.exited, Bun.sleep(5_000)]);
	try {
		if (proc.exitCode === null) proc.kill("SIGKILL");
	} catch {
		// ignore
	}
}

if (dryRun) {
	console.log("→ Go rollback drill dry-run");
	console.log(`  version: ${version}`);
	console.log(`  outDir: ${outDir}`);
	console.log(`  platform: ${platformArg ?? "current host"}`);
	process.exit(0);
}

const target = currentGoTarget();
const manifest = loadGoArtifactManifest(version, outDir);
if (!skipBuild && !manifest) {
	const build = Bun.spawnSync(
		[
			"bun",
			"scripts/build-go-backend.ts",
			`--version=${version}`,
			`--out-dir=${outDir}`,
			`--platform=${target.platform}`,
		],
		{
			cwd: join(import.meta.dir, ".."),
			stdout: "inherit",
			stderr: "inherit",
			stdin: "inherit",
			env: { ...process.env },
		},
	);
	if (build.exitCode !== 0) {
		process.exit(build.exitCode ?? 1);
	}
}

const currentManifest = loadGoArtifactManifest(version, outDir);
if (!currentManifest) {
	throw new Error(`Missing Go manifest for ${version}`);
}
const previousVersion = findPreviousGoVersion(version, outDir);
const home = join(tmpdir(), `narrafork-go-rollback-${Date.now().toString(36)}`);
mkdirSync(home, { recursive: true });
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const report: Record<string, unknown> = {
	version,
	previousVersion,
	target: target.platform,
	home,
	port,
	steps: [] as Array<Record<string, unknown>>,
};

const ts1 = spawnTsBackend(home, port);
await waitForHealth(baseUrl, "TS backend");
const token = await registerAdmin(baseUrl);
(report.steps as Array<Record<string, unknown>>).push({
	step: "ts-start",
	ok: true,
	token: token.slice(0, 8),
});
await stopBackend(ts1);
(report.steps as Array<Record<string, unknown>>).push({ step: "ts-stop", ok: true });

if (!currentManifest.artifacts.some((item) => item.platform === target.platform)) {
	throw new Error(`Missing Go artifact for ${target.platform}`);
}
const binaryPath = buildBinaryPath(version, target, outDir);
if (!skipBuild && !existsSync(binaryPath)) {
	throw new Error(`Missing Go binary for ${target.platform}: ${binaryPath}`);
}
const goBinary = binaryPath;
const go = spawnGoBackend(home, port, goBinary);
const goHealth = await waitForHealth(baseUrl, "Go backend");
(report.steps as Array<Record<string, unknown>>).push({
	step: "go-start",
	ok: true,
	backend: goHealth.backend,
	buildChannel: goHealth.buildChannel,
	version: goHealth.version,
});
await stopBackend(go);
(report.steps as Array<Record<string, unknown>>).push({ step: "go-stop", ok: true });

const ts2 = spawnTsBackend(home, port);
const tsHealth = await waitForHealth(baseUrl, "TS backend after rollback");
(report.steps as Array<Record<string, unknown>>).push({
	step: "ts-rollback",
	ok: true,
	version: tsHealth.version,
	backend: tsHealth.backend,
});
await stopBackend(ts2);
(report.steps as Array<Record<string, unknown>>).push({ step: "ts-final-stop", ok: true });

const reportPath = join(outDir, version, "rollback-drill.json");
mkdirSync(join(outDir, version), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, "\t")}\n`);
console.log(`✅ Rollback drill complete: ${reportPath}`);
