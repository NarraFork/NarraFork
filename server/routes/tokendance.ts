import { parseTokenDanceRecoveryAction } from "@shared/tokendance";
import { Hono } from "hono";
import { z } from "zod";
import { toErrorPayload } from "../lib/app-error-response";
import { AppError } from "../lib/errors";
import { requireAdmin, requireSessionAuth } from "../middleware/auth";
import {
	cancelTokenDanceOAuth,
	completeTokenDanceOAuth,
	createTokenDancePaymentSession,
	deleteTokenDanceConnection,
	getTokenDanceBalance,
	getTokenDanceConnection,
	getTokenDancePaymentSession,
	refreshTokenDanceBalance,
	refreshTokenDanceModels,
	restoreTokenDanceDraft,
	setTokenDanceDisabled,
	startTokenDanceOAuth,
	validateTokenDanceCallback,
} from "../services/tokendance-service";

export const tokendanceRoutes = new Hono();
tokendanceRoutes.onError((error, c) => {
	if (!(error instanceof AppError)) throw error;
	if (c.req.path.endsWith("/oauth/start") || c.req.path.endsWith("/oauth/complete")) {
		// Deliberately exclude messages, bodies, queries, headers, and credentials.
		console.warn("[TokenDance] OAuth request rejected", {
			stage: c.req.path.endsWith("/oauth/start") ? "start" : "complete",
			status: error.statusCode,
			code: error.code,
		});
	}
	const action = parseTokenDanceRecoveryAction(
		(error as AppError & { extra?: { recoveryAction?: unknown } }).extra?.recoveryAction,
	);
	// Only whitelisted recovery metadata reaches the browser; never upstream errors.
	return c.json(
		{ ...toErrorPayload(error), ...(action ? { recoveryAction: action } : {}) },
		error.statusCode as 400,
	);
});
// Explicit session gate remains necessary when this router is mounted independently.
// External OAuth admin principals must never reach credential management.
tokendanceRoutes.use("*", requireSessionAuth);
// Register the ordinary-user summary before the administrator gate.
tokendanceRoutes.get("/balance", (c) => c.json(getTokenDanceBalance()));
tokendanceRoutes.use("*", requireAdmin);
tokendanceRoutes.post("/balance/refresh", async (c) => c.json(await refreshTokenDanceBalance()));
tokendanceRoutes.post("/payment/sessions", async (c) => {
	const input = await body(
		c.req.raw,
		z
			.object({
				amount: z.number().int().min(1).max(100000),
				generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
				requestId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
				billingInstance: z.string().regex(/^[a-f0-9]{32}$/),
			})
			.strict(),
	);
	return c.json({ session: await createTokenDancePaymentSession(c.get("user").sub, input) });
});
tokendanceRoutes.get("/payment/sessions/:id", async (c) =>
	c.json({ session: await getTokenDancePaymentSession(c.get("user").sub, c.req.param("id")) }),
);
const flowSchema = z.object({ flowId: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const completeSchema = flowSchema.extend({
	code: z
		.string()
		.min(1)
		.max(4096)
		.regex(/^[!-~]+$/),
});
const startSchema = z
	.object({ callbackUrl: z.string().min(1).max(2048), draftSnapshot: z.unknown().optional() })
	.strict();
async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
	// Bound before parsing; drafts contain potentially sensitive unsaved credentials.
	const reader = request.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (reader) {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > 1024 * 1024 + 8192) {
					await reader.cancel();
					throw new AppError("TokenDance request exceeds size limit", 413, "TOKENDANCE_ERROR");
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new AppError("Invalid TokenDance request", 400, "TOKENDANCE_ERROR");
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new AppError("Invalid TokenDance request", 400, "TOKENDANCE_ERROR");
	return parsed.data;
}
tokendanceRoutes.post("/oauth/start", async (c) => {
	const input = await body(c.req.raw, startSchema);
	const callback = validateTokenDanceCallback(
		input.callbackUrl,
		c.req.url,
		c.req.header("Origin"),
		c.req.header("Sec-Fetch-Site"),
	);
	return c.json(startTokenDanceOAuth(c.get("user").sub, callback, input.draftSnapshot));
});
tokendanceRoutes.post("/oauth/complete", async (c) => {
	const input = await body(c.req.raw, completeSchema);
	return c.json(await completeTokenDanceOAuth(c.get("user").sub, input.flowId, input.code));
});
tokendanceRoutes.post("/oauth/cancel", async (c) => {
	const input = await body(c.req.raw, flowSchema);
	cancelTokenDanceOAuth(c.get("user").sub, input.flowId);
	return c.json({ success: true });
});
tokendanceRoutes.post("/oauth/restore", async (c) => {
	const input = await body(c.req.raw, flowSchema);
	return c.json(restoreTokenDanceDraft(c.get("user").sub, input.flowId));
});
tokendanceRoutes.get("/connection", (c) => c.json(getTokenDanceConnection()));
tokendanceRoutes.post("/models/refresh", async (c) =>
	c.json({ models: await refreshTokenDanceModels(c.req.raw.signal) }),
);
tokendanceRoutes.patch("/connection", async (c) => {
	const input = await body(c.req.raw, z.object({ disabled: z.boolean() }).strict());
	return c.json(await setTokenDanceDisabled(input.disabled));
});
tokendanceRoutes.delete("/connection", async (c) => {
	await deleteTokenDanceConnection();
	return c.json({ success: true });
});
