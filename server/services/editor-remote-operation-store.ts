import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
	EditorApplyResult,
	EditorHostReceiptRecord,
	EditorHostReceiptValue,
} from "../../shared/editor-provider-contracts";
import { FEATURE_EDITOR_HOST_RECEIPT_V1 } from "../lib/agent/execution/rpc-types";
import { getNarraforkHome } from "../lib/narrafork-home";
import {
	type EditorHelperResolver,
	EditorHelperSession,
	resolveEditorHelper,
} from "./editor-helper";

export type EditorDurableOperation = EditorHostReceiptRecord;
export interface EditorNativeReceiptStoreOptions {
	stateDir: string;
	root: string;
	resolveHelper?: EditorHelperResolver;
}
export const EDITOR_OPERATION_STORE_LIMITS = {
	records: 256,
	recordBytes: 16 * 1024,
	terminalMs: 10 * 60_000,
	ttlMs: 30 * 86400_000,
};
const MAX_BYTES = EDITOR_OPERATION_STORE_LIMITS.recordBytes;
/** Windows uses the verified helper's protected private directory/native persistence,
 * not Node mode bits or an invented POSIX directory fsync. */
export function editorReceiptStorageSupported(
	platform: NodeJS.Platform = process.platform,
	nativeHostFeature = false,
): boolean {
	return (
		platform === "linux" || platform === "darwin" || (platform === "win32" && nativeHostFeature)
	);
}
const validId = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value);
/** Immutable intent association, not another mutation journal/lock domain. No bodies or tokens.
 * Unknown receipts are never pruned as not-found; expiry makes recovery explicitly unavailable. */
export class EditorRemoteOperationStore {
	constructor(
		readonly root: string,
		readonly limits = EDITOR_OPERATION_STORE_LIMITS,
		private readonly native: EditorNativeReceiptStoreOptions | undefined = process.platform ===
		"win32"
			? { root: getNarraforkHome(), stateDir: join(getNarraforkHome(), "editor-native") }
			: undefined,
	) {}
	private async nativeCall<T>(
		method: "put" | "get" | "settle",
		params: object,
		signal?: AbortSignal,
	): Promise<T> {
		if (!this.native) throw new Error("Native receipt backend not selected");
		const session = await EditorHelperSession.open(
			this.native.resolveHelper ?? resolveEditorHelper,
			this.native.root,
			this.native.stateDir,
			`metadata-${randomUUID()}`,
			{ hostReceiptsDir: this.root, signal },
		);
		try {
			const capabilities = await session.capabilities();
			if (!capabilities.features.includes(FEATURE_EDITOR_HOST_RECEIPT_V1))
				throw new Error("Verified helper lacks native private Host receipt support");
			return await session.call<T>(`editor.hostReceipt.${method}`, params);
		} finally {
			await session.close();
		}
	}
	private async directory() {
		if (!editorReceiptStorageSupported())
			throw new Error("Host durable editor receipt storage is unsupported on this platform");
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const stat = await lstat(this.root);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			(process.platform !== "win32" &&
				((stat.mode & 0o077) !== 0 || (process.geteuid && stat.uid !== process.geteuid())))
		)
			throw new Error("Editor receipt directory is not private");
		return `${stat.dev}:${stat.ino}`;
	}
	private path(operationId: string) {
		if (!validId(operationId)) throw new Error("Invalid editor operation id");
		return join(this.root, `${operationId}.json`);
	}
	async put(value: EditorDurableOperation) {
		if (this.native) {
			if (value.receipt || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES)
				throw new Error("Invalid native editor intent metadata");
			const result = await this.nativeCall<{ ok: boolean }>("put", { value });
			if (!result?.ok) throw new Error("Native editor intent was not persisted");
			return;
		}
		const before = await this.directory();
		// Discover unsupported directory durability before creating any operation association.
		const probe = await open(this.root, constants.O_RDONLY);
		try {
			await probe.sync();
		} finally {
			await probe.close();
		}
		const bytes = Buffer.from(JSON.stringify(value));
		if (bytes.length > MAX_BYTES) throw new Error("Editor recovery metadata exceeds budget");
		let count = 0;
		const terminal: { path: string; mtime: number }[] = [];
		const entries = await opendir(this.root);
		try {
			let scanned = 0;
			for await (const entry of entries) {
				if (++scanned > this.limits.records + 2)
					throw new Error("Editor recovery inventory exceeds budget");
				if (!entry.isFile()) throw new Error("Unsafe editor recovery inventory");
				// Only a host-settled receipt is eligible; pending/unknown sole proof never expires into not-found.
				if (/^[a-zA-Z0-9_-]{1,128}\.json\.settled$/.test(entry.name)) {
					const path = join(this.root, entry.name),
						stat = await lstat(path);
					if (
						!stat.isSymbolicLink() &&
						stat.nlink === 1 &&
						Date.now() - stat.mtimeMs >= this.limits.terminalMs
					) {
						await unlink(path);
						continue;
					}
					if (!stat.isSymbolicLink() && stat.nlink === 1)
						terminal.push({ path, mtime: stat.mtimeMs });
				}
				count++;
			}
			if (count >= this.limits.records) {
				// Pressure shortens only the already-transferred terminal retention window.
				// Expired/not-found remains unknown, never permission to package/reapply an old op.
				terminal.sort((a, b) => a.mtime - b.mtime);
				for (const item of terminal.slice(0, 16)) {
					await unlink(item.path);
					count--;
				}
			}
			if (count >= this.limits.records)
				throw new Error("Editor recovery receipt capacity exceeded");
		} finally {
			await entries.close().catch(() => {});
		}
		const temporary = join(this.root, `.${randomUUID()}.pending`);
		const file = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		try {
			await file.writeFile(bytes);
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			if ((await this.directory()) !== before) throw new Error("Editor recovery directory changed");
			await link(temporary, this.path(value.operationId));
			const directory = await open(this.root, constants.O_RDONLY);
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} finally {
			await unlink(temporary).catch(() => {});
		}
	}
	/** Called only after host evidence + lease settlement, never on a mere transport success. */
	async markSettled(operationId: string, receipt: EditorApplyResult, signal?: AbortSignal) {
		signal?.throwIfAborted();
		if (this.native) {
			const result = await this.nativeCall<{ ok: boolean }>(
				"settle",
				{ operationId, receipt },
				signal,
			);
			if (!result?.ok) throw new Error("Native editor terminal proof was not persisted");
			return;
		}
		const record = await this.get(operationId);
		if (
			!record ||
			receipt.operationId !== operationId ||
			!["committed", "rejected"].includes(receipt.outcome) ||
			(receipt.outcome === "committed" &&
				(receipt.rawDigest !== record.rawDigest || receipt.totalBytes !== record.bytes))
		)
			throw new Error("Cannot take over unmatched editor proof");
		const directoryIdentity = await this.directory();
		const temporary = join(this.root, `.${randomUUID()}.pending`);
		const bytes = Buffer.from(JSON.stringify({ ...record, receipt }));
		if (bytes.length > MAX_BYTES) throw new Error("Terminal editor receipt budget exceeded");
		const file = await open(
			temporary,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		try {
			await file.writeFile(bytes);
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			if ((await this.directory()) !== directoryIdentity)
				throw new Error("Editor receipt directory changed");
			await rename(temporary, `${this.path(operationId)}.settled`);
			// Taking over sole proof requires directory durability too. Unsupported platforms
			// retain the executor's unacknowledged proof, never silently claim a durable ACK.
			const directory = await open(this.root, constants.O_RDONLY);
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
			await unlink(this.path(operationId)).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		} finally {
			await unlink(temporary).catch(() => {});
		}
	}
	private validate(value: EditorDurableOperation, operationId: string): EditorDurableOperation {
		if (
			!value ||
			value.version !== 1 ||
			value.operationId !== operationId ||
			!Number.isFinite(value.createdAt) ||
			value.createdAt > Date.now() ||
			Date.now() - value.createdAt > this.limits.ttlMs ||
			Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES ||
			![
				value.userId,
				value.narratorId,
				value.deviceId,
				value.hostOperationId,
				value.namespace,
				value.resourceKey,
				value.root,
				value.requestDigest,
				value.rawDigest,
			].every((s) => typeof s === "string" && s.length > 0 && s.length <= 8192) ||
			!Number.isSafeInteger(value.bytes) ||
			value.bytes < 0 ||
			value.bytes > 20 * 1024 * 1024 ||
			!value.identity ||
			value.identity.deviceId !== value.deviceId ||
			!/^[a-f0-9]{64}$/.test(value.rawDigest) ||
			!validId(value.leaseId) ||
			!validId(value.effectId) ||
			!value.saved ||
			!/^[a-f0-9]{64}$/.test(value.saved.hash) ||
			value.saved.bytes !== value.bytes ||
			!Number.isSafeInteger(value.saved.snapshotRevision) ||
			(value.saved.hashKind === "raw-sha256" && value.saved.hash !== value.rawDigest) ||
			(value.receipt &&
				(value.receipt.operationId !== operationId ||
					!["committed", "rejected"].includes(value.receipt.outcome) ||
					(value.receipt.outcome === "committed" &&
						(value.receipt.rawDigest !== value.rawDigest ||
							value.receipt.totalBytes !== value.bytes))))
		)
			throw new Error("Editor recovery record is invalid or expired; verify manually");
		return value;
	}
	async get(operationId: string, signal?: AbortSignal): Promise<EditorDurableOperation | null> {
		signal?.throwIfAborted();
		if (this.native) {
			const result = await this.nativeCall<EditorHostReceiptValue>("get", { operationId }, signal);
			return result?.value === null ? null : this.validate(result?.value, operationId);
		}
		await this.directory();
		let file: Awaited<ReturnType<typeof open>>;
		try {
			file = await open(
				`${this.path(operationId)}.settled`,
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				file = await open(this.path(operationId), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
		}
		try {
			const stat = await file.stat();
			if (
				!stat.isFile() ||
				stat.nlink !== 1 ||
				stat.size > MAX_BYTES ||
				(process.platform !== "win32" &&
					((stat.mode & 0o077) !== 0 || (process.geteuid && stat.uid !== process.geteuid())))
			)
				throw new Error("Unsafe editor recovery record");
			const bytes = Buffer.alloc(MAX_BYTES + 1);
			const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
			if (bytesRead > MAX_BYTES) throw new Error("Editor recovery record too large");
			const value = JSON.parse(bytes.subarray(0, bytesRead).toString()) as EditorDurableOperation;
			return this.validate(value, operationId);
		} finally {
			await file.close();
		}
	}
}
export function editorOperationNamespace(
	sourceInstanceId: string,
	userId: string,
	deviceId: string,
) {
	return createHash("sha256")
		.update(JSON.stringify(["editor-native-v1", sourceInstanceId, userId, deviceId]))
		.digest("hex");
}
