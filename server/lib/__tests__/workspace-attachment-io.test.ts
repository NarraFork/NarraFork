import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	WORKSPACE_ATTACHMENT_CHUNK_BYTES,
	WORKSPACE_ATTACHMENT_MAX_BYTES,
	type WorkspaceAttachmentBackend,
	type WorkspaceAttachmentBinding,
	type WorkspaceAttachmentCreationProof,
	type WorkspaceAttachmentIntent,
	type WorkspaceAttachmentOperation,
	type WorkspaceAttachmentOperations,
} from "@shared/workspace-attachment-protocol";
import {
	cleanupWorkspaceAttachmentByProof,
	createWorkspaceAttachmentFromStagedFile,
	isWorkspaceAttachmentProof,
} from "../workspace-attachment-io";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const binding: WorkspaceAttachmentBinding = {
	sourceInstanceId: "source",
	workspaceInstanceId: "workspace",
	scopeId: "scope",
	root: "/selected/repo",
	rootIdentity: "real-root-incarnation",
	fence: 3,
};
function primitive() {
	let intent: WorkspaceAttachmentIntent | undefined;
	let written = 0;
	const hash = createHash("sha256");
	let creation: WorkspaceAttachmentCreationProof | undefined;
	let currentIncarnation = "created-incarnation";
	let currentDigest = "";
	let removed = false;
	let largestChunk = 0;
	const calls: WorkspaceAttachmentOperation[] = [];
	const backend: WorkspaceAttachmentBackend = {
		supportsWorkspaceAttachment: true,
		async workspaceAttachment<K extends WorkspaceAttachmentOperation>(
			operation: K,
			request: WorkspaceAttachmentOperations[K]["request"],
		): Promise<WorkspaceAttachmentOperations[K]["result"]> {
			calls.push(operation);
			if (operation === "cleanup") {
				const input = request as WorkspaceAttachmentOperations["cleanup"]["request"];
				const matchesOriginal =
					creation && JSON.stringify(input.proof) === JSON.stringify(creation);
				const matchesObject =
					currentIncarnation === creation?.incarnation && currentDigest === creation?.digest;
				const outcome = matchesOriginal && matchesObject ? "deleted" : "conflict";
				if (outcome === "deleted") removed = true;
				return {
					binding: input.binding,
					operationId: input.operationId,
					requestDigest: input.requestDigest,
					outcome,
				} as WorkspaceAttachmentOperations[K]["result"];
			}
			if (operation === "begin") {
				intent = request as WorkspaceAttachmentIntent;
				expect(intent.expected).toBe("absent");
				expect(intent.noOverwrite).toBe(true);
			}
			if (!intent) throw new Error("No original intent");
			if (operation === "append") {
				const input = request as WorkspaceAttachmentOperations["append"]["request"];
				const bytes = Buffer.from(input.contentBase64, "base64");
				expect(input.offset).toBe(written);
				expect(bytes.length).toBeLessThanOrEqual(WORKSPACE_ATTACHMENT_CHUNK_BYTES);
				expect(createHash("sha256").update(bytes).digest("hex")).toBe(input.chunkDigest);
				largestChunk = Math.max(largestChunk, bytes.length);
				hash.update(bytes);
				written += bytes.length;
			}
			if (operation === "commit") {
				currentDigest = hash.digest("hex");
				if (currentDigest !== intent.digest) throw new Error("Creation bytes changed");
				creation = {
					version: 1,
					binding,
					operationId: intent.operationId,
					requestDigest: intent.requestDigest,
					path: intent.path,
					sizeBytes: intent.sizeBytes,
					digest: currentDigest,
					incarnation: currentIncarnation,
					nativeMetadataDigest: "a".repeat(64),
					creationProof: "native-private-created-receipt",
					state: "committed",
					createdAt: new Date().toISOString(),
				};
			}
			return {
				binding,
				operationId: intent.operationId,
				requestDigest: intent.requestDigest,
				path: intent.path,
				writtenBytes: written,
				state: creation ? "committed" : "pending",
				...(creation ? { proof: creation } : {}),
			} as WorkspaceAttachmentOperations[K]["result"];
		},
	};
	return {
		target: { deviceId: "remote", backend, binding },
		calls,
		get largestChunk() {
			return largestChunk;
		},
		get removed() {
			return removed;
		},
		mutateContent() {
			currentDigest = "f".repeat(64);
		},
		replaceObject() {
			currentIncarnation = "external-replacement-incarnation";
		},
	};
}
async function staged(sizeBytes: number) {
	const dir = await mkdtemp(resolve(tmpdir(), "nf-attachment-receipt-"));
	dirs.push(dir);
	const path = resolve(dir, "payload");
	const file = await open(path, "wx");
	try {
		await file.truncate(sizeBytes);
	} finally {
		await file.close();
	}
	return path;
}
async function create(sizeBytes = 128 * 1024 + 7) {
	const native = primitive();
	const signal = AbortSignal.timeout(30_000);
	const authorize = mock(async () => {});
	const proof = await createWorkspaceAttachmentFromStagedFile({
		target: native.target,
		operationId: "original-creation",
		path: ".narrafork/attached/op/notes.txt",
		stagedFilePath: await staged(sizeBytes),
		sizeBytes,
		signal,
		authorize,
	});
	return { native, signal, authorize, proof };
}

describe("independent attachment receipt stream adapter", () => {
	test("streams a real 100MiB file through the protocol fixture without history blob staging", async () => {
		const { native, proof } = await create(WORKSPACE_ATTACHMENT_MAX_BYTES);
		expect(proof.sizeBytes).toBe(WORKSPACE_ATTACHMENT_MAX_BYTES);
		expect(isWorkspaceAttachmentProof(proof)).toBe(true);
		expect(native.largestChunk).toBe(WORKSPACE_ATTACHMENT_CHUNK_BYTES);
		expect(native.calls.filter((op) => op === "append")).toHaveLength(
			WORKSPACE_ATTACHMENT_MAX_BYTES / WORKSPACE_ATTACHMENT_CHUNK_BYTES,
		);
		expect(native.calls[0]).toBe("begin");
		expect(native.calls.at(-1)).toBe("commit");
	}, 30_000);
	test("unchanged original object is removed only by native conditional cleanup", async () => {
		const { native, proof, signal, authorize } = await create();
		const result = await cleanupWorkspaceAttachmentByProof({
			target: native.target,
			proof,
			operationId: "cleanup-original-creation",
			signal,
			authorize,
		});
		expect(result.outcome).toBe("deleted");
		expect(native.removed).toBe(true);
		expect(native.calls.at(-1)).toBe("cleanup");
	});
	test("fresh cleanup lease fence verifies immutable original publisher proof", async () => {
		const { native, proof, signal, authorize } = await create();
		const original = structuredClone(proof);
		const result = await cleanupWorkspaceAttachmentByProof({
			target: { ...native.target, binding: { ...binding, fence: binding.fence + 1 } },
			proof,
			operationId: "cleanup-fresh-lease",
			signal,
			authorize,
		});
		expect(result.outcome).toBe("deleted");
		expect(result.binding.fence).toBe(binding.fence + 1);
		expect(proof).toEqual(original);
		expect(native.removed).toBe(true);
	});
	for (const change of ["content", "incarnation"] as const)
		test(`external ${change} change conflicts against ORIGINAL proof and is retained`, async () => {
			const { native, proof, signal, authorize } = await create();
			if (change === "content") native.mutateContent();
			else native.replaceObject();
			const result = await cleanupWorkspaceAttachmentByProof({
				target: native.target,
				proof,
				operationId: "cleanup-original-creation",
				signal,
				authorize,
			});
			expect(result.outcome).toBe("conflict");
			expect(native.removed).toBe(false);
			expect(proof.incarnation).toBe("created-incarnation");
		});
	test("altered creation receipt cannot bless a current external object", async () => {
		const { native, proof, signal, authorize } = await create();
		native.replaceObject();
		const result = await cleanupWorkspaceAttachmentByProof({
			target: native.target,
			proof: { ...proof, incarnation: "external-replacement-incarnation" },
			operationId: "cleanup-foreign-proof",
			signal,
			authorize,
		});
		expect(result.outcome).toBe("conflict");
		expect(native.removed).toBe(false);
	});
	test("stable source/root drift and oversized input fail before primitive mutation", async () => {
		const { native, proof, signal, authorize } = await create();
		const count = native.calls.length;
		await expect(
			cleanupWorkspaceAttachmentByProof({
				target: { ...native.target, binding: { ...binding, rootIdentity: "replaced-root" } },
				proof,
				operationId: "cleanup-stale",
				signal,
				authorize,
			}),
		).rejects.toThrow("stale");
		await expect(
			createWorkspaceAttachmentFromStagedFile({
				target: native.target,
				operationId: "too-big",
				path: "notes.txt",
				stagedFilePath: "/never-read",
				sizeBytes: WORKSPACE_ATTACHMENT_MAX_BYTES + 1,
				signal,
				authorize,
			}),
		).rejects.toThrow("Invalid bounded");
		expect(native.calls).toHaveLength(count);
	});
	test("cancellation stops before begin and missing receipt is never accepted as owned", async () => {
		const native = primitive();
		const controller = new AbortController();
		controller.abort();
		await expect(
			createWorkspaceAttachmentFromStagedFile({
				target: native.target,
				operationId: "aborted",
				path: "notes.txt",
				stagedFilePath: "/never-read",
				sizeBytes: 1,
				signal: controller.signal,
				authorize: async () => {},
			}),
		).rejects.toThrow();
		expect(native.calls).toEqual([]);
		expect(
			isWorkspaceAttachmentProof({
				version: 1,
				digest: "a".repeat(64),
				incarnation: "random-path",
			}),
		).toBe(false);
	});
});
