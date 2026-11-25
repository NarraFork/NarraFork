import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeSpawn } from "../../spawn";

const root = join(import.meta.dir, "../../../..");

test("compiled Recall projection preserves codec NULs outside the source tree", async () => {
	mkdirSync(join(root, ".narrafork"), { recursive: true });
	const source = mkdtempSync(join(root, ".narrafork/recall-projection-compile-"));
	const output = mkdtempSync(join(tmpdir(), "nf-recall-projection-binary-"));
	try {
		const entry = join(source, "probe.ts");
		writeFileSync(
			entry,
			String.raw`
import { runRecallPgProjection } from "../../server/lib/db-worker/recall-pg-projection-client";
const text = "original\0中文\u{1F600}";
const result = await runRecallPgProjection(async () => ({
  kind: "message",
  input: { narratorId: "fork", messageId: "message", offset: 0, maxChars: 200 },
  row: {
    messageId: "message", narratorId: "fork", narratorTitle: "Fork", role: "assistant",
    origin: "assistant", createdAt: "2026-01-01", seq: 20, bodyRevision: 1,
    contentJson: JSON.stringify([{type:"text",text},{type:"thinking",thinking:"private\0reasoning"}]),
    toolCalls: []
  }
}));
console.log(JSON.stringify(result));
`,
		);
		const executable = join(output, process.platform === "win32" ? "recall.exe" : "recall");
		const build = await safeSpawn({
			cmd: [
				process.execPath,
				"build",
				"--compile",
				"--outfile",
				executable,
				entry,
				join(root, "server/lib/db-worker/recall-pg-projection-worker.ts"),
			],
			cwd: root,
			timeout: 60000,
			maxOutputBytes: 1024 * 1024,
		});
		expect(build.exitCode, build.stderr).toBe(0);
		const run = await safeSpawn({
			cmd: [executable],
			cwd: output,
			timeout: 20000,
			maxOutputBytes: 64 * 1024,
			env: { ...process.env, NARRAFORK_DB_WORKER: "on", NARRAFORK_DB_WORKER_CONCURRENCY: "2" },
		});
		expect(run.exitCode, run.stderr).toBe(0);
		expect(JSON.parse(run.stdout.trim())).toMatchObject({
			messageId: "message",
			narratorId: "fork",
			text: "original\0中文\u{1F600}",
			totalChars: 12,
			offset: 0,
			hasMore: false,
			nextOffset: null,
			omittedBlocks: ["thinking"],
		});
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(output, { recursive: true, force: true });
	}
}, 90000);
