import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { grammarCachePath } from "../grammar-store";
import { ensureGrammarFixture } from "./grammar-fixture";

const execute = promisify(execFile);
const project = resolve(import.meta.dir, "../../../../..");
const fixtureRoot = join(import.meta.dir, "integration-fixtures");
const hasTypescript = ensureGrammarFixture("typescript");

(hasTypescript ? test : test.skip)(
	"minified compiled provider uses its embedded structural worker after source entries are removed",
	async () => {
		// Both compile inputs are disposable fixtures. Removing their entire tree before
		// executing the binary rules out a successful load of an unembedded source entry.
		await mkdir(fixtureRoot, { recursive: true });
		const source = await mkdtemp(join(fixtureRoot, "compiled-"));
		const artifacts = await mkdtemp(join(tmpdir(), "nf-structural-compiled-"));
		const server = join(source, "server");
		const main = join(server, "probe.ts");
		const entry = join(server, "lib/agent/structural/worker-entry.ts");
		const binary = join(artifacts, process.platform === "win32" ? "probe.exe" : "probe");
		const home = join(artifacts, "home");
		const data = join(home, ".narrafork");
		const provider = join(project, "server/lib/agent/structural/tree-sitter-provider.ts");
		const client = join(project, "server/lib/agent/structural/worker-client.ts");
		const runtime = join(project, "server/lib/runtime-target.ts");
		try {
			await mkdir(dirname(entry), { recursive: true });
			await mkdir(join(data, "grammars"), { recursive: true });
			await copyFile(
				grammarCachePath("typescript"),
				join(data, "grammars/tree-sitter-typescript.wasm"),
			);
			await writeFile(
				main,
				`import { treeSitterProvider } from ${JSON.stringify(provider)};
import { closeStructuralWorkers } from ${JSON.stringify(client)};
import { isCompiledRuntime } from ${JSON.stringify(runtime)};
const doc = {
 filePath: "/compiled/probe.ts", languageId: "typescript",
 text: "export function compiledWorker(value: number) { return value + value; }\\n"
};
try {
 const support = await treeSitterProvider.supports(doc);
 const outline = await treeSitterProvider.outline(doc);
 const located = await treeSitterProvider.locate(doc, { symbol: "compiledWorker" });
 const statistics = await treeSitterProvider.statistics(doc);
 console.log(JSON.stringify({
  compiled: isCompiledRuntime(), support,
  names: outline.map(node => node.name),
  located: located.map(node => node.symbolPath),
  references: statistics?.identifiers.find(entry => entry.name === "value")?.count
 }));
} finally { await closeStructuralWorkers(); }
`,
			);
			await writeFile(
				entry,
				`import ${JSON.stringify(join(project, "server/lib/agent/structural/worker-entry.ts"))};\n`,
			);
			await execute(
				process.execPath,
				[
					"build",
					main,
					entry,
					"--root",
					server,
					"--compile",
					"--minify",
					"--asset-naming=[dir]/[name].[ext]",
					"--outfile",
					binary,
				],
				{ cwd: project, timeout: 60_000, maxBuffer: 1024 * 1024 },
			);
			await rm(source, { recursive: true, force: true });
			expect(existsSync(main)).toBe(false);
			expect(existsSync(entry)).toBe(false);
			const { stdout } = await execute(binary, [], {
				cwd: artifacts,
				env: {
					...process.env,
					HOME: home,
					USERPROFILE: home,
					NARRAFORK_HOME: data,
					NARRAFORK_TEST: "1",
				},
				timeout: 30_000,
				maxBuffer: 64 * 1024,
			});
			expect(JSON.parse(stdout.trim())).toEqual({
				compiled: true,
				support: "full",
				names: ["compiledWorker"],
				located: ["compiledWorker"],
				references: 3,
			});
		} finally {
			await rm(source, { recursive: true, force: true });
			await rm(artifacts, { recursive: true, force: true });
		}
	},
	120_000,
);
