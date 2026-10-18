import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	link,
	lstat,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Worker as NodeWorker } from "node:worker_threads";
import { tagBlock } from "../../frontend/components/narrator/file-editor/editor-format-rope";
import { EditorSaveCodec } from "../../frontend/components/narrator/file-editor/editor-save-codec";
import { EDITOR_FILE_MAX_BYTES, type EditorRawSeal } from "../../shared/editor-document";
import { testEnvironment } from "../../tests/preload";
import { EditorDocumentJobs } from "./editor-document-jobs";

let jobs: EditorDocumentJobs;

import {
	type EditorActor,
	type EditorDocumentDependencies,
	EditorDocumentService,
} from "./editor-document-service";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let root: string,
	target: string,
	service: EditorDocumentService,
	actor: EditorActor,
	writes: number,
	outside: boolean;
const initial = new TextEncoder().encode("a\r\nb\rc\n");
beforeEach(async () => {
	root = await mkdtemp(join(testEnvironment.isolatedHome, "raw-upload-"));
	target = join(root, "file.txt");
	await writeFile(target, initial);
	writes = 0;
	outside = false;
	actor = {
		userId: "fixture-user",
		narratorId: "fixture-narrator",
		authorize: async () => ({
			cwd: root,
			canonicalPath: target,
			lexicalPath: target,
			projectId: null,
			outsideRoots: outside,
		}),
	};
	// Explicit test writer: exercises host stage/prepare/receipt, NOT production atomic IO.
	const execute: EditorDocumentDependencies["execute"] = async (request) => {
		await request.authorize();
		const prepared = await request.construct({
			bytes: new Uint8Array(await readFile(target)),
		} as Parameters<typeof request.construct>[0]);
		writes++;
		await writeFile(target, prepared.nextBytes);
		return { result: prepared.result } as Awaited<
			ReturnType<EditorDocumentDependencies["execute"]>
		>;
	};
	jobs = new EditorDocumentJobs();
	service = new EditorDocumentService({
		root: join(root, "transfers"),
		jobs,
		execute,
		rawWriter: {
			execute,
			queryOperation: async (_actor, operationId) => ({ operationId, status: "uncertain" }),
		},
	});
});
afterEach(async () => {
	await service.dispose();
	await rm(root, { recursive: true, force: true });
});
async function setup() {
	const doc = await service.create(actor, { path: target, origin: "legacy", protocol: "raw-v2" });
	if (doc.protocol !== "raw-v2") throw new Error("Expected raw document");
	const upload = await service.createUpload(actor, doc.docId, {
		protocol: "raw-v2",
		hashKind: "raw-sha256",
		encoding: doc.encoding,
		bom: doc.bom,
		baseHash: doc.baseHash,
		snapshotRevision: 7,
	});
	const codec = await EditorSaveCodec.create({
			root: tagBlock(Uint8Array.of(2, 3, 1)),
			encoding: "utf-8",
			bom: "none",
		}),
		bytes = codec.push("A\nb\nc\n", true),
		seal = codec.finish();
	return { doc, upload, bytes, seal };
}
const body = (bytes: Uint8Array) => new Response(Uint8Array.from(bytes)).body;
async function put(
	value: Awaited<ReturnType<typeof setup>>,
	seq: number,
	offset: number,
	bytes: Uint8Array,
) {
	return service.putChunk(
		actor,
		value.doc.docId,
		value.upload.uploadId,
		{ seq, offset, bytes: bytes.length, digest: hash(bytes) },
		body(bytes),
	);
}
const gate = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};
const ledger = () =>
	service as unknown as {
		totalBytes: number;
		sessions: Map<
			string,
			{ reserved: number; uploads: Map<string, { path: string; reserved: number; busy: boolean }> }
		>;
	};
const stagePath = (docId: string, uploadId: string) => {
	const upload = ledger().sessions.get(docId)?.uploads.get(uploadId);
	if (!upload) throw new Error("Missing test stage");
	return upload.path;
};
async function waitFor(check: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 1500;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error("Test resource boundary not reached");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}
// Inspect only this process's descriptors for the test's own private path; never close by fd scan.
async function stageFds(path: string) {
	return (
		await Promise.all(
			(await readdir("/proc/self/fd")).map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => "")),
		)
	).filter((value) => value.startsWith(path));
}
test.skipIf(process.platform !== "linux")(
	"queued raw seal opens no parent FD before existing IO admission",
	async () => {
		const value = await setup();
		await put(value, 0, 0, value.bytes);
		const path = stagePath(value.doc.docId, value.upload.uploadId),
			entered = gate(),
			release = gate();
		const held = jobs.withIo(actor.userId, async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const outcome = service.sealRaw(actor, value.doc.docId, value.upload.uploadId, value.seal).then(
			() => null,
			(error) => error,
		);
		try {
			await waitFor(() => (jobs as unknown as { queue: unknown[] }).queue.length === 1);
			expect(await stageFds(path)).toEqual([]);
			await service.cancelUpload(actor, value.doc.docId, value.upload.uploadId);
			expect(await outcome).not.toBeNull();
			expect(await stageFds(path)).toEqual([]);
			expect(ledger().totalBytes).toBe(0);
		} finally {
			release.resolve();
			await held;
			await outcome;
		}
	},
);
for (const mode of ["cancel", "timeout", "DELETE"] as const)
	test.skipIf(process.platform !== "linux")(
		`20MiB raw seal ${mode} after open releases real FDs, including deleted stage descriptors`,
		async () => {
			const value = await setup(),
				block = new Uint8Array(256 * 1024).fill(65),
				digest = hash(new Uint8Array(EDITOR_FILE_MAX_BYTES).fill(65));
			for (let offset = 0, seq = 0; offset < EDITOR_FILE_MAX_BYTES; offset += block.length, seq++)
				await service.putChunk(
					actor,
					value.doc.docId,
					value.upload.uploadId,
					{ seq, offset, bytes: block.length, digest: hash(block) },
					body(block),
				);
			const path = stagePath(value.doc.docId, value.upload.uploadId),
				controller = new AbortController(),
				original = NodeWorker.prototype.postMessage;
			let dispatched = false;
			const observer = spyOn(NodeWorker.prototype, "postMessage").mockImplementation(function (
				this: NodeWorker,
				message,
				transfer,
			) {
				original.call(this, message, transfer);
				if (message?.action === "raw-seal" && message.path === path) dispatched = true;
			});
			const outcome = service
				.sealRaw(
					actor,
					value.doc.docId,
					value.upload.uploadId,
					{
						protocol: "raw-v2",
						hashKind: "raw-sha256",
						bytes: EDITOR_FILE_MAX_BYTES,
						rawDigest: digest,
						textDigest: digest,
						formatDigest: hash(new Uint8Array()),
						textLength: EDITOR_FILE_MAX_BYTES,
						newlines: 0,
					},
					controller.signal,
				)
				.then(
					() => null,
					(error) => error,
				);
			try {
				await waitFor(async () => dispatched && (await stageFds(path)).length > 0);
				const timeout = AbortSignal.timeout(20);
				await new Promise<void>((resolve) =>
					timeout.addEventListener("abort", () => resolve(), { once: true }),
				);
				if (mode === "cancel")
					await service.cancelUpload(actor, value.doc.docId, value.upload.uploadId);
				else if (mode === "DELETE") await service.remove(actor, value.doc.docId);
				else controller.abort(timeout.reason);
				expect(await outcome).not.toBeNull();
				expect(await stageFds(path)).toEqual([]);
				expect(
					await lstat(path).then(
						() => true,
						() => false,
					),
				).toBe(false);
				expect(ledger().totalBytes).toBe(0);
				expect(writes).toBe(0);
				expect(await readFile(target)).toEqual(Buffer.from(initial));
				if (mode !== "DELETE") {
					expect(ledger().sessions.has(value.doc.docId)).toBe(true);
					expect(ledger().sessions.get(value.doc.docId)?.reserved).toBe(0);
				}
				console.info(
					"RAW_SEAL_CANCEL_FDS",
					JSON.stringify({
						mode,
						opened: true,
						remaining: (await stageFds(path)).length,
						reserved: ledger().totalBytes,
					}),
				);
			} finally {
				controller.abort();
				await outcome;
				observer.mockRestore();
			}
		},
		10_000,
	);
for (const queued of [false, true])
	test(`cancelled raw chunk ${queued ? "queued before IO" : "waiting for body"} releases prefix and reservation without closing the document`, async () => {
		const value = await setup();
		await put(value, 0, 0, value.bytes.subarray(0, 2));
		const path = stagePath(value.doc.docId, value.upload.uploadId),
			entered = gate(),
			release = gate();
		const hold = queued
			? jobs.withIo(actor.userId, async () => {
					entered.resolve();
					await release.promise;
				})
			: undefined;
		if (hold) await entered.promise;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull: async () => {
					entered.resolve();
					await release.promise;
				},
			},
			{ highWaterMark: 0 },
		);
		const outcome = service
			.putChunk(
				actor,
				value.doc.docId,
				value.upload.uploadId,
				{ seq: 1, offset: 2, bytes: value.bytes.length - 2, digest: hash(value.bytes.subarray(2)) },
				stream,
			)
			.then(
				() => null,
				(error) => error,
			);
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			if (queued)
				await waitFor(
					() =>
						!!ledger().sessions.get(value.doc.docId)?.uploads.get(value.upload.uploadId)?.busy &&
						(jobs as unknown as { queue: unknown[] }).queue.length === 1,
				);
			else await entered.promise;
			await service.cancelUpload(actor, value.doc.docId, value.upload.uploadId);
			const exited = await Promise.race([
				outcome.then(() => true),
				new Promise<boolean>((resolve) => {
					deadline = setTimeout(() => resolve(false), 1000);
				}),
			]);
			expect(exited).toBe(true);
			expect(await outcome).not.toBeNull();
			expect(
				await lstat(path).then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(ledger().totalBytes).toBe(0);
			expect(ledger().sessions.get(value.doc.docId)?.reserved).toBe(0);
			expect(ledger().sessions.has(value.doc.docId)).toBe(true);
			await service.cancelUpload(actor, value.doc.docId, value.upload.uploadId);
			expect(ledger().totalBytes).toBe(0);
			const again = await service.createUpload(actor, value.doc.docId, {
				protocol: "raw-v2",
				hashKind: "raw-sha256",
				baseHash: value.doc.baseHash,
				encoding: value.doc.encoding,
				bom: value.doc.bom,
				snapshotRevision: 8,
			});
			await service.cancelUpload(actor, value.doc.docId, again.uploadId);
			expect(ledger().totalBytes).toBe(0);
			expect(writes).toBe(0);
		} finally {
			clearTimeout(deadline);
			release.resolve();
			await hold;
			await outcome;
		}
	});
test("raw preparation cannot reuse an otherwise identical v1-domain recovery marker", async () => {
	const value = await setup(),
		path = join(root, "transfers", `ed-${value.upload.operationId}.json`);
	const legacy = {
		version: 1,
		userId: actor.userId,
		narratorId: actor.narratorId,
		operationId: value.upload.operationId,
		snapshotRevision: 7,
		hash: value.seal.rawDigest,
		rawDigest: value.seal.rawDigest,
		bytes: value.bytes.length,
		createdAt: Date.now(),
	};
	await writeFile(path, JSON.stringify(legacy));
	await put(value, 0, 0, value.bytes);
	await service.sealRaw(actor, value.doc.docId, value.upload.uploadId, value.seal);
	await expect(service.commit(actor, value.doc.docId, value.upload.uploadId, {})).rejects.toThrow(
		"Recovery metadata does not match",
	);
	expect(writes).toBe(0);
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual(legacy);
	expect(await readFile(target)).toEqual(Buffer.from(initial));
});
test("real host chunk/seal + worker prepare writes exact raw format only through trusted fixture", async () => {
	const value = await setup();
	expect(value.doc.capabilities?.stage).toBe(true);
	await put(value, 0, 0, value.bytes.subarray(0, 2));
	await put(value, 1, 2, value.bytes.subarray(2));
	await service.sealRaw(actor, value.doc.docId, value.upload.uploadId, value.seal);
	const result = await service.commit(actor, value.doc.docId, value.upload.uploadId, {});
	expect(result).toMatchObject({
		status: "saved",
		hash: value.seal.rawDigest,
		hashKind: "raw-sha256",
		snapshotRevision: 7,
	});
	expect(await readFile(target)).toEqual(Buffer.from("A\r\nb\rc\n"));
	expect(writes).toBe(1);
	expect(await service.commit(actor, value.doc.docId, value.upload.uploadId, {})).toEqual(result);
	expect(writes).toBe(1);
});
test("lost reply identical last chunk is idempotent; different digest, gaps and offsets do not append", async () => {
	const value = await setup();
	await put(value, 0, 0, value.bytes);
	await put(value, 0, 0, value.bytes);
	await expect(put(value, 0, 0, new TextEncoder().encode("different"))).rejects.toThrow();
	await expect(put(value, 2, value.bytes.length, Uint8Array.of(1))).rejects.toThrow();
	await expect(put(value, 1, value.bytes.length + 1, Uint8Array.of(1))).rejects.toThrow();
	await service.sealRaw(actor, value.doc.docId, value.upload.uploadId, value.seal);
	expect(writes).toBe(0);
	expect(await readFile(target)).toEqual(Buffer.from(initial));
});
for (const key of ["rawDigest", "textDigest", "formatDigest", "textLength", "newlines"] as const)
	test(`incorrect seal ${key} never writes`, async () => {
		const value = await setup();
		await put(value, 0, 0, value.bytes);
		const invalid: EditorRawSeal = {
			...value.seal,
			[key]: typeof value.seal[key] === "string" ? "0".repeat(64) : 999,
		};
		await expect(
			service.sealRaw(actor, value.doc.docId, value.upload.uploadId, invalid),
		).rejects.toThrow();
		await expect(
			service.commit(actor, value.doc.docId, value.upload.uploadId, {}),
		).rejects.toThrow();
		expect(writes).toBe(0);
		expect(await readFile(target)).toEqual(Buffer.from(initial));
	});
test("truncated and over-budget chunk streams are refused before append", async () => {
	const value = await setup();
	for (const bytes of [value.bytes.subarray(1), new Uint8Array(300_000)])
		await expect(
			service.putChunk(
				actor,
				value.doc.docId,
				value.upload.uploadId,
				{ seq: 0, offset: 0, bytes: value.bytes.length, digest: hash(value.bytes) },
				body(bytes),
			),
		).rejects.toThrow();
	await put(value, 0, 0, value.bytes);
	await service.sealRaw(actor, value.doc.docId, value.upload.uploadId, value.seal);
	expect(writes).toBe(0);
});
for (const alias of ["symlink", "hardlink"] as const)
	test(`raw append refuses a staging ${alias} before touching a different file`, async () => {
		const value = await setup();
		await put(value, 0, 0, value.bytes.subarray(0, 2));
		const paths = await readdir(join(root, "transfers")),
			staged = paths.find((path) => /^ed-[a-f0-9-]+$/.test(path));
		if (!staged) throw new Error("No private stage");
		const other = join(root, "different-resource.txt"),
			stage = join(root, "transfers", staged);
		await writeFile(other, "OK");
		await unlink(stage);
		if (alias === "symlink") await symlink(other, stage);
		else await link(other, stage);
		await expect(put(value, 1, 2, value.bytes.subarray(2))).rejects.toThrow();
		expect(await readFile(other, "utf8")).toBe("OK");
		expect(await readFile(target)).toEqual(Buffer.from(initial));
		expect(writes).toBe(0);
	});
test("outside-root confirmation reuses the same sealed upload", async () => {
	outside = true;
	const value = await setup();
	await put(value, 0, 0, value.bytes);
	await service.sealRaw(actor, value.doc.docId, value.upload.uploadId, value.seal);
	let token = "";
	try {
		await service.commit(actor, value.doc.docId, value.upload.uploadId, {});
	} catch (error) {
		token = (error as { data: { confirmationToken: string } }).data.confirmationToken;
	}
	expect(token).not.toBe("");
	expect(writes).toBe(0);
	await service.commit(actor, value.doc.docId, value.upload.uploadId, { confirmationToken: token });
	expect(writes).toBe(1);
});
test("production can stage but backend refuses raw target writes regardless of client capability spoofing", async () => {
	await service.dispose();
	service = new EditorDocumentService({
		root: join(root, "transfers"),
		execute: async () => {
			writes++;
			throw new Error("must not dispatch");
		},
	});
	const value = await setup();
	expect(value.doc.capabilities).toMatchObject({
		stage: true,
		durableApply: false,
		durableQuery: false,
	});
	await put(value, 0, 0, value.bytes);
	await service.sealRaw(actor, value.doc.docId, value.upload.uploadId, value.seal);
	await expect(service.commit(actor, value.doc.docId, value.upload.uploadId, {})).rejects.toThrow(
		"writer is not available",
	);
	expect(writes).toBe(0);
	expect(await readFile(target)).toEqual(Buffer.from(initial));
});
