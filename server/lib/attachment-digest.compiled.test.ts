import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { compiledWorkerBuildEntrypoints } from "./compiled-worker";

const exec = promisify(execFile);
const project = resolve(import.meta.dir, "../..");

test("a compiled digest client loads its registered Worker and hashes every supported input", async () => {
	const artifacts = await mkdtemp(join(tmpdir(), "nf-compiled-attachment-digest-"));
	const probe = join(project, `.attachment-digest-probe-${crypto.randomUUID()}.ts`);
	const binary = join(artifacts, "probe");
	const input = join(artifacts, "abc.bin");
	try {
		await writeFile(input, "abc");
		await writeFile(
			probe,
			`import { digestAttachment, closeAttachmentDigestWorkers } from "./server/lib/attachment-digest";
try {
	const file = process.argv[2];
	const values = await Promise.all([
		digestAttachment(new Blob(["abc"])),
		digestAttachment(new File(["abc"], "abc.bin")),
		digestAttachment(Bun.file(file)),
		digestAttachment(file),
	]);
	console.log(JSON.stringify(values));
} finally { await closeAttachmentDigestWorkers(); }
`,
		);
		const entries = compiledWorkerBuildEntrypoints().filter((entry) =>
			entry.endsWith("/attachment-digest-worker.ts"),
		);
		expect(entries).toHaveLength(1);
		await exec(
			process.execPath,
			[
				"build",
				probe,
				...entries,
				"--compile",
				"--minify",
				"--asset-naming=[dir]/[name].[ext]",
				"--outfile",
				binary,
			],
			{ cwd: project, timeout: 60_000, maxBuffer: 1024 * 1024 },
		);
		await rm(probe, { force: true });
		const result = await exec(binary, [input], {
			cwd: artifacts,
			timeout: 20_000,
			maxBuffer: 1024 * 1024,
		});
		expect(JSON.parse(result.stdout.trim())).toEqual(
			Array(4).fill("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
		);
	} finally {
		await rm(probe, { force: true });
		await rm(artifacts, { recursive: true, force: true });
	}
}, 90_000);
