import { readQuery } from "@server/db/worker-read";
import { isGenUiToolName } from "@shared/gen-ui-public";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { narrators } from "../db/schema";
import { getClientIp } from "../lib/client-ip";
import { AppError, RateLimitError } from "../lib/errors";
import {
	postPublicDiscussionSchema,
	publicSharePageSchema,
} from "../lib/validators/public-narrator-shares";
import { listPublicDiscussion, postPublicDiscussion } from "../services/chat-service";
import { narratorService } from "../services/narrator-service";
import {
	isPublicToolSourceAllowed,
	projectPublicNarratorPayload,
} from "../services/public-narrator-share-gen-ui";
import { PUBLIC_SHARE_LIMITS as L } from "../services/public-narrator-share-limits";
import { publicShareRateLimiter } from "../services/public-narrator-share-rate-limit";
import {
	createPublicShare,
	getPublicSharedSession,
	listPublicShares,
	revalidatePublicShare,
	revokePublicShare,
	unavailablePublicShare,
	type VerifiedPublicShare,
	verifyPublicShare,
} from "../services/public-narrator-share-service";
import {
	parseHistoricalWriteDocumentReference,
	parseTextDocumentRangeQuery,
	toolInputStreamSource,
} from "../services/tool-input-stream-source";

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

// ── Narrator document read-through ──────────────────────────────────────────
// The share link grants existing narrator reads unchanged, except GenUI
// tool cards: preview references/results become a static server-authored summary.
// Ordinary Read/Write/Edit file history is unchanged, including UI source files.
// Parameter parsing mirrors `server/routes/narrators.ts` — keep them in sync.
publicNarratorShareRoutes.get("/:shareId/pretext-document", async (c) => {
	const auth = c.get("publicShare");
	const afterSeqRaw = c.req.query("afterSeq");
	const beforeSeqRaw = c.req.query("beforeSeq");
	const limitRaw = c.req.query("limit");
	const messageVersionRaw = c.req.query("messageVersion");
	const afterSeq = afterSeqRaw != null ? Number.parseInt(afterSeqRaw, 10) : undefined;
	const beforeSeq = beforeSeqRaw != null ? Number.parseInt(beforeSeqRaw, 10) : undefined;
	const requestedLimit = limitRaw != null ? Number.parseInt(limitRaw, 10) : undefined;
	const expectedMessageVersion =
		messageVersionRaw != null ? Number.parseInt(messageVersionRaw, 10) : undefined;
	const limit =
		requestedLimit != null && !Number.isNaN(requestedLimit)
			? Math.min(Math.max(requestedLimit, 1), 100)
			: 100;
	const result = await narratorService.getPretextDocumentPage(auth.narratorId, {
		afterSeq: afterSeq != null && !Number.isNaN(afterSeq) ? afterSeq : undefined,
		beforeSeq: beforeSeq != null && !Number.isNaN(beforeSeq) ? beforeSeq : undefined,
		limit,
		messageVersion:
			expectedMessageVersion != null && !Number.isNaN(expectedMessageVersion)
				? expectedMessageVersion
				: undefined,
	});
	// The service guarantees the page's own revision consistency (see the narrator
	// route's note); a second version comparison here only produced spurious 409s.
	const narratorMeta = await readQuery(
		db.query.narrators.findFirst({
			where: eq(narrators.id, auth.narratorId),
			columns: { id: true },
		}),
	);
	if (!narratorMeta) throw unavailablePublicShare();
	revalidatePublicShare(auth);
	return c.json(projectPublicNarratorPayload(auth.narratorId, result));
});
publicNarratorShareRoutes.get("/:shareId/tool-calls/:toolUseId/input-document", async (c) => {
	const auth = c.get("publicShare");
	const reference = parseHistoricalWriteDocumentReference(c.req.query());
	const metadata = await narratorService.getToolCallPreviewMetadata(
		auth.narratorId,
		c.req.param("toolUseId"),
		reference,
	);
	if (isGenUiToolName(metadata.toolName)) throw unavailablePublicShare();
	const ref = await toolInputStreamSource.ensureWriteDocumentSource(
		auth.narratorId,
		c.req.param("toolUseId"),
		reference,
		c.req.raw.signal,
	);
	revalidatePublicShare(auth);
	return c.json(ref);
});

publicNarratorShareRoutes.get("/:shareId/text-documents/:refId", async (c) => {
	const auth = c.get("publicShare");
	const { offset, limit } = parseTextDocumentRangeQuery(c.req.query());
	// Descriptor metadata is server-owned. Classify BEFORE reading source bytes,
	// including refs learned from an authenticated tab or a prior WS connection.
	const descriptor = toolInputStreamSource.descriptor(c.req.param("refId"));
	if (
		descriptor.source?.narratorId !== auth.narratorId ||
		!isPublicToolSourceAllowed(auth.narratorId, descriptor.source)
	)
		throw unavailablePublicShare();
	const range = await toolInputStreamSource.getTextDocumentRange(
		auth.narratorId,
		c.req.param("refId"),
		offset,
		limit,
		c.req.raw.signal,
	);
	// Revocation/expiry during asynchronous disk I/O must not return any source bytes.
	revalidatePublicShare(auth);
	return c.json(range);
});

publicNarratorShareRoutes.get("/:shareId/message-location/:messageId", async (c) => {
	const auth = c.get("publicShare");
	const location = await narratorService.getMessageLocation(
		auth.narratorId,
		c.req.param("messageId"),
	);
	revalidatePublicShare(auth);
	return c.json(location);
});
publicNarratorShareRoutes.get("/:shareId/tool-calls/:toolUseId", async (c) => {
	const auth = c.get("publicShare");
	const reference = {
		toolCallId: c.req.query("toolCallId"),
		messageId: c.req.query("messageId"),
	};
	const metadata = await narratorService.getToolCallPreviewMetadata(
		auth.narratorId,
		c.req.param("toolUseId"),
		reference,
	);
	// The existing selector handles shared refs/COW/subagent ancestry. Do not load
	// private input/output/error bodies just to discover that access is forbidden.
	if (isGenUiToolName(metadata.toolName)) throw unavailablePublicShare();
	const detail = await narratorService.getToolCallDetail(
		auth.narratorId,
		c.req.param("toolUseId"),
		{ toolCallId: metadata.id, messageId: metadata.messageId },
	);
	if (isGenUiToolName(detail.toolName)) throw unavailablePublicShare();
	revalidatePublicShare(auth);
	return c.json(detail);
});

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
// Terminating fallbacks are essential: an invalid sharing path must NEVER execute
// SessionAuth or a first-party route registered later on the parent Hono app.
publicNarratorShareRoutes.all("/:shareId/*", (c) =>
	c.json({ error: "Not found", code: "PUBLIC_SHARE_NOT_FOUND" }, 404),
);
publicNarratorShareRoutes.all("*", (c) =>
	c.json({ error: "Not found", code: "PUBLIC_SHARE_NOT_FOUND" }, 404),
);
