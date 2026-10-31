/**
 * 数据导入 / 导出 / 清空（仅管理员）。
 *
 * - GET  /api/storage/export          导出 ZIP（带会话，供 File System Access 流式写入）
 * - POST /api/storage/export/ticket   签发一次性下载票据
 * - GET  /api/storage/export/download 凭票据下载（挂在全局会话认证之前）
 * - POST /api/storage/import/preview  上传 ZIP，返回统计与会话冲突清单
 * - POST /api/storage/import          按预览 token + 冲突决策执行导入
 * - POST /api/storage/clear           清空指定类别（必须携带当前登录用户密码）
 */

import { Hono } from "hono";
import { z } from "zod/v4";
import { catalogError } from "../lib/errors";
import { requireAdmin } from "../middleware/auth";
import { authSessionStore } from "../services/auth/store";
import {
	applyImport,
	clearData,
	consumeExportTicket,
	createExportTicket,
	exportData,
	previewImport,
	previewImportFromStream,
	type TransferSelection,
} from "../services/data-portability";

export const storageTransferRoutes = new Hono();

const conflictDecisionSchema = z.enum(["overwrite", "skip"]);

const selectionSchema = z.object({
	requests: z.boolean(),
	sessions: z.boolean(),
	providers: z.boolean(),
});

const importSchema = z.object({
	token: z.string().min(1),
	conflictDefault: conflictDecisionSchema.optional(),
	conflictById: z.record(z.string(), conflictDecisionSchema).optional(),
	/** 只导入选中的类别；缺省全选。 */
	include: selectionSchema.partial().optional(),
});

const clearSchema = z.object({
	target: z.enum(["requests", "sessions", "providers", "all"]),
	/** 当前登录用户的密码：清空是不可逆操作，必须二次授权。 */
	password: z.string().min(1),
});

function selectionFromQuery(url: URL): TransferSelection {
	return {
		requests: url.searchParams.get("requests") !== "0",
		sessions: url.searchParams.get("sessions") !== "0",
		providers: url.searchParams.get("providers") !== "0",
	};
}

function exportFilename(): string {
	return `narrafork-export-${new Date().toISOString().slice(0, 10)}.zip`;
}

/** 打包并流式返回 ZIP。调用方负责已经完成管理员或票据鉴权。 */
async function sendExport(selection: TransferSelection): Promise<Response> {
	const { zipPath, counts } = await exportData(selection);
	const file = Bun.file(zipPath);
	const response = new Response(file.stream(), {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="${exportFilename()}"`,
			"Cache-Control": "no-store",
			"X-Export-Counts": JSON.stringify(counts),
		},
	});
	// 传输完成后清理临时文件（不消费响应体，避免破坏下载）。
	const size = file.size;
	setTimeout(
		() => {
			void import("node:fs/promises").then(({ rm }) => rm(zipPath, { force: true }));
		},
		Math.max(60_000, Math.min(600_000, Math.ceil(size / 1_000_000) * 10_000)),
	);
	return response;
}

/**
 * GET /api/storage/export
 * 导出 ZIP；`?requests=0&sessions=0&providers=0` 用于排除某类数据（缺省全选）。
 * 响应流式发送。浏览器应把 body 直接写入用户选定的文件，不要先读成 Blob。
 */
storageTransferRoutes.get("/export", requireAdmin, async (c) => {
	return sendExport(selectionFromQuery(new URL(c.req.url)));
});

/** POST /api/storage/export/ticket — 给无法流式写文件的浏览器换一张下载票据。 */
storageTransferRoutes.post("/export/ticket", requireAdmin, async (c) => {
	const parsed = selectionSchema.safeParse(await c.req.json());
	if (!parsed.success) throw catalogError("EXPORT_PARAMS_INVALID");
	if (!parsed.data.requests && !parsed.data.sessions && !parsed.data.providers) {
		throw catalogError("EXPORT_PARAMS_INVALID");
	}
	return c.json({ ticket: createExportTicket(parsed.data) });
});

/**
 * GET /api/storage/export/download?ticket=
 * 必须在 `app.ts` 里挂到全局会话认证之前：`<a href>` 带不上 Authorization。
 * 票据是唯一凭证，用过即废。
 */
export const exportTicketDownloadRoutes = new Hono();

exportTicketDownloadRoutes.get("/", async (c) => {
	const selection = consumeExportTicket(c.req.query("ticket") ?? "");
	if (!selection) throw catalogError("EXPORT_TICKET_INVALID");
	return sendExport(selection);
});

/**
 * POST /api/storage/import/preview
 * 首选请求体就是导出 ZIP 的原始字节：边落盘边校验大小、快照流式解压，几 GB 的包
 * 也不需要整份进内存。同时兼容旧的 multipart 上传，这样浏览器缓存了旧前端资源时
 * 仍能导入，而不是让用户对着一句"缺少 snapshot.db"猜。
 */
storageTransferRoutes.post("/import/preview", requireAdmin, async (c) => {
	const contentType = c.req.header("content-type") ?? "";
	if (contentType.startsWith("multipart/form-data")) {
		const form = await c.req.formData();
		const file = form.get("file");
		if (!(file instanceof File)) throw catalogError("IMPORT_FILE_REQUIRED");
		const preview = await previewImport(await file.arrayBuffer(), file.name);
		return c.json({
			token: preview.token,
			counts: preview.counts,
			conflicts: preview.conflicts,
			exportedAt: preview.exportedAt,
			version: preview.version,
		});
	}

	const body = c.req.raw.body;
	if (!body) throw catalogError("IMPORT_FILE_REQUIRED");
	const declared = Number(c.req.header("content-length") ?? 0);
	const preview = await previewImportFromStream(
		body,
		Number.isFinite(declared) && declared > 0 ? declared : undefined,
	);
	return c.json({
		token: preview.token,
		counts: preview.counts,
		conflicts: preview.conflicts,
		exportedAt: preview.exportedAt,
		version: preview.version,
	});
});

/** POST /api/storage/import — 按预览结果执行导入。 */
storageTransferRoutes.post("/import", requireAdmin, async (c) => {
	const parsed = importSchema.safeParse(await c.req.json());
	if (!parsed.success) throw catalogError("IMPORT_PARAMS_INVALID");
	const result = await applyImport(parsed.data.token, {
		conflictDefault: parsed.data.conflictDefault,
		conflictById: parsed.data.conflictById,
		include: parsed.data.include,
	});
	return c.json(result);
});

/** POST /api/storage/clear — 校验当前用户密码后清空数据。 */
storageTransferRoutes.post("/clear", requireAdmin, async (c) => {
	const parsed = clearSchema.safeParse(await c.req.json());
	if (!parsed.success) throw catalogError("CLEAR_PARAMS_INVALID");
	const user = c.get("user") as { sub?: string } | undefined;
	const userId = user?.sub;
	if (!userId) throw catalogError("CLEAR_USER_UNKNOWN");

	// 复用登录时的密码校验：取当前用户的密码哈希后比对。
	const passwordHash = await authSessionStore.findPasswordHash(userId);
	if (!passwordHash) {
		throw catalogError("CLEAR_PASSWORD_NOT_SET");
	}
	const valid = await Bun.password.verify(parsed.data.password, passwordHash);
	if (!valid) throw catalogError("CLEAR_PASSWORD_INVALID");

	const result = await clearData(parsed.data.target);
	return c.json(result);
});
