import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import iconv from "iconv-lite";
import {
	EDITOR_FILE_MAX_BYTES,
	EDITOR_METADATA_MAX_BYTES,
	EDITOR_SESSION_IDLE_MS,
	EDITOR_TRANSFER_MAX_BYTES,
	type EditorDocumentDescriptor,
} from "../../shared/editor-document";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import { fileChangeOperations, narrators, users } from "../db/schema";
import { generateId } from "../lib/id";
import {
	EditorDocumentJobs,
	editorWorkerEntryPoint,
	editorWorkerSpecifierCandidates,
} from "./editor-document-jobs";
import { queryEditorOperation } from "./editor-document-runtime";
import {
	type EditorActor,
	EditorDocumentError,
	EditorDocumentService,
} from "./editor-document-service";
import type {
	EditorVersionMetadata,
	EditorWorkerRequest,
	EditorWorkerResult,
} from "./editor-document-worker";
import { type FileChangeLocalIo, fileChangeLocalIo } from "./file-change-local-io";
import { LocalFileChangeRuntime } from "./file-change-runtime";

let root: string, target: string, actor: EditorActor, service: EditorDocumentService;
let runtime: LocalFileChangeRuntime, io: FileChangeLocalIo, dispatches: number, outside: boolean;
let unlinkVersion: (path: string) => Promise<void>;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
beforeEach(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	root = await mkdtemp(join(testEnvironment.isolatedHome, "large-editor-"));
	target = join(root, "file.txt");
	await writeFile(target, "before\r\n中文🙂\r\n");
	const userId = generateId(),
		narratorId = generateId(),
		now = new Date().toISOString();
	db.insert(users)
		.values({ id: userId, username: userId, passwordHash: "x", role: "user", createdAt: now })
		.run();
	db.insert(narrators)
		.values({ id: narratorId, cwd: root, ownerUserId: userId, createdAt: now, updatedAt: now })
		.run();
	dispatches = 0;
	outside = false;
	unlinkVersion = unlink;
	io = {
		...fileChangeLocalIo,
		async apply(input) {
			dispatches++;
			return fileChangeLocalIo.apply(input);
		},
	};
	runtime = new LocalFileChangeRuntime({ db, privateRoot: testEnvironment.narraforkHome, io });
	actor = {
		userId,
		narratorId,
		async authorize() {
			return {
				cwd: root,
				projectId: null,
				lexicalPath: target,
				canonicalPath: target,
				outsideRoots: outside,
			};
		},
	};
	service = new EditorDocumentService({
		root: join(root, "transfers"),
		execute: (request) => runtime.executeEditor(request),
		unlinkVersion: (path) => unlinkVersion(path),
	});
});
afterEach(async () => {
	await service.dispose();
	await rm(root, { recursive: true, force: true });
});
const bodies = async () =>
	(await readdir(join(root, "transfers"))).filter((path) => !path.endsWith(".json"));
const create = () => service.create(actor, { path: target, deviceId: "local", origin: "legacy" });
async function upload(
	doc: EditorDocumentDescriptor,
	content: string,
	baseHash: string | null = doc.baseHash,
) {
	const entry = await service.createUpload(actor, doc.docId, {
		baseHash,
		encoding: doc.encoding,
		snapshotRevision: 7,
	});
	const bytes = new TextEncoder().encode(content);
	await service.put(actor, doc.docId, entry.uploadId, new Response(bytes).body, bytes.byteLength);
	return entry.uploadId;
}
async function failure(body: () => Promise<unknown>) {
	try {
		await body();
		throw new Error("Expected rejection");
	} catch (error) {
		expect(error).toBeInstanceOf(EditorDocumentError);
		return error as EditorDocumentError;
	}
}
function operations() {
	return db
		.select()
		.from(fileChangeOperations)
		.where(eq(fileChangeOperations.narratorId, actor.narratorId))
		.limit(10)
		.all();
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { resolve, promise };
}

test("raw open final authorization and DELETE settle without leaking the closing session quota", async () => {
	const doc = await service.create(actor, {
		path: target,
		deviceId: "local",
		origin: "legacy",
		protocol: "raw-v2",
	});
	const entered = deferred(),
		resume = deferred();
	const authorize = actor.authorize.bind(actor);
	let calls = 0;
	const pause = spyOn(actor, "authorize").mockImplementation(async (...args) => {
		const binding = await authorize(...args);
		if (++calls === 2) {
			entered.resolve();
			await resume.promise;
		}
		return binding;
	});
	const opening = service.rawOpen(actor, doc.docId, doc.versionHandle).catch((error) => error);
	try {
		await entered.promise;
		expect(await service.remove(actor, doc.docId)).toEqual({ status: "released" });
		resume.resolve();
		expect(await opening).toBeInstanceOf(EditorDocumentError);
		expect((Reflect.get(service, "sessions") as Map<string, unknown>).size).toBe(0);
		expect(
			(Reflect.get(service, "userSessions") as Map<string, number>).get(actor.userId) ?? 0,
		).toBe(0);
		expect(service.streams.diagnostics.active).toBe(0);
	} finally {
		resume.resolve();
		await opening;
		pause.mockRestore();
	}
});

test.each([
	"before",
	"second-frame",
] as const)("remote assembled body reauthorizes current access %s publication and returns its window on denial", async (when) => {
	const bytes = Buffer.alloc(64 * 1024, 65);
	await writeFile(target, bytes);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const original = actor.authorize.bind(actor);
	let revoked = false,
		body = false,
		bodyFrames = 0,
		checks = 0;
	const closes: boolean[] = [];
	actor.authorize = async (...args) => {
		checks++;
		if (revoked) throw new EditorDocumentError("FORBIDDEN", "Current device access revoked", 403);
		return {
			...(await original(...args)),
			deviceId: "peer",
			workspaceIdentity: "root",
			runtimeEpoch: "epoch",
			runtimeGeneration: 1,
			rawSource: {
				open: async () => ({
					readId: "peer-read",
					sourceGeneration: "generation",
					totalBytes: bytes.length,
					rawDigest: digest,
					identity: {
						deviceId: "peer",
						pathFlavor: "posix" as const,
						canonicalPath: target,
						workspaceIdentity: "root",
						runtimeEpoch: "epoch",
						runtimeGeneration: 1,
						fencingToken: 1,
					},
				}),
				chunk: async (input) => {
					expect(input.maxBytes).toBeLessThanOrEqual(16384);
					if (body && ++bodyFrames === 2 && when === "second-frame") revoked = true;
					const part = bytes.subarray(input.offset, input.offset + input.maxBytes);
					return {
						readId: input.readId,
						sourceGeneration: "generation",
						offset: input.offset,
						bytes: part.length,
						dataB64: part.toString("base64"),
						eof: input.offset + part.length === bytes.length,
					};
				},
				close: async (input) => {
					if (body) closes.push(input.abort);
				},
			},
		};
	};
	const doc = await service.create(actor, {
		path: target,
		deviceId: "peer",
		origin: "reference",
		protocol: "raw-v2",
	});
	const opened = await service.rawOpen(actor, doc.docId, doc.versionHandle);
	body = true;
	checks = 0;
	if (when === "before") revoked = true;
	await expect(service.rawChunk(actor, doc.docId, opened.readId, 0, 65536)).rejects.toMatchObject({
		code: "FORBIDDEN",
		statusCode: 403,
	});
	expect(bodyFrames).toBe(when === "before" ? 0 : 2);
	expect(checks).toBe(when === "before" ? 1 : 2);
	expect(closes).toEqual([true]);
	expect(service.streams.diagnostics.active).toBe(0);
	expect(service.streams.diagnostics.windowBytes).toBe(0);
	expect(dispatches).toBe(0);
});

async function createFifo(path: string) {
	const command = Bun.spawn(["mkfifo", path], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		signal: AbortSignal.timeout(2_000),
	});
	expect(await command.exited).toBe(0);
}
async function expectFastFifoRejection(
	path: string,
	operation: () => Promise<unknown>,
	message: string,
) {
	// Rescue a regressed blocking open so the test fails its latency assertion rather
	// than leaving an uninterruptible reader in the isolated test process forever.
	const rescue = setTimeout(() => {
		void open(path, constants.O_WRONLY | (constants.O_NONBLOCK ?? 0))
			.then((file) => file.close())
			.catch(() => {});
	}, 2_000);
	const started = performance.now();
	try {
		await expect(operation()).rejects.toThrow(message);
		expect(performance.now() - started).toBeLessThan(1_500);
	} finally {
		clearTimeout(rescue);
	}
}

describe("large editor objects and real durable pipeline", () => {
	test("cached saved status reauthorizes its original device without opening a deleted target", async () => {
		let revoked = false,
			metadataChecks = 0;
		actor.authorizeOperation = async (deviceId) => {
			expect(deviceId).toBe("local");
			metadataChecks++;
			if (revoked) throw new EditorDocumentError("FORBIDDEN", "Device access revoked", 403);
		};
		const doc = await create(),
			uploaded = await upload(doc, "saved\n");
		const saved = await service.commit(actor, doc.docId, uploaded, {});
		await rm(target);
		actor.authorize = async () => {
			throw new Error("Receipt query must not reopen the target");
		};
		expect((await service.operation(actor, saved.operationId)).status).toBe("saved");
		revoked = true;
		await expect(service.operation(actor, saved.operationId)).rejects.toMatchObject({
			statusCode: 403,
		});
		expect(metadataChecks).toBe(2);
		expect(dispatches).toBe(1);
	});

	test.skipIf(process.platform === "win32")(
		"worker refuses a FIFO without waiting for a writer",
		async () => {
			const fifo = join(root, "source.fifo");
			await createFifo(fifo);
			const jobs = new EditorDocumentJobs();
			await expectFastFifoRejection(
				fifo,
				() =>
					jobs.run(actor.userId, {
						action: "metadata",
						sourcePath: fifo,
					}),
				"not regular",
			);
			await expectFastFifoRejection(
				fifo,
				() => jobs.run(actor.userId, { action: "seal", path: fifo }),
				"not regular",
			);
		},
		10_000,
	);
	test.skipIf(process.platform === "win32")(
		"version content refuses an internal object replaced with a FIFO",
		async () => {
			const doc = await create();
			const versionPath = target;
			await unlink(versionPath);
			await createFifo(versionPath);
			await expectFastFifoRejection(
				versionPath,
				() => service.content(actor, doc.docId, doc.versionHandle),
				"not regular",
			);
			expect(await service.remove(actor, doc.docId)).toEqual({ status: "released" });
			expect(await bodies()).toHaveLength(0);
		},
		10_000,
	);
	test("startup cleanup handles more than 4096 orphan bodies from lightweight sessions", async () => {
		const transfers = join(root, "transfers");
		await mkdir(transfers, { mode: 0o700 });
		for (let start = 0; start < 4097; start += 64)
			await Promise.all(
				Array.from({ length: Math.min(64, 4097 - start) }, () =>
					writeFile(join(transfers, `ed-${randomUUID()}`), "x"),
				),
			);
		await create();
		expect(await readdir(transfers)).toEqual([]);
	}, 15_000);
	test("source metadata has no body object and revalidates decoded CRLF text", async () => {
		const doc = await create();
		expect(doc.baseHash).toBe(hash("before\r\n中文🙂\r\n"));
		expect(doc.eol).toBe("CRLF");
		expect(await bodies()).toHaveLength(0);
		for (let i = 0; i < 2; i++)
			expect(
				await new Response(await service.content(actor, doc.docId, doc.versionHandle)).text(),
			).toBe("before\n中文🙂\n");
		await writeFile(target, "beforz\r\n中文🙂\r\n");
		await expect(service.content(actor, doc.docId, doc.versionHandle)).rejects.toMatchObject({
			code: "EDITOR_SOURCE_CHANGED",
			statusCode: 409,
		});
		expect(await bodies()).toHaveLength(0);
	});
	for (const change of ["revoked", "cwd"] as const) {
		test(`source content reauthorizes after waiting for IO when access is ${change}`, async () => {
			const doc = await create();
			const jobs = Reflect.get(service, "jobs") as EditorDocumentJobs;
			const entered = deferred();
			const resume = deferred();
			const original = jobs.run.bind(jobs);
			const run = spyOn(jobs, "run").mockImplementation(async (user, request, signal) => {
				if (request.action === "content") {
					entered.resolve();
					await resume.promise;
				}
				return original(user, request, signal);
			});
			const pending = service.content(actor, doc.docId, doc.versionHandle);
			try {
				await entered.promise;
				const authorize = actor.authorize.bind(actor);
				actor.authorize = async (input, need) => {
					if (change === "revoked")
						throw new EditorDocumentError("FORBIDDEN", "Access revoked", 403);
					return { ...(await authorize(input, need)), cwd: join(root, "different") };
				};
				resume.resolve();
				await expect(pending).rejects.toMatchObject({
					statusCode: 403,
					code: change === "revoked" ? "FORBIDDEN" : "EDITOR_IDENTITY_CHANGED",
				});
				expect(Reflect.get(jobs, "transfers")).toBe(0);
				expect(Reflect.get(jobs, "transferBytes")).toBe(0);
				const sessions = Reflect.get(service, "sessions") as Map<string, { pins: number }>;
				expect(sessions.get(doc.docId)?.pins).toBe(0);
			} finally {
				resume.resolve();
				await pending.catch(() => {});
				run.mockRestore();
			}
		});
	}
	for (const change of ["revision", "root"] as const)
		test(`queued commit rejects ${change} changes after its initial binding check with zero dispatch`, async () => {
			const workspace = join(root, "execution");
			await mkdir(workspace);
			target = join(workspace, "file.txt");
			const originalBytes = "same baseline\r\n";
			await writeFile(target, originalBytes);
			let revision = 1;
			actor.authorize = async () => {
				const stat = await lstat(workspace, { bigint: true });
				return {
					cwd: workspace,
					projectId: null,
					lexicalPath: target,
					canonicalPath: target,
					outsideRoots: false,
					contextKey: `revision-${revision}`,
					workspaceIdentity: `${stat.dev}:${stat.ino}`,
					pathFlavor: "posix",
				};
			};
			const doc = await create();
			const uploadId = await upload(doc, "must not write\n");
			const jobs = Reflect.get(service, "jobs") as EditorDocumentJobs;
			const entered = deferred();
			const resume = deferred();
			const queued = deferred();
			const holding = jobs.withIo(actor.userId, async () => {
				entered.resolve();
				await resume.promise;
			});
			await entered.promise;
			const withIo = jobs.withIo.bind(jobs);
			const admission = spyOn(jobs, "withIo").mockImplementation((user, body, signal) => {
				const result = withIo(user, body, signal);
				queued.resolve();
				return result;
			});
			const pending = service.commit(actor, doc.docId, uploadId, {}).catch((error) => error);
			try {
				await queued.promise;
				expect((Reflect.get(jobs, "queue") as unknown[]).length).toBe(1);
				if (change === "revision") revision++;
				else {
					await rename(workspace, `${workspace}-old`);
					await mkdir(workspace);
					await writeFile(target, originalBytes);
				}
				resume.resolve();
				await holding;
				expect(await pending).toMatchObject({ code: "EDITOR_IDENTITY_CHANGED", statusCode: 403 });
				expect(dispatches).toBe(0);
				expect(operations()).toHaveLength(0);
				expect(await readFile(target, "utf8")).toBe(originalBytes);
			} finally {
				resume.resolve();
				await holding;
				await pending;
				admission.mockRestore();
			}
		});
	test("content validates every metadata field, not only hash or byte length", async () => {
		const jobs = new EditorDocumentJobs();
		const opened = await jobs.run(actor.userId, { action: "metadata", sourcePath: target });
		if (opened.kind !== "source") throw new Error("Unexpected source result");
		const changes: Partial<EditorVersionMetadata>[] = [
			{ baseHash: hash("other") },
			{ encoding: "utf-16le" },
			{ eol: "LF" },
			{ sourceBytes: opened.metadata.sourceBytes + 1 },
			{ utf8Bytes: opened.metadata.utf8Bytes + 1 },
		];
		for (const change of changes)
			await expect(
				jobs.run(actor.userId, {
					action: "content",
					sourcePath: target,
					metadata: { ...opened.metadata, ...change },
				}),
			).rejects.toMatchObject({ code: "EDITOR_SOURCE_CHANGED", statusCode: 409 });
	});
	for (const change of ["encoding", "eol", "deleted", "symlink"] as const) {
		test(`source content rejects ${change} changes after metadata capture`, async () => {
			const doc = await create();
			if (change === "encoding")
				await writeFile(target, iconv.encode("before\r\n中文🙂\r\n", "utf-16le"));
			if (change === "eol") await writeFile(target, "before\n中文🙂\n");
			if (change === "deleted" || change === "symlink") await unlink(target);
			if (change === "symlink") {
				const replacement = join(root, "replacement");
				await writeFile(replacement, "before\r\n中文🙂\r\n");
				await symlink(replacement, target);
			}
			await expect(service.content(actor, doc.docId, doc.versionHandle)).rejects.toThrow();
			expect(await bodies()).toHaveLength(0);
			await service.remove(actor, doc.docId);
		});
	}
	test("source stream pulls 64 KiB and holds its pin until EOF, abort or cancel", async () => {
		await writeFile(target, "x".repeat(150_000));
		const doc = await create();
		const controller = new AbortController();
		const stream = await service.content(actor, doc.docId, doc.versionHandle, controller.signal);
		const reader = stream.getReader();
		const first = await reader.read();
		expect(first.value?.byteLength).toBe(64 * 1024);
		expect(await service.remove(actor, doc.docId)).toEqual({ status: "released" });
		expect((Reflect.get(service, "sessions") as Map<string, unknown>).size).toBe(0);
		expect(Reflect.get(Reflect.get(service, "jobs"), "transfers")).toBe(0);
		controller.abort();
		await expect(reader.read()).rejects.toThrow("cancelled");
		await service.sweep(Date.now() + EDITOR_SESSION_IDLE_MS + 1);
		expect((Reflect.get(service, "sessions") as Map<string, unknown>).size).toBe(0);
		const reopened = await create();
		const cancelled = await service.content(actor, reopened.docId, reopened.versionHandle);
		await cancelled.cancel();
		await cancelled.cancel();
		expect(
			await new Response(
				await service.content(actor, reopened.docId, reopened.versionHandle),
			).text(),
		).toBe("x".repeat(150_000));
	});
	test("worker content failure releases source admission and session pin", async () => {
		const doc = await create();
		await writeFile(target, "changed");
		for (let i = 0; i < 10; i++)
			await expect(service.content(actor, doc.docId, doc.versionHandle)).rejects.toMatchObject({
				code: "EDITOR_SOURCE_CHANGED",
			});
		const jobs = Reflect.get(service, "jobs") as EditorDocumentJobs;
		expect(Reflect.get(jobs, "transfers")).toBe(0);
		expect(Reflect.get(jobs, "transferBytes")).toBe(0);
		await service.remove(actor, doc.docId);
		expect((Reflect.get(service, "sessions") as Map<string, unknown>).size).toBe(0);
	});
	test("dispose cancels unconsumed source streams and returns their permit", async () => {
		const doc = await create();
		const stream = await service.content(actor, doc.docId, doc.versionHandle);
		await service.dispose();
		await expect(new Response(stream).text()).rejects.toThrow("cancelled");
		const jobs = Reflect.get(service, "jobs") as EditorDocumentJobs;
		expect(Reflect.get(jobs, "transfers")).toBe(0);
		expect(Reflect.get(jobs, "transferBytes")).toBe(0);
		expect((Reflect.get(service, "sessions") as Map<string, unknown>).size).toBe(0);
	});
	test("unread source response expires and releases memory, pins and permits", async () => {
		const jobs = new EditorDocumentJobs();
		const metadata: EditorVersionMetadata = {
			baseHash: hash("x"),
			encoding: "utf-8",
			eol: "LF",
			sourceBytes: 1,
			utf8Bytes: 1,
		};
		const run = spyOn(jobs, "run").mockImplementation(
			async (_user, request): Promise<EditorWorkerResult> => {
				if (request.action === "cleanup") return { kind: "cleaned", operations: [] };
				if (request.action === "metadata") return { kind: "source", metadata };
				if (request.action === "content") return { kind: "content", bytes: new Uint8Array([120]) };
				throw new Error("Unexpected action");
			},
		);
		await service.dispose();
		service = new EditorDocumentService({
			root: join(root, "transfers"),
			jobs,
			execute: (request) => runtime.executeEditor(request),
		});
		const doc = await create();
		let deadline!: () => void;
		const original = globalThis.setTimeout;
		const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
			delay?: number,
		) => {
			if (delay === 30_000) {
				deadline = callback;
				return original(() => {}, 60_000);
			}
			return original(callback, delay);
		}) as typeof setTimeout);
		try {
			const stream = await service.content(actor, doc.docId, doc.versionHandle);
			expect(timers).toHaveBeenCalled();
			deadline();
			await expect(new Response(stream).text()).rejects.toThrow("timed out");
			await service.remove(actor, doc.docId);
			expect(Reflect.get(jobs, "transfers")).toBe(0);
			expect(Reflect.get(jobs, "transferBytes")).toBe(0);
			expect((Reflect.get(service, "sessions") as Map<string, unknown>).size).toBe(0);
		} finally {
			timers.mockRestore();
			run.mockRestore();
		}
	});
	const signatures = [
		["utf-8", Buffer.from([0xef, 0xbb, 0xbf])],
		["utf-16le", Buffer.from([0xff, 0xfe])],
		["utf-16be", Buffer.from([0xfe, 0xff])],
	] as const;
	for (const [encoding, bom] of [["utf-8", Buffer.alloc(0)], ...signatures] as const) {
		test(`${encoding} saves preserve the original BOM choice (${bom.byteLength})`, async () => {
			await writeFile(target, Buffer.concat([bom, iconv.encode("before\r\n", encoding)]));
			const doc = await create();
			expect(doc.encoding).toBe(encoding);
			expect(doc.baseHash).toBe(hash("before\r\n"));
			let baseHash = doc.baseHash;
			for (const [input, output] of [
				["after\n", "after\r\n"],
				["again\n\uFEFFbody\n", "again\r\n\uFEFFbody\r\n"],
			]) {
				const id = await upload(doc, input, baseHash);
				const saved = await service.commit(actor, doc.docId, id, {});
				const expected = Buffer.concat([bom, iconv.encode(output, encoding)]);
				expect(await readFile(target)).toEqual(expected);
				expect(saved).toMatchObject({
					status: "saved",
					hash: hash(output),
					bytes: expected.byteLength,
				});
				if (saved.status !== "saved") throw new Error("Expected settled save");
				expect(await service.commit(actor, doc.docId, id, {})).toEqual(saved);
				expect(
					JSON.parse(
						await readFile(join(root, "transfers", `ed-${saved.operationId}.json`), "utf8"),
					),
				).toMatchObject({
					hash: hash(output),
					rawDigest: createHash("sha256").update(expected).digest("hex"),
					bytes: expected.byteLength,
				});
				baseHash = saved.hash;
			}
			expect(dispatches).toBe(2);
		});
	}
	for (const [encoding, bom] of signatures) {
		test(`${encoding} BOM is retained when saving an empty document`, async () => {
			await writeFile(target, Buffer.concat([bom, iconv.encode("before\r\n", encoding)]));
			const doc = await create();
			const id = await upload(doc, "");
			const saved = await service.commit(actor, doc.docId, id, {});
			expect(await readFile(target)).toEqual(bom);
			expect(saved).toMatchObject({ status: "saved", hash: hash(""), bytes: bom.byteLength });
		});
		test(`${encoding} saves do not restore a deleted file's BOM`, async () => {
			await writeFile(target, Buffer.concat([bom, iconv.encode("before\r\n", encoding)]));
			const doc = await create();
			await unlink(target);
			const id = await upload(doc, "after\n", null);
			const saved = await service.commit(actor, doc.docId, id, {});
			const expected = Buffer.from(iconv.encode("after\n", encoding));
			expect(await readFile(target)).toEqual(expected);
			expect(saved).toMatchObject({
				status: "saved",
				hash: hash("after\n"),
				bytes: expected.byteLength,
			});
		});
		test(`${encoding} BOM counts toward the final 20 MiB limit`, async () => {
			await writeFile(target, Buffer.concat([bom, iconv.encode("before", encoding)]));
			const doc = await create();
			const text = "a".repeat(
				(EDITOR_FILE_MAX_BYTES - bom.byteLength) / iconv.encode("a", encoding).byteLength,
			);
			const id = await upload(doc, text);
			const saved = await service.commit(actor, doc.docId, id, {});
			const before = await readFile(target);
			expect(before.byteLength).toBe(EDITOR_FILE_MAX_BYTES);
			expect(before.subarray(0, bom.byteLength)).toEqual(bom);
			expect(iconv.decode(before.subarray(bom.byteLength), encoding)).toBe(text);
			expect(saved).toMatchObject({
				status: "saved",
				hash: hash(text),
				bytes: EDITOR_FILE_MAX_BYTES,
			});
			if (saved.status !== "saved") throw new Error("Expected settled save");
			const oversized = await upload(doc, `${text}a`, saved.hash);
			const error = await failure(() => service.commit(actor, doc.docId, oversized, {}));
			expect(error.message).toContain("20 MiB");
			expect(dispatches).toBe(1);
			expect(operations()).toHaveLength(1);
			expect((await readFile(target)).equals(before)).toBe(true);
		}, 30_000);
	}
	test("worker does not infer a signature from a mismatched or generic encoding", async () => {
		const jobs = new EditorDocumentJobs();
		const uploadPath = join(root, "encoding-controls");
		await writeFile(uploadPath, "after\n");
		for (const [encoding, before] of [
			["utf-8", Buffer.from([0xff, 0xfe])],
			["utf-16le", Buffer.from([0xef, 0xbb, 0xbf, 0x01])],
			["utf-16be", Buffer.from([0xff, 0xfe])],
			["utf-16", Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode("before\n", "utf-16be")])],
		] as const) {
			const result = await jobs.run(actor.userId, {
				action: "prepare",
				before,
				uploadPath,
				conflictPath: join(root, `encoding-control-${encoding}`),
				baseHash: hash(iconv.decode(before, encoding)),
				encoding,
				digest: hash("after\n"),
			});
			expect(result.kind).toBe("prepared");
			if (result.kind !== "prepared") throw new Error("Expected preparation");
			expect(Buffer.from(result.nextBytes)).toEqual(Buffer.from(iconv.encode("after\n", encoding)));
			expect(result.hash).toBe(hash("after\n"));
		}
	});
	test("worker preserves leading U+FEFF content separately from a file's BOM", async () => {
		const jobs = new EditorDocumentJobs();
		const uploadPath = join(root, "leading-content-bom");
		await writeFile(uploadPath, "\uFEFF\uFEFFafter\n");
		for (const [encoding, bom] of signatures) {
			const result = await jobs.run(actor.userId, {
				action: "prepare",
				before: Buffer.concat([bom, iconv.encode("before\n", encoding)]),
				uploadPath,
				conflictPath: join(root, `leading-content-${encoding}`),
				baseHash: hash("before\n"),
				encoding,
				digest: hash("\uFEFF\uFEFFafter\n"),
			});
			expect(result.kind).toBe("prepared");
			if (result.kind !== "prepared") throw new Error("Expected preparation");
			expect(Buffer.from(result.nextBytes)).toEqual(
				Buffer.concat([bom, iconv.encode("\uFEFFafter\n", encoding)]),
			);
			expect(result.hash).toBe(hash("\uFEFFafter\n"));
		}
	});
	test("sealed PUT cannot overwrite, commit is idempotent and writes durable human evidence", async () => {
		const doc = await create(),
			id = await upload(doc, "after\n中文🙂\n");
		expect(
			(await failure(() => service.put(actor, doc.docId, id, new Response("evil").body, 4))).code,
		).toBe("EDITOR_INVALID_STATE");
		const result = await service.commit(actor, doc.docId, id, {});
		expect(result).toMatchObject({
			status: "saved",
			hash: hash("after\r\n中文🙂\r\n"),
			snapshotRevision: 7,
		});
		expect(await service.commit(actor, doc.docId, id, {})).toEqual(result);
		expect(dispatches).toBe(1);
		expect(await readFile(target, "utf8")).toBe("after\r\n中文🙂\r\n");
		expect(operations()).toHaveLength(1);
		expect(operations()[0]).toMatchObject({
			sourceKind: "editor",
			sourceId: result.operationId,
			actorSubjectKey: `user:${actor.userId}`,
			settlement: "settled",
			executionOutcome: "succeeded",
		});
		expect((await service.operation(actor, result.operationId)).status).toBe("saved");
		expect((await bodies()).length).toBe(0);
	});
	test("corrupt existing blob retries editor preparation and saves exactly once", async () => {
		await service.dispose();
		// Keep the database's existing instance identity when running after other saves.
		const privateRoot = testEnvironment.narraforkHome;
		const namespace = await runtime.initialize();
		const before = await readFile(target);
		const blob = await namespace.store.putBytes(before, { expectedSize: before.byteLength });
		await writeFile(
			join(privateRoot, "file-change-blobs", "sha256", blob.digest.slice(0, 2), blob.digest),
			"corrupt",
		);
		let preparations = 0;
		let recoveryBody: string | undefined;
		service = new EditorDocumentService({
			root: join(root, "transfers"),
			execute: (request) =>
				runtime.executeEditor({
					...request,
					construct: async (observation) => {
						preparations++;
						const prepared = await request.construct(observation);
						const body = await readFile(
							join(root, "transfers", `ed-${request.requestId}.json`),
							"utf8",
						);
						if (recoveryBody !== undefined) expect(body).toBe(recoveryBody);
						recoveryBody = body;
						return prepared;
					},
				}),
		});
		const doc = await create();
		const id = await upload(doc, "after\n中文🙂\n");
		const saved = await service.commit(actor, doc.docId, id, {});
		expect(saved).toMatchObject({
			status: "saved",
			hash: hash("after\r\n中文🙂\r\n"),
			snapshotRevision: 7,
		});
		expect(preparations).toBe(2);
		expect(dispatches).toBe(1);
		expect(await readFile(target, "utf8")).toBe("after\r\n中文🙂\r\n");
		expect(operations()).toHaveLength(1);
		expect(operations()[0]).toMatchObject({
			sourceId: saved.operationId,
			settlement: "settled",
			executionOutcome: "succeeded",
		});
		expect(await service.commit(actor, doc.docId, id, {})).toEqual(saved);
		expect(dispatches).toBe(1);
		expect(await bodies()).toHaveLength(0);
	});
	test("different recovery content prevents editor dispatch and is never overwritten", async () => {
		const doc = await create();
		const id = await upload(doc, "mine");
		const { operationId } = await service.uploadStatus(actor, doc.docId, id);
		const path = join(root, "transfers", `ed-${operationId}.json`);
		const original = JSON.stringify({
			version: 1,
			operationId,
			userId: actor.userId,
			narratorId: actor.narratorId,
			snapshotRevision: 7,
			hash: hash("else"),
			rawDigest: hash("else"),
			bytes: 4,
			createdAt: Date.now(),
		});
		await writeFile(path, original);
		const error = await failure(() => service.commit(actor, doc.docId, id, {}));
		expect(error.message).toContain("Recovery metadata does not match this preparation");
		expect(dispatches).toBe(0);
		expect(operations()).toHaveLength(0);
		expect(await readFile(target, "utf8")).toBe("before\r\n中文🙂\r\n");
		expect(await readFile(path, "utf8")).toBe(original);
		expect(await bodies()).toHaveLength(0);
	});
	test("worker reuses only identical recovery content and preserves its original timestamp", async () => {
		const jobs = new EditorDocumentJobs();
		const operationId = randomUUID();
		const path = join(root, `ed-${operationId}.json`);
		const uploadPath = join(root, "uploaded");
		await writeFile(uploadPath, "same");
		const request: Extract<EditorWorkerRequest, { action: "prepare" }> = {
			action: "prepare",
			before: null,
			baseHash: null,
			encoding: "utf-8",
			digest: hash("same"),
			uploadPath,
			conflictPath: join(root, "conflict"),
			recovery: {
				path,
				operationId,
				userId: actor.userId,
				narratorId: actor.narratorId,
				snapshotRevision: 7,
			},
		};
		const first = await jobs.run(actor.userId, request);
		expect(first.kind).toBe("prepared");
		const original = await readFile(path, "utf8");
		expect(await jobs.run(actor.userId, request)).toEqual(first);
		expect(await readFile(path, "utf8")).toBe(original);
		await writeFile(uploadPath, "different");
		await expect(jobs.run(actor.userId, { ...request, digest: hash("different") })).rejects.toThrow(
			"Recovery metadata does not match this preparation",
		);
		expect(await readFile(path, "utf8")).toBe(original);
		expect(await Bun.file(join(root, `ed-${operationId}`)).exists()).toBe(false);
	});
	test("worker refuses recovery records with mismatched identity, revision or content fields", async () => {
		const jobs = new EditorDocumentJobs();
		const operationId = randomUUID();
		const path = join(root, `ed-${operationId}.json`);
		const uploadPath = join(root, "uploaded");
		await writeFile(uploadPath, "same");
		const request: Extract<EditorWorkerRequest, { action: "prepare" }> = {
			action: "prepare",
			before: null,
			baseHash: null,
			encoding: "utf-8",
			digest: hash("same"),
			uploadPath,
			conflictPath: join(root, "conflict"),
			recovery: {
				path,
				operationId,
				userId: actor.userId,
				narratorId: actor.narratorId,
				snapshotRevision: 7,
			},
		};
		await jobs.run(actor.userId, request);
		const metadata = JSON.parse(await readFile(path, "utf8"));
		for (const mismatch of [
			{ operationId: randomUUID() },
			{ userId: "other-user" },
			{ narratorId: "other-narrator" },
			{ snapshotRevision: 8 },
			{ hash: hash("other") },
			{ rawDigest: hash("other") },
			{ bytes: 5 },
		]) {
			const body = JSON.stringify({ ...metadata, ...mismatch });
			await writeFile(path, body);
			await expect(jobs.run(actor.userId, request)).rejects.toThrow(
				"Recovery metadata does not match this preparation",
			);
			expect(await readFile(path, "utf8")).toBe(body);
			expect(await Bun.file(join(root, `ed-${operationId}`)).exists()).toBe(false);
		}
	});
	test("confirmation does not consume sealed upload or create a durable operation", async () => {
		outside = true;
		const doc = await create(),
			id = await upload(doc, "confirmed");
		const error = await failure(() => service.commit(actor, doc.docId, id, {}));
		expect(error.code).toBe("NEEDS_CONFIRMATION");
		expect(operations()).toHaveLength(0);
		expect(dispatches).toBe(0);
		const saved = await service.commit(actor, doc.docId, id, {
			confirmationToken: error.data.confirmationToken as string,
		});
		expect(saved.status).toBe("saved");
		expect(dispatches).toBe(1);
	});
	test("conflict captures the locked before version, never today's path contents", async () => {
		const doc = await create(),
			id = await upload(doc, "mine");
		await writeFile(target, "first external\r\n");
		const error = await failure(() => service.commit(actor, doc.docId, id, {}));
		expect(error.code).toBe("STALE_WRITE");
		expect(error.data.currentHash).toBe(hash("first external\r\n"));
		await writeFile(target, "second external");
		expect(
			await new Response(
				await service.content(actor, doc.docId, error.data.conflictVersionHandle as string),
			).text(),
		).toBe("first external\n");
		expect((await failure(() => service.commit(actor, doc.docId, id, {}))).data).toEqual(
			error.data,
		);
		expect(dispatches).toBe(0);
		expect(operations()).toHaveLength(0);
	});
	test("external deletion produces null lock and immutable empty conflict", async () => {
		const doc = await create(),
			id = await upload(doc, "mine");
		await unlink(target);
		const error = await failure(() => service.commit(actor, doc.docId, id, {}));
		expect(error.data.currentHash).toBeNull();
		const retry = await upload(doc, "mine", null);
		expect((await service.commit(actor, doc.docId, retry, {})).status).toBe("saved");
		expect(await readFile(target)).toEqual(Buffer.from("mine"));
	});
	test("concurrent duplicate commit gets the same operation and DELETE pins dispatched data", async () => {
		const entered = deferred(),
			release = deferred();
		io.apply = async (input) => {
			dispatches++;
			entered.resolve();
			await release.promise;
			return fileChangeLocalIo.apply(input);
		};
		const doc = await create(),
			id = await upload(doc, "after");
		const pending = service.commit(actor, doc.docId, id, {});
		await entered.promise;
		const repeated = await service.commit(actor, doc.docId, id, {});
		expect(repeated.status).toBe("committing");
		expect(await service.remove(actor, doc.docId)).toEqual({ status: "committing" });
		expect((await bodies()).length).toBe(1);
		release.resolve();
		const saved = await pending;
		expect(saved.operationId).toBe(repeated.operationId);
		expect(dispatches).toBe(1);
		expect(await bodies()).toHaveLength(0);
	});
	test("truncated and invalid UTF-8 uploads cannot become sealed", async () => {
		const doc = await create();
		const make = () =>
			service.createUpload(actor, doc.docId, {
				baseHash: doc.baseHash,
				encoding: doc.encoding,
				snapshotRevision: 1,
			});
		const a = await make();
		await expect(
			service.put(actor, doc.docId, a.uploadId, new Response("short").body, 10),
		).rejects.toThrow("truncated");
		const b = await make();
		await expect(
			service.put(
				actor,
				doc.docId,
				b.uploadId,
				new Response(new Uint8Array([255])).body,
				undefined,
			),
		).rejects.toThrow();
		expect(await bodies()).toHaveLength(0);
		expect(dispatches).toBe(0);
	});
	test("same baseHash saves do not overwrite a previously saved version", async () => {
		const doc = await create(),
			second = await create();
		const a = await upload(doc, "one"),
			b = await upload(second, "two");
		await service.commit(actor, doc.docId, a, {});
		expect((await failure(() => service.commit(actor, second.docId, b, {}))).code).toBe(
			"STALE_WRITE",
		);
		expect(dispatches).toBe(1);
		expect(await readFile(target, "utf8")).toBe("one");
	});
	test("session binding rejects wrong user/narrator and expires without changing the file", async () => {
		const doc = await create();
		await expect(
			service.content({ ...actor, userId: "other" }, doc.docId, doc.versionHandle),
		).rejects.toThrow("expired");
		await expect(
			service.content({ ...actor, narratorId: "other" }, doc.docId, doc.versionHandle),
		).rejects.toThrow("expired");
		await service.sweep(Date.now() + EDITOR_SESSION_IDLE_MS + 1);
		expect(
			(await failure(() => service.content(actor, doc.docId, doc.versionHandle))).statusCode,
		).toBe(410);
		expect(await bodies()).toHaveLength(0);
	});
	test("failed metadata creation rolls back incremental session accounting", async () => {
		await unlink(target);
		await expect(create()).rejects.toThrow();
		expect((Reflect.get(service, "sessions") as Map<string, unknown>).size).toBe(0);
		expect((Reflect.get(service, "userSessions") as Map<string, number>).size).toBe(0);
		expect(Reflect.get(service, "totalBytes")).toBe(0);
		await writeFile(target, "valid");
		const doc = await create();
		await service.remove(actor, doc.docId);
		expect((Reflect.get(service, "userSessions") as Map<string, number>).size).toBe(0);
	});
	test("receipt ownership survives session release and expires exactly once", async () => {
		const doc = await create();
		const id = await upload(doc, "mine");
		await service.commit(actor, doc.docId, id, {});
		await service.remove(actor, doc.docId);
		expect(Reflect.get(service, "totalBytes")).toBe(EDITOR_METADATA_MAX_BYTES);
		expect((Reflect.get(service, "userOperations") as Map<string, number>).get(actor.userId)).toBe(
			1,
		);
		const now = Date.now() + EDITOR_SESSION_IDLE_MS + 1;
		await service.sweep(now);
		await service.sweep(now);
		expect(Reflect.get(service, "totalBytes")).toBe(0);
		expect((Reflect.get(service, "userBytes") as Map<string, number>).size).toBe(0);
		expect((Reflect.get(service, "userOperations") as Map<string, number>).size).toBe(0);
	});
	test("sweep is single-flight and yields between lightweight session batches", async () => {
		const jobs = new EditorDocumentJobs();
		const metadata: EditorVersionMetadata = {
			baseHash: hash("x"),
			encoding: "utf-8",
			eol: "LF",
			sourceBytes: 1,
			utf8Bytes: 1,
		};
		const run = spyOn(jobs, "run").mockImplementation(
			async (_user, request): Promise<EditorWorkerResult> => {
				if (request.action === "cleanup") return { kind: "cleaned", operations: [] };
				if (request.action === "metadata") return { kind: "source", metadata };
				throw new Error("Unexpected action");
			},
		);
		await service.dispose();
		service = new EditorDocumentService({
			root: join(root, "transfers"),
			jobs,
			execute: (request) => runtime.executeEditor(request),
		});
		try {
			for (let i = 0; i < 130; i++) await create();
			let yielded = false;
			setImmediate(() => {
				yielded = true;
			});
			const sweep = service.sweep(Date.now() + EDITOR_SESSION_IDLE_MS + 1);
			expect(service.sweep()).toBe(sweep);
			await sweep;
			expect(yielded).toBe(true);
			expect((Reflect.get(service, "sessions") as Map<string, unknown>).size).toBe(0);
			expect((Reflect.get(service, "userSessions") as Map<string, number>).size).toBe(0);
		} finally {
			run.mockRestore();
		}
	});
	test("source sessions consume no disk reservation; upload quota remains bounded", async () => {
		const docs: EditorDocumentDescriptor[] = [];
		for (let i = 0; i < 9; i++) docs.push(await create());
		for (const doc of docs.slice(0, 8))
			await service.createUpload(actor, doc.docId, {
				baseHash: doc.baseHash,
				encoding: doc.encoding,
				snapshotRevision: 1,
			});
		expect(
			(
				await failure(() =>
					service.createUpload(actor, docs[8].docId, {
						baseHash: docs[8].baseHash,
						encoding: docs[8].encoding,
						snapshotRevision: 1,
					}),
				)
			).code,
		).toBe("EDITOR_QUOTA_EXCEEDED");
		expect(await bodies()).toHaveLength(0);
	});
	test("worker accepts exactly 20 MiB and rejects source +1 byte and symlinks", async () => {
		const jobs = new EditorDocumentJobs();
		await writeFile(target, new Uint8Array(EDITOR_FILE_MAX_BYTES).fill(97));
		const result = await jobs.run(actor.userId, {
			action: "metadata",
			sourcePath: target,
		});
		expect(result.kind).toBe("source");
		await writeFile(target, new Uint8Array(EDITOR_FILE_MAX_BYTES + 1).fill(97));
		await expect(
			jobs.run(actor.userId, {
				action: "metadata",
				sourcePath: target,
			}),
		).rejects.toThrow("budget");
		const link = join(root, "link");
		await symlink(target, link);
		await expect(
			jobs.run(actor.userId, {
				action: "metadata",
				sourcePath: link,
			}),
		).rejects.toThrow("Symbolic");
	}, 30_000);
	test("UTF-16 source and GBK conversion preserve decoded hash and original EOL", async () => {
		const jobs = new EditorDocumentJobs();
		for (const encoding of ["utf-16le", "utf-16be", "gbk"]) {
			const previous = "中文测试\r\n正文\r\n";
			const bytes = iconv.encode(previous, encoding);
			const uploaded = Buffer.from("修改\n正文\n");
			const path = join(root, `upload-${encoding}`);
			await writeFile(path, uploaded);
			const result = await jobs.run(actor.userId, {
				action: "prepare",
				before: bytes,
				uploadPath: path,
				conflictPath: join(root, `conflict-${encoding}`),
				encoding,
				baseHash: hash(previous),
				digest: hash(uploaded.toString()),
			});
			expect(result.kind).toBe("prepared");
			if (result.kind === "prepared") {
				expect(iconv.decode(Buffer.from(result.nextBytes), encoding)).toBe("修改\r\n正文\r\n");
				expect(result.hash).toBe(hash("修改\r\n正文\r\n"));
				expect(Buffer.from(result.nextBytes)).toEqual(
					Buffer.from(iconv.encode("修改\r\n正文\r\n", encoding)),
				);
			}
		}
		await writeFile(
			target,
			Buffer.concat([Buffer.from([255, 254]), iconv.encode("中文\r\n", "utf-16le")]),
		);
		expect((await create()).encoding).toBe("utf-16le");
	});
	test("restart recovery combines bounded metadata with the real settled receipt", async () => {
		const doc = await create(),
			id = await upload(doc, "persisted\n");
		const saved = await service.commit(actor, doc.docId, id, {});
		if (saved.status !== "saved") throw new Error("Expected settled save");
		await service.dispose();
		service = new EditorDocumentService({
			root: join(root, "transfers"),
			execute: (request) => runtime.executeEditor(request),
			queryOperation: queryEditorOperation,
		});
		expect(await service.operation(actor, saved.operationId)).toEqual({
			status: "saved",
			operationId: saved.operationId,
			result: saved,
		});
		await expect(
			service.operation({ ...actor, userId: "other" }, saved.operationId),
		).rejects.toThrow("owned durable receipt");
		await service.dispose();
		await unlink(join(root, "transfers", `ed-${saved.operationId}.json`));
		service = new EditorDocumentService({
			root: join(root, "transfers"),
			execute: (request) => runtime.executeEditor(request),
			queryOperation: queryEditorOperation,
		});
		expect((await service.operation(actor, saved.operationId)).status).toBe("uncertain");
	});
	test("slow conflict download prevents replacement and preserves the sealed retry", async () => {
		const doc = await create(),
			id = await upload(doc, "mine");
		await writeFile(target, "external one");
		const conflict = await failure(() => service.commit(actor, doc.docId, id, {}));
		const stream = await service.content(
			actor,
			doc.docId,
			conflict.data.conflictVersionHandle as string,
		);
		const retry = await upload(doc, "mine", conflict.data.currentHash as string);
		await writeFile(target, "external two");
		expect((await failure(() => service.commit(actor, doc.docId, retry, {}))).message).toContain(
			"download",
		);
		expect((await service.uploadStatus(actor, doc.docId, retry)).state).toBe("sealed");
		expect(await bodies()).toHaveLength(2);
		await stream.cancel();
		expect((await failure(() => service.commit(actor, doc.docId, retry, {}))).code).toBe(
			"STALE_WRITE",
		);
		expect(await bodies()).toHaveLength(1);
	});
	test("remove cancels an unread conflict stream and frees FD, readers and permit", async () => {
		const doc = await create();
		const id = await upload(doc, "mine");
		await writeFile(target, "external");
		const stale = await failure(() => service.commit(actor, doc.docId, id, {}));
		const stream = await service.content(
			actor,
			doc.docId,
			stale.data.conflictVersionHandle as string,
		);
		const jobs = Reflect.get(service, "jobs") as EditorDocumentJobs;
		expect(Reflect.get(jobs, "transfers")).toBe(1);
		expect(Reflect.get(jobs, "transferBytes")).toBe(64 * 1024);
		await service.remove(actor, doc.docId);
		await expect(new Response(stream).text()).rejects.toThrow("cancelled");
		expect(Reflect.get(jobs, "transfers")).toBe(0);
		expect(Reflect.get(jobs, "transferBytes")).toBe(0);
		expect((Reflect.get(service, "sessions") as Map<string, unknown>).size).toBe(0);
		expect(await bodies()).toHaveLength(0);
	});
	test("new downloads cannot enter the old version while its unlink is pending", async () => {
		const doc = await create(),
			id = await upload(doc, "mine");
		await writeFile(target, "external one");
		const first = await failure(() => service.commit(actor, doc.docId, id, {}));
		const retry = await upload(doc, "mine", first.data.currentHash as string);
		await writeFile(target, "external two");
		const entered = deferred(),
			resume = deferred();
		let oldPath = "";
		unlinkVersion = async (path) => {
			oldPath = path;
			entered.resolve();
			await resume.promise;
			await unlink(path);
		};
		const reserved = () =>
			(Reflect.get(service, "sessions") as ReadonlyMap<string, { reserved: number }>).get(doc.docId)
				?.reserved ?? 0;
		const before = reserved();
		const pending = failure(() => service.commit(actor, doc.docId, retry, {}));
		await Promise.race([
			entered.promise,
			pending.then((error) => {
				throw error;
			}),
		]);
		try {
			const rejected = await service
				.content(actor, doc.docId, first.data.conflictVersionHandle as string)
				.then(
					async (stream) => {
						await stream.cancel();
						return null;
					},
					(error: unknown) => error,
				);
			expect(rejected).toBeInstanceOf(EditorDocumentError);
			expect((rejected as EditorDocumentError).code).toBe("EDITOR_VERSION_RETIRED");
			expect(await readFile(oldPath, "utf8")).toBe("external one");
			expect(reserved()).toBe(before + EDITOR_TRANSFER_MAX_BYTES);
		} finally {
			resume.resolve();
			await pending; // A failing assertion must still drain the in-flight commit before cleanup.
		}
		const second = await pending;
		expect(second.code).toBe("STALE_WRITE");
		expect(
			await new Response(
				await service.content(actor, doc.docId, second.data.conflictVersionHandle as string),
			).text(),
		).toBe("external two");
		expect(reserved()).toBe(Buffer.byteLength("external two"));
		expect(dispatches).toBe(0);
	}, 30_000);
	test("failed conflict unlink stays retired and charged until a later successful removal", async () => {
		const doc = await create(),
			id = await upload(doc, "mine");
		await writeFile(target, "external one");
		const first = await failure(() => service.commit(actor, doc.docId, id, {}));
		const retry = await upload(doc, "mine", first.data.currentHash as string);
		await writeFile(target, "external two");
		let oldPath = "";
		unlinkVersion = async (path) => {
			oldPath = path;
			throw new Error("Injected unlink failure");
		};
		const rejected = await failure(() => service.commit(actor, doc.docId, retry, {}));
		expect(rejected.code).toBe("EDITOR_VERSION_CLEANUP_FAILED");
		expect(
			(
				await failure(() =>
					service.content(actor, doc.docId, first.data.conflictVersionHandle as string),
				)
			).code,
		).toBe("EDITOR_VERSION_RETIRED");
		expect(await readFile(oldPath, "utf8")).toBe("external one");
		const reserved = () =>
			(Reflect.get(service, "sessions") as ReadonlyMap<string, { reserved: number }>).get(doc.docId)
				?.reserved ?? 0;
		expect(reserved()).toBe(Buffer.byteLength("external one"));
		unlinkVersion = unlink;
		const next = await upload(doc, "mine", first.data.currentHash as string);
		const second = await failure(() => service.commit(actor, doc.docId, next, {}));
		expect(second.code).toBe("STALE_WRITE");
		expect(reserved()).toBe(Buffer.byteLength("external two"));
		expect(dispatches).toBe(0);
	}, 30_000);
	test("GBK cannot silently replace an inserted emoji", async () => {
		const previous = "中文测试文件正文\r\n".repeat(50);
		await writeFile(target, iconv.encode(previous, "gbk"));
		const doc = await create();
		expect(["gbk", "gb18030"]).toContain(doc.encoding);
		// GB18030 represents emoji; select GBK explicitly in the worker test below.
		const jobs = new EditorDocumentJobs(),
			uploadPath = join(root, "lossy-upload");
		const content = "中文🙂\n";
		await writeFile(uploadPath, content);
		await expect(
			jobs.run(actor.userId, {
				action: "prepare",
				before: iconv.encode(previous, "gbk"),
				uploadPath,
				conflictPath: join(root, "lossy-conflict"),
				encoding: "gbk",
				baseHash: hash(previous),
				digest: hash(content),
			}),
		).rejects.toThrow("losslessly");
		expect((await readFile(target)).equals(iconv.encode(previous, "gbk"))).toBe(true);
		expect(operations()).toHaveLength(0);
	});
	test("20 MiB real source/upload/commit records event-loop responsiveness", async () => {
		await writeFile(target, Buffer.alloc(EDITOR_FILE_MAX_BYTES, 97));
		const samples: number[] = [];
		let last = performance.now();
		const timer = setInterval(() => {
			const now = performance.now();
			samples.push(now - last);
			last = now;
		}, 5);
		const started = performance.now();
		try {
			const doc = await create();
			const sourceMs = performance.now() - started;
			const stream = await service.content(actor, doc.docId, doc.versionHandle);
			const reader = stream.getReader();
			let received = 0;
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				received += part.value.byteLength;
			}
			expect(received).toBe(EDITOR_FILE_MAX_BYTES);
			const id = await upload(doc, "b".repeat(EDITOR_FILE_MAX_BYTES));
			const result = await service.commit(actor, doc.docId, id, {});
			expect(result).toMatchObject({ status: "saved", bytes: EDITOR_FILE_MAX_BYTES });
			expect((await readFile(target)).length).toBe(EDITOR_FILE_MAX_BYTES);
			console.info(
				"EDITOR_20MIB_RESPONSIVENESS",
				JSON.stringify({
					sourceMs: Math.round(sourceMs),
					totalMs: Math.round(performance.now() - started),
					samples: samples.length,
					maxIntervalMs: Math.round(Math.max(...samples)),
					p95IntervalMs: Math.round(
						[...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] ?? 0,
					),
				}),
			);
			expect(samples.length).toBeGreaterThan(10);
		} finally {
			clearInterval(timer);
		}
	}, 60_000);
	test("compiled workers probe JavaScript build-root candidates; dev keeps TypeScript", () => {
		expect(editorWorkerSpecifierCandidates(true, "file:///$bunfs/root/narrafork")).toEqual([
			"file:///$bunfs/root/services/editor-document-worker.js",
			"file:///$bunfs/root/server/services/editor-document-worker.js",
			"file:///$bunfs/root/editor-document-worker.js",
		]);
		expect(
			editorWorkerSpecifierCandidates(
				false,
				"file:///workspace/server/services/editor-document-jobs.ts",
			),
		).toEqual(["file:///workspace/server/services/editor-document-worker.ts"]);
	});
	test("Windows compiled workers keep forward-slash virtual paths at the Worker boundary", () => {
		for (const root of ["file:///B:/~BUN/root/", "file:///B:/%7EBUN/root/"]) {
			const candidates = editorWorkerSpecifierCandidates(true, `${root}narrafork.exe`);
			expect(candidates.map(editorWorkerEntryPoint)).toEqual([
				"B:/~BUN/root/services/editor-document-worker.js",
				"B:/~BUN/root/server/services/editor-document-worker.js",
				"B:/~BUN/root/editor-document-worker.js",
			]);
		}
	});
	test("ordinary files and Linux compiled workers retain URL handling", () => {
		for (const specifier of [
			"file:///C:/workspace%20name/server/services/editor-document-worker.ts",
			"file:///workspace/server/services/editor-document-worker.ts",
			"file:///$bunfs/root/services/editor-document-worker.js",
		]) {
			const entry = editorWorkerEntryPoint(specifier);
			expect(entry).toBeInstanceOf(URL);
			expect(String(entry)).toBe(specifier);
		}
	});
	test("an unavailable pre-ready candidate can fall through without dispatching the job", async () => {
		const jobs = new EditorDocumentJobs([
			pathToFileURL(join(root, "not-an-editor-worker.ts")).href,
			new URL("./editor-document-worker.ts", import.meta.url).href,
		]);
		const result = await jobs.run(actor.userId, {
			action: "metadata",
			sourcePath: target,
		});
		expect(result.kind).toBe("source");
		if (result.kind !== "source") throw new Error("Unexpected metadata result");
		const content = await jobs.run(actor.userId, {
			action: "content",
			sourcePath: target,
			metadata: result.metadata,
		});
		expect(content.kind).toBe("content");
		if (content.kind !== "content") throw new Error("Unexpected content result");
		expect(new TextDecoder().decode(content.bytes)).toBe("before\n中文🙂\n");
	});
	test("a ready worker error never retries a potentially side-effecting job", async () => {
		const fixture = join(root, "ready-failure.ts"),
			marker = join(root, "executions");
		await writeFile(
			fixture,
			`import { parentPort } from "node:worker_threads";
import { appendFile } from "node:fs/promises";
parentPort.once("message", async (request) => {
 await appendFile(request.path, "x");
 parentPort.postMessage({ error: "deliberate-ready-failure" });
 parentPort.close();
});
parentPort.postMessage({ type: "editor-worker-ready", version: 1 });`,
		);
		const url = pathToFileURL(fixture).href;
		const jobs = new EditorDocumentJobs([url, url]);
		await expect(jobs.run(actor.userId, { action: "seal", path: marker })).rejects.toThrow(
			"deliberate-ready-failure",
		);
		expect(await readFile(marker, "utf8")).toBe("x");
	});
	test("source transfer admission enforces 128 MiB, eight active, 64 queued and idempotent release", async () => {
		const jobs = new EditorDocumentJobs();
		const a = await jobs.acquireTransfer(64 * 1024 * 1024);
		const b = await jobs.acquireTransfer(64 * 1024 * 1024);
		let thirdAdmitted = false;
		const third = jobs.acquireTransfer(1).then((permit) => {
			thirdAdmitted = true;
			return permit;
		});
		await Promise.resolve();
		expect(thirdAdmitted).toBe(false);
		a.release();
		a.release();
		const c = await third;
		expect(Reflect.get(jobs, "transferBytes")).toBe(64 * 1024 * 1024 + 1);
		b.release();
		c.release();
		const active = await Promise.all(Array.from({ length: 8 }, () => jobs.acquireTransfer(1)));
		const controller = new AbortController();
		const queued = Array.from({ length: 64 }, () => jobs.acquireTransfer(1, controller.signal));
		const failures = Promise.all(queued.map((value) => value.catch((error) => error)));
		await expect(jobs.acquireTransfer(1)).rejects.toMatchObject({ code: "EDITOR_BUSY" });
		controller.abort();
		expect((await failures).every((error) => error.code === "EDITOR_TIMEOUT")).toBe(true);
		for (const permit of active) permit.release();
		expect(Reflect.get(jobs, "transfers")).toBe(0);
		expect(Reflect.get(jobs, "transferBytes")).toBe(0);
		expect(Reflect.get(jobs, "transferQueue")).toHaveLength(0);
	});
	test("source transfer permit is independent of inherited IO admission", async () => {
		const jobs = new EditorDocumentJobs();
		await jobs.withIo(actor.userId, async () => {
			const permit = await jobs.acquireTransfer(1);
			await jobs.withIo(actor.userId, async () => {});
			permit.release();
		});
		expect(Reflect.get(jobs, "transfers")).toBe(0);
	});
	test("IO admission bounds complete commits to two globally and one per user", async () => {
		const jobs = new EditorDocumentJobs(),
			release = deferred();
		const active = new Set<string>();
		let peak = 0;
		const work = (user: string) =>
			jobs.withIo(user, async () => {
				expect(active.has(user)).toBe(false);
				active.add(user);
				peak = Math.max(peak, active.size);
				await release.promise;
				active.delete(user);
			});
		const a = work("a"),
			b = work("b");
		const queued = Array.from({ length: 8 }, (_, i) => work(i % 2 ? "a" : "c"));
		await expect(work("extra")).rejects.toThrow("queue is full");
		release.resolve();
		await Promise.all([a, b, ...queued]);
		expect(peak).toBe(2);
	});
	test("oversize or malformed recovery metadata is rejected before unbounded parsing", async () => {
		const jobs = new EditorDocumentJobs(),
			folder = join(root, "recovery-check");
		await mkdir(folder, { mode: 0o700 });
		const path = join(folder, "ed-00000000-0000-4000-8000-000000000000.json");
		await writeFile(path, Buffer.alloc(32769, 32));
		await expect(jobs.run(actor.userId, { action: "cleanup", root: folder })).rejects.toThrow(
			"budget",
		);
		await writeFile(path, "{}");
		await expect(jobs.run(actor.userId, { action: "cleanup", root: folder })).rejects.toThrow();
	});
	test("final encoding byte expansion fails before any durable intent or dispatch", async () => {
		const doc = await create(),
			id = await upload(doc, "中".repeat(8 * 1024 * 1024));
		const error = await failure(() => service.commit(actor, doc.docId, id, {}));
		expect(error.message).toContain("20 MiB");
		expect(dispatches).toBe(0);
		expect(operations()).toHaveLength(0);
		expect(await readFile(target, "utf8")).toBe("before\r\n中文🙂\r\n");
	}, 30_000);
	test("runtime revalidates after async construction before overwriting an external change", async () => {
		const doc = await create(),
			id = await upload(doc, "mine");
		io.apply = async (input) => {
			await writeFile(target, "external during evidence publication");
			return fileChangeLocalIo.apply(input);
		};
		await expect(service.commit(actor, doc.docId, id, {})).rejects.toThrow();
		expect(await readFile(target, "utf8")).toBe("external during evidence publication");
		expect(operations()).toHaveLength(1);
	}, 30_000);
	test("preparation infrastructure failure never writes the target", async () => {
		const doc = await create(),
			id = await upload(doc, "mine");
		const prepare = runtime.evidence.finalizePreparation.bind(runtime.evidence);
		runtime.evidence.finalizePreparation = async () => {
			throw new Error("Injected evidence failure");
		};
		try {
			await expect(service.commit(actor, doc.docId, id, {})).rejects.toThrow(
				"Injected evidence failure",
			);
			expect(dispatches).toBe(0);
			expect(await readFile(target, "utf8")).toBe("before\r\n中文🙂\r\n");
		} finally {
			runtime.evidence.finalizePreparation = prepare;
		}
	}, 30_000);
	test("startup cleans bounded orphan objects without touching arbitrary files", async () => {
		await mkdir(join(root, "transfers"), { mode: 0o700 });
		await writeFile(join(root, "transfers", "ed-1234-abcd"), "orphan");
		await create();
		expect(await bodies()).toHaveLength(0);
	});
	test("disk-state reports an unchanged baseline without creating a session or body", async () => {
		const doc = await create();
		const before = (service as unknown as { sessions: Map<string, unknown> }).sessions.size;
		const bodiesBefore = (await bodies()).length;
		const state = await service.diskState(actor, doc.docId);
		expect(state).toEqual({
			exists: true,
			baseHash: doc.baseHash,
			encoding: doc.encoding,
			eol: doc.eol,
			sourceBytes: doc.sourceBytes,
			utf8Bytes: doc.utf8Bytes,
		});
		expect((service as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(before);
		expect((await bodies()).length).toBe(bodiesBefore);
	});
	test("disk-state reports an external change with the v1 text hash and leaves the baseline", async () => {
		const doc = await create();
		await writeFile(target, "external edit\n");
		const state = await service.diskState(actor, doc.docId);
		expect(state.exists).toBe(true);
		if (!state.exists) throw new Error("unreachable");
		expect(state.baseHash).toBe(hash("external edit\n"));
		expect(state.baseHash).not.toBe(doc.baseHash);
		// The saved session baseline still guards uploads against the original version.
		const uploadId = await upload(doc, "mine\n");
		const conflict = await failure(() => service.commit(actor, doc.docId, uploadId, {}));
		expect(conflict.code).toBe("STALE_WRITE");
	});
	test("disk-state reports deletion without failing or exposing a path", async () => {
		const doc = await create();
		await rm(target);
		expect(await service.diskState(actor, doc.docId)).toEqual({ exists: false });
	});
	test("disk-state reauthorizes after IO: a changed binding cannot publish the observation", async () => {
		const doc = await create();
		let calls = 0;
		const original = actor.authorize;
		actor.authorize = async (input, need) => {
			calls++;
			const binding = await original.call(actor, input, need);
			// First call (before IO) matches; the post-IO reauthorization sees a new workspace.
			return calls >= 2 ? { ...binding, contextKey: "rebound" } : binding;
		};
		const error = await failure(() => service.diskState(actor, doc.docId));
		expect(error.code).toBe("EDITOR_IDENTITY_CHANGED");
		actor.authorize = original;
	});
	test("disk-state for an unknown or other user's document is indistinguishable from expired", async () => {
		const doc = await create();
		const other: EditorActor = { ...actor, userId: generateId() };
		const error = await failure(() => service.diskState(other, doc.docId));
		expect(error.statusCode).toBe(410);
		const missing = await failure(() => service.diskState(actor, randomUUID()));
		expect(missing.statusCode).toBe(410);
	});
});

describe("editor temporary directory auto-repair", () => {
	const makeService = (store: string) =>
		new EditorDocumentService({
			root: store,
			execute: (request) => runtime.executeEditor(request),
		});
	const openDoc = (svc: EditorDocumentService) =>
		svc.create(actor, { path: target, deviceId: "local", origin: "legacy" });

	test.skipIf(process.platform === "win32")(
		"repairs a loose-mode transfer directory instead of failing the session",
		async () => {
			const store = join(root, "loose-mode-store");
			await mkdir(store, { mode: 0o700 });
			await chmod(store, 0o755);
			const svc = makeService(store);
			try {
				const doc = await openDoc(svc);
				expect(doc.docId).toBeTruthy();
				const stat = await lstat(store);
				expect(stat.isDirectory()).toBe(true);
				expect(stat.isSymbolicLink()).toBe(false);
				expect(stat.mode & 0o077).toBe(0);
			} finally {
				await svc.dispose();
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"replaces a symlink at the transfer root without following its target",
		async () => {
			const store = join(root, "symlink-store");
			const elsewhere = join(root, "symlink-target");
			await mkdir(elsewhere, { mode: 0o700 });
			await writeFile(join(elsewhere, "keep-me"), "preserved");
			await symlink(elsewhere, store);
			const svc = makeService(store);
			try {
				const doc = await openDoc(svc);
				expect(doc.docId).toBeTruthy();
				const stat = await lstat(store);
				expect(stat.isSymbolicLink()).toBe(false);
				expect(stat.isDirectory()).toBe(true);
				expect(stat.mode & 0o077).toBe(0);
				expect(await readFile(join(elsewhere, "keep-me"), "utf8")).toBe("preserved");
			} finally {
				await svc.dispose();
			}
		},
	);

	test("replaces a non-directory placeholder at the transfer root", async () => {
		const store = join(root, "file-store");
		await writeFile(store, "not a directory");
		const svc = makeService(store);
		try {
			const doc = await openDoc(svc);
			expect(doc.docId).toBeTruthy();
			const stat = await lstat(store);
			expect(stat.isDirectory()).toBe(true);
			expect(stat.isSymbolicLink()).toBe(false);
		} finally {
			await svc.dispose();
		}
	});

	test.skipIf(process.platform === "win32")(
		"heals the store when permissions are loosened mid-session",
		async () => {
			const store = join(root, "mid-session-store");
			const svc = makeService(store);
			try {
				const first = await openDoc(svc);
				expect(first.docId).toBeTruthy();
				await chmod(store, 0o755);
				const second = await openDoc(svc);
				expect(second.docId).toBeTruthy();
				const stat = await lstat(store);
				expect(stat.mode & 0o077).toBe(0);
			} finally {
				await svc.dispose();
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"creates a missing transfer directory as a private owned path",
		async () => {
			const store = join(root, "missing-store");
			const svc = makeService(store);
			try {
				const doc = await openDoc(svc);
				expect(doc.docId).toBeTruthy();
				const stat = await lstat(store);
				expect(stat.isDirectory()).toBe(true);
				expect(stat.mode & 0o077).toBe(0);
			} finally {
				await svc.dispose();
			}
		},
	);
});
