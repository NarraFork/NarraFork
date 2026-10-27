/**
 * 数据可移植性：导出 / 导入预览 / 导入 / 清空。
 *
 * 性能取向：导出用 `VACUUM INTO` 生成原生 SQLite 快照，导入用 `ATTACH` + 纯 SQL 合并
 * （`INSERT OR IGNORE ... SELECT`、行值 `UPDATE`），全程不把表数据搬进 JS 再逐行写回——
 * 请求历史与消息表可能有数十万行，SQLite 引擎内部完成合并比 JSON 往返快几个数量级。
 *
 * ZIP 内容：snapshot.db（原生快照）、providers.json（配置，非表）、manifest.json。
 * 会话冲突：预览阶段用 ATTACH 联查检出重复 id，由调用方决定覆盖或跳过。
 * 覆盖时保留会话行、用导入行更新列（messages.narrator_id 为 NOT NULL，删行会失败）。
 * 清空：分项（requests / sessions / providers）与全量；调用方先校验当前用户密码。
 *
 * ⚠️ 维护约定（修改 server/db/schema.ts 时必读）：
 * - 导出 = 整库快照，**新增表会自动导出**，无需改本文件；
 * - 导入 = 只合并 `copyTable` 里显式列举的表。新增需要跨机迁移的表必须在此补 `copyTable`，
 *   否则导入会静默丢数据；
 * - 新增 NOT NULL 且无默认值的列会让旧快照导入缺列（列交集只能拷贝双方都有的列），
 *   需要补默认值或拒绝旧版本；
 * - 新增需要「清空」的数据需在 `clearData` 对应分支处理；
 * - 改完跑 `bun test --isolate server/services/__tests__/data-portability*.test.ts`。
 * 详见 docs/DATA_PORTABILITY.md。
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, type FileHandle, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, inflateRawSync } from "node:zlib";
import { AppError, catalogError } from "@server/lib/errors";
import { generateShortId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { saveSettings, settings } from "@server/lib/settings";
import type { NarraForkSettings } from "@server/lib/settings/types";
import { MAX_IMPORT_BYTES, MAX_IMPORT_LABEL } from "@shared/storage-transfer";
import archiver from "archiver";
import { sqlite } from "../db";

const EXPORT_VERSION = 1;
const PREVIEW_TTL_MS = 30 * 60 * 1000;

/** 供应商配置里参与导出/导入的顶层字段。 */
const PROVIDER_KEYS = [
	"customApiProviders",
	"nugProviders",
	"codex",
	"tokendance",
	"commandCode",
] as const;

type ProviderKey = (typeof PROVIDER_KEYS)[number];
type ClearTarget = "requests" | "sessions" | "providers" | "all";

interface ImportPreview {
	token: string;
	snapshotPath: string;
	createdAt: number;
	/** 导出包里的供应商配置（小体量，直接随预览保存在内存）。 */
	providers: Partial<Record<ProviderKey, unknown>>;
	counts: { requests: number; sessions: number; providers: number };
	conflicts: Array<{ id: string; name: string; importedMessages: number }>;
	exportedAt?: string;
	version?: number;
}

const previews = new Map<string, ImportPreview>();

/** 清理过期预览（连同临时快照）。 */
function prunePreviews() {
	const now = Date.now();
	for (const [token, preview] of previews) {
		if (now - preview.createdAt > PREVIEW_TTL_MS) {
			previews.delete(token);
			void rm(preview.snapshotPath, { force: true }).catch(() => {});
		}
	}
}

// ── ZIP 读取（只读实现，避免引入额外依赖）─────────────────────────────────

/**
 * 条目索引：只记录位置与压缩方式，不读数据。
 *
 * 导出包里的 snapshot.db 可以有 GB 级，整份读进 Buffer 会把主线程内存打满，
 * 所以索引与数据分开：小条目（manifest/providers）整份读，快照流式解压到磁盘。
 */
interface ZipEntryIndex {
	method: number;
	compressedSize: number;
	dataStart: number;
}

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
/** 中央目录本身的上限：条目再多也不该到这个量级，超过即视为构造异常。 */
const MAX_ZIP_DIRECTORY_BYTES = 16 * 1024 * 1024;
/** manifest / providers 这类小条目允许整份读的上限。 */
const MAX_SMALL_ENTRY_BYTES = 16 * 1024 * 1024;

/** 读满缓冲区：`FileHandle.read` 与 write 一样可能只返回一部分字节。 */
async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
	let filled = 0;
	while (filled < buffer.byteLength) {
		const { bytesRead } = await handle.read(
			buffer,
			filled,
			buffer.byteLength - filled,
			position + filled,
		);
		if (bytesRead <= 0) throw catalogError("IMPORT_ZIP_INVALID");
		filled += bytesRead;
	}
}

/** 解析 ZIP 中央目录，返回 `条目名 → 位置`（支持 store / deflate）。 */
async function readZipIndex(zipPath: string): Promise<Map<string, ZipEntryIndex>> {
	const handle = await open(zipPath, "r");
	try {
		const { size } = await handle.stat();
		if (size < 22) throw catalogError("IMPORT_ZIP_INVALID");
		const tailSize = Math.min(size, 66_000);
		const tail = Buffer.allocUnsafe(tailSize);
		await readFully(handle, tail, size - tailSize);
		const eocdIndex = tail.lastIndexOf(EOCD_SIGNATURE);
		if (eocdIndex < 0) throw catalogError("IMPORT_ZIP_INVALID");
		const entryCount = tail.readUInt16LE(eocdIndex + 10);
		const dirOffset = tail.readUInt32LE(eocdIndex + 16);
		const dirLength = size - tailSize + eocdIndex - dirOffset;
		if (dirLength <= 0 || dirLength > MAX_ZIP_DIRECTORY_BYTES) {
			throw catalogError("IMPORT_ZIP_INVALID");
		}

		const directory = Buffer.allocUnsafe(dirLength);
		await readFully(handle, directory, dirOffset);

		const index = new Map<string, ZipEntryIndex>();
		let offset = 0;
		for (let i = 0; i < entryCount; i += 1) {
			if (directory.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) break;
			const method = directory.readUInt16LE(offset + 10);
			const compressedSize = directory.readUInt32LE(offset + 20);
			const nameLength = directory.readUInt16LE(offset + 28);
			const extraLength = directory.readUInt16LE(offset + 30);
			const commentLength = directory.readUInt16LE(offset + 32);
			const localOffset = directory.readUInt32LE(offset + 42);
			const name = directory.toString("utf8", offset + 46, offset + 46 + nameLength);
			offset += 46 + nameLength + extraLength + commentLength;
			if (name.endsWith("/")) continue;

			// 本地头的名字/extra 长度可能与中央目录不同，必须读它自己的那 30 字节
			const header = Buffer.allocUnsafe(30);
			await readFully(handle, header, localOffset);
			const localNameLength = header.readUInt16LE(26);
			const localExtraLength = header.readUInt16LE(28);
			index.set(name, {
				method,
				compressedSize,
				dataStart: localOffset + 30 + localNameLength + localExtraLength,
			});
		}
		return index;
	} finally {
		await handle.close();
	}
}

/** 读一个小条目（manifest.json / providers.json）并解压。 */
async function readSmallEntry(zipPath: string, entry: ZipEntryIndex): Promise<Buffer> {
	if (entry.compressedSize > MAX_SMALL_ENTRY_BYTES) throw catalogError("IMPORT_ZIP_INVALID");
	const handle = await open(zipPath, "r");
	try {
		const raw = Buffer.allocUnsafe(entry.compressedSize);
		await readFully(handle, raw, entry.dataStart);
		return entry.method === 0 ? raw : inflateRawSync(raw);
	} finally {
		await handle.close();
	}
}

/** 把条目流式解压到目标文件：内存占用与快照大小无关。 */
async function extractEntryToFile(
	zipPath: string,
	entry: ZipEntryIndex,
	destination: string,
): Promise<void> {
	const source = createReadStream(zipPath, {
		start: entry.dataStart,
		end: entry.dataStart + entry.compressedSize - 1,
	});
	const target = createWriteStream(destination);
	await (entry.method === 0
		? pipeline(source, target)
		: pipeline(source, createInflateRaw(), target));
}

// ── 导出 ─────────────────────────────────────────────────────────────────

export interface ExportCounts {
	requests: number;
	sessions: number;
	providers: number;
}

function countRowsIn(path: string | null, table: string): number {
	if (!path) {
		const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
		return Number(row.n);
	}
	const probe = new Database(path, { readonly: true });
	try {
		const row = probe.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
		return Number(row.n);
	} finally {
		probe.close();
	}
}

/** 导出/导入的类别选择。缺省即全选。 */
export interface TransferSelection {
	requests: boolean;
	sessions: boolean;
	providers: boolean;
}

export const ALL_DATA_KINDS: TransferSelection = {
	requests: true,
	sessions: true,
	providers: true,
};

/**
 * 按选择裁剪快照：`VACUUM INTO` 只能整库复制，未勾选的类别在这里删掉。
 *
 * 快照是临时文件，删行不涉及主库；关掉外键只为免去删表顺序的约束。
 */
function pruneSnapshot(snapshotPath: string, selection: TransferSelection): void {
	if (selection.requests && selection.sessions) return;
	const snapshot = new Database(snapshotPath);
	try {
		snapshot.run("PRAGMA foreign_keys = OFF");
		snapshot.transaction(() => {
			if (!selection.requests) snapshot.run("DELETE FROM api_requests");
			if (!selection.sessions) {
				snapshot.run("DELETE FROM narrator_message_refs");
				snapshot.run("DELETE FROM narrator_tool_calls");
				snapshot.run("DELETE FROM narrator_messages");
				snapshot.run("DELETE FROM narrators");
			}
		})();
	} finally {
		snapshot.close();
	}
}

/**
 * 导出一份 ZIP：`VACUUM INTO` 生成一致快照（SQLite 原生，不经过 JS 逐行序列化），
 * 再压缩进 ZIP。供应商配置与清单是小的 JSON 文件。
 */
export async function exportData(
	selection: TransferSelection = ALL_DATA_KINDS,
): Promise<{ zipPath: string; counts: ExportCounts }> {
	const dir = await mkdtemp(join(tmpdir(), "narrafork-export-"));
	const snapshotPath = join(dir, "snapshot.db");
	const zipPath = join(dir, "narrafork-export.zip");
	const output = createWriteStream(zipPath);
	const archive = archiver("zip", { zlib: { level: 1 } });
	try {
		// 原生快照：包含全部已提交数据（WAL 内容一并固化），单条 SQL、毫秒级。
		// `VACUUM INTO` 只读主库，导出失败不会对主库留下任何改动。
		sqlite.run("VACUUM INTO ?", [snapshotPath]);
		pruneSnapshot(snapshotPath, selection);

		const providers = selection.providers
			? collectProviders(settings)
			: ({} as Partial<Record<ProviderKey, unknown>>);
		// 计数从裁剪后的快照读，与实际导出的内容一致。
		const counts: ExportCounts = {
			requests: countRowsIn(snapshotPath, "api_requests"),
			sessions: countRowsIn(snapshotPath, "narrators"),
			providers: countProviders(providers),
		};

		const done = new Promise<void>((resolve, reject) => {
			output.on("close", () => resolve());
			output.on("error", reject);
			archive.on("error", reject);
		});
		archive.pipe(output);
		archive.file(snapshotPath, { name: "snapshot.db" });
		archive.append(JSON.stringify(providers, null, 2), {
			name: "providers.json",
		});
		archive.append(
			JSON.stringify(
				{ version: EXPORT_VERSION, exportedAt: new Date().toISOString(), counts },
				null,
				2,
			),
			{ name: "manifest.json" },
		);
		await archive.finalize();
		await done;
		// 快照本体已进 ZIP，无需保留
		void rm(snapshotPath, { force: true }).catch(() => {});
		return { zipPath, counts };
	} catch (error) {
		// 失败不留半成品：先断开输出流（Windows 上文件否则仍被占用），再整份清掉临时目录。
		try {
			archive.abort();
		} catch {
			// 已结束的归档 abort 会抛错
		}
		output.destroy();
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

function collectProviders(source: NarraForkSettings): Partial<Record<ProviderKey, unknown>> {
	const out: Partial<Record<ProviderKey, unknown>> = {};
	for (const key of PROVIDER_KEYS) {
		const value = source[key];
		if (value !== undefined) (out as Record<string, unknown>)[key] = value;
	}
	return out;
}

function countProviders(providers: Partial<Record<ProviderKey, unknown>>): number {
	let total = 0;
	if (Array.isArray(providers.customApiProviders)) total += providers.customApiProviders.length;
	if (Array.isArray(providers.nugProviders)) total += providers.nugProviders.length;
	for (const single of ["codex", "tokendance", "commandCode"] as const) {
		if (providers[single] !== undefined) total += 1;
	}
	return total;
}

// ── 导入预览 ─────────────────────────────────────────────────────────────

/** 校验导出的 manifest 版本是否可导入。 */
function assertVersion(manifest: Record<string, unknown> | undefined) {
	if (!manifest) return;
	const version = Number(manifest.version ?? 0);
	if (version > EXPORT_VERSION) {
		throw catalogError("IMPORT_VERSION_TOO_NEW", { version, supported: EXPORT_VERSION });
	}
}

/** 上传体边写盘边校验大小：GB 级导出包不进内存，超限立刻中断。 */
/**
 * 上传体边写盘边校验大小。
 *
 * `FileHandle.write` 可能只写入一部分字节，必须循环到写完——大包（数百 MB）里漏掉
 * 这一点会静默产出截断的 ZIP，随后表现为"缺少 snapshot.db"这种误导性错误。
 */
async function writeUploadToFile(
	stream: ReadableStream<Uint8Array>,
	path: string,
	expectedBytes?: number,
): Promise<number> {
	const handle = await open(path, "w");
	let total = 0;
	try {
		for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
			total += chunk.byteLength;
			if (total > MAX_IMPORT_BYTES) {
				throw catalogError("IMPORT_FILE_TOO_LARGE", { limit: MAX_IMPORT_LABEL });
			}
			const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			let written = 0;
			while (written < view.byteLength) {
				const result = await handle.write(view, written, view.byteLength - written);
				if (result.bytesWritten <= 0) throw new Error("Import upload write stalled");
				written += result.bytesWritten;
			}
		}
	} finally {
		await handle.close();
	}
	// 传输被中断时长度会短于声明值；此时不能拿截断的包去解析。
	if (expectedBytes !== undefined && total !== expectedBytes) {
		throw catalogError("IMPORT_ZIP_INVALID");
	}
	return total;
}

/**
 * 预检上传的导出 ZIP：只读中央目录，快照流式解压到磁盘，再用 ATTACH 联查冲突。
 * 快照留在临时目录，token 30 分钟内可用于执行导入。
 */
export async function previewImportFromStream(
	stream: ReadableStream<Uint8Array>,
	expectedBytes?: number,
): Promise<ImportPreview> {
	const dir = await mkdtemp(join(tmpdir(), "narrafork-import-"));
	const zipPath = join(dir, "upload.zip");
	try {
		const bytes = await writeUploadToFile(stream, zipPath, expectedBytes);
		// 排障线索：真实落地字节数是判断"前端上传格式/传输中断"的第一手证据。
		logger.info("Import upload received", {
			bytes,
			declared: expectedBytes ?? null,
		});
		return await buildImportPreview(zipPath, dir);
	} catch (error) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw error;
	} finally {
		void rm(zipPath, { force: true }).catch(() => {});
	}
}

/** 内存字节路径（测试与 CLI 使用）；大包走 `previewImportFromStream`。 */
export async function previewImport(upload: ArrayBuffer, fileName: string): Promise<ImportPreview> {
	if (!fileName.toLowerCase().endsWith(".zip")) {
		throw catalogError("IMPORT_FILE_REQUIRED");
	}
	const bytes = new Uint8Array(upload);
	if (bytes.byteLength > MAX_IMPORT_BYTES) {
		throw catalogError("IMPORT_FILE_TOO_LARGE", { limit: MAX_IMPORT_LABEL });
	}
	const dir = await mkdtemp(join(tmpdir(), "narrafork-import-"));
	const zipPath = join(dir, "upload.zip");
	try {
		await writeFile(zipPath, bytes);
		return await buildImportPreview(zipPath, dir);
	} catch (error) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw error;
	} finally {
		void rm(zipPath, { force: true }).catch(() => {});
	}
}

async function buildImportPreview(zipPath: string, dir: string): Promise<ImportPreview> {
	const index = await readZipIndex(zipPath);
	const snapshotEntry = index.get("snapshot.db");
	if (!snapshotEntry) {
		// 空索引通常意味着请求体不是 ZIP（例如旧前端发的 multipart 包装）。
		logger.warn("Import archive has no snapshot.db", {
			entries: [...index.keys()].slice(0, 10),
			entryCount: index.size,
		});
		throw catalogError("IMPORT_ENTRY_MISSING", { name: "snapshot.db" });
	}

	const manifestEntry = index.get("manifest.json");
	const manifest = manifestEntry
		? (JSON.parse((await readSmallEntry(zipPath, manifestEntry)).toString("utf8")) as Record<
				string,
				unknown
			>)
		: undefined;
	assertVersion(manifest);
	const providersEntry = index.get("providers.json");
	const providers = providersEntry
		? (JSON.parse((await readSmallEntry(zipPath, providersEntry)).toString("utf8")) as Partial<
				Record<ProviderKey, unknown>
			>)
		: {};

	const snapshotPath = join(dir, "snapshot.db");
	await extractEntryToFile(zipPath, snapshotEntry, snapshotPath);

	// ATTACH 快照到主库连接，联查冲突（单条 SQL，不把 id 集合搬进 JS）
	const attachName = `imp_${randomBytes(4).toString("hex")}`;
	sqlite.run(`ATTACH DATABASE ? AS ${attachName}`, [snapshotPath]);
	try {
		// 快照可能来自残缺/手工构造的包：先确认三类核心表存在，给可读错误
		for (const table of ["api_requests", "narrators", "narrator_messages"]) {
			const exists = sqlite
				.prepare(
					`SELECT 1 FROM ${attachName}.sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
				)
				.get(table);
			if (!exists) {
				throw catalogError("IMPORT_TABLE_MISSING", { table });
			}
		}
		const conflicts = sqlite
			.prepare(
				`SELECT i.id AS id, i.title AS title, i.message_count AS messageCount
				   FROM ${attachName}.narrators i
				   JOIN main.narrators m ON m.id = i.id`,
			)
			.all() as Array<{ id: string; title: string | null; messageCount: number | null }>;

		const counts = {
			requests: countRowsIn(snapshotPath, "api_requests"),
			sessions: countRowsIn(snapshotPath, "narrators"),
			providers: countProviders(providers),
		};
		const token = randomBytes(18).toString("base64url");
		const preview: ImportPreview = {
			token,
			snapshotPath,
			createdAt: Date.now(),
			providers,
			counts,
			conflicts: conflicts.map((row) => ({
				id: row.id,
				name: row.title || "(未命名会话)",
				importedMessages: Number(row.messageCount ?? 0),
			})),
			exportedAt: typeof manifest?.exportedAt === "string" ? manifest.exportedAt : undefined,
			version: manifest ? Number(manifest.version ?? EXPORT_VERSION) : undefined,
		};
		previews.set(token, preview);
		prunePreviews();
		return preview;
	} finally {
		try {
			sqlite.run(`DETACH DATABASE ${attachName}`);
		} catch {
			// 连接可能已关闭；忽略
		}
	}
}

export function getPreview(token: string): ImportPreview {
	const preview = previews.get(token);
	if (!preview) throw catalogError("IMPORT_PREVIEW_EXPIRED");
	return preview;
}

// ── 导入执行 ─────────────────────────────────────────────────────────────

export type ConflictDecision = "overwrite" | "skip";
export interface ImportOptions {
	/** 全部冲突的统一决策；也可按会话 id 给出逐条决策。 */
	conflictDefault?: ConflictDecision;
	conflictById?: Record<string, ConflictDecision>;
	/** 只导入选中的类别；缺省为全选。 */
	include?: Partial<TransferSelection>;
}

export interface ImportResult {
	requestsInserted: number;
	sessionsInserted: number;
	sessionsOverwritten: number;
	sessionsSkipped: number;
	/** 被其它唯一约束挡住、无法落库的会话数；它们的消息/引用/请求也没有导入。 */
	sessionsRejected: number;
	providersAdded: number;
	providersRenamed: number;
}

function changesOf(run: { changes?: number }): number {
	return Number(run.changes ?? 0);
}

/** 读取某库某表的列名（schema 为 "main" 或 ATTACH 别名）。 */
function tableColumns(schema: string, table: string): string[] {
	return (
		sqlite.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>
	).map((row) => row.name);
}

/** 导出包携带的表；其余表（projects/users/…）在目标库的存在性无法由导入保证。 */
const IMPORTED_TABLES = [
	"narrators",
	"narrator_messages",
	"narrator_message_refs",
	"narrator_tool_calls",
	"api_requests",
] as const;

/**
 * 该表指向「未导入表」的外键列 → 目标表。
 *
 * 由 schema 推导而不是手工维护清单：漏一张表就会在提交时炸成
 * `FOREIGN KEY constraint failed`，这份清单以前确实漏过两次。
 */
function absentForeignKeyColumns(table: string): Record<string, string> {
	const absent: Record<string, string> = {};
	const rows = sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
		from: string;
		table: string;
	}>;
	for (const fk of rows) {
		if (!(IMPORTED_TABLES as readonly string[]).includes(fk.table)) absent[fk.from] = fk.table;
	}
	return absent;
}

/** 列值表达式：被引用行存在则保留原值，否则置 NULL（NULL 本身也走 ELSE）。 */
function columnValue(name: string, absentFks?: Record<string, string>): string {
	const referencedTable = absentFks?.[name];
	return referencedTable
		? `CASE WHEN "${name}" IN (SELECT id FROM main."${referencedTable}") THEN "${name}" ELSE NULL END`
		: `"${name}"`;
}

/**
 * 提交前自检：只处理**本次新增**的行（rowid 高于导入前的最大值）。
 *
 * 目标库可能本来就存在历史悬空引用，那不是这次导入造成的，绝不能顺手改掉。新增行里
 * 仍指向缺失目标的：可空列置 NULL，NOT NULL 列删行——引用目标不存在时它本身没有意义。
 */
function repairDanglingReferences(baselines: Map<string, number>): void {
	const pendingViolations = () =>
		IMPORTED_TABLES.flatMap((table) =>
			(
				sqlite.prepare(`PRAGMA foreign_key_check(${table})`).all() as Array<{
					rowid: number;
					parent: string;
					fkid: number;
				}>
			)
				.filter((row) => row.rowid > (baselines.get(table) ?? 0))
				.map((row) => ({ ...row, table })),
		);

	for (let round = 0; round < 3; round += 1) {
		const violations = pendingViolations();
		if (violations.length === 0) return;

		let repaired = 0;
		for (const violation of violations) {
			const fks = sqlite.prepare(`PRAGMA foreign_key_list(${violation.table})`).all() as Array<{
				id: number;
				from: string;
			}>;
			const column = fks.find((fk) => fk.id === violation.fkid)?.from;
			if (!column) continue;
			try {
				repaired += changesOf(
					sqlite.run(`UPDATE main.${violation.table} SET "${column}" = NULL WHERE rowid = ?`, [
						violation.rowid,
					]),
				);
			} catch {
				repaired += changesOf(
					sqlite.run(`DELETE FROM main.${violation.table} WHERE rowid = ?`, [violation.rowid]),
				);
			}
		}
		logger.warn("Import repaired dangling references", {
			tables: [...new Set(violations.map((v) => `${v.table}->${v.parent}`))].slice(0, 20),
			count: violations.length,
			repaired,
		});
		if (repaired === 0) break;
	}

	const remaining = pendingViolations();
	if (remaining.length === 0) return;
	logger.error("Import has unresolvable dangling references", {
		details: [...new Set(remaining.map((v) => `${v.table}->${v.parent}`))].slice(0, 20),
	});
	throw new AppError("Import failed: unresolvable foreign key references (see server log)", 400);
}

/**
 * 解决 `handle_fold` 唯一冲突：入站会话与本地会话同名时给它换一个后缀。
 *
 * 这是跨实例导入最常见的失败点——两个实例里同一个用户用了同名 handle。
 * `INSERT OR IGNORE` 会静默跳过整个会话，它的消息/引用/请求随后全部悬空，
 * 提交时表现为一句莫名的 `FOREIGN KEY constraint failed`。改名后数据一条不丢。
 *
 * @returns 被改名的 `会话 id → 新 handle`
 */
function dedupeIncomingHandles(attachName: string, ids: string[]): Map<string, string> {
	const renamed = new Map<string, string>();
	const taken = new Set(
		(
			sqlite
				.prepare(`SELECT handle_fold FROM main.narrators WHERE handle_fold IS NOT NULL`)
				.all() as Array<{
				handle_fold: string;
			}>
		).map((row) => row.handle_fold),
	);
	for (const id of ids) {
		const row = sqlite
			.prepare(`SELECT handle, handle_fold FROM ${attachName}.narrators WHERE id = ?`)
			.get(id) as { handle: string | null; handle_fold: string | null } | undefined;
		const fold = row?.handle_fold ?? null;
		if (!fold) continue;
		if (!taken.has(fold)) {
			taken.add(fold);
			continue;
		}
		const base = row?.handle?.trim() || fold;
		for (let suffix = 2; suffix < 500; suffix += 1) {
			const candidate = `${base}-${suffix}`;
			const candidateFold = candidate.toLowerCase();
			if (taken.has(candidateFold)) continue;
			sqlite.run(`UPDATE ${attachName}.narrators SET handle = ?, handle_fold = ? WHERE id = ?`, [
				candidate,
				candidateFold,
				id,
			]);
			taken.add(candidateFold);
			renamed.set(id, candidate);
			break;
		}
	}
	return renamed;
}

/**
 * 以「两库列交集」把快照表整体追加进主库（`INSERT OR IGNORE`）。
 * 用交集而不是 `SELECT *`：快照与当前库可能因迁移进度不同而列数不一致。
 */
function copyTable(
	attachName: string,
	table: string,
	options?: {
		where?: { column: string; value: string };
		/** 按 `ABSENT_TARGET_FKS` 把指向未导入表的列置 NULL。 */
		nullAbsentFks?: boolean;
		/** 这些会话没能落库，它们的子行必须一起跳过，否则留下悬空引用。 */
		excludeNarrators?: string[];
		/** 无论目标库有没有对应行都置 NULL 的列（会话整类未导入时用）。 */
		forceNull?: string[];
	},
): number {
	const target = new Set(tableColumns("main", table));
	const shared = tableColumns(attachName, table).filter((name) => target.has(name));
	if (shared.length === 0) return 0;
	const cols = shared.map((name) => `"${name}"`).join(", ");
	const absentFks = options?.nullAbsentFks ? absentForeignKeyColumns(table) : undefined;
	const forcedNull = new Set(options?.forceNull ?? []);
	const select = shared
		.map((name) => (forcedNull.has(name) ? "NULL" : columnValue(name, absentFks)))
		.join(", ");
	const where = options?.where;
	const excluded = options?.excludeNarrators ?? [];
	const filters: string[] = [];
	const params: string[] = [];
	if (where) {
		filters.push(`"${where.column}" = ?`);
		params.push(where.value);
	}
	if (excluded.length > 0 && shared.includes("narrator_id")) {
		filters.push(
			`(narrator_id IS NULL OR narrator_id NOT IN (${excluded.map(() => "?").join(", ")}))`,
		);
		params.push(...excluded);
	}
	const clause = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
	return changesOf(
		sqlite.run(
			`INSERT OR IGNORE INTO main.${table} (${cols}) SELECT ${select} FROM ${attachName}.${table}${clause}`,
			params,
		),
	);
}

/**
 * 按预览 token 执行导入：全程用 SQLite 原生 SQL 合并。
 *
 * 请求历史按主键 `INSERT OR IGNORE` 追加；会话按冲突决策「UPDATE 现有行」或「跳过」，
 * 新会话直接插入；消息 `INSERT OR IGNORE`（fork 共享的消息被复用，不覆盖其它会话的内容）；
 * 引用与工具调用在覆盖时先删本会话旧行再插入。整个数据合并在一个事务里完成。
 */
export async function applyImport(token: string, options: ImportOptions): Promise<ImportResult> {
	const preview = getPreview(token);
	const result: ImportResult = {
		requestsInserted: 0,
		sessionsInserted: 0,
		sessionsOverwritten: 0,
		sessionsSkipped: 0,
		sessionsRejected: 0,
		providersAdded: 0,
		providersRenamed: 0,
	};

	await access(preview.snapshotPath).catch(() => {
		throw catalogError("IMPORT_SNAPSHOT_EXPIRED");
	});

	const attachName = `imp_${randomBytes(4).toString("hex")}`;
	sqlite.run(`ATTACH DATABASE ? AS ${attachName}`, [preview.snapshotPath]);
	try {
		// 覆盖列同样取交集（快照与主库可能列数不同）
		const incomingNarratorColumns = tableColumns(attachName, "narrators");
		const narratorColumns = tableColumns("main", "narrators").filter(
			(name) => name !== "id" && incomingNarratorColumns.includes(name),
		);
		const absentNarratorFks = absentForeignKeyColumns("narrators");
		const columnAssignments = narratorColumns
			.map((name) => {
				const value = columnValue(name, absentNarratorFks);
				return `"${name}" = (SELECT ${value} FROM ${attachName}.narrators WHERE id = main.narrators.id)`;
			})
			.join(", ");

		const transaction = sqlite.transaction(() => {
			const counts: ImportResult = {
				requestsInserted: 0,
				sessionsInserted: 0,
				sessionsOverwritten: 0,
				sessionsSkipped: 0,
				sessionsRejected: 0,
				providersAdded: 0,
				providersRenamed: 0,
			};
			// 批内互相引用（会话父子、消息↔引用）无法靠行序满足，统一延到提交时校验：
			// 提交仍失败就整批回滚，主库不会被改坏。
			sqlite.run("PRAGMA defer_foreign_keys = ON");

			const include = { ...ALL_DATA_KINDS, ...options.include };

			// 1) 会话：先解决 handle 重名。`INSERT OR IGNORE` 遇到 `idx_narrators_handle_fold`
			//    冲突会静默跳过整个会话，它的消息/引用/请求随后全部悬空——跨实例导入时两个
			//    实例里的同名 handle 极常见，改名后数据一条不丢。
			const incomingIds = include.sessions
				? (
						sqlite.prepare(`SELECT id FROM ${attachName}.narrators`).all() as Array<{ id: string }>
					).map((row) => row.id)
				: [];
			const renamedHandles = include.sessions
				? dedupeIncomingHandles(attachName, incomingIds)
				: new Map<string, string>();
			if (renamedHandles.size > 0) {
				logger.info("Import renamed conflicting narrator handles", {
					count: renamedHandles.size,
					samples: [...renamedHandles].slice(0, 5),
				});
			}

			// 自检只修本次新增的行：库里原有的悬空引用不是这次导入造成的，不能顺手动它们。
			const baselines = new Map<string, number>();
			for (const table of IMPORTED_TABLES) {
				const row = sqlite
					.prepare(`SELECT COALESCE(MAX(rowid), 0) AS baseline FROM main.${table}`)
					.get() as { baseline: number };
				baselines.set(table, Number(row.baseline));
			}

			const rejected: string[] = [];
			if (include.sessions) {
				const existing = new Set(
					(sqlite.prepare(`SELECT id FROM main.narrators`).all() as Array<{ id: string }>).map(
						(row) => row.id,
					),
				);
				for (const id of incomingIds) {
					const decision = options.conflictById?.[id] ?? options.conflictDefault ?? "skip";
					if (!existing.has(id)) {
						copyTable(attachName, "narrators", {
							where: { column: "id", value: id },
							nullAbsentFks: true,
						});
						// 仍被其它唯一约束挡住时，会话进不来，它的子行必须一起跳过。
						if (sqlite.prepare(`SELECT 1 FROM main.narrators WHERE id = ?`).get(id)) {
							counts.sessionsInserted += 1;
						} else {
							rejected.push(id);
						}
						continue;
					}
					if (decision === "skip") {
						counts.sessionsSkipped += 1;
						continue;
					}
					// 覆盖只更新会话行本身：删掉本地 refs/tool_calls 会级联抹掉其它表对它们的引用，
					// 也会丢掉导出之后本地新增的历史。合并语义不删除本地数据。
					sqlite.run(`UPDATE main.narrators SET ${columnAssignments} WHERE id = ?`, [id]);
					counts.sessionsOverwritten += 1;
				}
				counts.sessionsRejected = rejected.length;
				if (rejected.length > 0) {
					logger.warn("Import skipped narrators blocked by unique constraints", {
						count: rejected.length,
						ids: rejected.slice(0, 10),
					});
				}
			}

			// 2) 消息与引用/工具调用：全量追加（主键冲突跳过，保持 fork 共享语义）
			if (include.sessions) {
				copyTable(attachName, "narrator_messages", {
					nullAbsentFks: true,
					excludeNarrators: rejected,
				});
				copyTable(attachName, "narrator_message_refs", { excludeNarrators: rejected });
				copyTable(attachName, "narrator_tool_calls", {
					nullAbsentFks: true,
					excludeNarrators: rejected,
				});
			}

			// 3) 请求历史最后：它同时引用会话与消息，必须在两者就位后插入
			if (include.requests) {
				counts.requestsInserted = copyTable(attachName, "api_requests", {
					excludeNarrators: rejected,
					// 会话整类没有导入时，请求上的会话/消息引用必然悬空
					forceNull: include.sessions ? [] : ["narrator_id", "message_id"],
				});
			}

			// 4) 自检：只处理本次新增行，兜住无法预见的悬空引用（日志会写明表与数量）
			repairDanglingReferences(baselines);

			// 5) 供应商合并：`saveSettings` 是原子写（临时文件 + rename），放在事务末尾，
			// 失败时数据整批回滚，不会留下「数据进了、供应商没进」的半成品。
			if (include.providers) {
				const merge = mergeProviders(preview.providers);
				if (merge.changed) {
					const next = structuredClone(settings) as NarraForkSettings;
					for (const key of PROVIDER_KEYS) {
						if (merge.merged[key] !== undefined) {
							(next as unknown as Record<string, unknown>)[key] = merge.merged[key];
						}
					}
					saveSettings(next);
					counts.providersAdded = merge.added;
					counts.providersRenamed = merge.renamed;
					if (merge.skipped > 0) {
						// 同 apiKey + 同 baseUrl、单例已配置：默认不导入，避免出现改不动的重复项
						logger.info("Import skipped duplicate providers", { count: merge.skipped });
					}
				}
			}
			return counts;
		});
		// 实例刚启动时后台维护任务（完整性检查、FTS 重建）可能短暂持有写锁。导入是低频
		// 运维操作，短重试即可；不延长全局 busy_timeout——那会把主线程卡在锁等待里。
		// 计数由事务返回：重试时旧的一次已经被回滚，不能让计数叠加。
		for (let attempt = 1; ; attempt += 1) {
			try {
				Object.assign(result, transaction());
				break;
			} catch (error) {
				const code = (error as { code?: string } | null)?.code;
				const busy = code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
				if (!busy || attempt >= 3) throw error;
				await Bun.sleep(250 * attempt);
			}
		}
	} finally {
		try {
			sqlite.run(`DETACH DATABASE ${attachName}`);
		} catch {
			// 忽略
		}
	}

	previews.delete(token);
	void rm(preview.snapshotPath, { force: true }).catch(() => {});
	return result;
}

// ── 供应商合并 ───────────────────────────────────────────────────────────

/** 同一端点判定：同 apiKey + 同 baseUrl 即视为同一供应商（忽略结尾斜杠）。 */
function sameProvider(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const keyA = String(a.apiKey ?? "").trim();
	const keyB = String(b.apiKey ?? "").trim();
	if (!keyA || keyA !== keyB) return false;
	const url = (value: unknown) =>
		String(value ?? "")
			.trim()
			.replace(/\/+$/, "");
	return url(a.baseUrl) === url(b.baseUrl);
}

/** 列表内不重复的供应商 id：id 重复会让前端按 id 的编辑/删除串行到别的条目。 */
function uniqueProviderId(taken: Set<string>): string {
	for (;;) {
		const id = generateShortId();
		if (!taken.has(id)) return id;
	}
}

function mergeProviders(incoming: Partial<Record<ProviderKey, unknown>>): {
	merged: Partial<Record<ProviderKey, unknown>>;
	changed: boolean;
	added: number;
	renamed: number;
	skipped: number;
} {
	const current = structuredClone(settings) as NarraForkSettings;
	const merged: Partial<Record<ProviderKey, unknown>> = {};
	let changed = false;
	let added = 0;
	let renamed = 0;
	let skipped = 0;

	const listKeys = ["customApiProviders", "nugProviders"] as const;
	for (const key of listKeys) {
		const incomingList = incoming[key];
		if (!Array.isArray(incomingList) || incomingList.length === 0) continue;
		const currentList = [
			...(((current as unknown as Record<string, unknown>)[key] ?? []) as Array<
				Record<string, unknown>
			>),
		];
		const existingNames = new Set(currentList.map((item) => String(item.name ?? "")));
		const existingPrefixes = new Set(currentList.map((item) => String(item.prefix ?? "")));
		const existingIds = new Set(currentList.map((item) => String(item.id ?? "")));
		for (const item of incomingList as Array<Record<string, unknown>>) {
			const copy = { ...item };
			// 同一端点（同 apiKey + 同 baseUrl）已在本地：默认不导入，避免出现一堆
			// 内容相同、id 也相同的副本——那会让整个供应商列表无法编辑。
			if (currentList.some((existing) => sameProvider(existing, copy))) {
				skipped += 1;
				continue;
			}
			if (!copy.id || existingIds.has(String(copy.id))) {
				copy.id = uniqueProviderId(existingIds);
			}
			existingIds.add(String(copy.id));
			// 重名 → 自动追加「-副本」（多次重复时继续加编号）
			const name = String(copy.name ?? "导入的供应商");
			if (existingNames.has(name)) {
				let n = 1;
				let candidate = `${name}-副本`;
				while (existingNames.has(candidate)) {
					n += 1;
					candidate = `${name}-副本${n}`;
				}
				copy.name = candidate;
				existingNames.add(candidate);
				renamed += 1;
			} else {
				existingNames.add(name);
			}
			// prefix 冲突 → 自动编号（prefix 是内部标识，必须唯一）
			const prefix = String(copy.prefix ?? "");
			if (prefix && existingPrefixes.has(prefix)) {
				let n = 2;
				let candidate = `${prefix}-${n}`;
				while (existingPrefixes.has(candidate)) {
					n += 1;
					candidate = `${prefix}-${n}`;
				}
				copy.prefix = candidate;
				existingPrefixes.add(candidate);
			} else if (prefix) {
				existingPrefixes.add(prefix);
			}
			currentList.push(copy);
			added += 1;
		}
		(merged as Record<string, unknown>)[key] = currentList;
		changed = true;
	}

	// 单例平台：本地已配置就不动它。覆盖本地配置是"导入后反而坏了"的直接来源。
	for (const key of ["codex", "tokendance", "commandCode"] as const) {
		const value = incoming[key];
		if (value === undefined) continue;
		if ((current as unknown as Record<string, unknown>)[key] !== undefined) {
			skipped += 1;
			continue;
		}
		added += 1;
		(merged as Record<string, unknown>)[key] = value;
		changed = true;
	}

	return { merged, changed, added, renamed, skipped };
}

// ── 清空 ─────────────────────────────────────────────────────────────────

export interface ClearResult {
	target: ClearTarget;
	deleted: { requests: number; sessions: number; providers: number };
}

/** 清空指定类别的数据。调用方负责先验证密码。 */
export async function clearData(target: ClearTarget): Promise<ClearResult> {
	const deleted = { requests: 0, sessions: 0, providers: 0 };
	const clearRequests = target === "requests" || target === "all";
	const clearSessions = target === "sessions" || target === "all";
	const clearProviders = target === "providers" || target === "all";

	if (clearRequests || clearSessions || clearProviders) {
		const transaction = sqlite.transaction(() => {
			if (clearRequests) {
				const before = sqlite.prepare(`SELECT COUNT(*) AS n FROM api_requests`).get() as {
					n: number;
				};
				sqlite.run(`DELETE FROM api_requests`);
				deleted.requests = Number(before.n);
			}
			if (clearSessions) {
				const before = sqlite.prepare(`SELECT COUNT(*) AS n FROM narrators`).get() as {
					n: number;
				};
				// 顺序：先断开其它表的会话引用（保留请求历史等），再删依赖表与会话本体。
				sqlite.run(`UPDATE terminals SET narrator_id = NULL WHERE narrator_id IS NOT NULL`);
				sqlite.run(
					`UPDATE benchmark_task_results SET narrator_id = NULL WHERE narrator_id IS NOT NULL`,
				);
				sqlite.run(`DELETE FROM narrator_message_refs`);
				sqlite.run(`DELETE FROM narrator_tool_calls`);
				sqlite.run(`DELETE FROM narrator_messages`);
				sqlite.run(`DELETE FROM narrators`);
				deleted.sessions = Number(before.n);
			}
			// 供应商最后清：`saveSettings` 是原子写，失败则上面已删的数据一并回滚。
			if (clearProviders) {
				const next = structuredClone(settings) as NarraForkSettings;
				let removed = 0;
				for (const key of PROVIDER_KEYS) {
					const value = (next as unknown as Record<string, unknown>)[key];
					if (Array.isArray(value)) removed += value.length;
					else if (value !== undefined) removed += 1;
					(next as unknown as Record<string, unknown>)[key] = Array.isArray(value) ? [] : undefined;
				}
				saveSettings(next);
				deleted.providers = removed;
			}
		});
		transaction();
	}

	return { target, deleted };
}
