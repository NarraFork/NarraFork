/**
 * 数据可移植性：导出 / 导入预览 / 导入 / 清空。
 *
 * 性能取向：导出在子进程里把固定的几张表复制成 SQLite 快照，导入用 `ATTACH` + 纯 SQL 合并
 * （`INSERT OR IGNORE ... SELECT`、行值 `UPDATE`），全程不把表数据搬进 JS 再逐行写回——
 * 请求历史与消息表可能有数十万行，SQLite 引擎内部完成合并比 JSON 往返快几个数量级。
 *
 * ZIP 内容：snapshot.db（原生快照）、providers.json（配置，非表）、manifest.json。
 * 会话冲突：预览阶段用 ATTACH 联查检出重复 id，由调用方决定覆盖或跳过。
 * 覆盖时保留会话行、用导入行更新列（messages.narrator_id 为 NOT NULL，删行会失败）。
 * 清空：分项（requests / sessions / providers）与全量；调用方先校验当前用户密码。
 *
 * ⚠️ 维护约定（修改 server/db/schema.ts 时必读）：
 * - 导出 = `SNAPSHOT_TABLES` 里的表。新增需要跨机迁移的表必须加进那份清单，否则不会进 ZIP；
 * - 导入 = 只合并 `copyTable` 里显式列举的表。同一张表还要在 `applyImport` 里补 `copyTable`，
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
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, inflateRawSync } from "node:zlib";
import { BundleError, bundleCatalogError } from "@server/lib/credential-transfer/bundle";
import { AppError, catalogError } from "@server/lib/errors";
import { invalidateGitIdentityCache } from "@server/lib/git-identity";
import { generateShortId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { exportModelCatalogSettings, importModelCatalogSettings } from "@server/lib/model-catalog";
import { getProviderKeyStore } from "@server/lib/provider-keys";
import { saveSettings, settings } from "@server/lib/settings";
import {
	COMMAND_CODE_KEY_OWNER,
	nugKeyOwner,
	platformInstanceKeyOwner,
	TOKENDANCE_KEY_OWNER,
} from "@server/lib/settings/provider-keys-projection";
import type { NarraForkSettings } from "@server/lib/settings/types";
import {
	collectProviderKeys,
	countSingleKeys,
	type ExportedKeys,
	openProviderKeys,
	restoreExtraKeys,
	SEALED_KEYS_ENTRY,
	sealProviderKeys,
	withFirstKeys,
	withoutKeys,
} from "@server/services/data-portability-keys";
import { addImportedRequestsToUsageDaily } from "@server/services/usage-daily";
import {
	MAX_IMPORT_BYTES,
	MAX_IMPORT_LABEL,
	MAX_SNAPSHOT_LABEL,
	MAX_SNAPSHOT_UNCOMPRESSED_BYTES,
} from "@shared/storage-transfer";
import archiver from "archiver";
import { sqlite } from "../db";
import { getDbPath } from "../db/connection";
import { buildSnapshotInSubprocess } from "../db/snapshot-build";
import { SNAPSHOT_TABLES } from "../db/snapshot-protocol";

/** Archives without sealed provider keys; every version of this importer reads them. */
const PLAIN_EXPORT_VERSION = 1;
/** Archives whose provider keys are sealed in `provider-keys.sealed.json`. */
const SEALED_KEYS_EXPORT_VERSION = 2;
/** The newest version this importer reads. */
const EXPORT_VERSION = SEALED_KEYS_EXPORT_VERSION;
const PREVIEW_TTL_MS = 30 * 60 * 1000;

/** 供应商配置里参与导出/导入的顶层字段。 */
const PROVIDER_KEYS = [
	"customApiProviders",
	"nugProviders",
	"codex",
	"tokendance",
	"commandCode",
] as const;

/**
 * 挂在 `agent` 下、但语义上属于供应商配置的字段。
 *
 * 导出包按顶层键平铺，导入/清空时再放回 `agent`，这样没有平台实例功能的版本读到的仍是
 * 同一份 providers.json 结构。
 *
 * 除实例清单外，逐模型的设置（隐藏、协议、自定义模型、上下文等元数据）也在这里：它们以
 * `<前缀>:<模型>` 为键，换一份设置就全部对不上，必须跟供应商一起搬。
 */
const AGENT_PROVIDER_KEYS = [
	"platformInstances",
	"hiddenModels",
	// Provider prefixes left out of auto:<model> routing; follows prefix renames on import.
	"autoExcludedProviders",
	"modelProtocols",
	"modelProtocolOverrides",
	"customModels",
	"modelCatalog",
] as const;

type ProviderKey = (typeof PROVIDER_KEYS)[number] | (typeof AGENT_PROVIDER_KEYS)[number];
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
	/** `provider-keys.sealed.json` as found in the archive; opened at import with a passphrase. */
	sealedKeys?: string;
	/** Owners in the sealed file, from its plaintext header; for the preview only. */
	sealedKeyCount?: number;
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
		const inflated = entry.method === 0 ? raw : inflateRawSync(raw);
		if (inflated.byteLength > MAX_SMALL_ENTRY_BYTES) throw catalogError("IMPORT_ZIP_INVALID");
		return inflated;
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
	// 解压后的字节数才是磁盘占用。压缩包停在 4 GB，展开后仍可能把磁盘写满。
	let seen = 0;
	const limited = new Transform({
		transform(chunk, _encoding, callback) {
			const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
			seen += bytes;
			if (seen > MAX_SNAPSHOT_UNCOMPRESSED_BYTES) {
				callback(catalogError("IMPORT_FILE_TOO_LARGE", { limit: MAX_SNAPSHOT_LABEL }));
				return;
			}
			callback(null, chunk);
		},
	});
	if (entry.method === 0) await pipeline(source, limited, target);
	else await pipeline(source, createInflateRaw(), limited, target);
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
 * 没有 File System Access API 的浏览器不能把 fetch 流直接存成用户文件。
 * 管理员会话换一张短期票据，浏览器再用普通导航下载，下载管理器自己写盘。
 * 票据挂在全局会话认证之前，本身就是凭证，所以必须短、一次有效、数量有上限。
 */
export const EXPORT_TICKET_TTL_MS = 2 * 60 * 1000;
const EXPORT_TICKET_LIMIT = 32;

interface ExportTicket {
	selection: TransferSelection;
	expiresAt: number;
	/**
	 * Seals provider keys. Kept only in memory, for one download, so it never appears in the
	 * download URL. Step-up was consumed when the ticket was issued.
	 */
	passphrase?: string;
}

const exportTickets = new Map<string, ExportTicket>();

function copySelection(selection: TransferSelection): TransferSelection {
	return {
		requests: selection.requests,
		sessions: selection.sessions,
		providers: selection.providers,
	};
}

function pruneExportTickets(now: number) {
	for (const [token, ticket] of exportTickets) {
		if (now >= ticket.expiresAt) exportTickets.delete(token);
	}
	while (exportTickets.size >= EXPORT_TICKET_LIMIT) {
		const oldest = exportTickets.keys().next().value;
		if (oldest === undefined) break;
		exportTickets.delete(oldest);
	}
}

/** 签发一张导出下载票据。`now` 只给测试注入时钟。 */
export function createExportTicket(
	selection: TransferSelection,
	now = Date.now(),
	passphrase?: string,
): string {
	pruneExportTickets(now);
	const token = randomBytes(18).toString("base64url");
	exportTickets.set(token, {
		selection: copySelection(selection),
		expiresAt: now + EXPORT_TICKET_TTL_MS,
		...(passphrase ? { passphrase } : {}),
	});
	return token;
}

/**
 * 取出并作废一张票据。过期、伪造、用过第二次都返回 null。
 * 先删除再判断过期，避免时钟回拨后同一张票据还能用。
 */
export function consumeExportTicket(token: string, now = Date.now()): TransferSelection | null {
	return redeemExportTicket(token, now)?.selection ?? null;
}

/** Like consumeExportTicket, with the passphrase a providers export was issued with. */
export function redeemExportTicket(
	token: string,
	now = Date.now(),
): { selection: TransferSelection; passphrase?: string } | null {
	const ticket = exportTickets.get(token);
	if (!ticket) return null;
	exportTickets.delete(token);
	if (now >= ticket.expiresAt) return null;
	return {
		selection: ticket.selection,
		...(ticket.passphrase ? { passphrase: ticket.passphrase } : {}),
	};
}

/**
 * 导出一份 ZIP：先在子进程里把导入需要的表复制成原生 SQLite 快照，再压缩进 ZIP。
 * 供应商配置与清单是小的 JSON 文件。
 */
/**
 * Provider keys never go into `providers.json`. With `options.passphrase` they are sealed
 * into `provider-keys.sealed.json` (data-portability-keys.ts); without it the providers are
 * exported without keys. The route requires step-up before it passes a passphrase.
 */
export async function exportData(
	selection: TransferSelection = ALL_DATA_KINDS,
	options: { passphrase?: string } = {},
): Promise<{ zipPath: string; counts: ExportCounts }> {
	const dir = await mkdtemp(join(tmpdir(), "narrafork-export-"));
	const snapshotPath = join(dir, "snapshot.db");
	const zipPath = join(dir, "narrafork-export.zip");
	const output = createWriteStream(zipPath);
	const archive = archiver("zip", { zlib: { level: 1 } });
	// 只导出供应商时不建快照：供应商配置在 settings.json 里。快照会把
	// 与选择无关的会话和请求历史一起带走。
	const needsSnapshot = selection.requests || selection.sessions;
	try {
		if (needsSnapshot) {
			// 只把导入需要的表复制进快照，且整段 O(数据量) 的工作放在子进程里，
			// 不让 INSERT…SELECT / VACUUM 占住服务器的单一线程。
			await buildSnapshotInSubprocess({
				sourcePath: getDbPath(),
				outputPath: snapshotPath,
				requests: selection.requests,
				sessions: selection.sessions,
			});
		}

		const collected = selection.providers
			? collectProviders(settings)
			: ({} as Partial<Record<ProviderKey, unknown>>);
		// Keys leave providers.json and travel sealed. Sealing (async scrypt) is done before
		// archiving starts, so a failure leaves no half-written ZIP.
		const sealedKeys =
			selection.providers && options.passphrase
				? await sealProviderKeys(collectProviderKeys(collected), options.passphrase)
				: null;
		const providers = selection.providers ? withoutKeys(collected) : collected;
		// 计数从快照读，与实际导出的内容一致；没有快照时这两类必然是 0。
		const counts: ExportCounts = {
			requests: needsSnapshot ? countRowsIn(snapshotPath, "api_requests") : 0,
			sessions: needsSnapshot ? countRowsIn(snapshotPath, "narrators") : 0,
			providers: countProviders(providers),
		};

		const done = new Promise<void>((resolve, reject) => {
			output.on("close", () => resolve());
			output.on("error", reject);
			archive.on("error", reject);
		});
		archive.pipe(output);
		if (needsSnapshot) archive.file(snapshotPath, { name: "snapshot.db" });
		archive.append(JSON.stringify(providers, null, 2), {
			name: "providers.json",
		});
		if (sealedKeys) archive.append(sealedKeys, { name: SEALED_KEYS_ENTRY });
		// Only an archive with sealed keys is version 2: an older instance cannot read them and
		// must refuse it, while archives without providers stay importable there.
		archive.append(
			JSON.stringify(
				{
					version: sealedKeys ? SEALED_KEYS_EXPORT_VERSION : PLAIN_EXPORT_VERSION,
					exportedAt: new Date().toISOString(),
					counts,
				},
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
	const agent = source.agent as unknown as Record<string, unknown> | undefined;
	for (const key of AGENT_PROVIDER_KEYS) {
		const value = agent?.[key];
		if (value !== undefined) (out as Record<string, unknown>)[key] = value;
	}
	// Model overrides live beside settings.json, not in it.
	out.modelCatalog = exportModelCatalogSettings();
	return out;
}

function countProviders(providers: Partial<Record<ProviderKey, unknown>>): number {
	let total = 0;
	if (Array.isArray(providers.customApiProviders)) total += providers.customApiProviders.length;
	if (Array.isArray(providers.nugProviders)) total += providers.nugProviders.length;
	if (Array.isArray(providers.platformInstances)) total += providers.platformInstances.length;
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

/**
 * 只导出供应商的包里没有快照：造一个只有列结构的空库顶替。
 *
 * 这样 ATTACH 与合并语句照常执行、结果为空，导入流程不需要为「无快照」再分叉一条路径。
 */
function createEmptySnapshot(snapshotPath: string): void {
	const attachName = `empty_${randomBytes(4).toString("hex")}`;
	sqlite.run(`ATTACH DATABASE ? AS ${attachName}`, [snapshotPath]);
	try {
		for (const table of [...SNAPSHOT_TABLES.requests, ...SNAPSHOT_TABLES.sessions]) {
			sqlite.run(`CREATE TABLE ${attachName}.${table} AS SELECT * FROM main.${table} LIMIT 0`);
		}
	} finally {
		sqlite.run(`DETACH DATABASE ${attachName}`);
	}
}

async function buildImportPreview(zipPath: string, dir: string): Promise<ImportPreview> {
	const index = await readZipIndex(zipPath);
	const snapshotEntry = index.get("snapshot.db");
	const providersEntry = index.get("providers.json");
	const snapshotPath = join(dir, "snapshot.db");
	if (snapshotEntry) {
		await extractEntryToFile(zipPath, snapshotEntry, snapshotPath);
	} else if (providersEntry) {
		// 只导出了供应商的包：包里本来就没有快照。用一个空库顶替，让后面的
		// ATTACH/合并逻辑自然空跑，只应用 providers.json。
		createEmptySnapshot(snapshotPath);
	} else {
		// 空索引通常意味着请求体不是 ZIP（例如旧前端发的 multipart 包装）。
		logger.warn("Import archive has neither snapshot.db nor providers.json", {
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
	const providers = providersEntry
		? (JSON.parse((await readSmallEntry(zipPath, providersEntry)).toString("utf8")) as Partial<
				Record<ProviderKey, unknown>
			>)
		: {};
	// Opened only at import, with the passphrase; the preview just says the keys are there.
	const sealedEntry = index.get(SEALED_KEYS_ENTRY);
	const sealedKeys = sealedEntry
		? (await readSmallEntry(zipPath, sealedEntry)).toString("utf8")
		: undefined;

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
			version: manifest ? Number(manifest.version ?? PLAIN_EXPORT_VERSION) : undefined,
			...(sealedKeys ? { sealedKeys, sealedKeyCount: sealedHeaderCount(sealedKeys) } : {}),
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

/** The plaintext `count` of a sealed bundle; 0 when it cannot be read. */
function sealedHeaderCount(text: string): number {
	try {
		const count = Number((JSON.parse(text) as { count?: unknown }).count);
		return Number.isSafeInteger(count) && count > 0 ? count : 0;
	} catch {
		return 0;
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
	/** Opens the archive's sealed provider keys; required when it has them and providers are imported. */
	passphrase?: string;
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
	/** Provider keys restored from the archive's sealed file (0 for an archive without it). */
	keysImported: number;
	/** Sealed keys that could not be written to the key store; see the server log. */
	keysFailed: number;
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
	"narrator_blocks",
	"narrator_text_snapshots",
	"recent_tab_archive_marks",
	"folder_git_identity_bindings",
	"api_requests",
] as const;

/** 单条 SQL 的占位符上限按 400 切段，避免顶到 SQLite 的变量个数限制。 */
const SQL_PARAM_CHUNK = 400;

function chunkedInLists(ids: string[]): { groups: string[]; params: string[] } {
	const groups: string[] = [];
	const params: string[] = [];
	for (let offset = 0; offset < ids.length; offset += SQL_PARAM_CHUNK) {
		const chunk = ids.slice(offset, offset + SQL_PARAM_CHUNK);
		groups.push(`(${chunk.map(() => "?").join(", ")})`);
		params.push(...chunk);
	}
	return { groups, params };
}

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
 * Folder picks are personal: the two foreign keys alone do not prove that the picked
 * identity belongs to the binding's user. Drop only newly imported mismatches; existing
 * local rows are not this import's responsibility. Missing identities are rejected by the
 * same ownership check; any other dangling references are repaired in this transaction.
 */
function removeInvalidFolderIdentityBindings(baseline: number): void {
	const removed = changesOf(
		sqlite.run(
			`DELETE FROM main.folder_git_identity_bindings
			 WHERE rowid > ?
			   AND NOT EXISTS (
			     SELECT 1 FROM main.user_git_identities
			     WHERE user_git_identities.id = folder_git_identity_bindings.identity_id
			       AND user_git_identities.user_id = folder_git_identity_bindings.user_id
			   )`,
			[baseline],
		),
	);
	if (removed > 0) {
		logger.warn("Import skipped folder bindings with missing or cross-user identities", {
			removed,
		});
	}
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
		const { groups, params: chunkParams } = chunkedInLists(excluded);
		const absent = groups.map((group) => `narrator_id NOT IN ${group}`).join(" AND ");
		filters.push(`(narrator_id IS NULL OR (${absent}))`);
		params.push(...chunkParams);
	} else if (
		excluded.length > 0 &&
		table === "narrator_blocks" &&
		tableColumns(attachName, "narrator_messages").includes("id")
	) {
		// 块行没有 narrator_id。跳过的会话只通过它的消息把块排除掉。
		const { groups, params: chunkParams } = chunkedInLists(excluded);
		const owned = groups.map((group) => `narrator_id IN ${group}`).join(" OR ");
		filters.push(
			`message_id NOT IN (SELECT id FROM ${attachName}.narrator_messages WHERE ${owned})`,
		);
		params.push(...chunkParams);
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
 * 新会话直接插入；消息、引用、工具调用和消息块都按主键合并，不删除本地行。
 * 跳过的会话连同它的消息、引用、工具调用、消息块，以及指向它的请求，一起不导入。
 * 整个数据合并在一个事务里完成。
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
		keysImported: 0,
		keysFailed: 0,
	};

	await access(preview.snapshotPath).catch(() => {
		throw catalogError("IMPORT_SNAPSHOT_EXPIRED");
	});

	// Sealed provider keys are opened before the transaction: scrypt is async and the import
	// transaction is synchronous. A wrong passphrase stops here, before anything is written.
	const importProviders = options.include?.providers ?? true;
	let sealedKeys: ExportedKeys | null = null;
	if (preview.sealedKeys && importProviders) {
		if (!options.passphrase) throw catalogError("IMPORT_PASSPHRASE_REQUIRED");
		try {
			sealedKeys = await openProviderKeys(preview.sealedKeys, options.passphrase);
		} catch (error) {
			if (error instanceof BundleError) bundleCatalogError(error);
			throw error;
		}
	}
	// providers.json has no keys; the merge's same-endpoint check and the settings save need
	// each provider's first key in place, as an old plain export had it.
	const incomingProviders = sealedKeys
		? (withFirstKeys(preview.providers, sealedKeys) as Partial<Record<ProviderKey, unknown>>)
		: preview.providers;
	/** Incoming custom API provider id → the local id it was added under. */
	let addedProviders: ReadonlyMap<string, string> = new Map();
	/** Single-key providers that were added; their key came in with the settings save. */
	let addedSingleKeyOwners: ReadonlySet<string> = new Set();

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
				keysImported: 0,
				keysFailed: 0,
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
			const skipped: string[] = [];
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
						skipped.push(id);
						continue;
					}
					// 覆盖只更新会话行本身：删掉本地 refs/tool_calls 会级联抹掉其它表对它们的引用，
					// 也会丢掉导出之后本地新增的历史。合并语义不删除本地数据。
					sqlite.run(`UPDATE main.narrators SET ${columnAssignments} WHERE id = ?`, [id]);
					// Workspaces are local UI state, not snapshot tables. Imported session titles
					// still invalidate any candidate generated from their previous metadata.
					sqlite.run(
						`UPDATE main.workspaces SET title_revision = title_revision + 1
						WHERE id IN (SELECT workspace_id FROM main.workspace_panels WHERE narrator_id = ?)`,
						[id],
					);
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

			// 跳过或被唯一约束挡住的会话：子行和指向它的请求都不进来。
			const excludedNarrators = [...rejected, ...skipped];

			// 2) 消息、引用、工具调用、消息块：按主键追加。
			//    `body_rows_only = 1` 时正文只在块行里，漏掉块就等于丢了会话内容。
			if (include.sessions) {
				copyTable(attachName, "narrator_messages", {
					nullAbsentFks: true,
					excludeNarrators: excludedNarrators,
				});
				copyTable(attachName, "narrator_message_refs", { excludeNarrators: excludedNarrators });
				copyTable(attachName, "narrator_tool_calls", {
					nullAbsentFks: true,
					excludeNarrators: excludedNarrators,
				});
				copyTable(attachName, "narrator_blocks", { excludeNarrators: excludedNarrators });
				copyTable(attachName, "recent_tab_archive_marks", {
					excludeNarrators: excludedNarrators,
				});
				copyTable(attachName, "folder_git_identity_bindings");
				removeInvalidFolderIdentityBindings(baselines.get("folder_git_identity_bindings") ?? 0);
				if (
					counts.sessionsInserted + counts.sessionsOverwritten > 0 &&
					tableColumns(attachName, "narrator_text_snapshots").includes("sha256")
				) {
					// Shared content store: copy complete manifests and their children without
					// parsing potentially large JSON bodies on the application thread.
					copyTable(attachName, "narrator_text_snapshots");
					// A collector may already have marked roots before this import. Renew the
					// publication grace in the SAME transaction, including reused orphan hashes;
					// INSERT OR IGNORE alone would leave their old timestamps sweepable.
					sqlite.run(
						`UPDATE main.narrator_text_snapshots SET created_at = MAX(created_at, ?)
						 WHERE sha256 IN (SELECT sha256 FROM ${attachName}.narrator_text_snapshots)`,
						[new Date().toISOString()],
					);
				}
			}

			// 3) 请求历史最后：它同时引用会话与消息，必须在两者就位后插入
			if (include.requests) {
				counts.requestsInserted = copyTable(attachName, "api_requests", {
					excludeNarrators: excludedNarrators,
					// 会话整类没有导入时，请求上的会话/消息引用必然悬空
					forceNull: include.sessions ? [] : ["narrator_id", "message_id"],
				});
			}

			// 4) 自检：只处理本次新增行，兜住无法预见的悬空引用（日志会写明表与数量）
			repairDanglingReferences(baselines);
			// 本次新增的请求计入用量日账本（按 rowid 基线，重复导入被主键跳过的行不会重复计数）
			if (include.requests)
				addImportedRequestsToUsageDaily(sqlite, baselines.get("api_requests") ?? 0);

			// 5) 供应商合并：`saveSettings` 是原子写（临时文件 + rename），放在事务末尾，
			// 失败时数据整批回滚，不会留下「数据进了、供应商没进」的半成品。
			if (include.providers) {
				const merge = mergeProviders(incomingProviders);
				// Read after the transaction commits; a retried transaction recomputes them.
				addedProviders = merge.addedCustomApiProviders;
				addedSingleKeyOwners = merge.addedSingleKeyOwners;
				// 改名的供应商：本次写入的会话跟着指向新前缀，不留在本地同名的另一个服务上。
				if (include.sessions) {
					remapImportedNarratorModels(
						incomingIds.filter((id) => !excludedNarrators.includes(id)),
						merge.prefixRemaps,
					);
				}
				if (merge.changed) {
					const next = structuredClone(settings) as NarraForkSettings;
					for (const key of PROVIDER_KEYS) {
						if (merge.merged[key] !== undefined) {
							(next as unknown as Record<string, unknown>)[key] = merge.merged[key];
						}
					}
					const agentPatch: Record<string, unknown> = {};
					for (const key of AGENT_PROVIDER_KEYS) {
						if (merge.merged[key] !== undefined) agentPatch[key] = merge.merged[key];
					}
					if (Object.keys(agentPatch).length > 0) {
						next.agent = { ...next.agent, ...agentPatch } as NarraForkSettings["agent"];
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
				// The transaction is deferred, so a concurrent commit surfaces as
				// SQLITE_BUSY_SNAPSHOT: same "database is locked", suffixed code.
				const busy = !!code?.startsWith("SQLITE_BUSY") || code === "SQLITE_LOCKED";
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

	if (options.include?.sessions ?? true) invalidateGitIdentityCache();

	// The key store is a file outside the SQLite transaction, so the remaining keys are
	// written only once the transaction committed. The first key of each provider (and the
	// single key of NUG / TokenDance / Command Code) was stored by the settings save above.
	if (sealedKeys) {
		const restored = restoreExtraKeys(sealedKeys, addedProviders);
		result.keysImported = restored.imported + countSingleKeys(sealedKeys, addedSingleKeyOwners);
		result.keysFailed = restored.failed;
		if (restored.failed > 0) {
			logger.warn("Import could not restore some provider keys", restored);
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

/**
 * 模型目录的合并：用户编辑层按 id 取并集，同键以导入为准。
 *
 * 实例级策略（`autoApply` / `pinnedVersion`）保留本地——导入搬的是模型数据，不是目录更新策略。
 */
/**
 * 按模型键的第一段（`prefix:model`）改写。
 *
 * 不用 `startsWith(prefix + ":")` 扫整张表：`openai` 会误中 `openai-2:model`。
 * 只认冒号前的完整前缀。`__agg__:prefix:model` 的前缀在第二段。
 */
function rewritePrefixedModelKey(value: string, remaps: Map<string, string>): string {
	if (value.startsWith("__agg__:")) {
		const rest = value.slice("__agg__:".length);
		const colon = rest.indexOf(":");
		if (colon < 0) return value;
		const next = remaps.get(rest.slice(0, colon));
		if (!next) return value;
		return `__agg__:${next}:${rest.slice(colon + 1)}`;
	}
	const colon = value.indexOf(":");
	if (colon < 0) return value;
	const next = remaps.get(value.slice(0, colon));
	if (!next) return value;
	return `${next}:${value.slice(colon + 1)}`;
}

function rememberPrefixRemap(remaps: Map<string, string>, from: string, to: string): void {
	if (!from || !to || from === to) return;
	const existing = remaps.get(from);
	if (existing && existing !== to) return;
	remaps.set(from, to);
}

/**
 * 前缀改名之后，逐模型设置仍指向旧前缀就会挂到本地那个同名供应商上。
 *
 * 每次从原始 `incoming` 复制一份再改：导入事务遇到 `SQLITE_BUSY` 会整段重跑，
 * 改到原对象上会把 `openai:model` 再写成 `openai-2-2:model`。
 */
function remapIncomingModelSettings(
	incoming: Partial<Record<ProviderKey, unknown>>,
	remaps: Map<string, string>,
): Partial<Record<ProviderKey, unknown>> {
	if (remaps.size === 0) return incoming;
	const rewrite = (value: string) => rewritePrefixedModelKey(value, remaps);
	const next: Partial<Record<ProviderKey, unknown>> = { ...incoming };
	if (Array.isArray(incoming.hiddenModels)) {
		next.hiddenModels = incoming.hiddenModels.map((item) => rewrite(String(item)));
	}
	// A list of bare prefixes, not `前缀:模型` keys.
	if (Array.isArray(incoming.autoExcludedProviders)) {
		next.autoExcludedProviders = incoming.autoExcludedProviders.map(
			(prefix) => remaps.get(String(prefix)) ?? String(prefix),
		);
	}
	for (const key of ["modelProtocols", "modelProtocolOverrides"] as const) {
		const record = incoming[key];
		if (!record || typeof record !== "object" || Array.isArray(record)) continue;
		const rewritten: Record<string, unknown> = {};
		for (const [modelKey, value] of Object.entries(record as Record<string, unknown>)) {
			rewritten[rewrite(modelKey)] = value;
		}
		next[key] = rewritten;
	}
	if (Array.isArray(incoming.customModels)) {
		next.customModels = (incoming.customModels as Array<Record<string, unknown>>).map((entry) => {
			const copy = { ...entry };
			if (typeof copy.value === "string") copy.value = rewrite(copy.value);
			if (typeof copy.provider === "string") {
				copy.provider = remaps.get(copy.provider) ?? copy.provider;
			}
			return copy;
		});
	}
	// 模型自定义参数里「单个来源」的键是 `前缀:模型`，跟着前缀改名；旧包的内联本地层同理。
	const catalog = incoming.modelCatalog as Record<string, unknown> | undefined;
	if (catalog && typeof catalog === "object") {
		const rekey = (record: unknown) =>
			record && typeof record === "object" && !Array.isArray(record)
				? Object.fromEntries(
						Object.entries(record as Record<string, unknown>).map(([key, value]) => [
							rewrite(key),
							value,
						]),
					)
				: record;
		const copy: Record<string, unknown> = { ...catalog };
		for (const layer of ["overrides", "local"] as const) {
			const value = catalog[layer] as Record<string, unknown> | undefined;
			if (value && typeof value === "object")
				copy[layer] = { ...value, connections: rekey(value.connections) };
		}
		next.modelCatalog = copy;
	}
	return next;
}

/** 合并 `agent` 下的逐模型设置；返回是否产生了变化。 */
function mergeAgentModelSettings(
	current: NarraForkSettings,
	incoming: Partial<Record<ProviderKey, unknown>>,
	merged: Partial<Record<ProviderKey, unknown>>,
): boolean {
	const agent = (current.agent ?? {}) as unknown as Record<string, unknown>;
	const out = merged as Record<string, unknown>;
	let changed = false;

	for (const key of ["hiddenModels", "autoExcludedProviders"] as const) {
		const list = incoming[key];
		if (!Array.isArray(list)) continue;
		out[key] = [...new Set([...((agent[key] as string[] | undefined) ?? []), ...list])];
		changed = true;
	}

	for (const key of ["modelProtocols", "modelProtocolOverrides"] as const) {
		const patch = incoming[key];
		if (!patch || typeof patch !== "object") continue;
		out[key] = {
			...((agent[key] as Record<string, unknown> | undefined) ?? {}),
			...(patch as Record<string, unknown>),
		};
		changed = true;
	}

	if (Array.isArray(incoming.customModels)) {
		const byValue = new Map<string, Record<string, unknown>>();
		for (const entry of (agent.customModels as Array<Record<string, unknown>>) ?? []) {
			byValue.set(String(entry.value ?? ""), entry);
		}
		for (const entry of incoming.customModels as Array<Record<string, unknown>>) {
			byValue.set(String(entry.value ?? ""), entry);
		}
		out.customModels = [...byValue.values()];
		changed = true;
	}

	// Overrides are merged into the catalog's own file (incoming wins per entry); the
	// catalog keeps owning `agent.modelCatalog`, so nothing goes into the settings patch.
	if (incoming.modelCatalog && typeof incoming.modelCatalog === "object") {
		importModelCatalogSettings(incoming.modelCatalog);
		changed = true;
	}

	return changed;
}

function mergeProviders(incoming: Partial<Record<ProviderKey, unknown>>): {
	merged: Partial<Record<ProviderKey, unknown>>;
	changed: boolean;
	added: number;
	renamed: number;
	skipped: number;
	/** Incoming prefix → the prefix it was imported under, for providers that were renamed. */
	prefixRemaps: Map<string, string>;
	/**
	 * Incoming custom API provider id → the local id it was added under. Providers merged
	 * into a local one (same key and base URL) are absent: they keep their local keys.
	 */
	addedCustomApiProviders: Map<string, string>;
	/** Exporting-instance owner ids of single-key providers that were added (NUG, TokenDance, Command Code). */
	addedSingleKeyOwners: Set<string>;
} {
	const current = structuredClone(settings) as NarraForkSettings;
	const merged: Partial<Record<ProviderKey, unknown>> = {};
	let changed = false;
	let added = 0;
	let renamed = 0;
	let skipped = 0;
	const prefixRemaps = new Map<string, string>();
	const addedCustomApiProviders = new Map<string, string>();
	const addedSingleKeyOwners = new Set<string>();

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
		// `auto` is reserved for auto:<model> values; an older export may still use it.
		const existingPrefixes = new Set([
			"auto",
			...currentList.map((item) => String(item.prefix ?? "")),
		]);
		const existingIds = new Set(currentList.map((item) => String(item.id ?? "")));
		for (const item of incomingList as Array<Record<string, unknown>>) {
			const copy = { ...item };
			// 同一端点（同 apiKey + 同 baseUrl）已在本地：默认不导入，避免出现一堆
			// 内容相同、id 也相同的副本——那会让整个供应商列表无法编辑。
			const sameEndpoint = currentList.find((existing) => sameProvider(existing, copy));
			if (sameEndpoint) {
				// 同一端点留在本地供应商上。两边前缀不同时，模型设置要改挂到本地前缀。
				rememberPrefixRemap(
					prefixRemaps,
					String(copy.prefix ?? ""),
					String(sameEndpoint.prefix ?? ""),
				);
				skipped += 1;
				continue;
			}
			const incomingId = typeof item.id === "string" ? item.id : "";
			if (!copy.id || existingIds.has(String(copy.id))) {
				copy.id = uniqueProviderId(existingIds);
			}
			existingIds.add(String(copy.id));
			if (key === "customApiProviders" && incomingId) {
				addedCustomApiProviders.set(incomingId, String(copy.id));
			}
			// A NUG provider's key is stored by the settings save under its (possibly new) id.
			if (key === "nugProviders" && incomingId) addedSingleKeyOwners.add(nugKeyOwner(incomingId));
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
				rememberPrefixRemap(prefixRemaps, prefix, candidate);
			} else if (prefix) {
				existingPrefixes.add(prefix);
			}
			currentList.push(copy);
			added += 1;
		}
		(merged as Record<string, unknown>)[key] = currentList;
		changed = true;
	}

	// 平台实例：与列表型供应商同一套避让规则。前缀是模型命名空间，本地已占用的前缀
	// 必须改名后再导入，否则两个实例会同时解析到同一批模型 ID。
	const incomingInstances = incoming.platformInstances;
	if (Array.isArray(incomingInstances) && incomingInstances.length > 0) {
		const agent = (current.agent ?? {}) as unknown as Record<string, unknown>;
		const currentList = [...((agent.platformInstances ?? []) as Array<Record<string, unknown>>)];
		const existingIds = new Set(currentList.map((entry) => String(entry.id ?? "")));
		// `auto` is reserved for auto:<model> values, like the provider lists above.
		const existingPrefixes = new Set([
			"auto",
			...currentList.map((entry) => String(entry.prefix ?? "")),
		]);
		for (const item of incomingInstances as Array<Record<string, unknown>>) {
			const copy = { ...item };
			const platform = String(copy.platform ?? "");
			const prefix = String(copy.prefix ?? "");
			// 同平台同前缀就是同一条命名空间，内容一样的实例没必要再导一份。
			if (
				currentList.some(
					(entry) =>
						String(entry.platform ?? "") === platform && String(entry.prefix ?? "") === prefix,
				)
			) {
				skipped += 1;
				continue;
			}
			const incomingInstanceId = typeof copy.id === "string" ? copy.id : "";
			if (!copy.id || existingIds.has(String(copy.id))) copy.id = uniqueProviderId(existingIds);
			existingIds.add(String(copy.id));
			// 实例密钥由设置保存按新 id 落库；这里只登记导出侧的 owner 以便统计。
			if (incomingInstanceId)
				addedSingleKeyOwners.add(platformInstanceKeyOwner(incomingInstanceId));
			if (prefix && existingPrefixes.has(prefix)) {
				let n = 2;
				let candidate = `${prefix}-${n}`;
				while (existingPrefixes.has(candidate)) {
					n += 1;
					candidate = `${prefix}-${n}`;
				}
				copy.prefix = candidate;
				existingPrefixes.add(candidate);
				rememberPrefixRemap(prefixRemaps, prefix, candidate);
				renamed += 1;
			} else if (prefix) {
				existingPrefixes.add(prefix);
			}
			currentList.push(copy);
			added += 1;
		}
		(merged as Record<string, unknown>).platformInstances = currentList;
		changed = true;
	}

	// 逐模型设置（隐藏、协议、自定义模型、上下文元数据）跟着供应商一起搬。
	// 前缀避让发生在上面：这里用改写后的键，避免设置还粘在本地那个同名供应商上。
	if (
		mergeAgentModelSettings(current, remapIncomingModelSettings(incoming, prefixRemaps), merged)
	) {
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
		if (key === "tokendance") addedSingleKeyOwners.add(TOKENDANCE_KEY_OWNER);
		if (key === "commandCode") addedSingleKeyOwners.add(COMMAND_CODE_KEY_OWNER);
		changed = true;
	}

	return {
		merged,
		changed,
		added,
		renamed,
		skipped,
		prefixRemaps,
		addedCustomApiProviders,
		addedSingleKeyOwners,
	};
}

/** Session columns that hold a model value (`<prefix>:<model>`, `__agg__:<prefix>:<model>`, …). */
const NARRATOR_MODEL_COLUMNS = ["model", "pending_model_restore"] as const;

/**
 * Point imported sessions at the providers' new prefixes.
 *
 * A provider that came in renamed (`openai` → `openai-2`) leaves the sessions that used it
 * naming the local `openai`, which is a different service. Only the rows this import wrote
 * are touched. Each value is rewritten once with the same rule as the model settings, so a
 * chain of renames (`a` → `a-2` while `a-2` → `a-3`) cannot apply twice. Reads only the two
 * short model columns of the imported sessions.
 */
function remapImportedNarratorModels(ids: readonly string[], remaps: Map<string, string>): void {
	if (remaps.size === 0 || ids.length === 0) return;
	const present = tableColumns("main", "narrators");
	const columns = NARRATOR_MODEL_COLUMNS.filter((column) => present.includes(column));
	if (columns.length === 0) return;
	const select = sqlite.prepare(
		`SELECT id, ${columns.map((column) => `"${column}"`).join(", ")}
		 FROM main.narrators WHERE id IN (SELECT value FROM json_each(?))`,
	);
	const updates = columns.map((column) =>
		sqlite.prepare(`UPDATE main.narrators SET "${column}" = ? WHERE id = ?`),
	);
	const rows = select.all(JSON.stringify(ids)) as Array<Record<string, string | null>>;
	for (const row of rows) {
		columns.forEach((column, index) => {
			const value = row[column];
			if (!value) return;
			const next = rewritePrefixedModelKey(value, remaps);
			if (next !== value) updates[index]?.run(next, row.id as string);
		});
	}
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
				// 用量日账本是按天汇总的请求历史，随请求历史一起清空。
				sqlite.run(`DELETE FROM usage_daily`);
				deleted.requests = Number(before.n);
			}
			if (clearSessions) {
				const before = sqlite.prepare(`SELECT COUNT(*) AS n FROM narrators`).get() as {
					n: number;
				};
				// FK-cascaded panel removal must invalidate previously generated title candidates.
				sqlite.run(`UPDATE workspaces SET title_revision = title_revision + 1
					WHERE id IN (SELECT workspace_id FROM workspace_panels WHERE narrator_id IS NOT NULL)`);
				// 顺序：先断开其它表的会话引用（保留请求历史等），再删依赖表与会话本体。
				sqlite.run(`UPDATE terminals SET narrator_id = NULL WHERE narrator_id IS NOT NULL`);
				sqlite.run(
					`UPDATE benchmark_task_results SET narrator_id = NULL WHERE narrator_id IS NOT NULL`,
				);
				sqlite.run(`DELETE FROM narrator_message_refs`);
				sqlite.run(`DELETE FROM narrator_tool_calls`);
				sqlite.run(`DELETE FROM narrator_messages`);
				sqlite.run(`DELETE FROM recent_tab_archive_marks`);
				// Unlike narrator picks, folder picks have no narrator FK to cascade through.
				sqlite.run(`DELETE FROM folder_git_identity_bindings`);
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
				// 逐模型的供应商设置同样归零；模型目录本身不清——它包含用户手写的模型卡片，
				// 不属于"删掉这个供应商"的范畴。
				const agent = next.agent as unknown as Record<string, unknown> | undefined;
				if (agent) {
					for (const key of [
						"platformInstances",
						"hiddenModels",
						"customModels",
						"autoExcludedProviders",
					] as const) {
						const value = agent[key];
						if (Array.isArray(value)) removed += value.length;
						agent[key] = [];
					}
					for (const key of ["modelProtocols", "modelProtocolOverrides"] as const) {
						const value = agent[key];
						if (value && typeof value === "object") removed += Object.keys(value).length;
						agent[key] = {};
					}
				}
				const customIds = (settings.customApiProviders ?? []).map((provider) => provider.id);
				saveSettings(next);
				// Every key of the cleared providers, not only the first one settings held.
				for (const id of customIds) getProviderKeyStore().removeProvider(id);
				deleted.providers = removed;
			}
		});
		transaction();
		if (clearSessions) invalidateGitIdentityCache();
	}

	return { target, deleted };
}
