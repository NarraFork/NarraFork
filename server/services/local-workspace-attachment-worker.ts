import { createHash, randomBytes } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
	type FileHandle,
	lstat,
	mkdir,
	open,
	opendir,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	WORKSPACE_ATTACHMENT_CHUNK_BYTES,
	WORKSPACE_ATTACHMENT_MAX_BYTES,
	type WorkspaceAttachmentBinding,
	type WorkspaceAttachmentCleanup,
	type WorkspaceAttachmentCreationProof,
	type WorkspaceAttachmentIntent,
	type WorkspaceAttachmentOperation,
	type WorkspaceAttachmentOperations,
	type WorkspaceAttachmentStatus,
} from "@shared/workspace-attachment-protocol";
import {
	acquireLocalAttachmentMutation,
	attachmentMetadataDigest,
	attachmentObjectIdentity,
	attachmentSameStamp,
	localAttachmentNativeSupported,
	nativeAttachmentMetadata,
	quarantineLocalAttachmentNoReplace,
} from "./local-workspace-attachment-native";

export interface LocalAttachmentWorkerRequest {
	id: number;
	operation: WorkspaceAttachmentOperation;
	request: WorkspaceAttachmentOperations[WorkspaceAttachmentOperation]["request"];
	binding: WorkspaceAttachmentBinding;
	privateRoot: string;
	cancel: SharedArrayBuffer;
	deadline: number;
}
export type LocalAttachmentWorkerResponse =
	| { type: "ready"; supported: boolean }
	| { type: "guard"; id: number; guardId: number; path: string }
	| {
			type: "result";
			id: number;
			result?: WorkspaceAttachmentStatus | WorkspaceAttachmentCleanup;
			error?: string;
	  };
interface RecordEntry {
	intent: WorkspaceAttachmentIntent;
	status: WorkspaceAttachmentStatus;
	chunks: Record<string, string>;
	metadata?: string;
	cleanup?: WorkspaceAttachmentCleanup;
}
const JOURNAL_BYTES = 512 * 1024;
const PRIVATE_BYTES = 512 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const guardReplies = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
let nextGuard = 1;

function contained(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function sameBinding(a: WorkspaceAttachmentBinding, b: WorkspaceAttachmentBinding): boolean {
	return (
		a.sourceInstanceId === b.sourceInstanceId &&
		a.workspaceInstanceId === b.workspaceInstanceId &&
		a.scopeId === b.scopeId &&
		a.root === b.root &&
		a.rootIdentity === b.rootIdentity &&
		a.fence === b.fence
	);
}
function sameNamespace(a: WorkspaceAttachmentBinding, b: WorkspaceAttachmentBinding): boolean {
	return (
		a.sourceInstanceId === b.sourceInstanceId &&
		a.workspaceInstanceId === b.workspaceInstanceId &&
		a.scopeId === b.scopeId &&
		a.root === b.root &&
		a.rootIdentity === b.rootIdentity
	);
}
function sameProof(
	a: WorkspaceAttachmentCreationProof,
	b: WorkspaceAttachmentCreationProof,
): boolean {
	return (
		sameBinding(a.binding, b.binding) &&
		a.version === b.version &&
		a.state === b.state &&
		a.operationId === b.operationId &&
		a.requestDigest === b.requestDigest &&
		a.path === b.path &&
		a.sizeBytes === b.sizeBytes &&
		a.digest === b.digest &&
		a.incarnation === b.incarnation &&
		a.nativeMetadataDigest === b.nativeMetadataDigest &&
		a.creationProof === b.creationProof &&
		a.createdAt === b.createdAt
	);
}
function regular(stat: BigIntStats) {
	if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(WORKSPACE_ATTACHMENT_MAX_BYTES))
		throw new Error("Attachment requires a bounded single-link regular referent");
	attachmentObjectIdentity(stat);
}
async function syncDirectory(path: string) {
	const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
	try {
		await file.sync();
	} finally {
		await file.close();
	}
}
async function privateRecord(path: string): Promise<RecordEntry | undefined> {
	let file: FileHandle;
	try {
		file = await open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const before = await file.stat({ bigint: true });
		regular(before);
		if (before.size > BigInt(JOURNAL_BYTES)) throw new Error("Attachment receipt metadata budget");
		const bytes = Buffer.alloc(Number(before.size));
		let offset = 0;
		while (offset < bytes.length) {
			const read = await file.read(bytes, offset, bytes.length - offset, offset);
			if (!read.bytesRead) throw new Error("Attachment private receipt changed");
			offset += read.bytesRead;
		}
		if (!attachmentSameStamp(before, await file.stat({ bigint: true })))
			throw new Error("Attachment private receipt changed");
		const record = JSON.parse(bytes.toString()) as RecordEntry;
		record.chunks ??= {};
		return record;
	} finally {
		await file.close();
	}
}
async function saveRecord(path: string, record: RecordEntry) {
	const bytes = Buffer.from(JSON.stringify(record));
	if (bytes.length > JOURNAL_BYTES) throw new Error("Attachment receipt metadata budget");
	const temp = join(dirname(path), `.pending-${randomBytes(16).toString("hex")}`);
	const file = await open(
		temp,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
		0o600,
	);
	try {
		let offset = 0;
		while (offset < bytes.length) {
			const written = await file.write(bytes, offset, bytes.length - offset, offset);
			if (!written.bytesWritten) throw new Error("Private attachment receipt write stopped");
			offset += written.bytesWritten;
		}
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temp, path);
	await syncDirectory(dirname(path));
}
async function ensurePrivate(root: string, binding: WorkspaceAttachmentBinding) {
	if (!isAbsolute(root) || contained(binding.root, root))
		throw new Error("Attachment private receipts must be outside the user workspace");
	await mkdir(root, { recursive: true, mode: 0o700 });
	if ((await realpath(root)) !== root) throw new Error("Attachment private root contains an alias");
	const stat = await lstat(root, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077n) !== 0n)
		throw new Error("Attachment private root permissions are unsafe");
}
async function rootAndAncestors(
	binding: WorkspaceAttachmentBinding,
	path: string,
	allowMissing: boolean,
) {
	if (!isAbsolute(binding.root) || (await realpath(binding.root)) !== binding.root)
		throw new Error("Attachment root is not canonical");
	const root = await lstat(binding.root, { bigint: true });
	if (
		!root.isDirectory() ||
		root.isSymbolicLink() ||
		attachmentObjectIdentity(root) !== binding.rootIdentity
	)
		throw new Error("Attachment original root incarnation changed");
	if (!contained(binding.root, path) || path === binding.root)
		throw new Error("Attachment path escapes its real root");
	const dirs: string[] = [];
	for (let p = dirname(path); p !== binding.root; p = dirname(p)) {
		if (dirs.length >= 128 || !contained(binding.root, p))
			throw new Error("Attachment parent depth limit");
		dirs.push(p);
	}
	for (const parent of dirs.reverse()) {
		try {
			const stat = await lstat(parent, { bigint: true });
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new Error("Attachment parent is not a real directory");
		} catch (error) {
			if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
	}
}
function targetPath(binding: WorkspaceAttachmentBinding, path: string): string {
	if (
		!path ||
		isAbsolute(path) ||
		path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
	)
		throw new Error("Attachment path must be a clean relative file path");
	const target = resolve(binding.root, path);
	if (!contained(binding.root, target) || target === binding.root)
		throw new Error("Attachment path escaped its namespace");
	return target;
}
async function hashFile(
	file: FileHandle,
	check: () => void,
): Promise<{ digest: string; stat: BigIntStats }> {
	const before = await file.stat({ bigint: true });
	regular(before);
	const digest = createHash("sha256");
	const bytes = Buffer.allocUnsafe(WORKSPACE_ATTACHMENT_CHUNK_BYTES);
	let offset = 0;
	while (offset < Number(before.size)) {
		check();
		const read = await file.read(
			bytes,
			0,
			Math.min(bytes.length, Number(before.size) - offset),
			offset,
		);
		if (!read.bytesRead) throw new Error("Attachment changed during bounded hashing");
		digest.update(bytes.subarray(0, read.bytesRead));
		offset += read.bytesRead;
	}
	check();
	const after = await file.stat({ bigint: true });
	regular(after);
	if (!attachmentSameStamp(before, after))
		throw new Error("Attachment changed during bounded hashing");
	return { digest: digest.digest("hex"), stat: after };
}

async function execute(input: LocalAttachmentWorkerRequest) {
	const cancellation = new Int32Array(input.cancel);
	const check = () => {
		if (Atomics.load(cancellation, 0) || Date.now() > input.deadline)
			throw new Error(
				"Local attachment operation cancelled or timed out; dispatched evidence retained",
			);
	};
	const authorize = async (path: string) => {
		check();
		const guardId = nextGuard++;
		await new Promise<void>((resolveGuard, reject) => {
			const timer = setTimeout(
				() => {
					guardReplies.delete(guardId);
					reject(new Error("Local attachment authority deadline"));
				},
				Math.max(1, input.deadline - Date.now()),
			);
			guardReplies.set(guardId, {
				resolve: () => {
					clearTimeout(timer);
					resolveGuard();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			self.postMessage({
				type: "guard",
				id: input.id,
				guardId,
				path,
			} satisfies LocalAttachmentWorkerResponse);
		});
		check();
	};
	check();
	if (!localAttachmentNativeSupported())
		throw new Error(
			`Complete native local attachment metadata unsupported on ${process.platform}; no creation receipt or cleanup`,
		);
	if (!sameBinding(input.binding, input.request.binding))
		throw new Error("Attachment request changed its admitted real binding");
	await ensurePrivate(input.privateRoot, input.binding);
	const proof =
		input.operation === "cleanup"
			? (input.request as WorkspaceAttachmentOperations["cleanup"]["request"]).proof
			: undefined;
	const operationId = proof?.operationId ?? input.request.operationId;
	if (
		!operationId ||
		operationId.length > 256 ||
		!/^[a-f0-9]{64}$/.test(input.request.requestDigest)
	)
		throw new Error("Invalid attachment operation identity");
	const key = hash(`${input.binding.scopeId}\0${operationId}`);
	const recordPath = join(input.privateRoot, `${key}.json`);
	const partPath = join(input.privateRoot, `${key}.part`);
	const lockFile = await open(
		join(input.privateRoot, "publisher.lock"),
		constants.O_RDWR | constants.O_CREAT | NOFOLLOW,
		0o600,
	);
	const unlock = await acquireLocalAttachmentMutation(lockFile, check);
	try {
		let record = await privateRecord(recordPath);
		if (!record) {
			if (input.operation !== "begin")
				throw new Error("Original attachment publisher receipt is unavailable; target retained");
			const intent = input.request as WorkspaceAttachmentIntent;
			if (
				intent.expected !== "absent" ||
				intent.noOverwrite !== true ||
				!Number.isSafeInteger(intent.sizeBytes) ||
				intent.sizeBytes < 0 ||
				intent.sizeBytes > WORKSPACE_ATTACHMENT_MAX_BYTES ||
				!/^[a-f0-9]{64}$/.test(intent.digest)
			)
				throw new Error("Invalid exclusive bounded attachment intent");
			const target = targetPath(input.binding, intent.path);
			await authorize(target);
			await rootAndAncestors(input.binding, target, true);
			try {
				await lstat(target);
				throw new Error("Attachment target already exists; no overwrite");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const directory = await opendir(input.privateRoot);
			let entries = 0,
				bytes = 0;
			for await (const entry of directory) {
				if (++entries > 256) throw new Error("Private attachment operation count budget");
				const stat = await lstat(join(input.privateRoot, entry.name));
				bytes += stat.size;
				if (bytes + intent.sizeBytes > PRIVATE_BYTES)
					throw new Error("Private attachment staging byte quota");
			}
			const part = await open(
				partPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
				0o600,
			);
			try {
				await part.sync();
			} finally {
				await part.close();
			}
			record = {
				intent: structuredClone(intent),
				status: {
					binding: input.binding,
					operationId,
					requestDigest: intent.requestDigest,
					path: intent.path,
					writtenBytes: 0,
					state: "pending",
				},
				chunks: {},
			};
			await saveRecord(recordPath, record);
		}
		if (
			!(input.operation === "cleanup"
				? sameNamespace(record.intent.binding, input.binding) &&
					input.binding.fence >= record.intent.binding.fence
				: sameBinding(record.intent.binding, input.binding)) ||
			record.intent.operationId !== operationId
		)
			throw new Error("Attachment publisher namespace changed");
		if (
			input.operation !== "cleanup" &&
			record.intent.requestDigest !== input.request.requestDigest
		)
			throw new Error("Attachment original intent digest changed");
		const target = targetPath(input.binding, record.intent.path);
		await authorize(target);
		await rootAndAncestors(input.binding, target, true);
		if (input.operation === "begin") {
			const intent = input.request as WorkspaceAttachmentIntent;
			if (
				intent.path !== record.intent.path ||
				intent.digest !== record.intent.digest ||
				intent.sizeBytes !== record.intent.sizeBytes ||
				intent.expected !== "absent" ||
				intent.noOverwrite !== true
			)
				throw new Error("Attachment retry intent changed");
			return record.status;
		}
		if (input.operation === "status") return record.status;
		if (input.operation === "append") {
			if (record.status.state === "committed") return record.status;
			if (record.status.state !== "pending")
				throw new Error("Attachment stage is uncertain; retained");
			const request = input.request as WorkspaceAttachmentOperations["append"]["request"];
			if (request.contentBase64.length > Math.ceil(WORKSPACE_ATTACHMENT_CHUNK_BYTES / 3) * 4)
				throw new Error("Attachment chunk byte cap");
			const bytes = Buffer.from(request.contentBase64, "base64");
			if (
				bytes.length > WORKSPACE_ATTACHMENT_CHUNK_BYTES ||
				hash(bytes) !== request.chunkDigest ||
				!Number.isSafeInteger(request.offset) ||
				request.offset < 0
			)
				throw new Error("Attachment chunk digest/offset invalid");
			if (request.offset < record.status.writtenBytes) {
				if (record.chunks[String(request.offset)] !== request.chunkDigest)
					throw new Error("Attachment duplicate chunk conflict");
				return record.status;
			}
			if (
				request.offset !== record.status.writtenBytes ||
				request.offset + bytes.length > record.intent.sizeBytes
			)
				throw new Error("Attachment stage offset or size conflict");
			const file = await open(partPath, constants.O_WRONLY | NOFOLLOW);
			try {
				const stat = await file.stat({ bigint: true });
				regular(stat);
				if (stat.size !== BigInt(record.status.writtenBytes)) {
					record.status.state = "unknown";
					record.status.reason = "Unacknowledged stage suffix retained";
					await saveRecord(recordPath, record);
					throw new Error(record.status.reason);
				}
				check();
				let offset = 0;
				while (offset < bytes.length) {
					const write = await file.write(
						bytes,
						offset,
						bytes.length - offset,
						request.offset + offset,
					);
					if (!write.bytesWritten) throw new Error("Attachment stage write stopped");
					offset += write.bytesWritten;
				}
				await file.sync();
				record.chunks[String(request.offset)] = request.chunkDigest;
				record.status.writtenBytes += bytes.length;
				await saveRecord(recordPath, record);
				return record.status;
			} finally {
				await file.close();
			}
		}
		if (input.operation === "commit") {
			if (record.status.state === "committed") return record.status;
			if (
				record.status.state !== "pending" ||
				record.status.writtenBytes !== record.intent.sizeBytes
			)
				throw new Error("Attachment stage is incomplete or uncertain");
			const staged = await open(partPath, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
			try {
				const expected = await hashFile(staged, check);
				if (
					Number(expected.stat.size) !== record.intent.sizeBytes ||
					expected.digest !== record.intent.digest
				)
					throw new Error("Attachment complete staged digest mismatch");
				await authorize(target);
				await rootAndAncestors(input.binding, target, true);
				const parents: string[] = [];
				for (let parent = dirname(target); parent !== input.binding.root; parent = dirname(parent))
					parents.push(parent);
				if (parents.length > 32) throw new Error("Attachment parent creation budget");
				for (const parent of parents.reverse()) {
					await authorize(target);
					await rootAndAncestors(input.binding, target, true);
					try {
						await mkdir(parent, { mode: 0o700 });
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					}
					const stat = await lstat(parent);
					if (!stat.isDirectory() || stat.isSymbolicLink())
						throw new Error("Attachment parent changed");
				}
				await authorize(target);
				await rootAndAncestors(input.binding, target, false);
				record.status.state = "unknown";
				record.status.reason = "Exclusive publication dispatched; no unproven cleanup";
				await saveRecord(recordPath, record);
				// Existing guarded publisher contract: O_CREAT|O_EXCL|O_NOFOLLOW, never rename over a target.
				const output = await open(
					target,
					constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
					0o600,
				);
				try {
					const created = await output.stat({ bigint: true });
					regular(created);
					const bytes = Buffer.allocUnsafe(WORKSPACE_ATTACHMENT_CHUNK_BYTES);
					let offset = 0;
					while (offset < record.intent.sizeBytes) {
						check();
						const read = await staged.read(
							bytes,
							0,
							Math.min(bytes.length, record.intent.sizeBytes - offset),
							offset,
						);
						if (!read.bytesRead) throw new Error("Attachment staged file ended during copy");
						let written = 0;
						while (written < read.bytesRead) {
							const write = await output.write(
								bytes,
								written,
								read.bytesRead - written,
								offset + written,
							);
							if (!write.bytesWritten) throw new Error("Attachment publication write stopped");
							written += write.bytesWritten;
						}
						offset += read.bytesRead;
					}
					await output.sync();
					await authorize(target);
					await rootAndAncestors(input.binding, target, false);
					const after = await hashFile(output, check);
					const named = await lstat(target, { bigint: true });
					regular(named);
					if (
						attachmentObjectIdentity(created) !== attachmentObjectIdentity(after.stat) ||
						!attachmentSameStamp(after.stat, named) ||
						after.digest !== record.intent.digest ||
						Number(after.stat.size) !== record.intent.sizeBytes
					)
						throw new Error("Exclusive attachment referent changed; retained");
					const metadata = nativeAttachmentMetadata(output, after.stat);
					if (!attachmentSameStamp(after.stat, await output.stat({ bigint: true })))
						throw new Error("Attachment metadata changed after publication");
					const actualProof: WorkspaceAttachmentCreationProof = {
						version: 1,
						binding: input.binding,
						operationId,
						requestDigest: record.intent.requestDigest,
						path: record.intent.path,
						sizeBytes: record.intent.sizeBytes,
						digest: after.digest,
						incarnation: attachmentObjectIdentity(after.stat),
						nativeMetadataDigest: attachmentMetadataDigest(metadata),
						creationProof: randomBytes(32).toString("hex"),
						state: "committed",
						createdAt: new Date().toISOString(),
					};
					record.metadata = metadata;
					record.status.state = "committed";
					record.status.proof = actualProof;
					delete record.status.reason;
					await saveRecord(recordPath, record);
					await syncDirectory(dirname(target));
					return record.status;
				} finally {
					await output.close();
				}
			} finally {
				await staged.close();
			}
		}
		if (input.operation === "cleanup") {
			if (!proof || !record.status.proof || !sameProof(proof, record.status.proof))
				throw new Error("Original creation proof is missing or forged; file retained");
			const request = input.request as WorkspaceAttachmentOperations["cleanup"]["request"];
			const result = (
				outcome: WorkspaceAttachmentCleanup["outcome"],
				reason?: string,
			): WorkspaceAttachmentCleanup => ({
				binding: input.binding,
				operationId: request.operationId,
				requestDigest: request.requestDigest,
				outcome,
				...(reason ? { reason } : {}),
			});
			if (record.cleanup) {
				if (
					record.cleanup.operationId !== request.operationId ||
					record.cleanup.requestDigest !== request.requestDigest
				)
					throw new Error("Cleanup idempotency key changed");
				return { ...record.cleanup, binding: input.binding };
			}
			if (record.status.state !== "committed" || !record.metadata)
				return result("unknown", "Original publication is uncertain; retained");
			// All identity/bytes/metadata observations happen AFTER the common lock and the live authority handshake.
			await authorize(target);
			await rootAndAncestors(input.binding, target, false);
			let file: FileHandle;
			try {
				file = await open(target, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					return result("conflict", "Original created entry disappeared; no deletion proof");
				throw error;
			}
			try {
				const current = await hashFile(file, check);
				const named = await lstat(target, { bigint: true });
				regular(named);
				if (
					attachmentObjectIdentity(current.stat) !== proof.incarnation ||
					!attachmentSameStamp(current.stat, named) ||
					current.digest !== proof.digest ||
					Number(current.stat.size) !== proof.sizeBytes
				)
					return result("conflict", "Created incarnation or bytes changed; retained");
				if (nativeAttachmentMetadata(file, current.stat) !== record.metadata)
					return result("conflict", "Created native metadata changed; retained");
				await authorize(target);
				await rootAndAncestors(input.binding, target, false);
				const last = await lstat(target, { bigint: true });
				if (
					!attachmentSameStamp(current.stat, last) ||
					!attachmentSameStamp(last, await file.stat({ bigint: true }))
				)
					return result("conflict", "Created entry replaced before conditional detach; retained");
				const quarantine = join(input.privateRoot, `${key}.deleted`);
				quarantineLocalAttachmentNoReplace(target, quarantine);
				const moved = await lstat(quarantine, { bigint: true });
				regular(moved);
				if (
					attachmentObjectIdentity(moved) !== proof.incarnation ||
					moved.size !== current.stat.size ||
					moved.mode !== current.stat.mode
				) {
					record.status.state = "unknown";
					record.status.reason = "Foreign quarantine retained; no delete";
					await saveRecord(recordPath, record);
					return result("unknown", record.status.reason);
				}
				const held = await file.stat({ bigint: true });
				if (attachmentObjectIdentity(held) !== attachmentObjectIdentity(moved))
					return result("unknown", "Detached referent changed; quarantine retained");
				// Only the proven, detached referent is removed. Never unlink the user target path.
				await unlink(quarantine);
				record.status.state = "cleaned";
				record.cleanup = result("deleted");
				await saveRecord(recordPath, record);
				await syncDirectory(dirname(target));
				return record.cleanup;
			} finally {
				await file.close();
			}
		}
		throw new Error("Unknown attachment operation");
	} finally {
		unlock();
		await lockFile.close();
	}
}

self.postMessage({
	type: "ready",
	supported: localAttachmentNativeSupported(),
} satisfies LocalAttachmentWorkerResponse);
self.onmessage = async (
	event: MessageEvent<
		| LocalAttachmentWorkerRequest
		| { type: "guard_reply"; guardId: number; ok: boolean; error?: string }
	>,
) => {
	const message = event.data;
	if ("type" in message && message.type === "guard_reply") {
		const reply = guardReplies.get(message.guardId);
		if (!reply) return;
		guardReplies.delete(message.guardId);
		if (message.ok) reply.resolve();
		else reply.reject(new Error(message.error ?? "Local attachment authority denied"));
		return;
	}
	const request = message as LocalAttachmentWorkerRequest;
	try {
		self.postMessage({
			type: "result",
			id: request.id,
			result: await execute(request),
		} satisfies LocalAttachmentWorkerResponse);
	} catch (error) {
		self.postMessage(
			JSON.stringify({
				type: "result",
				id: request.id,
				error: error instanceof Error ? error.message : String(error),
			} satisfies LocalAttachmentWorkerResponse),
		);
	}
};
