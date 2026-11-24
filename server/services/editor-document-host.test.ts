import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import iconv from "iconv-lite";
import { tagBlock } from "../../frontend/components/narrator/file-editor/editor-format-rope";
import { EditorSaveCodec } from "../../frontend/components/narrator/file-editor/editor-save-codec";
import {
	EDITOR_FILE_MAX_BYTES,
	type EditorRawDocumentDescriptor,
	type EditorRawEncoding,
} from "../../shared/editor-document";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import { fileChangeOperations, narrators, users } from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import * as executors from "../lib/executor-binaries";
import { logger } from "../lib/logger";
import { getNarraforkHome } from "../lib/narrafork-home";
import { editorOperationMetadataSchema } from "../lib/validators/editor-documents";
import { denyHostEditorHelpers } from "../routes/editor-native-fixture";
import { settleWorkerRead } from "./__tests__/file-worker-database";
import {
	executeEditorDocumentFileChange,
	getEditorDocumentService,
	queryEditorOperation,
} from "./editor-document-runtime";
import { type EditorActor, EditorDocumentService } from "./editor-document-service";
import {
	createFileChangeLocalIo,
	fileChangeLocalIo,
	type LocalFileHandle,
	type LocalFileSyscalls,
} from "./file-change-local-io";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let root: string, target: string;
beforeEach(async () => {
	root = await mkdtemp(join(testEnvironment.isolatedHome, "host-save-"));
	target = join(root, "file.txt");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Exact production singleton, default runtime, SQLite evidence and worker metadata.
 * No seeded helper or alternative writer. Only prohibited entrypoints are trapped;
 * worker threads and legitimate Git/snapshot subprocesses remain available. */
// The 20 MiB workflow spans independent preflight/upload/seal/commit/recovery phases.
// Its aggregate test watchdog is 120s; product IO/worker budgets remain unchanged.
// The five smaller scenarios retain their original 30s test watchdog.
for (const scenario of [
	"20MiB-and-cold-query",
	"utf-8",
	"utf-16le",
	"utf-16be",
	"gbk",
	"racing-saves",
] as const) {
	test(
		`fresh production Host ${scenario} needs zero helper/distribution/network calls`,
		async () => {
			const scenarioRoot = root,
				scenarioTarget = target;
			const forbidden = () => {
				throw new Error("Host save must not enter helper/distribution");
			};
			const processGuard = denyHostEditorHelpers();
			const traps = [
				spyOn(executors, "ensureExecutorBinary").mockImplementation(forbidden),
				spyOn(globalThis, "fetch").mockImplementation(
					Object.assign(forbidden, { preconnect: forbidden }),
				),
			];
			const warnings = spyOn(logger, "warn");
			const service = getEditorDocumentService();
			let cold: EditorDocumentService | undefined;
			const userId = randomUUID(),
				narratorId = randomUUID(),
				now = new Date().toISOString();
			db.insert(users)
				.values({
					id: userId,
					username: userId,
					passwordHash: "fixture",
					role: "user",
					createdAt: now,
				})
				.run();
			db.insert(narrators)
				.values({
					id: narratorId,
					cwd: scenarioRoot,
					ownerUserId: userId,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			let revoked = false;
			const actor: EditorActor = {
				userId,
				narratorId,
				authorizeOperation: async (device) => {
					if (revoked || device !== "local") throw new Error("revoked");
				},
				authorize: async () => {
					if (revoked) throw new Error("revoked");
					return {
						cwd: scenarioRoot,
						projectId: null,
						lexicalPath: scenarioTarget,
						canonicalPath: scenarioTarget,
						outsideRoots: false,
						deviceId: "local",
						workspaceRevision: 0,
					};
				},
			};
			try {
				expect(process.env.NARRAFORK_TEST).toBe("1");
				expect(getNarraforkHome()).toBe(testEnvironment.narraforkHome);
				await expect(
					lstat(join(getNarraforkHome(), "editor-native-operations")),
				).rejects.toMatchObject({ code: "ENOENT" });
				await writeFile(scenarioTarget, "a\r\nb\rc\n");
				const opened = await service.create(actor, {
					path: scenarioTarget,
					origin: "legacy",
					protocol: "raw-v2",
				});
				if (opened.protocol !== "raw-v2") throw new Error("raw descriptor required");
				expect(opened.capabilities).toMatchObject({
					rawRead: true,
					rawSave: true,
					stage: true,
					durableApply: false,
					durableQuery: true,
				});
				await service.remove(actor, opened.docId);

				const save = async (
					before: Uint8Array,
					text: string,
					encoding: EditorRawEncoding,
					bom: "none" | "utf8" | "utf16le" | "utf16be",
					tags: Uint8Array,
					openedDocument?: EditorRawDocumentDescriptor,
				) => {
					if (!openedDocument) await writeFile(scenarioTarget, before);
					const inode = (await lstat(scenarioTarget)).ino;
					const doc =
						openedDocument ??
						(await service.create(actor, {
							path: scenarioTarget,
							origin: "legacy",
							protocol: "raw-v2",
							encodingHint: encoding,
						}));
					if (doc.protocol !== "raw-v2") throw new Error("raw descriptor required");
					const codec = await EditorSaveCodec.create({ encoding, bom, root: tagBlock(tags) });
					const encoded: Uint8Array[] = [];
					for (let offset = 0; offset < text.length; offset += 65536)
						encoded.push(
							codec.push(text.slice(offset, offset + 65536), offset + 65536 >= text.length),
						);
					const next = Buffer.concat(encoded),
						seal = codec.finish();
					const upload = await service.createUpload(actor, doc.docId, {
						protocol: "raw-v2",
						hashKind: "raw-sha256",
						baseHash: doc.baseHash,
						encoding,
						bom,
						snapshotRevision: 17,
					});
					for (let offset = 0, seq = 0; offset < next.length; offset += 65536, seq++) {
						const chunk = next.slice(offset, offset + 65536);
						await service.putChunk(
							actor,
							doc.docId,
							upload.uploadId,
							{ seq, offset, bytes: chunk.length, digest: hash(chunk) },
							new Response(chunk).body,
						);
					}
					await service.sealRaw(actor, doc.docId, upload.uploadId, seal);
					const result = await service.commit(actor, doc.docId, upload.uploadId, {});
					expect(result.status).toBe("saved");
					expect(await readFile(scenarioTarget)).toEqual(Buffer.from(next));
					expect((await lstat(scenarioTarget)).ino).toBe(inode);
					expect(await service.operation(actor, result.operationId)).toMatchObject({
						status: "saved",
						result: { snapshotRevision: 17, hashKind: "raw-sha256", hash: hash(next) },
					});
					await service.remove(actor, doc.docId);
					return { result, next };
				};
				let large: Awaited<ReturnType<typeof save>> | undefined;
				if (scenario === "20MiB-and-cold-query") {
					const twenty = new Uint8Array(EDITOR_FILE_MAX_BYTES).fill(65);
					large = await save(
						twenty,
						`B${"A".repeat(EDITOR_FILE_MAX_BYTES - 1)}`,
						"utf-8",
						"none",
						new Uint8Array(),
					);
					expect(large.next.length).toBe(EDITOR_FILE_MAX_BYTES);
				} else if (scenario !== "racing-saves") {
					const encoding = scenario;
					const bom =
						encoding === "gbk"
							? "none"
							: encoding === "utf-8"
								? "utf8"
								: encoding === "utf-16le"
									? "utf16le"
									: "utf16be";
					const prefix =
						encoding === "utf-8"
							? Buffer.from([239, 187, 191])
							: encoding === "utf-16le"
								? Buffer.from([255, 254])
								: encoding === "utf-16be"
									? Buffer.from([254, 255])
									: Buffer.alloc(0);
					const before = Buffer.concat([prefix, iconv.encode("a\r\nb\rc\n中文", encoding)]);
					const saved = await save(before, "A\nb\nc\n中文", encoding, bom, Uint8Array.of(2, 3, 1));
					expect(saved.next).toEqual(
						Buffer.concat([prefix, iconv.encode("A\r\nb\rc\n中文", encoding)]),
					);
				}
				if (scenario === "racing-saves") {
					await writeFile(scenarioTarget, "same-base");
					const documents = await Promise.all(
						[0, 1].map(() =>
							service.create(actor, { path: scenarioTarget, origin: "legacy", protocol: "raw-v2" }),
						),
					);
					const racing = await Promise.allSettled(
						documents.map((document, index) => {
							if (document.protocol !== "raw-v2") throw new Error("raw descriptor required");
							return save(
								Buffer.from("same-base"),
								`winner-${index}`,
								"utf-8",
								"none",
								new Uint8Array(),
								document,
							);
						}),
					);
					expect(racing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
					const rejected = racing.find((result) => result.status === "rejected");
					expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
						code: "STALE_WRITE",
					});
				}
				await expect(
					(await settleWorkerRead(queryEditorOperation(actor, randomUUID()))).result(),
				).rejects.toMatchObject({
					code: "EDITOR_OPERATION_UNKNOWN",
				});
				if (large) {
					// Simulate a lost success reply: metadata survives an independent service's
					// cold recovery. Current disk is deliberately unrelated: query is evidence-only.
					cold = new EditorDocumentService({
						root: join(getNarraforkHome(), "editor-transfers"),
						execute: () => {
							throw new Error("query must never dispatch");
						},
						queryOperation: queryEditorOperation,
					});
					await writeFile(scenarioTarget, "unrelated-current-disk");
					const historyStatus = "disabled";
					expect(await cold.operation(actor, large.result.operationId)).toMatchObject({
						status: "saved",
						result: { hash: hash(large.next), snapshotRevision: 17, historyStatus },
					});
					expect(await readFile(scenarioTarget, "utf8")).toBe("unrelated-current-disk");
					expect(await queryEditorOperation(actor, large.result.operationId)).toMatchObject({
						status: "uncertain",
					});
					const recovery = editorOperationMetadataSchema.parse(
						JSON.parse(
							await readFile(
								join(getNarraforkHome(), "editor-transfers", `ed-${large.result.operationId}.json`),
								"utf8",
							),
						),
					);
					// Local applied proof uses the owned recovery description; content evidence is disabled.
					expect(
						await queryEditorOperation(actor, large.result.operationId, {
							...recovery,
							rawDigest: "f".repeat(64),
						}),
					).toMatchObject({ status: "saved", result: { historyStatus: "disabled" } });
					const row = db
						.select({ id: fileChangeOperations.id })
						.from(fileChangeOperations)
						.where(eq(fileChangeOperations.sourceId, large.result.operationId))
						.get();
					if (!row) throw new Error("missing Host evidence");
					db.update(fileChangeOperations)
						.set({ settlement: "applying" })
						.where(eq(fileChangeOperations.id, row.id))
						.run();
					// A stale aggregate label cannot erase the independently recorded, verified
					// applied effect. Query still uses its receipt, never today's unrelated disk.
					expect(await cold.operation(actor, large.result.operationId)).toMatchObject({
						status: "saved",
						result: {
							hash: hash(large.next),
							diskOutcome: "applied",
							historyStatus,
						},
					});
					expect(await readFile(scenarioTarget, "utf8")).toBe("unrelated-current-disk");
					db.update(fileChangeOperations)
						.set({ settlement: "settled" })
						.where(eq(fileChangeOperations.id, row.id))
						.run();
					await expect(
						(
							await settleWorkerRead(
								queryEditorOperation({ ...actor, userId: "other" }, large.result.operationId),
							)
						).result(),
					).rejects.toMatchObject({ code: "EDITOR_OPERATION_UNKNOWN" });
					revoked = true;
					await expect(
						(await settleWorkerRead(cold.operation(actor, large.result.operationId))).result(),
					).rejects.toThrow("revoked");
				}
				await expect(
					lstat(join(getNarraforkHome(), "editor-native-operations")),
				).rejects.toMatchObject({ code: "ENOENT" });
				expect(processGuard.starts).toBe(0);
				for (const trap of traps) expect(trap).toHaveBeenCalledTimes(0);
			} finally {
				revoked = false;
				await cold?.dispose();
				await service.dispose();
				// Disposed streams cannot be reused. Only retire this test process's singleton,
				// leaving the next independent scenario to use the real production factory.
				const singleton = Symbol.for("narrafork.editor-documents.v1");
				if (Reflect.get(globalThis, singleton) === service)
					Reflect.deleteProperty(globalThis, singleton);
				for (const trap of traps) trap.mockRestore();
				warnings.mockRestore();
				processGuard.restore();
			}
		},
		scenario === "20MiB-and-cold-query" ? 120_000 : 30_000,
	);
}

const profile = {
	maxBytes: EDITOR_FILE_MAX_BYTES,
	createParents: false,
};
async function input(next = Buffer.from("replacement")) {
	return {
		backend: localBackend,
		lexicalPath: target,
		canonicalPath: target,
		before: await fileChangeLocalIo.read(target),
		nextBytes: next,
		signal: new AbortController().signal,
		assertTarget: async () => {},
		onDispatch: () => {},
	};
}

test("unsupported remote adapters cannot fall through to a Host path", async () => {
	await writeFile(target, "original");
	await expect(
		executeEditorDocumentFileChange({
			requestId: randomUUID(),
			resourceKey: "unsupported",
			userId: "user",
			narratorId: "narrator",
			cwd: root,
			canonicalPath: target,
			lexicalPath: target,
			signal: new AbortController().signal,
			input: {},
			authorize: async () => {
				throw new Error("must reject before admission");
			},
			construct: () => {
				throw new Error("must not construct Host bytes");
			},
			remote: {
				backend: localBackend,
				runtime: { runtimeEpoch: "fixture", runtimeGeneration: 0 },
				currentRuntime: () => null,
				rootIdentity: "unsupported",
				assertParent: async () => {},
			},
		}),
	).rejects.toMatchObject({ code: "EDITOR_PROVIDER_UNSUPPORTED" });
	expect(await readFile(target, "utf8")).toBe("original");
});

test("Host profile rejects absent parents, read-only and over-budget bytes; ordinary writer still creates parents", async () => {
	const io = createFileChangeLocalIo(undefined, profile);
	target = join(root, "absent", "file");
	expect(await io.apply(await input())).toMatchObject({
		kind: "not_applied",
		parentEffects: { createdPaths: [], possiblePaths: [] },
	});
	await expect(lstat(join(root, "absent"))).rejects.toMatchObject({ code: "ENOENT" });
	expect(await fileChangeLocalIo.apply(await input())).toMatchObject({ kind: "applied" });
	await chmod(target, 0o444);
	expect(await io.apply(await input())).toMatchObject({ kind: "not_applied" });
	await chmod(target, 0o644);
	expect(await io.apply(await input(Buffer.alloc(EDITOR_FILE_MAX_BYTES + 1)))).toMatchObject({
		kind: "not_applied",
	});
	await writeFile(target, Buffer.alloc(EDITOR_FILE_MAX_BYTES + 1));
	await expect(io.read(target)).rejects.toThrow("budget");
});

test.each([
	"short-write",
	"sync",
	"close",
	"after-read",
	"root",
	"revoke",
] as const)("Host post-mutation %s failure is unknown, never a second write", async (fault) => {
	await writeFile(target, "original");
	let writes = 0,
		syncs = 0,
		closes = 0,
		guards = 0,
		mutated = false;
	const calls: LocalFileSyscalls = {
		lstat,
		mkdir,
		async open(path, flags, mode) {
			const file = await open(path, flags, mode);
			const writable = !!(flags & (constants.O_RDWR | constants.O_WRONLY));
			if (!writable) {
				if (fault === "after-read" && mutated) {
					await file.close();
					throw new Error("after-read");
				}
				return file;
			}
			const wrapped: LocalFileHandle = {
				stat: (options) => file.stat(options),
				read: (...args) => file.read(...args),
				truncate: async (length) => {
					mutated = true;
					await file.truncate(length);
				},
				write: async (...args) => {
					writes++;
					return fault === "short-write" ? { bytesWritten: 0 } : file.write(...args);
				},
				sync: async () => {
					syncs++;
					if (fault === "sync") throw new Error("sync");
					await file.sync();
				},
				close: async () => {
					closes++;
					await file.close();
					if (fault === "close") throw new Error("close");
				},
			};
			return wrapped;
		},
	};
	const io = createFileChangeLocalIo(calls, profile),
		request = await input();
	request.assertTarget = async () => {
		guards++;
		if (mutated && (fault === "root" || fault === "revoke")) throw new Error(fault);
	};
	expect(await io.apply(request)).toMatchObject({ kind: "target_mutation_unknown" });
	expect(writes).toBe(1);
	expect(closes).toBe(1);
	expect(guards).toBeGreaterThanOrEqual(2);
	if (fault !== "short-write") expect(syncs).toBe(1);
	else expect((await readFile(target)).length).toBe(0);
});

test("Host positive short writes complete; cancellation after mutation retains verified applied IO", async () => {
	await writeFile(target, "original");
	for (const cancel of [false, true]) {
		const controller = new AbortController();
		let synced = false,
			closed = false,
			writes = 0;
		const io = createFileChangeLocalIo(
			{
				lstat,
				mkdir,
				async open(path, flags, mode) {
					const file = await open(path, flags, mode);
					if (!(flags & constants.O_RDWR)) return file;
					return {
						stat: (options) => file.stat(options),
						read: (...args) => file.read(...args),
						truncate: (length) => file.truncate(length),
						write: async (bytes, offset, length, position) => {
							writes++;
							const result = await file.write(bytes, offset, Math.min(length, 3), position);
							if (cancel) controller.abort();
							return result;
						},
						sync: async () => {
							await file.sync();
							synced = true;
						},
						close: async () => {
							await file.close();
							closed = true;
						},
					};
				},
			},
			profile,
		);
		const request = await input();
		request.signal = controller.signal;
		expect(await io.apply(request)).toMatchObject({ kind: "applied" });
		expect(await readFile(target)).toEqual(request.nextBytes);
		expect(writes).toBe(4);
		expect(synced && closed).toBe(true);
	}
});

test("Host target/revocation and cancellation failures before mutation reject without truncation", async () => {
	await writeFile(target, "original");
	const io = createFileChangeLocalIo(undefined, profile);
	for (const fault of ["target", "revoke", "cancel"] as const) {
		const request = await input();
		if (fault === "cancel") request.signal = AbortSignal.abort();
		else
			request.assertTarget = async () => {
				throw new Error(fault);
			};
		expect(await io.apply(request)).toMatchObject({ kind: "not_applied" });
		expect(await readFile(target, "utf8")).toBe("original");
	}
	// A pathname replacement after opening is caught by FD identity guards.
	const request = await input();
	let guards = 0;
	request.assertTarget = async () => {
		if (++guards === 2) {
			await rename(target, join(root, "retired"));
			await writeFile(target, "racer");
		}
	};
	expect(await io.apply(request)).toMatchObject({ kind: "not_applied" });
	expect(await readFile(target, "utf8")).toBe("racer");
});
