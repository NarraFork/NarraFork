import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const project = resolve(import.meta.dir, "../../..");
// The Windows launcher remains a submode of the existing plugin family, not another server.
test("minified plugin CLI preserves entry mode and fails closed without a confirmed Windows Job", async () => {
	const artifacts = await mkdtemp(join(tmpdir(), "nf-plugin-mode-"));
	const probe = join(project, `.plugin-mode-probe-${crypto.randomUUID()}.ts`);
	const binary = join(
		artifacts,
		process.platform === "win32" ? "plugin-probe.exe" : "plugin-probe",
	);
	const legacy = join(artifacts, "legacy entry.ts");
	const sentinel = "PLUGIN_TARGET_MUST_NOT_RUN";
	const flag = "--plugin-runtime-worker";
	const mode = "--windows-plugin-launcher";
	try {
		await writeFile(
			probe,
			'import { runPluginRuntimeWorker } from "./server/plugin-runtime-worker";\nawait runPluginRuntimeWorker();\n',
		);
		await writeFile(
			legacy,
			'process.stdout.write("LEGACY_PLUGIN_ENTRY_OK\\n"); process.exit(0);\n',
		);
		await exec(process.execPath, ["build", probe, "--compile", "--minify", "--outfile", binary], {
			cwd: project,
			timeout: 60_000,
			maxBuffer: 1024 * 1024,
		});
		const options = { cwd: artifacts, timeout: 10_000, maxBuffer: 8 * 1024 };
		const sourceLegacy = await exec(process.execPath, [probe, flag, legacy], options);
		expect(sourceLegacy.stdout.trim()).toBe("LEGACY_PLUGIN_ENTRY_OK");
		const compiledLegacy = await exec(binary, [flag, legacy], options);
		expect(compiledLegacy.stdout.trim()).toBe("LEGACY_PLUGIN_ENTRY_OK");
		// A nonexistent job (or a non-Windows host) must refuse before executing the target.
		const jobName = `Local\\NarraForkPlugin-${crypto.randomUUID()}`;
		const args = [
			flag,
			mode,
			jobName,
			process.execPath,
			"-e",
			`console.log(${JSON.stringify(sentinel)})`,
		];
		for (const [executable, argv] of [
			[process.execPath, [probe, ...args]],
			[binary, args],
		] as const) {
			if (executable === binary) await rm(probe, { force: true });
			let failure:
				| { code?: number | string; killed?: boolean; stdout?: string; stderr?: string }
				| undefined;
			try {
				await exec(executable, [...argv], options);
			} catch (error) {
				failure = error as NonNullable<typeof failure>;
			}
			expect(failure).toBeDefined();
			expect(typeof failure?.code).toBe("number");
			expect(failure?.code).not.toBe(0);
			expect(failure?.killed).not.toBe(true);
			expect(`${failure?.stdout ?? ""}${failure?.stderr ?? ""}`).not.toContain(sentinel);
			expect(failure?.stderr).not.toContain("instance lock");
			expect(failure?.stderr).not.toContain(jobName);
		}
	} finally {
		await rm(probe, { force: true });
		await rm(artifacts, { recursive: true, force: true });
	}
}, 90_000);
