import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("embedded WASM bootstraps without materializing temporary engine files", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "nf-structural-engine-"));
	try {
		const runtime = new URL("../tree-sitter-runtime.ts", import.meta.url).href;
		const store = new URL("../grammar-store.ts", import.meta.url).href;
		const { stdout } = await execute(
			process.execPath,
			[
				"--eval",
				`import { readdir } from "node:fs/promises";
import { getTreeSitterRuntime, loadTreeSitterLanguage, createTreeSitterParser } from ${JSON.stringify(runtime)};
import { readInstalledGrammar } from ${JSON.stringify(store)};
const bytes = await readInstalledGrammar("bash");
if (!bytes) throw new Error("Built-in Bash grammar unavailable");
const language = await loadTreeSitterLanguage(bytes);
const first = await getTreeSitterRuntime();
const second = await getTreeSitterRuntime();
const parser = await createTreeSitterParser(language);
const tree = parser.parse("printf hello\\n");
try {
 console.log(JSON.stringify({
  sameRuntime: first === second,
  root: tree?.rootNode.type,
  files: await readdir(process.env.TMPDIR)
 }));
} finally { tree?.delete(); parser.delete?.(); }
`,
			],
			{
				env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
				timeout: 15_000,
				maxBuffer: 64 * 1024,
			},
		);
		expect(JSON.parse(stdout.trim())).toEqual({ sameRuntime: true, root: "program", files: [] });
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});
