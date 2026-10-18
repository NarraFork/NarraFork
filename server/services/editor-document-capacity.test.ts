import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	EDITOR_MAX_SESSIONS,
	EDITOR_SESSION_IDLE_MS,
	EDITOR_TRANSFER_MAX_BYTES,
	EDITOR_USER_MAX_SESSIONS,
	EDITOR_USER_TEMP_MAX_BYTES,
	type EditorDocumentDescriptor,
} from "../../shared/editor-document";
import { testEnvironment } from "../../tests/preload";
import { EditorDocumentJobs } from "./editor-document-jobs";
import { type EditorActor, EditorDocumentService } from "./editor-document-service";
import type { EditorWorkerRequest, EditorWorkerResult } from "./editor-document-worker";

/** Measures idle metadata capacity, not worker throughput or browser Monaco capacity. */
class MetadataJobs extends EditorDocumentJobs {
	calls = 0;
	override async run(_userId: string, request: EditorWorkerRequest): Promise<EditorWorkerResult> {
		if (request.action === "cleanup") return { kind: "cleaned", operations: [] };
		if (request.action !== "metadata") throw new Error(`Unexpected job: ${request.action}`);
		this.calls++;
		return {
			kind: "source",
			metadata: {
				baseHash: createHash("sha256").update("small\n").digest("hex"),
				encoding: "utf-8",
				eol: "LF",
				sourceBytes: 6,
				utf8Bytes: 6,
			},
		};
	}
}

test("3000 idle editor sessions retain no source files or temporary byte reservations", async () => {
	const root = await mkdtemp(join(testEnvironment.isolatedHome, "editor-capacity-"));
	const jobs = new MetadataJobs();
	const target = join(root, "file.txt");
	const actor: EditorActor = {
		userId: "capacity-user",
		narratorId: "capacity-narrator",
		async authorize() {
			return {
				cwd: root,
				projectId: null,
				lexicalPath: target,
				canonicalPath: target,
				outsideRoots: false,
			};
		},
	};
	const service = new EditorDocumentService({
		root: join(root, "transfers"),
		jobs,
		async execute() {
			throw new Error("Idle sessions must not execute writes");
		},
	});
	const input = { path: target, origin: "legacy" as const };
	try {
		const heapBefore = process.memoryUsage().heapUsed;
		const start = performance.now();
		const docs: EditorDocumentDescriptor[] = [];
		for (let index = 0; index < 3000; index++) docs.push(await service.create(actor, input));
		const createMs = performance.now() - start;
		const heapDelta = process.memoryUsage().heapUsed - heapBefore;
		expect(jobs.calls).toBe(3000);
		expect(new Set(docs.map((doc) => doc.docId)).size).toBe(3000);
		expect(await readdir(join(root, "transfers"))).toEqual([]);

		// The entire user upload budget remains available after opening 3000 documents.
		const uploads = [];
		const slots = EDITOR_USER_TEMP_MAX_BYTES / EDITOR_TRANSFER_MAX_BYTES;
		for (let index = 0; index < slots; index++) {
			const doc = docs[index];
			uploads.push(
				await service.createUpload(actor, doc.docId, {
					baseHash: doc.baseHash,
					encoding: doc.encoding,
					snapshotRevision: 1,
				}),
			);
		}
		await expect(
			service.createUpload(actor, docs[slots].docId, {
				baseHash: docs[slots].baseHash,
				encoding: docs[slots].encoding,
				snapshotRevision: 1,
			}),
		).rejects.toMatchObject({ code: "EDITOR_QUOTA_EXCEEDED" });
		for (let index = 0; index < uploads.length; index++) {
			await service.cancelUpload(actor, docs[index].docId, uploads[index].uploadId);
		}
		const releaseStart = performance.now();
		await service.sweep(Date.now() + EDITOR_SESSION_IDLE_MS + 1);
		const releaseMs = performance.now() - releaseStart;
		expect(await readdir(join(root, "transfers"))).toEqual([]);
		await expect(
			service.createUpload(actor, docs[0].docId, {
				baseHash: docs[0].baseHash,
				encoding: docs[0].encoding,
				snapshotRevision: 1,
			}),
		).rejects.toMatchObject({ code: "EDITOR_SESSION_EXPIRED" });
		const reopened = await service.create(actor, input);
		await service.createUpload(actor, reopened.docId, {
			baseHash: reopened.baseHash,
			encoding: reopened.encoding,
			snapshotRevision: 1,
		});
		console.info("Editor idle capacity (stub metadata jobs)", {
			sessions: docs.length,
			createMs: Math.round(createMs),
			releaseMs: Math.round(releaseMs),
			heapDeltaBytes: heapDelta,
			sourceFiles: 0,
		});
	} finally {
		await service.dispose();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("user and global metadata session limits reclaim capacity after release", async () => {
	const root = await mkdtemp(join(testEnvironment.isolatedHome, "editor-limits-"));
	const target = join(root, "file.txt");
	const service = new EditorDocumentService({
		root: join(root, "transfers"),
		jobs: new MetadataJobs(),
		async execute() {
			throw new Error("Unexpected write");
		},
	});
	const actorFor = (userId: string): EditorActor => ({
		userId,
		narratorId: `${userId}-narrator`,
		async authorize() {
			return {
				cwd: root,
				projectId: null,
				lexicalPath: target,
				canonicalPath: target,
				outsideRoots: false,
			};
		},
	});
	const input = { path: target, origin: "legacy" as const };
	const first = actorFor("first");
	try {
		let firstDoc!: EditorDocumentDescriptor;
		for (let index = 0; index < EDITOR_USER_MAX_SESSIONS; index++) {
			const doc = await service.create(first, input);
			if (index === 0) firstDoc = doc;
		}
		await expect(service.create(first, input)).rejects.toMatchObject({
			code: "EDITOR_QUOTA_EXCEEDED",
		});
		await service.remove(first, firstDoc.docId);
		firstDoc = await service.create(first, input);
		for (let index = EDITOR_USER_MAX_SESSIONS; index < EDITOR_MAX_SESSIONS; index++) {
			await service.create(actorFor(`user-${Math.floor(index / EDITOR_USER_MAX_SESSIONS)}`), input);
		}
		const newcomer = actorFor("newcomer");
		await expect(service.create(newcomer, input)).rejects.toMatchObject({
			code: "EDITOR_QUOTA_EXCEEDED",
		});
		await service.remove(first, firstDoc.docId);
		const admitted = await service.create(newcomer, input);
		await expect(service.create(first, input)).rejects.toMatchObject({
			code: "EDITOR_QUOTA_EXCEEDED",
		});
		await service.remove(newcomer, admitted.docId);
		await service.create(first, input);
		expect(await readdir(join(root, "transfers"))).toEqual([]);
	} finally {
		await service.dispose();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
