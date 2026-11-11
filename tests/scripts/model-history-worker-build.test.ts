import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderBuildInfo } from "../../scripts/lib/build-materials";
import { compileRuntimeBundle } from "../../scripts/lib/runtime-compiler";
import { safeSpawn } from "../../server/lib/spawn";
import { modelHistoryFixtureSql } from "../../server/services/agent-runtime/model-history-fixture";
import { renderModelHistoryRevisionSql } from "../../server/services/agent-runtime/model-history-revision-sql";
import { createHelperDistributionDependencies } from "../../shared/helper-distribution";

// Real native compile/worker smoke. The temporary main entry shares server/'s
// common root with the shipped worker, exactly as build-cross-platform does.
// Neither this probe nor its read-only worker boot the application/database singleton.
test("compiled distributions include and can launch the read-only model history worker", async () => {
	const root = resolve(import.meta.dir, "../..");
	const directory = await mkdtemp(join(tmpdir(), "nf-history-compiled-"));
	const entry = join(root, "server", `.history-worker-probe-${randomUUID()}.ts`);
	const databasePath = join(directory, "fixture.db");
	const binary = join(directory, process.platform === "win32" ? "probe.exe" : "probe");
	const sqlite = new Database(databasePath);
	try {
		sqlite.run("PRAGMA journal_mode = WAL");
		sqlite.run(modelHistoryFixtureSql);
		sqlite.run(renderModelHistoryRevisionSql("sqlite"));
		sqlite.run("INSERT INTO narrators (id,title) VALUES ('probe-owner','Probe')");
		sqlite.run(
			"INSERT INTO narrator_messages (id,narrator_id,role,content_json) VALUES ('probe-message','probe-owner','user','[{\"type\":\"text\",\"text\":\"compiled fixture\"}]')",
		);
		sqlite.run(
			"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES ('probe-ref','probe-owner','probe-message',1)",
		);
		await writeFile(
			entry,
			`import { Database } from "bun:sqlite";
import { loadModelHistorySource, modelHistorySourceStats } from "./services/agent-runtime/model-history-source";
const path = process.argv[2];
if (!path) throw new Error("An explicit private fixture path is required");
const sqlite = new Database(path, { readonly: true });
try {
 const source = await loadModelHistorySource({ backend: "sqlite", sqlite }, "probe-owner");
 await loadModelHistorySource({ backend: "sqlite", sqlite }, "probe-owner");
 const row = source.messages[0];
 console.log(JSON.stringify({ id: row?.id, rows: source.messages.length, hits: modelHistorySourceStats().hits }));
} finally { sqlite.close(); }
`,
			{ flag: "wx" },
		);
		await compileRuntimeBundle({
			root,
			entrypoints: [entry, join(root, "server/services/agent-runtime/model-history-worker.ts")],
			outfile: binary,
			buildId: "model-history-fixture",
			repository: "fixture/repository",
			modules: new Map([
				[
					"build-info.ts",
					renderBuildInfo({
						version: "0.0.0",
						commit: "fixture",
						platform: "fixture",
						repository: "fixture/repository",
						helperDistribution: createHelperDistributionDependencies(),
					}),
				],
			]),
		});
		const result = await safeSpawn({
			cmd: [binary, databasePath],
			cwd: root,
			timeout: 15_000,
			maxOutputBytes: 64 * 1024,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdoutTruncated || result.stderrTruncated).toBe(false);
		expect(JSON.parse(result.stdout.trim())).toEqual({
			id: "probe-message",
			rows: 1,
			hits: 1,
		});
	} finally {
		sqlite.close();
		await rm(entry, { force: true });
		await rm(directory, { recursive: true, force: true });
	}
}, 90_000);
