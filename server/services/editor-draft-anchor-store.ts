import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	CreateEditorDraftAnchorInput,
	EditorDraftAnchorDescriptor,
	EditorDraftAnchorOperation,
} from "../../shared/editor-document";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

export const EDITOR_DRAFT_ANCHOR_LIMITS = {
	records: 128,
	bytes: 128 * 1024,
	queue: 64,
	stagedMs: 10 * 60_000,
	publishedMs: 7 * 86400_000,
	unknownMs: 30 * 86400_000,
	ioMs: 5000,
};
interface AnchorRecord extends EditorDraftAnchorDescriptor {
	published: boolean;
	createdAt: number;
	operations: EditorDraftAnchorOperation[];
	unverifiable: boolean;
}
interface Journal {
	version: 1;
	epoch: string;
	records: AnchorRecord[];
	digest: string;
}
const queues = new Map<string, { tail: Promise<unknown>; pending: number }>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () =>
	new AppError(
		"Draft recovery provenance is unavailable; no write was dispatched",
		503,
		"EDITOR_DRAFT_PROVENANCE_UNAVAILABLE",
	);
const missing = () =>
	new AppError(
		"Draft recovery coverage cannot be verified; keep this backup read-only",
		404,
		"EDITOR_DRAFT_ANCHOR_UNKNOWN",
	);
/** Tiny, bounded local v1 provenance only. This is neither a file capability nor a remote journal. */
export class EditorDraftAnchorStore {
	readonly root: string;
	constructor(
		root: string,
		readonly limits = EDITOR_DRAFT_ANCHOR_LIMITS,
		private now = Date.now,
	) {
		this.root = resolve(root);
	}
	private async serial<T>(run: () => Promise<T>): Promise<T> {
		let queue = queues.get(this.root);
		if (!queue) {
			queue = { tail: Promise.resolve(), pending: 0 };
			queues.set(this.root, queue);
		}
		if (queue.pending >= this.limits.queue) throw unavailable();
		queue.pending++;
		const started = this.now();
		const task = queue.tail
			.catch(() => {})
			.then(async () => {
				if (this.now() - started >= this.limits.ioMs) throw unavailable();
				return run();
			})
			.catch((error) => {
				if (error instanceof AppError) throw error;
				throw unavailable();
			});
		queue.tail = task;
		const owned = queue;
		void task
			.finally(() => {
				owned.pending--;
				if (!owned.pending && queues.get(this.root) === owned) queues.delete(this.root);
			})
			.catch(() => {});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				task,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(unavailable()), this.limits.ioMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
			if (this.now() - started > 100)
				logger.warn("Slow bounded editor draft provenance", { elapsedMs: this.now() - started });
		}
	}
	private async directory() {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const stat = await lstat(this.root);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			(process.platform !== "win32" &&
				((stat.mode & 0o077) !== 0 || (process.geteuid && stat.uid !== process.geteuid())))
		)
			throw unavailable();
		return `${stat.dev}:${stat.ino}`;
	}
	private async load(): Promise<Journal> {
		await this.directory();
		let file: Awaited<ReturnType<typeof open>>;
		try {
			file = await open(
				join(this.root, "anchors.json"),
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { version: 1, epoch: randomUUID(), records: [], digest: "" };
			throw unavailable();
		}
		try {
			const stat = await file.stat();
			if (
				!stat.isFile() ||
				stat.size > this.limits.bytes ||
				(process.platform !== "win32" && (stat.mode & 0o077) !== 0)
			)
				throw unavailable();
			const bytes = Buffer.alloc(this.limits.bytes + 1);
			let length = 0;
			while (length < bytes.length) {
				const read = await file.read(bytes, length, bytes.length - length, length);
				if (!read.bytesRead) break;
				length += read.bytesRead;
			}
			if (length > this.limits.bytes) throw unavailable();
			const journal = JSON.parse(bytes.subarray(0, length).toString("utf8")) as Journal;
			if (
				journal.version !== 1 ||
				typeof journal.epoch !== "string" ||
				!Array.isArray(journal.records) ||
				journal.records.length > this.limits.records ||
				journal.digest !== hash(JSON.stringify(journal.records)) ||
				journal.records.some(
					(row) =>
						!row ||
						typeof row.anchorId !== "string" ||
						typeof row.recoveryKey !== "string" ||
						typeof row.writerId !== "string" ||
						typeof row.resourceKey !== "string" ||
						!Number.isFinite(row.expiresAt) ||
						!Array.isArray(row.operations) ||
						row.operations.length > 8 ||
						typeof row.unverifiable !== "boolean" ||
						row.operations.some(
							(op) =>
								!op ||
								typeof op.operationId !== "string" ||
								!Number.isSafeInteger(op.snapshotRevision),
						) ||
						(row.status !== "no-dispatch" && row.status !== "query-first"),
				)
			)
				throw unavailable();
			return journal;
		} catch {
			throw unavailable();
		} finally {
			await file.close();
		}
	}
	/** Public only as an injectable persistence fault boundary; never accepts client paths. */
	async persist(journal: Journal) {
		const bytes = Buffer.from(
			JSON.stringify({ ...journal, digest: hash(JSON.stringify(journal.records)) }),
		);
		if (journal.records.length > this.limits.records || bytes.length > this.limits.bytes)
			throw new AppError(
				"Draft recovery metadata capacity exhausted",
				429,
				"EDITOR_DRAFT_ANCHOR_LIMIT",
			);
		const identity = await this.directory();
		const temporary = join(this.root, `anchor-${randomUUID()}.tmp`);
		let file: Awaited<ReturnType<typeof open>> | undefined;
		try {
			file = await open(temporary, "wx", 0o600);
			await file.writeFile(bytes);
			await file.sync();
			await file.close();
			file = undefined;
			if ((await this.directory()) !== identity) throw unavailable();
			await rename(temporary, join(this.root, "anchors.json"));
			if (process.platform !== "win32") {
				const directory = await open(this.root, constants.O_RDONLY);
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			}
		} finally {
			await file?.close().catch(() => {});
			await unlink(temporary).catch(() => {});
		}
	}
	private prune(journal: Journal) {
		journal.records = journal.records.filter((row) => row.expiresAt > this.now());
	}
	private public(row: AnchorRecord): EditorDraftAnchorDescriptor {
		const {
			published: _published,
			createdAt: _createdAt,
			operations: _operations,
			unverifiable: _unverifiable,
			...descriptor
		} = row;
		return descriptor;
	}
	private history(rows: AnchorRecord[], settled: readonly string[] = []) {
		const operations = new Map<string, EditorDraftAnchorOperation>();
		for (const row of rows)
			for (const operation of row.operations ?? [])
				if (operation.operationId && !settled.includes(operation.operationId))
					operations.set(operation.operationId, operation);
		if (operations.size > 8) throw unavailable();
		return [...operations.values()];
	}
	async pendingOperations(
		recoveryKey: string,
		writerId: string,
		resourceKey: string,
		modelLifetime: string,
	) {
		return this.serial(async () => {
			const journal = await this.load();
			this.prune(journal);
			return this.history(
				journal.records.filter(
					(row) =>
						row.recoveryKey === recoveryKey &&
						row.writerId === writerId &&
						row.resourceKey === resourceKey &&
						row.modelLifetime === modelLifetime,
				),
			);
		});
	}
	async create(
		recoveryKey: string,
		input: CreateEditorDraftAnchorInput,
		settled: readonly string[] = [],
	) {
		return this.serial(async () => {
			const journal = await this.load();
			this.prune(journal);
			if (
				journal.records.some(
					(row) =>
						row.recoveryKey === recoveryKey &&
						row.writerId === input.writerId &&
						row.resourceKey === input.resourceKey &&
						row.modelLifetime === input.modelLifetime &&
						row.retired,
				)
			)
				throw new AppError(
					"This draft writer was retired by explicit recovery; reopen the previous editor before saving",
					409,
					"EDITOR_DRAFT_WRITER_RETIRED",
				);
			const older = journal.records.filter(
				(row) =>
					row.recoveryKey === recoveryKey &&
					row.writerId === input.writerId &&
					row.resourceKey === input.resourceKey &&
					row.modelLifetime === input.modelLifetime,
			);
			const operations = this.history(older, settled);
			// Drop a settled input op entirely: push, unverifiable AND fallback must agree,
			// otherwise query-first + pending history silently resurrect from fallback alone.
			const liveInput =
				input.operation?.operationId && settled.includes(input.operation.operationId)
					? undefined
					: input.operation;
			if (
				liveInput?.operationId &&
				!operations.some((op) => op.operationId === liveInput.operationId)
			)
				operations.push({ ...liveInput });
			if (operations.length > 8) throw unavailable();
			const unverifiable =
				older.some((row) => row.unverifiable) || (!!liveInput && !liveInput.operationId);
			const operation = operations.at(-1) ?? liveInput;
			const row: AnchorRecord = {
				anchorId: randomUUID(),
				checkpointGeneration: randomUUID(),
				recoveryKey,
				resourceKey: input.resourceKey,
				writerId: input.writerId,
				revision: input.revision,
				modelLifetime: input.modelLifetime,
				status: operation || unverifiable ? "query-first" : "no-dispatch",
				...(operation ? { operation: { ...operation } } : {}),
				operations,
				unverifiable,
				retired: false,
				createdAt: this.now(),
				expiresAt: this.now() + this.limits.stagedMs,
				published: false,
			};
			journal.records.push(row);
			await this.persist(journal);
			await this.cleanOrphans();
			return this.public(row);
		});
	}
	async get(recoveryKey: string, anchorId: string) {
		return this.serial(async () => {
			const journal = await this.load();
			const row = journal.records.find(
				(row) =>
					row.anchorId === anchorId &&
					row.recoveryKey === recoveryKey &&
					row.expiresAt > this.now(),
			);
			if (!row) throw missing();
			return this.public(row);
		});
	}
	async publish(recoveryKey: string, anchorId: string) {
		return this.serial(async () => {
			const journal = await this.load();
			this.prune(journal);
			const row = journal.records.find(
				(row) => row.anchorId === anchorId && row.recoveryKey === recoveryKey,
			);
			if (!row) throw missing();
			row.published = true;
			row.expiresAt =
				this.now() +
				(row.status === "query-first" ? this.limits.unknownMs : this.limits.publishedMs);
			// Only this writer/resource's superseded pointers. Missing old anchors always fail closed.
			journal.records = journal.records.filter(
				(other) =>
					other === row ||
					other.recoveryKey !== recoveryKey ||
					other.writerId !== row.writerId ||
					other.resourceKey !== row.resourceKey ||
					other.modelLifetime !== row.modelLifetime ||
					other.retired,
			);
			await this.persist(journal);
			return this.public(row);
		});
	}
	async release(recoveryKey: string, anchorId: string) {
		return this.serial(async () => {
			const journal = await this.load();
			const row = journal.records.find(
				(row) => row.anchorId === anchorId && row.recoveryKey === recoveryKey,
			);
			if (!row || row.retired) return { released: false };
			journal.records = journal.records.filter((other) => other !== row);
			await this.persist(journal);
			return { released: true };
		});
	}
	async claim(recoveryKey: string, anchorId: string) {
		return this.serial(async () => {
			const journal = await this.load();
			this.prune(journal);
			const row = journal.records.find(
				(row) => row.anchorId === anchorId && row.recoveryKey === recoveryKey,
			);
			if (!row) throw missing();
			if (row.status === "no-dispatch") {
				row.retired = true;
				row.expiresAt = this.now() + this.limits.publishedMs;
				await this.persist(journal);
			}
			return this.public(row);
		});
	}
	async beforeDispatch(
		recoveryKey: string,
		writerId: string,
		resourceKey: string,
		modelLifetime: string,
		operation: EditorDraftAnchorOperation,
		settled: readonly string[] = [],
	) {
		return this.serial(async () => {
			const journal = await this.load();
			this.prune(journal);
			const covered = journal.records.filter(
				(row) =>
					row.recoveryKey === recoveryKey &&
					row.writerId === writerId &&
					row.resourceKey === resourceKey &&
					row.modelLifetime === modelLifetime,
			);
			if (!covered.length) throw unavailable();
			if (covered.some((row) => row.retired))
				throw new AppError(
					"The previous draft writer was retired by recovery; no write was dispatched",
					409,
					"EDITOR_DRAFT_WRITER_RETIRED",
				);
			const operations = this.history(covered, settled);
			if (!operations.some((op) => op.operationId === operation.operationId))
				operations.push({ ...operation });
			if (operations.length > 8) throw unavailable();
			for (const row of covered) {
				if (
					!row.operation?.operationId &&
					row.operation?.snapshotRevision === operation.snapshotRevision
				)
					row.unverifiable = false;
				row.status = "query-first";
				row.operation = { ...operation };
				row.operations = operations;
				row.expiresAt = this.now() + this.limits.unknownMs;
			}
			await this.persist(journal);
		});
	}
	private async cleanOrphans() {
		// Bounded metadata-only cleanup of this private journal's incomplete atomic replacements.
		const directory = await opendir(this.root, { bufferSize: 16 });
		let seen = 0;
		for await (const entry of directory) {
			if (++seen > 16) break;
			if (!/^anchor-[a-f0-9-]{36}\.tmp$/.test(entry.name)) continue;
			const path = join(this.root, entry.name);
			const stat = await lstat(path).catch(() => null);
			if (
				stat?.isFile() &&
				stat.size <= this.limits.bytes &&
				this.now() - stat.mtimeMs > this.limits.stagedMs
			)
				await unlink(path).catch(() => {});
		}
	}
}
