import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import {
	WORKSPACE_ATTACHMENT_CHUNK_BYTES,
	WORKSPACE_ATTACHMENT_MAX_BYTES,
	type WorkspaceAttachmentBackend,
	type WorkspaceAttachmentBinding,
	type WorkspaceAttachmentCleanup,
	type WorkspaceAttachmentCreationProof,
	type WorkspaceAttachmentIntent,
	type WorkspaceAttachmentStatus,
} from "@shared/workspace-attachment-protocol";

/** Provided by the trusted actor/native resolver, not reconstructed from a pathname. */
export interface WorkspaceAttachmentTarget {
	deviceId: string;
	backend: WorkspaceAttachmentBackend;
	binding: WorkspaceAttachmentBinding;
}

function sameBinding(a: WorkspaceAttachmentBinding, b: WorkspaceAttachmentBinding): boolean {
	return sameStableSource(a, b) && a.fence === b.fence;
}

// A fresh cleanup lease has a NEW fence; the private original creation proof is
// immutable. Only stable source/workspace/scope/root identity is shared across leases.
function sameStableSource(a: WorkspaceAttachmentBinding, b: WorkspaceAttachmentBinding): boolean {
	return (
		a.sourceInstanceId === b.sourceInstanceId &&
		a.workspaceInstanceId === b.workspaceInstanceId &&
		a.scopeId === b.scopeId &&
		a.root === b.root &&
		a.rootIdentity === b.rootIdentity
	);
}
export function isWorkspaceAttachmentProof(
	value: unknown,
): value is WorkspaceAttachmentCreationProof {
	if (!value || typeof value !== "object") return false;
	const proof = value as Record<string, unknown>;
	const binding = proof.binding;
	if (!binding || typeof binding !== "object") return false;
	const root = binding as Record<string, unknown>;
	return (
		proof.version === 1 &&
		proof.state === "committed" &&
		typeof proof.operationId === "string" &&
		!!proof.operationId &&
		typeof proof.path === "string" &&
		!!proof.path &&
		typeof proof.requestDigest === "string" &&
		/^[a-f0-9]{64}$/.test(proof.requestDigest) &&
		typeof proof.digest === "string" &&
		/^[a-f0-9]{64}$/.test(proof.digest) &&
		typeof proof.nativeMetadataDigest === "string" &&
		/^[a-f0-9]{64}$/.test(proof.nativeMetadataDigest) &&
		typeof proof.incarnation === "string" &&
		!!proof.incarnation &&
		typeof proof.creationProof === "string" &&
		proof.creationProof.length >= 16 &&
		proof.creationProof.length <= 4096 &&
		typeof proof.createdAt === "string" &&
		!!proof.createdAt &&
		typeof proof.sizeBytes === "number" &&
		Number.isSafeInteger(proof.sizeBytes) &&
		proof.sizeBytes >= 0 &&
		proof.sizeBytes <= WORKSPACE_ATTACHMENT_MAX_BYTES &&
		["sourceInstanceId", "workspaceInstanceId", "scopeId", "root", "rootIdentity"].every(
			(key) => typeof root[key] === "string" && !!root[key],
		) &&
		typeof root.fence === "number" &&
		Number.isSafeInteger(root.fence) &&
		root.fence >= 0
	);
}

async function hashStagedFile(
	path: string,
	sizeBytes: number,
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	const worker = new Worker(new URL("./workspace-attachment-hash-worker.ts", import.meta.url).href);
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (error?: Error, digest?: string) => {
			if (done) return;
			done = true;
			signal.removeEventListener("abort", abort);
			worker.terminate();
			if (error) reject(error);
			else if (digest) resolve(digest);
			else reject(new Error("Attachment hash missing"));
		};
		const abort = () =>
			finish(
				signal.reason instanceof Error ? signal.reason : new Error("Attachment hashing cancelled"),
			);
		worker.onerror = (event) => finish(new Error(event.message || "Attachment hash worker failed"));
		worker.onmessage = (event: MessageEvent<{ digest?: string; error?: string }>) => {
			if (event.data.error) finish(new Error(event.data.error));
			else if (/^[a-f0-9]{64}$/.test(event.data.digest ?? "")) finish(undefined, event.data.digest);
			else finish(new Error("Attachment hash worker returned invalid digest"));
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		else worker.postMessage({ path, sizeBytes });
	});
}

function assertStatus(status: WorkspaceAttachmentStatus, intent: WorkspaceAttachmentIntent): void {
	if (
		!sameBinding(status.binding, intent.binding) ||
		status.operationId !== intent.operationId ||
		status.requestDigest !== intent.requestDigest ||
		status.path !== intent.path ||
		!Number.isSafeInteger(status.writtenBytes) ||
		status.writtenBytes < 0 ||
		status.writtenBytes > intent.sizeBytes
	)
		throw new Error("Attachment primitive changed its admitted intent");
	if (status.state === "conflict" || status.state === "unknown" || status.state === "cleaned")
		throw new Error(`Attachment primitive returned ${status.state}; retain operation evidence`);
}
function assertProof(
	proof: unknown,
	intent: WorkspaceAttachmentIntent,
): asserts proof is WorkspaceAttachmentCreationProof {
	if (
		!isWorkspaceAttachmentProof(proof) ||
		!sameBinding(proof.binding, intent.binding) ||
		proof.operationId !== intent.operationId ||
		proof.requestDigest !== intent.requestDigest ||
		proof.path !== intent.path ||
		proof.digest !== intent.digest ||
		proof.sizeBytes !== intent.sizeBytes
	)
		throw new Error("Attachment receipt does not prove the original exclusive creation");
}

/** 100 MiB bounded streaming, followed by the publisher's actual creation receipt. */
export async function createWorkspaceAttachmentFromStagedFile(input: {
	target: WorkspaceAttachmentTarget;
	operationId: string;
	path: string;
	stagedFilePath: string;
	sizeBytes: number;
	signal: AbortSignal;
	authorize(): Promise<void>;
}): Promise<WorkspaceAttachmentCreationProof> {
	const { target, signal } = input;
	if (!target.backend.supportsWorkspaceAttachment)
		throw new Error("Native workspace.attachment.v1 creation receipts are unavailable");
	if (
		!Number.isSafeInteger(input.sizeBytes) ||
		input.sizeBytes < 0 ||
		input.sizeBytes > WORKSPACE_ATTACHMENT_MAX_BYTES ||
		!input.path ||
		input.path.startsWith("/") ||
		input.path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
	)
		throw new Error("Invalid bounded attachment creation target");
	await input.authorize();
	signal.throwIfAborted();
	const digest = await hashStagedFile(input.stagedFilePath, input.sizeBytes, signal);
	const binding = Object.freeze({ ...target.binding });
	const requestDigest = createHash("sha256")
		.update(
			JSON.stringify({
				binding,
				operationId: input.operationId,
				path: input.path,
				sizeBytes: input.sizeBytes,
				digest,
				expected: "absent",
				noOverwrite: true,
			}),
		)
		.digest("hex");
	const intent: WorkspaceAttachmentIntent = {
		binding,
		operationId: input.operationId,
		requestDigest,
		path: input.path,
		sizeBytes: input.sizeBytes,
		digest,
		expected: "absent",
		noOverwrite: true,
	};
	await input.authorize();
	signal.throwIfAborted();
	let status = await target.backend.workspaceAttachment("begin", intent, signal);
	assertStatus(status, intent);
	if (status.state !== "committed") {
		const source = await open(input.stagedFilePath, "r");
		try {
			const buffer = Buffer.allocUnsafe(WORKSPACE_ATTACHMENT_CHUNK_BYTES);
			let offset = status.writtenBytes;
			while (offset < input.sizeBytes) {
				await input.authorize();
				signal.throwIfAborted();
				const read = await source.read(
					buffer,
					0,
					Math.min(buffer.length, input.sizeBytes - offset),
					offset,
				);
				if (read.bytesRead < 1)
					throw new Error("Staged attachment ended before its admitted length");
				const bytes = buffer.subarray(0, read.bytesRead);
				status = await target.backend.workspaceAttachment(
					"append",
					{
						binding,
						operationId: intent.operationId,
						requestDigest,
						offset,
						contentBase64: bytes.toString("base64"),
						chunkDigest: createHash("sha256").update(bytes).digest("hex"),
					},
					signal,
				);
				assertStatus(status, intent);
				if (status.state !== "pending" || status.writtenBytes !== offset + bytes.length)
					throw new Error("Attachment chunk receipt did not acknowledge exact bytes");
				offset += bytes.length;
			}
		} finally {
			await source.close();
		}
		await input.authorize();
		signal.throwIfAborted();
		status = await target.backend.workspaceAttachment(
			"commit",
			{ binding, operationId: intent.operationId, requestDigest },
			signal,
		);
		assertStatus(status, intent);
	}
	if (status.state !== "committed" || status.writtenBytes !== input.sizeBytes)
		throw new Error(
			"Attachment creation is unknown; retain evidence and never plain-delete its path",
		);
	assertProof(status.proof, intent);
	return Object.freeze(structuredClone(status.proof));
}

/** Only the native primitive compares/detaches/deletes. No fresh hash or plain unlink here. */
export async function cleanupWorkspaceAttachmentByProof(input: {
	target: WorkspaceAttachmentTarget;
	proof: WorkspaceAttachmentCreationProof;
	operationId: string;
	signal: AbortSignal;
	authorize(): Promise<void>;
}): Promise<WorkspaceAttachmentCleanup> {
	if (
		!isWorkspaceAttachmentProof(input.proof) ||
		!sameStableSource(input.target.binding, input.proof.binding) ||
		!input.target.backend.supportsWorkspaceAttachment
	)
		throw new Error("Original attachment creation binding/proof is unavailable or stale");
	const proof = Object.freeze(structuredClone(input.proof));
	const requestDigest = createHash("sha256")
		.update(JSON.stringify({ operationId: input.operationId, proof }))
		.digest("hex");
	await input.authorize();
	input.signal.throwIfAborted();
	const result = await input.target.backend.workspaceAttachment(
		"cleanup",
		{ binding: input.target.binding, operationId: input.operationId, requestDigest, proof },
		input.signal,
	);
	if (
		!sameBinding(result.binding, input.target.binding) ||
		result.operationId !== input.operationId ||
		result.requestDigest !== requestDigest ||
		!["deleted", "already_deleted", "conflict", "unknown"].includes(result.outcome)
	)
		throw new Error("Conditional attachment cleanup returned an unbound/unknown result");
	return result;
}
