import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { RateLimitError } from "../lib/errors";
import { getSettingsRevision, settings } from "../lib/settings";
import {
	currentCommandCodeCliIdentity,
	publicQuotaSnapshot,
	quotaRefreshRetryAfterMs,
	readQuotaSnapshots,
	refreshCommandCodeCliQuota,
	refreshQuotaSnapshots,
	waitForTokenDanceQuotaRefresh,
} from "../lib/sourcing/quota-snapshots";
import { getSourceGroup } from "../lib/sourcing/source-groups";
import { assertAdmin, requireSessionAuth } from "../middleware/auth";

const refreshSchema = z
	.object({
		groupId: z.string().min(1).max(256).optional(),
		credentialId: z.string().min(1).max(256).optional(),
	})
	.strict();

export const quotaSnapshotRoutes = new Hono();
quotaSnapshotRoutes.use("*", requireSessionAuth);
quotaSnapshotRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	await next();
});
quotaSnapshotRoutes.get("/", (c) => {
	const parsed = z
		.object({
			groupId: z.string().min(1).max(256).optional(),
			cachedOnly: z.enum(["true", "false"]).optional(),
			expectedGeneration: z.coerce.number().int().nonnegative().optional(),
		})
		.strict()
		.safeParse(c.req.query());
	if (!parsed.success) return c.json({ error: "invalid_scope" }, 400);
	const { groupId, cachedOnly, expectedGeneration } = parsed.data;
	if (groupId && !getSourceGroup(groupId)) return c.json({ error: "quota_subject_not_found" }, 404);
	if (expectedGeneration !== undefined && expectedGeneration !== getSettingsRevision())
		return c.json({ error: "Model runtime generation changed", code: "MODEL_RUNTIME_STALE" }, 409);
	const response = readQuotaSnapshots(
		c.get("user").role === "admin",
		cachedOnly !== "true",
		groupId,
	);
	if (expectedGeneration !== undefined && expectedGeneration !== getSettingsRevision())
		return c.json({ error: "Model runtime generation changed", code: "MODEL_RUNTIME_STALE" }, 409);
	const body = JSON.stringify(response);
	if ((groupId || cachedOnly === "true") && Buffer.byteLength(body) > 64 * 1024)
		return c.json(
			{ error: "Quota response exceeds the read budget", code: "QUOTA_RESPONSE_TOO_LARGE" },
			502,
		);
	return c.body(body, 200, { "Content-Type": "application/json" });
});
quotaSnapshotRoutes.post(
	"/refresh",
	bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "body_too_large" }, 413) }),
	async (c) => {
		let raw: unknown;
		try {
			const text = await c.req.text();
			raw = text.trim() ? JSON.parse(text) : {};
		} catch (error) {
			if (
				(error instanceof HTTPException && error.status === 413) ||
				(error instanceof Error && error.name === "BodyLimitError")
			)
				return c.json({ error: "body_too_large" }, 413);
			return c.json({ error: "invalid_body" }, 400);
		}
		const parsed = refreshSchema.safeParse(raw);
		if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
		const filter = parsed.data;
		const isAdmin = c.get("user").role === "admin";
		// The old Command Code GET allowed any session to read uncached CLI usage. Keep that
		// permission only for this exact operation; every cache-bypassing refresh stays admin-only.
		const cliOnly =
			filter.groupId === "CommandCode" && !filter.credentialId && !settings.commandCode?.apiKey;
		if (!cliOnly) await assertAdmin(c);
		const before = readQuotaSnapshots(isAdmin, false);
		if (
			(filter.groupId || filter.credentialId) &&
			!before.entries.some(
				(entry) =>
					(!filter.groupId || entry.groupId === filter.groupId) &&
					(!filter.credentialId || entry.credentialId === filter.credentialId),
			)
		)
			return c.json({ error: "quota_subject_not_found" }, 404);
		const retryAfterMs = cliOnly ? 0 : quotaRefreshRetryAfterMs(filter);
		if (retryAfterMs) {
			c.header("Retry-After", String(Math.ceil(retryAfterMs / 1_000)));
			throw new RateLimitError(
				"PROVIDER_BALANCE_THROTTLED",
				retryAfterMs,
				"Balance probe requested too frequently",
			);
		}
		const refresh = refreshQuotaSnapshots(filter);
		if (filter.groupId === "tokendance")
			await waitForTokenDanceQuotaRefresh(refresh, c.req.raw.signal);
		else void refresh.catch(() => {});
		const cliIdentity = cliOnly ? currentCommandCodeCliIdentity() : undefined;
		const cli = cliOnly ? await refreshCommandCodeCliQuota(c.req.raw.signal) : undefined;
		const response = readQuotaSnapshots(isAdmin, false);
		if (cli && cliIdentity && currentCommandCodeCliIdentity() === cliIdentity) {
			const entry = response.entries.find(
				(entry) =>
					entry.groupId === "CommandCode" &&
					entry.source === "probe" &&
					entry.credentialId === null &&
					entry.refreshOnRead === true,
			);
			if (entry) {
				entry.snapshot = publicQuotaSnapshot(cli);
				entry.refreshing = false;
			}
		}
		return c.json(response);
	},
);
