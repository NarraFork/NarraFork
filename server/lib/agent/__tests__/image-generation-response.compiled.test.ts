import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { COMPILED_WORKER_ENTRIES } from "../../compiled-worker";

const exec = promisify(execFile);
const project = resolve(import.meta.dir, "../../../..");

test("compiled image response worker captures and recovers without source files", async () => {
	const artifacts = await mkdtemp(join(tmpdir(), "nf-image-response-compiled-"));
	const probe = join(project, `.image-response-probe-${crypto.randomUUID()}.ts`);
	const binary = join(artifacts, "probe");
	try {
		const workerEntry = COMPILED_WORKER_ENTRIES.find(
			(entry) => entry === "lib/agent/image-generation-response-worker.ts",
		);
		expect(workerEntry).toBeTruthy();
		await writeFile(
			probe,
			`
import { generateAndStoreImages, recoverStoredImages } from "./server/lib/agent/image-generation-response";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64");
const signal = new AbortController().signal;
const scope = { narratorId: "compiled-image", signal };
let sends = 0;
const generated = await generateAndStoreImages({ prompt: "compiled", model: "image-model", signal }, scope, async () => {
	sends++;
	return { response: new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })) };
});
const recovered = await recoverStoredImages(generated.responseId, scope);
console.log(JSON.stringify({ sends, responseId: recovered.responseId, images: recovered.images }));
`,
		);
		await exec(
			process.execPath,
			[
				"build",
				probe,
				join(project, "server", workerEntry as string),
				"--compile",
				"--minify",
				"--asset-naming=[dir]/[name].[ext]",
				"--outfile",
				binary,
			],
			{ cwd: project, timeout: 60_000, maxBuffer: 1024 * 1024 },
		);
		await rm(probe, { force: true });
		const { stdout } = await exec(binary, [], {
			cwd: artifacts,
			env: { ...process.env, NARRAFORK_HOME: join(artifacts, "home") },
			timeout: 20_000,
			maxBuffer: 1024 * 1024,
		});
		const result = JSON.parse(stdout.trim()) as {
			sends: number;
			responseId: string;
			images: Array<{ imageId: string; filePath: string }>;
		};
		expect(result.sends).toBe(1);
		expect(result.images).toHaveLength(1);
		expect(result.images[0].imageId).toBe(`${result.responseId}_1`);
		expect(await Bun.file(result.images[0].filePath).exists()).toBe(true);
	} finally {
		await rm(probe, { force: true });
		await rm(artifacts, { recursive: true, force: true });
	}
}, 90_000);
