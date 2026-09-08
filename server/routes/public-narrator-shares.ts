import { Hono } from "hono";
import { getClientIp } from "../lib/client-ip";
import { AppError, RateLimitError } from "../lib/errors";
import {
	postPublicDiscussionSchema,
	publicSharePageSchema,
} from "../lib/validators/public-narrator-shares";
import { listPublicDiscussion, postPublicDiscussion } from "../services/chat-service";
import { PUBLIC_SHARE_LIMITS as L } from "../services/public-narrator-share-limits";
import {
	getPublicSharedTool,
	listPublicSharedMessages,
} from "../services/public-narrator-share-messages";
import { publicShareRateLimiter } from "../services/public-narrator-share-rate-limit";
import {
	createPublicShare,
	getPublicSharedSession,
	listPublicShares,
	revalidatePublicShare,
	revokePublicShare,
	type VerifiedPublicShare,
	verifyPublicShare,
} from "../services/public-narrator-share-service";
import { publicNarratorShareStreams } from "../services/public-narrator-share-stream";

/** Bounded at the stream, even when Content-Length is absent or dishonest. */
export async function readPublicShareJson(request: Request): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) throw new AppError("Invalid JSON", 400, "PUBLIC_SHARE_INVALID_INPUT");
	let stop: (error: Error) => void = () => {};
	const stopped = new Promise<never>((_resolve, reject) => {
		stop = reject;
	});
	const abort = () => {
		stop(new AppError("Request interrupted", 408, "PUBLIC_SHARE_BODY_TIMEOUT"));
		void reader.cancel().catch(() => {});
	};
	const timer = setTimeout(abort, L.bodyReadMs);
	request.signal.addEventListener("abort", abort, { once: true });
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		if (request.signal.aborted)
			throw new AppError("Request interrupted", 408, "PUBLIC_SHARE_BODY_TIMEOUT");
		if (Number(request.headers.get("Content-Length")) > L.bodyBytes)
			throw new AppError("Request body too large", 413, "PUBLIC_SHARE_BODY_LIMIT");
		while (true) {
			const chunk = await Promise.race([reader.read(), stopped]);
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > L.bodyBytes)
				throw new AppError("Request body too large", 413, "PUBLIC_SHARE_BODY_LIMIT");
			chunks.push(chunk.value);
		}
		try {
			return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
		} catch {
			throw new AppError("Invalid JSON", 400, "PUBLIC_SHARE_INVALID_INPUT");
		}
	} finally {
		clearTimeout(timer);
		request.signal.removeEventListener("abort", abort);
		void reader.cancel().catch(() => {});
	}
}

/** Mount ONLY after requireSessionAuth, beside /api/narrators. */
export const publicNarratorShareManagementRoutes = new Hono();
publicNarratorShareManagementRoutes.use("/:id/public-shares*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	await next();
});
publicNarratorShareManagementRoutes.get("/:id/public-shares", async (c) => {
	const user = c.get("user");
	return c.json(
		await listPublicShares(
			c.req.param("id"),
			{ userId: user.sub, isAdmin: user.role === "admin" },
			c.req.query(),
		),
	);
});
publicNarratorShareManagementRoutes.post("/:id/public-shares", async (c) => {
	const user = c.get("user");
	return c.json(
		await createPublicShare(
			c.req.param("id"),
			{ userId: user.sub, isAdmin: user.role === "admin" },
			await readPublicShareJson(c.req.raw),
		),
		201,
	);
});
publicNarratorShareManagementRoutes.delete("/:id/public-shares/:shareId", async (c) => {
	const user = c.get("user");
	await revokePublicShare(c.req.param("id"), c.req.param("shareId"), {
		userId: user.sub,
		isAdmin: user.role === "admin",
	});
	return c.body(null, 204);
});

type PublicEnv = { Variables: { publicShare: VerifiedPublicShare; publicIp: string } };
/** Self-contained anonymous prefix: no JWT/cookie fallback, including unknown routes. */
export const publicNarratorShareRoutes = new Hono<PublicEnv>();
publicNarratorShareRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
	c.header("X-Content-Type-Options", "nosniff");
	const ip = getClientIp(c) || "unknown";
	publicShareRateLimiter.consume("ip", ip);
	// Hono's wildcard middleware has no named params at its own route index.
	// Derive only the public identifier from the fixed mount, never a token.
	const shareId = /^\/api\/public\/narrator-shares\/([^/]+)(?:\/|$)/.exec(c.req.path)?.[1] ?? "";
	const auth = verifyPublicShare(shareId, c.req.header("Authorization"));
	c.set("publicShare", auth);
	c.set("publicIp", ip);
	const kind =
		c.req.method === "POST" ? "post" : c.req.path.endsWith("/events") ? "connect" : "read";
	publicShareRateLimiter.consume(kind, auth.shareId);
	await next();
});

// Deliberately no internal error messages, IDs, stack traces or body/secret logging.
publicNarratorShareRoutes.onError((error, c) => {
	if (error instanceof RateLimitError) {
		c.header("Retry-After", String(error.retryAfterSeconds));
		return c.json({ error: "Too many sharing requests", code: error.code }, 429);
	}
	if (error instanceof AppError && error.code === "PUBLIC_SHARE_BODY_LIMIT")
		return c.json({ error: "Request body too large", code: error.code }, 413);
	if (error instanceof AppError && error.code === "PUBLIC_SHARE_BODY_TIMEOUT")
		return c.json({ error: "Request interrupted", code: error.code }, 408);
	if (error instanceof AppError && error.code === "PUBLIC_SHARE_RESET")
		return c.json({ error: "Transcript changed; refresh", code: "PUBLIC_SHARE_RESET" }, 409);
	if (
		error instanceof AppError &&
		error.statusCode >= 400 &&
		error.statusCode < 500 &&
		error.statusCode !== 404 &&
		error.statusCode !== 403 &&
		error.statusCode !== 401
	)
		return c.json({ error: "Invalid sharing request", code: "PUBLIC_SHARE_INVALID_INPUT" }, 400);
	if (error instanceof AppError && [401, 403, 404].includes(error.statusCode))
		return c.json({ error: "Share link unavailable", code: "PUBLIC_SHARE_UNAVAILABLE" }, 404);
	return c.json(
		{ error: "Sharing temporarily unavailable", code: "PUBLIC_SHARE_TEMPORARY_ERROR" },
		503,
	);
});

publicNarratorShareRoutes.get("/:shareId", (c) =>
	c.json(getPublicSharedSession(c.get("publicShare"))),
);
publicNarratorShareRoutes.get("/:shareId/session", (c) =>
	c.json(getPublicSharedSession(c.get("publicShare"))),
);
publicNarratorShareRoutes.get("/:shareId/messages", (c) =>
	c.json(listPublicSharedMessages(c.get("publicShare"), c.req.query())),
);
publicNarratorShareRoutes.get("/:shareId/tools/:toolUseId", (c) =>
	c.json(getPublicSharedTool(c.get("publicShare"), c.req.param("toolUseId"))),
);
publicNarratorShareRoutes.get("/:shareId/discussion", async (c) => {
	const auth = c.get("publicShare");
	const parsed = publicSharePageSchema.safeParse(c.req.query());
	if (!parsed.success) throw new AppError("Invalid page parameters", 400);
	const page = await listPublicDiscussion({
		shareId: auth.shareId,
		tokenHash: auth.tokenHash,
		beforeSeq: parsed.data.beforeSeq,
		limit: parsed.data.limit,
	});
	revalidatePublicShare(auth);
	return c.json(page);
});
publicNarratorShareRoutes.post("/:shareId/discussion", async (c) => {
	const auth = c.get("publicShare");
	const parsed = postPublicDiscussionSchema.safeParse(await readPublicShareJson(c.req.raw));
	if (!parsed.success) throw new AppError("Invalid discussion parameters", 400);
	const message = await postPublicDiscussion({
		shareId: auth.shareId,
		tokenHash: auth.tokenHash,
		...parsed.data,
	});
	revalidatePublicShare(auth);
	return c.json(message, 201);
});
publicNarratorShareRoutes.get("/:shareId/events", (c) => {
	const stream = publicNarratorShareStreams.open(
		c.get("publicShare"),
		c.get("publicIp"),
		c.req.raw.signal,
	);
	c.header("Content-Type", "text/event-stream; charset=utf-8");
	c.header("X-Accel-Buffering", "no");
	return c.body(stream);
});
// Terminating fallbacks are essential: an invalid sharing path must NEVER execute
// SessionAuth or a first-party route registered later on the parent Hono app.
publicNarratorShareRoutes.all("/:shareId/*", (c) =>
	c.json({ error: "Not found", code: "PUBLIC_SHARE_NOT_FOUND" }, 404),
);
publicNarratorShareRoutes.all("*", (c) =>
	c.json({ error: "Not found", code: "PUBLIC_SHARE_NOT_FOUND" }, 404),
);
