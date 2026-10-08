import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dir, "../../..");
const entries = [
	"./server/services/project-archive/legacy-sync-worker.ts",
	"./server/services/project-archive/legacy-import-worker.ts",
];
const probeSource = `
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { exportLegacyProjectOnWorker } from "../services/project-archive/legacy-sync-job";
import { importLegacyProjectOnWorker } from "../services/project-archive/legacy-import-job";
import { ARCHIVE_COLUMNS, ARCHIVE_TABLE_ORDER } from "../services/project-archive/manifest";
import { privateArchiveWorkerSpecifiers } from "../services/project-archive/worker-client";
import { isCompiledRuntime } from "../lib/runtime-target";
const actor = { userId: "alice", isAdmin: false };
const sourcePath = join(process.cwd(), "source.sqlite");
const archivePath = join(process.cwd(), "archive.sqlite");
const targetPath = join(process.cwd(), "target.sqlite");
function create(path) {
	const db = new Database(path, {create:true});
	db.run("CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT); INSERT INTO users VALUES('alice','user')");
	for (const table of ARCHIVE_TABLE_ORDER) {
		const columns = new Set([...ARCHIVE_COLUMNS[table], ...(table === 'narrators' ? ['owner_user_id','acl_root_narrator_id','variant','refs_inherited_from','refs_backfill_cursor','next_seq'] : [])]);
		db.run('CREATE TABLE '+table+' ('+[...columns].map(name => name+' '+(name === 'id' ? 'TEXT PRIMARY KEY' : ['seq','refs_backfill_cursor'].includes(name) ? 'INTEGER' : 'TEXT')).join(',')+')');
	}
	return db;
}
const source = create(sourcePath);
source.run("INSERT INTO projects(id,name,git_path) VALUES('project','compiled smoke','/fixture'); INSERT INTO chapters(id,project_id) VALUES('chapter','project'); INSERT INTO narrators(id,type,owner_user_id,chapter_id,title) VALUES('solo','primary','alice','chapter','compiled'); INSERT INTO narrator_messages(id,narrator_id,role,content_json) VALUES('message','solo','assistant','[]'); INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES('ref','solo','message',9)");
source.close();
create(archivePath).close();
create(targetPath).close();
const output = {compiled:isCompiledRuntime(),moduleUrl:import.meta.url,specifiers:['legacy-sync','legacy-import'].map(kind => privateArchiveWorkerSpecifiers(kind))};
try {
	output.export = await exportLegacyProjectOnWorker({databasePath:sourcePath,archivePath,backend:'sqlite',projectId:'project',actor,deadline:Date.now()+20000});
	output.import = await importLegacyProjectOnWorker({databasePath:targetPath,archivePath,backend:'sqlite',gitPath:'/offline-fixture',actor,deadline:Date.now()+20000});
	const target = new Database(targetPath,{readonly:true});
	output.restored = target.prepare("SELECT n.id,n.status,n.permission_mode,r.seq FROM narrators n JOIN narrator_message_refs r ON r.narrator_id=n.id").get();
	target.close();
} catch(error) {output.error = error.message;}
console.log(JSON.stringify(output));
`;

test("production compile explicitly includes both project archive workers", async () => {
	const source = await readFile(join(root, "scripts/build-cross-platform.ts"), "utf8");
	const command = source.match(/const compile = await runBuildStep\(\s*\[([\s\S]*?)\]\s*,?\s*\)/);
	if (!command) throw new Error("Production compile arguments unavailable");
	const withoutComments = command[1].replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
	expect(withoutComments).toMatch(/^\s*process\.execPath\s*,/);
	const { stdout } = await exec(process.execPath, ["--eval", "process.stdout.write(Bun.version)"], {
		timeout: 10_000,
		maxBuffer: 1024,
	});
	expect(stdout).toBe(Bun.version);
	const args = [
		process.execPath,
		...[...withoutComments.matchAll(/"([^"\r\n]+)"/g)].map((match) => match[1]),
	];
	expect(args.slice(0, 3)).toEqual([process.execPath, "build", "./server/index.ts"]);
	const actual = args.slice(2, args.indexOf("--compile"));
	for (const entry of entries) expect(actual).toContain(entry);
});

test("minified compiled project workers operate outside source cwd; missing workers fail closed", async () => {
	const sourceDir = await mkdtemp(join(root, "server/.project-archive-compiled-"));
	const artifacts = await mkdtemp(join(tmpdir(), "nf-project-archive-compiled-"));
	try {
		const probe = join(sourceDir, "probe.ts");
		await writeFile(probe, probeSource);
		const binaries: string[] = [];
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
				expect(result.export.tables.narrators).toBe(1);
				expect(result.import.skipped).toBe(false);
				expect(result.restored).toEqual({
					id: "solo",
					status: "archived",
					permission_mode: "readOnly",
					seq: 9,
				});
			} else {
				expect(result.error).toBe("Project archive worker unavailable");
				expect(result.export).toBeUndefined();
				expect(result.import).toBeUndefined();
			}
		}
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(artifacts, { recursive: true, force: true });
	}
}, 120_000);
