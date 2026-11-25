import { expect, test } from "bun:test";
import { readFileSync, watch } from "node:fs";
import { mkdtemp, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const helper = JSON.stringify(join(ROOT, "scripts/ci-stage.ts"));
const prefix = "[ci-stage] ";
const diagnosticFile = /^ci-stage-\d+\.jsonl$/;
const hungMarker = '"phase":"webrtc-connect","event":"start"';

for (const flag of ["--isolate", "--parallel=2"]) {
	test(`${flag} retains a hung stage even while the worker is still running`, async () => {
		const directory = await mkdtemp(join(ROOT, ".ci-stage-probe-"));
		const pass = join(directory, "pass.test.ts");
		const hang = join(directory, "hang.test.ts");
		try {
			await writeFile(
				pass,
				`import { expect, test } from "bun:test";
				import { startCiStage, withCiStage } from ${helper};
				test("pass", async () => {
					startCiStage("go-peer-build", 1)("retry");
					startCiStage("go-peer-build", 2)("end");
					await expect(withCiStage("chromium", async () => {
						throw new Error("synthetic-private-payload");
					})).rejects.toThrow("synthetic-private-payload");
				});`,
			);
			await writeFile(
				hang,
				`import { beforeAll, test } from "bun:test";
				import { withCiStage } from ${helper};
				beforeAll(() => withCiStage("webrtc-connect", () => new Promise(() => {})), 1000);
				test("hang", () => {});`,
			);
			const seen = Promise.withResolvers<string>();
			const watcher = watch(directory, (_event, filename) => {
				if (!filename || !diagnosticFile.test(filename)) return;
				try {
					const text = readFileSync(join(directory, filename), "utf8");
					if (text.includes(hungMarker)) seen.resolve(filename);
				} catch {
					// Watch events may arrive before the append completes.
				}
			});
			try {
				const child = Bun.spawn(
					[process.execPath, "test", "--only-failures", "--no-orphans", flag, pass, hang],
					{
						cwd: directory,
						env: { ...process.env, NF_CI_STAGE_DIR: directory },
						stdout: "ignore",
						stderr: "pipe",
					},
				);
				const stderr = new Response(child.stderr).text();
				try {
					const filename = await Promise.race([seen.promise, child.exited.then(() => null)]);
					expect(filename).not.toBeNull();
					expect(child.exitCode).toBeNull();
					expect(await child.exited).not.toBe(0);
					const log = await stderr;
					expect(
						log.split("\n").some((line) => line.startsWith(prefix) && line.includes(hungMarker)),
					).toBe(true);
					expect(log).toContain("timed out");
					expect(log).not.toContain("synthetic-private-payload");
					const records = (await readdir(directory))
						.filter((name) => diagnosticFile.test(name))
						.flatMap((name) => readFileSync(join(directory, name), "utf8").trim().split("\n"))
						.map((line) => JSON.parse(line));
					expect(records.filter((record) => record.phase === "webrtc-connect")).toEqual([
						expect.objectContaining({ phase: "webrtc-connect", event: "start" }),
					]);
					expect(records.filter((record) => record.phase === "go-peer-build")).toEqual([
						expect.objectContaining({ event: "start", attempt: 1 }),
						expect.objectContaining({ event: "retry", attempt: 1, durationMs: expect.any(Number) }),
						expect.objectContaining({ event: "start", attempt: 2 }),
						expect.objectContaining({ event: "end", attempt: 2, durationMs: expect.any(Number) }),
					]);
					expect(records).toContainEqual(
						expect.objectContaining({
							phase: "chromium",
							event: "error",
							durationMs: expect.any(Number),
						}),
					);
					expect(JSON.stringify(records)).not.toContain("synthetic-private-payload");
				} finally {
					if (child.exitCode === null) child.kill();
					await child.exited;
				}
			} finally {
				watcher.close();
			}
		} finally {
			for (const name of await readdir(directory)) await rm(join(directory, name), { force: true });
			await rmdir(directory);
		}
	});
}
