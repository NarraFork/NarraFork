/**
 * 数据导入 / 导出 / 清空（仅管理员）。
 *
 * 导出不把 ZIP 读进页面：能选保存位置时把响应体直接写入文件，否则换一张一次性
 * 下载票据，让浏览器自己存盘。导入分两步——先上传预览（统计 + 会话 id 冲突清单），
 * 用户确认冲突策略后再按预览 token 执行；清空需要携带当前登录用户密码。
 */

import { MAX_IMPORT_BYTES, MAX_IMPORT_LABEL } from "@shared/storage-transfer";
import { ApiError, apiBase, getToken, readFetchError } from "./client";

/** 鉴权头（与其他 API 模块一致：Bearer + localStorage 令牌）。 */
function authHeaders(): Record<string, string> {
	const token = getToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface ExportCounts {
	requests: number;
	sessions: number;
	providers: number;
}

export interface ImportConflict {
	id: string;
	name: string;
	importedMessages: number;
}

export interface ImportPreviewResult {
	token: string;
	counts: ExportCounts;
	conflicts: ImportConflict[];
	exportedAt?: string;
	version?: number;
}

export type ConflictDecision = "overwrite" | "skip";

export interface ImportResult {
	requestsInserted: number;
	sessionsInserted: number;
	sessionsOverwritten: number;
	sessionsSkipped: number;
	/** 被唯一约束挡住、连同其消息一起跳过的会话数。 */
	sessionsRejected: number;
	providersAdded: number;
	providersRenamed: number;
}

/** 导出/导入的类别选择；`ALL_DATA_KINDS` 即全选。 */
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

export type ClearTarget = "requests" | "sessions" | "providers" | "all";

export interface ClearResult {
	target: ClearTarget;
	deleted: { requests: number; sessions: number; providers: number };
}

async function errorText(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: string };
		return body.error ?? `请求失败（${response.status}）`;
	} catch {
		return `请求失败（${response.status}）`;
	}
}

async function throwApiError(response: Response, fallback: string): Promise<never> {
	const { message, data } = await readFetchError(response, fallback);
	throw new ApiError(message, response.status, data);
}

function exportFilename(now = new Date()): string {
	return `narrafork-export-${now.toISOString().slice(0, 10)}.zip`;
}

function exportQuery(selection: TransferSelection): string {
	return new URLSearchParams({
		requests: selection.requests ? "1" : "0",
		sessions: selection.sessions ? "1" : "0",
		providers: selection.providers ? "1" : "0",
	}).toString();
}

interface ExportFileHandle {
	createWritable: () => Promise<WritableStream<Uint8Array>>;
}

type ExportFilePicker = (options: {
	suggestedName?: string;
	types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}) => Promise<ExportFileHandle>;

interface ExportFilePickerWindow {
	showSaveFilePicker?: ExportFilePicker;
}

function errorName(error: unknown): string | undefined {
	if (error instanceof Error) return error.name;
	if (typeof error === "object" && error !== null && "name" in error) {
		const name = (error as { name?: unknown }).name;
		return typeof name === "string" ? name : undefined;
	}
	return undefined;
}

/** 用户关掉保存对话框。不要当成失败，也不要改走票据下载。 */
function isUserCancel(error: unknown): boolean {
	const name = errorName(error);
	return name === "AbortError" || name === "NotAllowedError";
}

/** 非安全上下文或浏览器拒绝这个 API。可以改走票据。 */
function isPickerUnavailable(error: unknown): boolean {
	return errorName(error) === "SecurityError";
}

export interface ExportSaveDeps {
	/**
	 * 测试注入。`undefined` 用 `window.showSaveFilePicker`；`null` 表示这个环境没有该 API。
	 */
	showSaveFilePicker?: ExportFilePicker | null;
	/** 只用于测试注入：调用点只传 URL 与 init，不需要完整的 fetch 形状。 */
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	openDownload?: (url: string, filename: string) => void;
}

function openDownload(url: string, filename: string): void {
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.rel = "noopener";
	document.body.appendChild(link);
	link.click();
	link.remove();
}

/**
 * 把已鉴权的导出响应写入调用方准备好的文件。
 * 状态码不是 200 时先丢掉空文件，再抛出可本地化的 `ApiError`。
 */
async function streamAuthorizedExport(
	selection: TransferSelection,
	writable: WritableStream<Uint8Array>,
	fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<void> {
	let response: Response;
	try {
		response = await fetchImpl(`${apiBase()}/storage/export?${exportQuery(selection)}`, {
			headers: authHeaders(),
		});
	} catch (error) {
		await writable.abort(error).catch(() => {});
		throw error;
	}
	if (!response.ok) {
		await writable.abort().catch(() => {});
		await throwApiError(response, "Export failed");
	}
	if (!response.body) {
		await writable.abort().catch(() => {});
		throw new ApiError("Export failed", 500);
	}
	await response.body.pipeTo(writable);
}

async function saveExportWithTicket(
	selection: TransferSelection,
	filename: string,
	fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
	open: (url: string, filename: string) => void,
): Promise<void> {
	const response = await fetchImpl(`${apiBase()}/storage/export/ticket`, {
		method: "POST",
		headers: { ...authHeaders(), "Content-Type": "application/json" },
		body: JSON.stringify(selection),
	});
	if (!response.ok) await throwApiError(response, "Export failed");
	const body = (await response.json()) as { ticket?: unknown };
	if (typeof body.ticket !== "string" || body.ticket.length === 0) {
		throw new ApiError("Export failed", 500);
	}
	open(`${apiBase()}/storage/export/download?ticket=${encodeURIComponent(body.ticket)}`, filename);
}

/**
 * 保存导出包。
 *
 * 保存对话框必须是这次点击里的第一个 await，否则浏览器会拒绝 File System Access API。
 * 用户取消时返回 `cancelled`。传输失败会丢掉尚未提交的文件。
 */
export async function saveExport(
	selection: TransferSelection = ALL_DATA_KINDS,
	deps: ExportSaveDeps = {},
): Promise<"saved" | "cancelled"> {
	const filename = exportFilename();
	const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
	const open = deps.openDownload ?? openDownload;
	const picker =
		deps.showSaveFilePicker === undefined
			? (window as ExportFilePickerWindow).showSaveFilePicker
			: (deps.showSaveFilePicker ?? undefined);
	if (picker) {
		let handle: ExportFileHandle;
		try {
			handle = await picker({
				suggestedName: filename,
				types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }],
			});
		} catch (error) {
			if (isUserCancel(error)) return "cancelled";
			if (!isPickerUnavailable(error)) throw error;
			await saveExportWithTicket(selection, filename, fetchImpl, open);
			return "saved";
		}
		const writable = await handle.createWritable();
		await streamAuthorizedExport(selection, writable, fetchImpl);
		return "saved";
	}
	await saveExportWithTicket(selection, filename, fetchImpl, open);
	return "saved";
}

export const storageTransferApi = {
	/** 把导出包直接写入磁盘。支持的浏览器先选路径再流式写；其它浏览器走一次性下载票据。 */
	saveExport,

	/** 上传导出包做预检：统计数量 + 会话 id 冲突清单。 */
	async previewImport(file: File): Promise<ImportPreviewResult> {
		// 本地先挡一次：超过上限的文件传上去也只会在服务端被中断
		if (file.size > MAX_IMPORT_BYTES) {
			throw new Error(`导入文件超过 ${MAX_IMPORT_LABEL} 上限`);
		}
		const response = await fetch(`${apiBase()}/storage/import/preview`, {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/zip" },
			body: file,
		});
		if (!response.ok) throw new Error(await errorText(response));
		return (await response.json()) as ImportPreviewResult;
	},

	/** 按预览 token 执行导入；`include` 只合并选中的类别。 */
	async applyImport(
		token: string,
		conflictDefault?: ConflictDecision,
		conflictById?: Record<string, ConflictDecision>,
		include?: Partial<TransferSelection>,
	): Promise<ImportResult> {
		const response = await fetch(`${apiBase()}/storage/import`, {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify({ token, conflictDefault, conflictById, include }),
		});
		if (!response.ok) throw new Error(await errorText(response));
		return (await response.json()) as ImportResult;
	},

	/** 清空指定类别（需当前登录用户密码二次授权）。 */
	async clearData(target: ClearTarget, password: string): Promise<ClearResult> {
		const response = await fetch(`${apiBase()}/storage/clear`, {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify({ target, password }),
		});
		if (!response.ok) throw new Error(await errorText(response));
		return (await response.json()) as ClearResult;
	},
};
