/**
 * 数据导入 / 导出 / 清空（仅管理员）。
 *
 * - GET  /api/storage/export          导出 ZIP（清单 + 请求历史 + 会话 + 供应商）
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
	exportData,
	previewImport,
	previewImportFromStream,
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

/**
 * GET /api/storage/export
 * 导出 ZIP；`?requests=0&sessions=0&providers=0` 用于排除某类数据（缺省全选）。
 * 响应流式发送，结束时清理临时文件。
 */
storageTransferRoutes.get("/export", requireAdmin, async (c) => {
	const { zipPath, counts } = await exportData({
		requests: c.req.query("requests") !== "0",
		sessions: c.req.query("sessions") !== "0",
		providers: c.req.query("providers") !== "0",
	});
	const file = Bun.file(zipPath);
	const body = file.stream();
	const response = new Response(body, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="narrafork-export-${new Date()
				.toISOString()
				.slice(0, 10)}.zip"`,
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
