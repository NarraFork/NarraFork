import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { productionBackupAccessDDL } from "./production-fixture.test-helper";

const exec = promisify(execFile);
const root = resolve(import.meta.dir, "../../..");
const entries = [
	"./server/services/narrator-backup/worker.ts",
	"./server/services/project-archive/legacy-sync-worker.ts",
	"./server/services/project-archive/legacy-import-worker.ts",
];
const probeSource = `
import { Database } from "bun:sqlite";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKUP_TABLES } from "../services/narrator-backup/contract";
import { executeBackupWorker, NarratorBackupJobs } from "../services/narrator-backup/jobs";
import { exportLegacyProjectOnWorker } from "../services/project-archive/legacy-sync-job";
import { importLegacyProjectOnWorker } from "../services/project-archive/legacy-import-job";
import { ARCHIVE_COLUMNS, ARCHIVE_TABLE_ORDER } from "../services/project-archive/manifest";
import { privateArchiveWorkerSpecifiers } from "../services/narrator-backup/worker-client";
import { isCompiledRuntime } from "../lib/runtime-target";
const actor = { userId: "alice", isAdmin: false };
const signal = new AbortController().signal;
const sourcePath = join(process.cwd(), "source.sqlite");
const archivePath = join(process.cwd(), "archive.sqlite");
const targetPath = join(process.cwd(), "target.sqlite");
function create(path) {
	const db = new Database(path, {create:true});
	db.run("CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT); INSERT INTO users VALUES('alice','user')");
	for (const table of new Set([...Object.keys(BACKUP_TABLES), ...ARCHIVE_TABLE_ORDER])) {
		const columns = new Set([...(BACKUP_TABLES[table]?.split(" ") ?? []), ...(ARCHIVE_COLUMNS[table] ?? []), ...(table === 'projects' ? ['owner_user_id','visibility','chapter_settings'] : [])]);
		db.run('CREATE TABLE '+table+' ('+[...columns].map(name => name+' '+(name === 'id' ? 'TEXT PRIMARY KEY' : ['seq','refs_backfill_cursor'].includes(name) ? 'INTEGER' : 'TEXT')).join(',')+')');
	}
	for (const ddl of ${JSON.stringify(productionBackupAccessDDL.filter((sql) => !/^CREATE TABLE [`"]?(projects|chapters)[`"]?\s/i.test(sql)))}) db.run(ddl);
	return db;
}
const source = create(sourcePath);
source.run("INSERT INTO projects(id,name,git_path,owner_user_id,visibility) VALUES('project','compiled smoke','/fixture','alice','private'); INSERT INTO chapters(id,project_id) VALUES('chapter','project'); INSERT INTO narrators(id,type,owner_user_id,chapter_id,title) VALUES('solo','primary','alice','chapter','compiled'); INSERT INTO narrator_messages(id,narrator_id,role,content_json) VALUES('message','solo','assistant','[]'); INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES('ref','solo','message',9)");
source.close();
create(archivePath).close();
create(targetPath).close();
const config = {backend:'sqlite',databasePath:sourcePath,sourceInstanceId:'compiled-fixture',proofDirectory:join(process.cwd(),'private-proof'),objectSource:{shadowRoot:'unused',uploadsRoot:'unused',blobRoot:'unused',journalRoot:'unused'}};
const output = {compiled:isCompiledRuntime(),moduleUrl:import.meta.url,specifiers:entries()};
function entries() {return ['backup','legacy-sync','legacy-import'].map(kind => privateArchiveWorkerSpecifiers(kind));}
try {
	output.plan = await executeBackupWorker({action:'plan',actor,config,narratorIds:['solo'],profile:'conversation-state-v1'},signal);
	output.export = await exportLegacyProjectOnWorker({databasePath:sourcePath,archivePath,backend:'sqlite',projectId:'project',actor,deadline:Date.now()+20000},signal);
	output.import = await importLegacyProjectOnWorker({databasePath:targetPath,archivePath,backend:'sqlite',gitPath:'/offline-fixture',actor,deadline:Date.now()+20000},signal);
	const target = new Database(targetPath,{readonly:true});
	output.restored = target.prepare("SELECT n.id,n.status,n.permission_mode,r.seq FROM narrators n JOIN narrator_message_refs r ON r.narrator_id=n.id").get();
	target.close();
	const signedPath = join(process.cwd(),'signed.sqlite');
	await executeBackupWorker({action:'export',actor,config,narratorIds:['solo'],profile:'conversation-state-v1',artifactPath:signedPath,stagingPath:signedPath+'.staging'},signal);
	const signedBytes = await readFile(signedPath);
	await rm(signedPath);
	const freshJobs = new NarratorBackupJobs({root:join(process.cwd(),'fresh-backups'),config:async()=>config});
	output.signedUpload = await freshJobs.uploadArtifact(actor,new Blob([signedBytes]).stream(),signal);
	const sourceAgain = new Database(sourcePath);
	sourceAgain.run('DELETE FROM narrator_message_refs; DELETE FROM narrator_messages; DELETE FROM narrators');
	sourceAgain.close();
	output.signedPreview = await freshJobs.previewNarratorRestore(actor,output.signedUpload);
	output.signedRestore = await freshJobs.restoreNarratorState(actor,output.signedUpload);
} catch(error) {output.error = error.message;}
console.log(JSON.stringify(output));
`;

async function productionEntries() {
	const source = await readFile(join(root, "scripts/build-cross-platform.ts"), "utf8");
	const command = source.match(/const compile = Bun\.spawnSync\(\s*\[([\s\S]*?)\],\s*\{/);
	if (!command) throw new Error("Production compile arguments unavailable");
	const args = [
		...command[1].replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "").matchAll(/"([^"\r\n]+)"/g),
	].map((match) => match[1]);
	return args.slice(2, args.indexOf("--compile"));
}

test("production compile explicitly includes all three private archive workers", async () => {
	const actual = await productionEntries();
	for (const entry of entries) expect(actual).toContain(entry);
});

test("minified compiled workers complete real SQLite operations outside source cwd; missing workers fail closed", async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(process.env.NARRAFORK_HOME).toBeTruthy();
	const sourceDir = await mkdtemp(join(root, "server/.private-archive-compiled-"));
	const artifacts = await mkdtemp(join(tmpdir(), "nf-private-archive-compiled-"));
	try {
		const probe = join(sourceDir, "probe.ts");
		await writeFile(probe, probeSource);
		const binaries = [];
		for (const includeWorkers of [true, false]) {
			const binary = join(
				artifacts,
				`${includeWorkers ? "complete" : "missing"}${process.platform === "win32" ? ".exe" : ""}`,
			);
			await exec(
				process.execPath,
				[
					"build",
					probe,
					...(includeWorkers ? entries : []),
					"--root",
					join(root, "server"),
					"--compile",
					"--minify",
					"--asset-naming=[dir]/[name].[ext]",
					"--outfile",
					binary,
				],
				{ cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env } },
			);
			binaries.push(binary);
		}
		await rm(sourceDir, { recursive: true, force: true });
		for (const [index, binary] of binaries.entries()) {
			const cwd = join(artifacts, `isolated-${index}`);
			await mkdir(cwd);
			const { stdout } = await exec(binary, [], {
				cwd,
				timeout: 30_000,
				maxBuffer: 1024 * 1024,
				env: { ...process.env },
			});
			const result = JSON.parse(stdout.trim());
			expect(result.compiled).toBe(true);
			expect(result.moduleUrl).toMatch(/\$bunfs\/|%7EBUN\/|~BUN\//i);
			for (const choices of result.specifiers)
				for (const specifier of choices) expect(specifier).not.toContain(root);
			if (index === 0) {
				expect(result.error).toBeUndefined();
				expect(result.plan.narratorIds).toEqual(["solo"]);
				expect(result.plan.productionDiskRestoreAllowed).toBe(false);
				expect(result.export.tables.narrators).toBe(1);
				expect(result.import.skipped).toBe(false);
				expect(result.signedUpload.verifiedSameInstance).toBe(true);
				expect(result.signedPreview.sameInstanceStateRestoreAllowed).toBe(true);
				expect(result.signedPreview.crossInstanceApplySupported).toBe(false);
				expect(result.signedRestore.status).toBe("archived");
				expect(result.signedRestore.manualActivationRequired).toBe(true);
				expect(result.restored).toEqual({
					id: "solo",
					status: "archived",
					permission_mode: "readOnly",
					seq: 9,
				});
			} else {
				expect(result.error).toBe("Backup worker unavailable");
				expect(result.plan).toBeUndefined();
				expect(result.import).toBeUndefined();
			}
		}
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(artifacts, { recursive: true, force: true });
	}
}, 120_000);
