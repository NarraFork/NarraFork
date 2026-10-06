/**
 * Session-only Connected Apps grant management.
 *
 * This router deliberately does not install authentication itself: production
 * mounts it below the global requireSessionAuth boundary. Keeping the resource
 * router auth-agnostic also makes its ownership behavior straightforward to
 * exercise with the same middleware in route tests.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../lib/errors";
import {
	getUserOAuthGrant,
	listActiveUserOAuthGrantIds,
	listUserOAuthGrants,
	OAUTH_GRANT_DEFAULT_PAGE_LIMIT,
	OAUTH_GRANT_MAX_PAGE_LIMIT,
	type OAuthGrantView,
	revokeOAuthGrantForUser,
	revokeOAuthGrantsForUser,
} from "../services/oauth-grant-service";

const listQuerySchema = z.object({
	limit: z.preprocess(
		(value) => (value === undefined ? OAUTH_GRANT_DEFAULT_PAGE_LIMIT : Number(value)),
		z.number().int().min(1).max(OAUTH_GRANT_MAX_PAGE_LIMIT),
	),
	cursor: z.string().optional(),
});

const revokeBatchSchema = z
	.object({
		grantIds: z.array(z.string().trim().min(1)),
	})
	.strict()
	.transform(({ grantIds }) => [...new Set(grantIds)])
	.refine((grantIds) => grantIds.length >= 1, "grantIds must contain at least one grant id")
	.refine(
		(grantIds) => grantIds.length <= OAUTH_GRANT_MAX_PAGE_LIMIT,
		`grantIds cannot contain more than ${OAUTH_GRANT_MAX_PAGE_LIMIT} unique grant ids`,
	);

const revokeAllSchema = z.object({ confirm: z.literal(true) }).strict();

export interface ConnectedAppGrantItem {
	id: string;
	client: {
		clientId: string;
		name: string;
	};
	scopes: string[];
	projectIds: string[];
	consentedAt: string | null;
	lastUsedAt: string | null;
	status: "active" | "revoked";
	revokedAt: string | null;
	reason: string | null;
}

function toConnectedAppGrant(grant: OAuthGrantView): ConnectedAppGrantItem {
	return {
		id: grant.id,
		client: { clientId: grant.clientId, name: grant.clientName },
		scopes: grant.scopes,
		projectIds: grant.projectIds,
		consentedAt: grant.consentedAt,
		lastUsedAt: grant.lastUsedAt,
		status: grant.revokedAt ? "revoked" : "active",
		revokedAt: grant.revokedAt,
		reason: grant.revokedReason,
	};
}

async function readJson(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new ValidationError("Invalid JSON body");
	}
}

function parseOrThrow<T>(result: z.ZodSafeParseResult<T>): T {
	if (!result.success) throw new ValidationError(result.error.message);
	return result.data;
}

/** Mounted at /api/oauth/grants by the application. */
export const oauthGrantRoutes = new Hono();

/** Alias matching the plural resource name used by some callers. */
export const oauthGrantsRoutes = oauthGrantRoutes;

// The UI needs historical rows as well as currently active grants.
oauthGrantRoutes.get("/", async (c) => {
	const query = parseOrThrow(
		listQuerySchema.safeParse({
			limit: c.req.query("limit"),
			cursor: c.req.query("cursor"),
		}),
	);
	const page = await listUserOAuthGrants(c.get("user").sub, {
		limit: query.limit,
		cursor: query.cursor,
		includeRevoked: true,
	});
	return c.json({
		items: page.items.map(toConnectedAppGrant),
		nextCursor: page.nextCursor,
	});
});

oauthGrantRoutes.get("/:id", async (c) => {
	const grantId = c.req.param("id");
	const grant = await getUserOAuthGrant(c.get("user").sub, grantId);
	if (!grant) throw new NotFoundError("OAuth grant", grantId);
	return c.json(toConnectedAppGrant(grant));
});

oauthGrantRoutes.delete("/:id", async (c) => {
	const grantId = c.req.param("id");
	const revoked = await revokeOAuthGrantForUser({
		grantId,
		userId: c.get("user").sub,
		reason: "Revoked by user",
	});
	if (!revoked) throw new NotFoundError("OAuth grant", grantId);
	return c.json(toConnectedAppGrant(revoked));
});

oauthGrantRoutes.post("/revoke-batch", async (c) => {
	const grantIds = parseOrThrow(revokeBatchSchema.safeParse(await readJson(c)));
	const result = await revokeOAuthGrantsForUser({
		grantIds,
		userId: c.get("user").sub,
		reason: "Revoked by user",
	});
	return c.json(result);
});

oauthGrantRoutes.post("/revoke-all", async (c) => {
	const body = parseOrThrow(revokeAllSchema.safeParse(await readJson(c)));
	if (!body.confirm) throw new ValidationError("confirm must be true");

	const userId = c.get("user").sub;
	const page = await listActiveUserOAuthGrantIds(userId, OAUTH_GRANT_MAX_PAGE_LIMIT);
	const result =
		page.ids.length > 0
			? await revokeOAuthGrantsForUser({
					grantIds: page.ids,
					userId,
					reason: "Revoked by user",
				})
			: { revokedCount: 0 };
	return c.json({ revokedCount: result.revokedCount, hasMore: page.hasMore });
});
