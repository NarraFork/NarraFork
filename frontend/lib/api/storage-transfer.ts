/**
 * 数据导入 / 导出 / 清空（仅管理员）。
 *
 * 导出返回 ZIP 二进制；导入分两步——先上传预览（统计 + 会话 id 冲突清单），
 * 用户确认冲突策略后再按预览 token 执行；清空需要携带当前登录用户密码。
 */

import { MAX_IMPORT_BYTES, MAX_IMPORT_LABEL } from "@shared/storage-transfer";
import { apiBase, getToken } from "./client";

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

export const storageTransferApi = {
	/** 下载导出包（ZIP）；`selection` 决定包含哪些类别。 */
	async downloadExport(selection: TransferSelection = ALL_DATA_KINDS): Promise<Blob> {
		const params = new URLSearchParams({
			requests: selection.requests ? "1" : "0",
			sessions: selection.sessions ? "1" : "0",
			providers: selection.providers ? "1" : "0",
		});
		const response = await fetch(`${apiBase()}/storage/export?${params}`, {
			headers: authHeaders(),
		});
		if (!response.ok) throw new Error(await errorText(response));
		return await response.blob();
	},

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
