import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { NotFoundError, RateLimitError, ValidationError } from "../lib/errors";
import { ProviderQuotaError, quotaAbortable } from "../lib/provider-quota-async";
import { requireAdmin } from "../middleware/auth";
import { providerQuotaService } from "../services/provider-quota-service";

const listQuery = z
	.object({
		providerId: z.string().min(1).max(256).optional(),
		cursor: z.string().min(1).max(4_096).optional(),
		limit: z.coerce.number().int().min(1).max(100).default(100),
	})
	.strict();
const refreshBody = z.object({ mode: z.enum(["probe", "refresh"]).optional() }).strict();

async function readQuotaRefreshBody(c: Context): Promise<string> {
	const body = c.req.raw.body;
	if (!body) return "";
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, c.req.raw.signal]);
	const timer = setTimeout(() => controller.abort(new ProviderQuotaError("timeout")), 5_000);
	const reader = body.getReader();
	const cancel = () => void reader.cancel().catch(() => {});
	signal.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		if (Number(c.req.header("Content-Length")) > 1_024) throw new HTTPException(413);
		while (true) {
			const { value, done } = await quotaAbortable(reader.read(), signal);
			if (done) break;
			length += value.byteLength;
			if (length > 1_024) throw new HTTPException(413);
			chunks.push(value);
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		if (error instanceof HTTPException) throw error;
		if (error instanceof ProviderQuotaError && error.code === "timeout")
			throw new HTTPException(408);
		throw new ValidationError("Invalid quota refresh request");
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
		cancel();
		reader.releaseLock();
	}
}

/** Shared by the legacy endpoints so they cannot bypass the service's manual cooldown. */
export async function scheduleManualQuotaRefresh(
	c: Context,
	providerIds: readonly string[],
	mode: "probe" | "refresh" = "refresh",
): Promise<void> {
	const ready: string[] = [];
	let retryAfterMs = Number.POSITIVE_INFINITY;
	for (const id of new Set(providerIds)) {
		if (!providerQuotaService.peek(id)) continue;
		const delay = providerQuotaService.manualRetryAfterMs(id);
		if (delay > 0) retryAfterMs = Math.min(retryAfterMs, delay);
		else ready.push(id);
	}
	if (!ready.length && Number.isFinite(retryAfterMs)) {
		c.header("Retry-After", String(Math.ceil(retryAfterMs / 1_000)));
		throw new RateLimitError(
			"PROVIDER_QUOTA_THROTTLED",
			retryAfterMs,
			"Quota refresh requested too frequently",
		);
	}
	for (const id of ready) {
		try {
			// Queue admission happens before this call returns; accepted work remains detached.
			void providerQuotaService.refresh(id, { mode, manual: true }).catch(() => {});
		} catch (error) {
			if (!(error instanceof ProviderQuotaError) || error.code !== "queue_full") throw error;
			c.header("Retry-After", "1");
			throw new RateLimitError("PROVIDER_QUOTA_BUSY", 1_000, "Quota refresh queue is full");
		}
	}
}

export const providerQuotaRoutes = new Hono();

providerQuotaRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	await next();
});

// app.ts applies first-party session authentication before this router. Settings
// expose all Custom API providers to those sessions; there is no provider-specific
// role/visibility ACL. Only IDs from that effective directory may be returned.
providerQuotaRoutes.get("/", (c) => {
	const query = listQuery.parse(c.req.query());
	const visibleIds = new Set(Object.keys(providerQuotaService.generations()));
	return c.json(providerQuotaService.list({ ...query, visible: (id) => visibleIds.has(id) }));
});

for (const action of ["refresh", "probe"] as const) {
	providerQuotaRoutes.post(`/:id/${action}`, requireAdmin, async (c) => {
		const id = c.req.param("id");
		if (!id) throw new NotFoundError("Provider", "");
		const snapshot = providerQuotaService.peek(id);
		if (!snapshot) throw new NotFoundError("Provider", id);
		let raw: string;
		try {
			raw = await readQuotaRefreshBody(c);
		} catch (error) {
			if (error instanceof HTTPException)
				return c.json(
					{ error: error.status === 413 ? "PAYLOAD_TOO_LARGE" : "REQUEST_TIMEOUT" },
					error.status,
				);
			throw error;
		}
		let body: unknown;
		try {
			body = raw ? JSON.parse(raw) : {};
		} catch {
			throw new ValidationError("Invalid quota refresh request");
		}
		const { mode } = refreshBody.parse(body);
		await scheduleManualQuotaRefresh(c, [id], action === "probe" ? "probe" : (mode ?? "refresh"));
		// Never hold the request open for a plugin; the change event invalidates readers.
		return c.json(providerQuotaService.peek(id));
	});
}
