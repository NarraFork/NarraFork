import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const options = { timeout: 60_000, maxBuffer: 1024 * 1024 };

test("compiled historical Write keeps readonly eval workers, page ACK and actual exit without source files", async () => {
	const root = await mkdtemp(join(tmpdir(), "nf-history-compiled-"));
	const project = resolve(import.meta.dir, "../..");
	try {
		const source = join(root, "source");
		for (const path of [
			"server/services/tool-input-stream-source-worker.ts",
			"server/lib/compiled-worker.ts",
			"server/lib/runtime-target.ts",
			"server/lib/hot-safe.ts",
			"server/lib/errors.ts",
			"server/lib/id.ts",
			"server/lib/worker-runtime/lifecycle.ts",
			"server/lib/worker-runtime/pool.ts",
			"server/lib/worker-runtime/queue.ts",
			"shared/error-catalog.ts",
			"shared/pretext-layout/text-document.ts",
		]) {
			const target = join(source, path);
			await mkdir(dirname(target), { recursive: true });
			await copyFile(join(project, path), target);
		}
		await mkdir(join(source, "node_modules"));
		await cp(
			dirname(Bun.resolveSync("nanoid", import.meta.dir)),
			join(source, "node_modules/nanoid"),
			{ recursive: true },
		);
		await writeFile(
			join(source, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { paths: { "@shared/*": ["./shared/*"] } } }),
		);
		const probe = join(source, "server/probe.ts");
		await writeFile(
			probe,
			`
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { HistoricalWriteWorkerRuntime } from "./services/tool-input-stream-source-worker";
const databasePath = join(process.cwd(), "isolated.sqlite");
const db = new Database(databasePath);
db.run("CREATE TABLE narrator_tool_calls (id TEXT, message_id TEXT, tool_use_id TEXT, narrator_id TEXT, execution_attempt INTEGER, tool_name TEXT, input_json TEXT)");
const identity = { toolCallId: "row", messageId: "message", toolUseId: "tool", narratorId: "author", executionAttempt: 1, toolName: "Write" };
const text = "raw\\r\\n\\ud800😀".repeat(10000);
db.run("INSERT INTO narrator_tool_calls VALUES ('row', 'message', 'tool', 'author', 1, 'Write', ?)", [JSON.stringify({ content: text })]);
db.close();
const runtime = new HistoricalWriteWorkerRuntime();
let result = ""; let pages = 0; let maxPage = 0;
await runtime.stream(databasePath, identity, async (chunk, offset) => {
 if (offset !== result.length) throw new Error("offset mismatch");
 pages++; maxPage = Math.max(maxPage, chunk.length); result += chunk;
}, new AbortController().signal, 10000);
await runtime.close();
console.log(JSON.stringify({ equal: result === text, length: result.length, pages, maxPage }));
`,
		);
		const binary = join(root, process.platform === "win32" ? "probe.exe" : "probe");
		await exec(
			process.execPath,
			[
				"build",
				probe,
				"--compile",
				"--minify",
				"--asset-naming=[dir]/[name].[ext]",
				"--outfile",
				binary,
			],
			{ ...options, cwd: source },
		);
		await rm(source, { recursive: true, force: true });
		const cwd = join(root, "unrelated-cwd");
		await mkdir(cwd);
		const { stdout } = await exec(binary, [], { ...options, cwd });
		const result = JSON.parse(stdout.trim()) as {
			equal: boolean;
			length: number;
			pages: number;
			maxPage: number;
		};
		expect(result.equal).toBe(true);
		expect(result.length).toBe(80_000);
		expect(result.pages).toBe(Math.ceil(result.length / 8192));
		expect(result.maxPage).toBe(8192);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 90_000);
