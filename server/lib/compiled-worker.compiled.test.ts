import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compiledBuildArguments } from "../../scripts/lib/compiled-build";
import { compiledWorkerBuildEntrypoints } from "./compiled-worker";
import { buildDocx, buildZip } from "./document-preview/__tests__/docx-fixture";

const exec = promisify(execFile);
const project = resolve(import.meta.dir, "../..");

test("a main entry outside server/ misses the first $bunfs layout and loads the next one", async () => {
	const artifacts = await mkdtemp(join(tmpdir(), "nf-compiled-worker-"));
	const probe = join(project, `.compiled-worker-probe-${crypto.randomUUID()}.ts`);
	const binary = join(artifacts, "probe");
	try {
		await writeFile(
			probe,
			`import { compiledWorkerSpecifiers, connectCompiledWorker } from "./server/lib/compiled-worker";
const specifiers = compiledWorkerSpecifiers(
	"services/git-untracked-line-worker.ts",
	"./server/services/git-untracked-line-worker.ts",
	import.meta.url,
);
const attempts = [];
for (const specifier of specifiers) {
	try {
		const started = await connectCompiledWorker([specifier], { timeoutMs: 3000 });
		started.worker.postMessage({ action: "read", cwd: process.cwd(), paths: [], remainingBytes: 0, deadlineAt: Date.now() + 3000 });
		const message = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no reply")), 3000);
			started.worker.once("message", (value) => { clearTimeout(timer); resolve(value); });
			started.worker.once("error", (error) => { clearTimeout(timer); reject(error); });
		});
		await started.worker.terminate();
		attempts.push({ ok: true, specifier: started.specifier, message });
		break;
	} catch (error) {
		attempts.push({ ok: false, specifier, message: error instanceof Error ? error.message : String(error) });
	}
}
console.log(JSON.stringify({ specifiers, attempts }));
`,
		);
		await exec(
			process.execPath,
			[
				"build",
				probe,
				join(project, "server/services/git-untracked-line-worker.ts"),
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
			timeout: 20_000,
			maxBuffer: 1024 * 1024,
		});
		const result = JSON.parse(stdout.trim()) as {
			specifiers: string[];
			attempts: Array<{
				ok: boolean;
				specifier: string;
				message: string | { value?: { complete?: boolean } };
			}>;
		};
		const [first, second] = result.specifiers;
		if (!first || !second) throw new Error("Missing compiled layout candidates");
		expect(first).toEndWith("/services/git-untracked-line-worker.js");
		expect(second).toEndWith("/server/services/git-untracked-line-worker.js");
		// Bun reports a native virtual key, not the file URL (and not a fixed drive letter).
		const missingPath = fileURLToPath(first).split(sep).join("/");
		expect(result.attempts).toHaveLength(2);
		expect(result.attempts[0]).toEqual({
			ok: false,
			specifier: first,
			message: `No worker entry loaded (${first}: Cannot find module '${missingPath}')`,
		});
		expect(result.attempts[1]).toMatchObject({
			ok: true,
			specifier: second,
			message: { value: { complete: true, files: [] } },
		});
	} finally {
		await rm(probe, { force: true });
		await rm(artifacts, { recursive: true, force: true });
	}
}, 90_000);

// Keep this probe outside server/ to freeze the repo-root layout. Observe the real handles
// and separate failed layout probes (no business messages) from the two workers doing work.
const pairedWorkerProbe = `
import { readFile } from "node:fs/promises";
import { stagePluginPackage } from "../server/services/plugin-runtime";
import { requestDocumentPreview, closeDocumentPreviewWorkers } from "../server/lib/document-preview/client";
import { WorkerHandle } from "../server/lib/worker-runtime/lifecycle";
import { isCompiledRuntime } from "../server/lib/runtime-target";
if (!isCompiledRuntime()) throw new Error("Expected a compiled executable");
const [root, archive, sha256, docx] = process.argv.slice(2);
const threads = [];
const create = WorkerHandle.thread;
WorkerHandle.thread = (entry, options) => {
	const handle = create(entry, options);
	const thread = { entry: String(entry), handle, actions: [], exitCode: null };
	const post = handle.resource.postMessage.bind(handle.resource);
	handle.resource.postMessage = (message, ...transfer) => {
		if (message.action !== "ping") thread.actions.push(message.action);
		return post(message, ...transfer);
	};
	threads.push(thread);
	void handle.exited.then(code => { thread.exitCode = code; });
	return handle;
};
try {
	const staged = await stagePluginPackage(root, await readFile(archive), {
		expectedArchiveSha256: sha256,
		trustPolicy: { enabled: true, requireSignature: false },
	});
	const packageExited = threads.length > 0 && threads.every(thread => Number.isInteger(thread.exitCode));
	let preview;
	try {
		preview = await requestDocumentPreview(docx);
	} finally {
		await closeDocumentPreviewWorkers();
	}
	if (!preview.ok) throw new Error("Document preview failed: " + preview.failure.reason);
	console.log("WORKER-PAIR " + JSON.stringify({
		moduleUrl: import.meta.url, packageExited,
		pluginId: staged.pluginId, version: staged.version, hash: staged.hash, currentUpdated: staged.currentUpdated,
		kind: preview.result.kind, markdown: preview.result.markdown.trim(),
		threads: threads.map(({ entry, actions, exitCode }) => ({ entry, actions, exitCode })),
	}));
} finally {
	WorkerHandle.thread = create;
	await Promise.all(threads.map(({ handle }) => handle.close()));
}
`;

test("one compiled executable stages a plugin and previews a DOCX using both embedded workers", async () => {
	const artifacts = await mkdtemp(join(tmpdir(), "nf-worker-pair-"));
	let sourceDir: string | undefined;
	try {
		sourceDir = await mkdtemp(join(project, ".compiled-worker-pair-"));
		const probe = join(sourceDir, "probe.ts");
		const binary = join(artifacts, process.platform === "win32" ? "pair.exe" : "pair");
		const cwd = join(artifacts, "empty-cwd");
		const home = join(artifacts, "home");
		await Promise.all([mkdir(cwd), mkdir(home), writeFile(probe, pairedWorkerProbe)]);
		const env = { ...process.env, HOME: home, USERPROFILE: home, NARRAFORK_HOME: home };
		const workers = ["services/plugin-package-stage-worker", "lib/document-preview/worker"];
		const registered = new Set(compiledWorkerBuildEntrypoints());
		const entries = workers.map((name) => `./server/${name}.ts`);
		for (const entry of entries) expect(registered.has(entry)).toBe(true);
		await exec(
			process.execPath,
			["build", probe, ...entries, ...compiledBuildArguments(), "--outfile", binary],
			{
				cwd: project,
				env,
				timeout: 60_000,
				maxBuffer: 256 * 1024,
			},
		);
		await rm(sourceDir, { recursive: true });
		sourceDir = undefined;

		const fixture = join(project, "tests/fixtures/plugins/packages/valid-package");
		const manifest = await readFile(join(fixture, "manifest.json"));
		const server = await readFile(join(fixture, "server/index.js"));
		const archive = buildZip([
			{ name: "manifest.json", data: manifest },
			{ name: "server/index.js", data: server },
		]);
		const archivePath = join(artifacts, "hello.nfplugin");
		const docxPath = join(artifacts, "preview.docx");
		const marker = "Preview from the embedded worker";
		await Promise.all([
			writeFile(archivePath, archive),
			writeFile(docxPath, buildDocx({ bodyXml: `<w:p><w:r><w:t>${marker}</w:t></w:r></w:p>` })),
		]);
		const store = join(home, "plugins");
		const digest = createHash("sha256").update(archive).digest("hex");
		const expectedHash = createHash("sha256")
			.update("manifest.json\0")
			.update(manifest)
			.update("server/index.js\0")
			.update(server)
			.digest("hex");
		const { stdout } = await exec(binary, [store, archivePath, digest, docxPath], {
			cwd,
			env,
			timeout: 30_000,
			maxBuffer: 128 * 1024,
		});
		const reports = stdout.split(/\r?\n/).filter((line) => line.startsWith("WORKER-PAIR "));
		expect(reports).toHaveLength(1);
		const result = JSON.parse((reports[0] ?? "").slice("WORKER-PAIR ".length)) as {
			moduleUrl: string;
			threads: Array<{ entry: string; actions: string[]; exitCode: number | null }>;
		};
		const embedded = (path: string) => {
			const url = new URL(`${path}.js`, result.moduleUrl);
			return process.platform === "win32" ? fileURLToPath(url).split(sep).join("/") : url.href;
		};
		expect(result).toMatchObject({
			pluginId: "com.example.hello",
			version: "1.0.0",
			hash: expectedHash,
			currentUpdated: false,
			packageExited: true,
			kind: "docx",
			markdown: marker,
		});
		const [packageEntry, documentEntry] = entries.map((entry) => embedded(entry.slice(2, -3)));
		const active = result.threads.filter((thread) => thread.actions.length > 0);
		expect(active.map(({ entry, actions }) => ({ entry, actions }))).toEqual([
			{ entry: packageEntry, actions: ["plugin_package_stage", "plugin_package_verify"] },
			{ entry: documentEntry, actions: ["preview"] },
		]);
		const missingCandidates = new Set(workers.map(embedded));
		for (const thread of result.threads) {
			if (!thread.actions.length) expect(missingCandidates.has(thread.entry)).toBe(true);
			expect(thread.exitCode).toEqual(expect.any(Number));
		}
		expect(
			await readFile(
				join(store, "packages", "com.example.hello", "1.0.0", expectedHash, "server/index.js"),
			),
		).toEqual(server);
		await expect(readFile(join(store, "current.json"))).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
		await rm(artifacts, { recursive: true, force: true });
	}
}, 100_000);
