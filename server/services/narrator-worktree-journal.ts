import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, opendir, rename } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { WorktreeCreateResult } from "@shared/narrator-worktrees";
import { AppError } from "../lib/errors";
import type { WorktreeCreateRequest } from "../lib/validators/narrator-worktrees";

const MAX_RECORD_BYTES = 32 * 1024;
const MAX_CLEANUP_RECEIPTS = 512;

/** Compatibility inventory for worktrees created before the resource registry existed.
 * Incomplete, unreadable, oversized or concurrently-written evidence protects ALL candidates.
 * This is a bounded scan, never a bounded set interpreted as complete ownership evidence.
 */
export async function readWorktreeReceiptProtection(
	directory: string,
): Promise<{ complete: boolean; paths: Set<string> }> {
	const paths = new Set<string>();
	const started = performance.now();
	try {
		const stat = await lstat(directory).catch((cause) => {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw cause;
		});
		if (!stat) return { complete: true, paths };
		if (stat.isSymbolicLink() || !stat.isDirectory()) return { complete: false, paths };
		let count = 0;
		for await (const entry of await opendir(directory)) {
			if (++count > MAX_CLEANUP_RECEIPTS || performance.now() - started > 5000)
				return { complete: false, paths };
			if (!/^[a-f0-9]{64}\.json$/.test(entry.name) || !entry.isFile())
				return { complete: false, paths };
			const file = await open(
				join(directory, entry.name),
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				const metadata = await file.stat();
				if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES)
					return { complete: false, paths };
				const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
				const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
				if (bytesRead > MAX_RECORD_BYTES) return { complete: false, paths };
				const record = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
				if (
					typeof record.destination !== "string" ||
					record.destination.length > 4096 ||
					!isAbsolute(record.destination) ||
					normalize(record.destination) !== record.destination
				)
					return { complete: false, paths };
				paths.add(record.destination);
			} finally {
				await file.close();
			}
		}
		return { complete: true, paths };
	} catch {
		return { complete: false, paths };
	}
}

export type { WorktreeCreateResult, WorktreeEntry } from "@shared/narrator-worktrees";
export interface WorktreeJournalRecord {
	proposalHash: string;
	request: WorktreeCreateRequest;
	repositoryKey: string;
	/** Server-side actor and execution-device binding, never accepted from client input. */
	actorKey?: string;
	deviceId?: string;
	destination: string;
	expectedHead: string;
	/** Resolved once before dispatch; original request stays unchanged for proposal hashing. */
	branchName?: string;
	commandSucceeded?: boolean;
	result?: WorktreeCreateResult;
}
export interface WorktreeJournal {
	/** Bounded read only: never creates a receipt/directory or claims an absent requestId. */
	read(narratorId: string, requestId: string): Promise<WorktreeJournalRecord | null>;
	claim(
		narratorId: string,
		requestId: string,
		record: WorktreeJournalRecord,
	): Promise<{
		fresh: boolean;
		record: WorktreeJournalRecord;
	}>;
	save(narratorId: string, requestId: string, record: WorktreeJournalRecord): Promise<void>;
}

export function worktreeProposalHash(request: WorktreeCreateRequest): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				request.expectedRevision,
				request.workspaceKey,
				request.destinationPath,
				request.branch.kind,
				request.branch.name,
				request.baseRef ?? null,
			]),
		)
		.digest("hex");
}

/** Private, persistent receipts: pending is never interpreted as permission to retry Git. */
export class FileWorktreeJournal implements WorktreeJournal {
	constructor(private readonly directory: string) {}

	private path(narratorId: string, requestId: string) {
		const key = createHash("sha256")
			.update(JSON.stringify([narratorId, requestId]))
			.digest("hex");
		return join(this.directory, `${key}.json`);
	}

	private async prepare() {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		// Refuse a replaced receipt directory; Windows cannot open directory descriptors.
		const directoryStat = await lstat(this.directory);
		if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
			throw new Error("Invalid worktree receipt directory");
		if (process.platform === "win32") return;
		const handle = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			if (!(await handle.stat()).isDirectory())
				throw new Error("Invalid worktree receipt directory");
		} finally {
			await handle.close();
		}
	}

	async read(narratorId: string, requestId: string): Promise<WorktreeJournalRecord | null> {
		const directory = await lstat(this.directory).catch((cause) => {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw cause;
		});
		if (!directory) return null;
		if (directory.isSymbolicLink() || !directory.isDirectory())
			throw new Error("Invalid worktree receipt directory");
		const path = this.path(narratorId, requestId);
		const file = await lstat(path).catch((cause) => {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw cause;
		});
		if (!file) return null;
		if (file.isSymbolicLink() || !file.isFile()) throw new Error("Invalid worktree receipt file");
		const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await existing.stat();
			if (!stat.isFile() || stat.size > MAX_RECORD_BYTES)
				throw new Error("Receipt exceeds byte budget");
			const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
			const { bytesRead } = await existing.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_RECORD_BYTES) throw new Error("Receipt exceeds byte budget");
			return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as WorktreeJournalRecord;
		} finally {
			await existing.close();
		}
	}

	async claim(narratorId: string, requestId: string, record: WorktreeJournalRecord) {
		await this.prepare();
		const path = this.path(narratorId, requestId);
		let handle: FileHandle;
		try {
			handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const saved = await this.read(narratorId, requestId);
			if (!saved) throw new Error("Worktree receipt disappeared during replay");
			if (saved.proposalHash !== record.proposalHash)
				throw new AppError(
					"requestId already belongs to another proposal",
					409,
					"WORKTREE_REQUEST_CONFLICT",
				);
			return { fresh: false, record: saved };
		}
		try {
			await handle.writeFile(this.encode(record));
			await handle.sync();
		} finally {
			await handle.close();
		}
		await this.syncDirectory();
		return { fresh: true, record };
	}

	private encode(record: WorktreeJournalRecord) {
		const json = JSON.stringify(record);
		if (Buffer.byteLength(json) > MAX_RECORD_BYTES) throw new Error("Receipt exceeds byte budget");
		return json;
	}

	private async syncDirectory() {
		// Windows does not support fsync on directory descriptors. File fsync still applies.
		if (process.platform === "win32") return;
		const handle = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	async save(narratorId: string, requestId: string, record: WorktreeJournalRecord) {
		await this.prepare();
		const path = this.path(narratorId, requestId);
		const temporary = `${path}.${randomUUID()}.pending`;
		const handle = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			0o600,
		);
		try {
			await handle.writeFile(this.encode(record));
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		await this.syncDirectory();
	}
}
