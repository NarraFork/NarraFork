import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { testEnvironment } from "../../tests/preload";
import { safeSpawn } from "../lib/spawn";

test("compiled Host bridge and actual native helper save 20 MiB and recover a lost v1 reply", async () => {
	const project = resolve(import.meta.dir, "../.."),
		root = await mkdtemp(join(testEnvironment.isolatedHome, "compiled-editor-"));
	const binary = resolve(
		project,
		`.narrafork/editor-phase8-executor${process.platform === "win32" ? ".exe" : ""}`,
	);
	const host = join(root, `compiled-host${process.platform === "win32" ? ".exe" : ""}`);
	try {
		const bytes = await readFile(binary);
		const digest = createHash("sha256").update(bytes).digest("hex");
		await copyFile(binary, join(root, "editor-helper.exe"));
		await chmod(join(root, "editor-helper.exe"), 0o700);
		const built = await safeSpawn({
			cmd: [
				process.execPath,
				"build",
				"--compile",
				resolve(project, "scripts/smoke-editor-windows-native.ts"),
				"--outfile",
				host,
			],
			cwd: project,
			timeout: 60_000,
			maxOutputBytes: 64 * 1024,
		});
		expect(built.exitCode).toBe(0);
		const run = await safeSpawn({
			cmd: [host, root, digest, join(root, "run-data"), "--allow-posix-fixture"],
			cwd: root,
			env: { ...process.env, NARRAFORK_HOME: join(root, "fixture-home"), NARRAFORK_TEST: "1" },
			timeout: 60_000,
			maxOutputBytes: 64 * 1024,
		});
		expect(run.exitCode).toBe(0);
		const line = run.stdout.split(/\r?\n/).find((line) => line.includes('"gate":"EDITOR_'));
		if (!line) throw new Error(`Compiled helper proof missing: ${run.stderr.slice(0, 1024)}`);
		const proof = JSON.parse(line);
		expect(proof).toMatchObject({
			bytes: 20 * 1024 * 1024,
			actualPlatform: process.platform,
			binarySha256: digest,
			lostReplyApplies: 1,
			coldProof: "committed",
			v1SeparateHashDomains: true,
			privateRootReplacementRejected: true,
		});
		console.info("EDITOR_COMPILED_NATIVE_PROOF", JSON.stringify(proof));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 120_000);
