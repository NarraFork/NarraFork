import { type Context, Hono } from "hono";
import { scheduleOperatorShutdown } from "../lib/server-restart";
import { requireAdmin, requireAdminOrManagerToken, requireAuth } from "../middleware/auth";
import { systemLifecycle } from "../services/system-lifecycle-service";

export const systemLifecycleRoutes = new Hono();
systemLifecycleRoutes.use("*", requireAuth);
// All signed-in users need to distinguish maintenance pauses from stuck narrators.
// Do not expose coordinator blockers, narrator identities, or diagnostics here.
systemLifecycleRoutes.get("/notice", (c) => {
	const { phase, shutdownRequested } = systemLifecycle.status();
	c.header("Cache-Control", "no-store");
	return c.json({ phase, shutdownRequested });
});
systemLifecycleRoutes.get("/status", requireAdmin, (c) => {
	c.header("Cache-Control", "no-store");
	return c.json(systemLifecycle.status());
});
systemLifecycleRoutes.post("/prepare", requireAdmin, (c) => {
	const result = systemLifecycle.prepare();
	return c.json(result, result.success ? 202 : 409);
});
function shutdownResponse(c: Context) {
	const result = systemLifecycle.shutdown();
	return c.json(result, result.success ? 202 : 409);
}

systemLifecycleRoutes.post("/shutdown", requireAdmin, (c) => shutdownResponse(c));

/**
 * 管理器面板的停止入口。与更新路由一样挂在全局会话认证之前。
 * 本机回环加管理器令牌可以调用；其余请求仍要管理员会话。
 */
export const managerLifecycleRoutes = new Hono();
managerLifecycleRoutes.post("/shutdown", requireAdminOrManagerToken, (c) => shutdownResponse(c));
// 与 Ctrl+C 相同：reason=signal 走完整优雅退出，不走更新交接那条保留现场的准备流程。
managerLifecycleRoutes.post("/signal", requireAdminOrManagerToken, (c) => {
	const scheduled = scheduleOperatorShutdown({ reason: "signal" });
	return c.json({ success: scheduled }, scheduled ? 202 : 409);
});
systemLifecycleRoutes.post("/cancel", requireAdmin, (c) => {
	const result = systemLifecycle.cancel();
	return c.json(result, result.success ? 202 : 409);
});
