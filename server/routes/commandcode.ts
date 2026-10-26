/**
 * Command Code 的只读接口：登录状态与额度，以及管理员触发的模型刷新。
 *
 * 凭据来自设置页 API key，缺省时回退 CLI 的 `~/.commandcode/auth.json`。
 * 未登录时返回 `loggedIn: false` 与原因码，文案由前端翻译。
 */

import { Hono } from "hono";
import { z } from "zod";
import {
	invalidateCommandCodeAuthCache,
	resolveCommandCodeToken,
} from "../lib/commandcode-manager";
import { invalidateCommandCodeModelsCache, listCommandCodeModels } from "../lib/commandcode-models";
import { CommandCodeUsageError, fetchCommandCodeUsage } from "../lib/commandcode-usage";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { requireAdmin } from "../middleware/auth";

export const commandCodeRoutes = new Hono();

const refreshSchema = z
	.object({
		apiKey: z.string().max(4_000).optional(),
		baseUrl: z.string().max(2_000).optional(),
	})
	.strict();

/** 星号开头是设置页回显的脱敏值，不能当成新 key 去打上游。 */
function usableDraftKey(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.startsWith("*")) return undefined;
	return trimmed;
}

/** GET /api/commandcode/status — 凭据是否可用。 */
commandCodeRoutes.get("/status", (c) => {
	// 状态查询要能反映"刚在 CLI 里登录"，所以跳过凭据短缓存。
	const auth = resolveCommandCodeToken(settings.commandCode?.apiKey, { fresh: true });
	return c.json({
		loggedIn: !!auth.credential,
		userName: auth.credential?.userName,
		reason: auth.reason,
	});
});

/** GET /api/commandcode/usage — 额度；同时回报登录状态，让前端一次请求就能渲染。 */
commandCodeRoutes.get("/usage", async (c) => {
	// 与 /status 同理：额度面板上的登录状态必须是当前的真实状态。
	const auth = resolveCommandCodeToken(settings.commandCode?.apiKey, { fresh: true });
	if (!auth.credential) {
		return c.json({ loggedIn: false, reason: auth.reason });
	}
	try {
		return c.json({
			loggedIn: true,
			...(await fetchCommandCodeUsage(auth.credential.token, settings.commandCode?.baseUrl)),
		});
	} catch (error) {
		const code = error instanceof CommandCodeUsageError ? error.message : "usage_unavailable";
		const upstreamStatus = error instanceof CommandCodeUsageError ? error.status : 0;
		logger.error("Failed to fetch Command Code usage", { error: code, upstreamStatus });
		if (code === "unauthorized" || upstreamStatus === 401) {
			return c.json({ loggedIn: false, reason: "unauthorized" }, 401);
		}
		return c.json({ loggedIn: true, error: "usage_unavailable" }, 502);
	}
});

/**
 * POST /api/commandcode/models/refresh — 丢弃模型缓存并重新拉取。
 *
 * 只允许管理员。可选 body 里的 apiKey / baseUrl 只用于这一次拉取（设置页尚未保存的草稿），
 * 不写回 settings。未提供时用已保存的配置。
 */
commandCodeRoutes.post("/models/refresh", requireAdmin, async (c) => {
	const text = await c.req.text();
	let draft: z.infer<typeof refreshSchema> = {};
	if (text.trim()) {
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(text) as unknown;
		} catch {
			return c.json({ error: "invalid_body" }, 400);
		}
		const parsed = refreshSchema.safeParse(parsedJson);
		if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
		draft = parsed.data;
	}
	const apiKey = usableDraftKey(draft.apiKey) ?? settings.commandCode?.apiKey;
	const baseUrl = draft.baseUrl?.trim() || settings.commandCode?.baseUrl;
	invalidateCommandCodeModelsCache();
	// 刷新也意味着"现在的凭据"，不要沿用短缓存里的旧 token。
	invalidateCommandCodeAuthCache();
	const result = await listCommandCodeModels(apiKey, baseUrl);
	return c.json({ models: result.models, ok: result.ok }, result.ok ? 200 : 502);
});
