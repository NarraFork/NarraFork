/**
 * Admin CRUD for third-party OAuth clients (NarraFork as the provider).
 *
 * These endpoints manage the registrations used by the OAuth 2.0 authorization
 * server in `routes/oauth.ts` — they are unrelated to login-via-SSO (OIDC).
 * Mounted at /api/oauth-apps behind the global requireAuth gate; this router
 * additionally restricts the whole surface to admins, mirroring devices.ts.
 */
import { randomBytes } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db";
import { oauthClients } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import {
	exportOAuthClientManifest,
	oauthClientIdSchema,
	oauthClientManifestSchema,
	oauthClientNameSchema,
	oauthClientScopesSchema,
	oauthRedirectUrisSchema,
} from "../lib/oauth-client-manifest";
import {
	DEFAULT_OAUTH_CLIENT_POLICY,
	normalizeOAuthClientPolicy,
	type OAuthClientPolicy,
	oauthClientPolicyPatchSchema,
	oauthClientPolicySchema,
} from "../lib/oauth-client-policy";
import { requireAdmin } from "../middleware/auth";
import { propagateOAuthClientRestriction } from "../services/oauth-runtime-revocation";

type OAuthClientRow = typeof oauthClients.$inferSelect;

/** Public projection of a client. Public clients never carry a secret. */
interface OAuthClientView {
	id: string;
	clientId: string;
	name: string;
	redirectUris: string[];
	scopes: string[];
	grantTypes: string[];
	publicClient: boolean;
	policy: OAuthClientPolicy;
	lastUsedAt: string | null;
	revokedAt: string | null;
	revokedByUserId: string | null;
	revokedReason: string | null;
	createdAt: string;
	updatedAt: string;
}

function toClientView(row: OAuthClientRow): OAuthClientView {
	return {
		id: row.id,
		clientId: row.clientId,
		name: row.name,
		redirectUris: row.redirectUris,
		scopes: row.scopes,
		grantTypes: row.grantTypes,
		publicClient: row.publicClient,
		policy: normalizeOAuthClientPolicy(row.policyJson),
		lastUsedAt: row.lastUsedAt,
		revokedAt: row.revokedAt,
		revokedByUserId: row.revokedByUserId,
		revokedReason: row.revokedReason,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function valuesEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

const createOAuthClientSchema = z.object({
	/** Optional stable ID. Omitted values receive a generated public client ID. */
	clientId: oauthClientIdSchema.optional(),
	name: oauthClientNameSchema,
	redirectUris: oauthRedirectUrisSchema,
	scopes: oauthClientScopesSchema,
	publicClient: z.literal(true).optional(),
	policy: oauthClientPolicySchema.optional(),
});

const updateOAuthClientSchema = z
	.object({
		name: oauthClientNameSchema.optional(),
		redirectUris: oauthRedirectUrisSchema.optional(),
		scopes: oauthClientScopesSchema.optional(),
		policy: oauthClientPolicyPatchSchema.optional(),
	})
	.refine((data) => Object.keys(data).length > 0, {
		message: "At least one field must be provided",
	});

/** Generate a public client identifier, e.g. `nfc_<24 hex chars>`. */
function generateClientId(): string {
	return `nfc_${randomBytes(12).toString("hex")}`;
}

export const oauthAppRoutes = new Hono();

// Registering OAuth clients grants third-party apps API access on behalf of
// users, so the entire surface is admin-only (global requireAuth already ran).
oauthAppRoutes.use("*", requireAdmin);

// List all non-revoked OAuth clients.
oauthAppRoutes.get("/", async (c) => {
	const rows = await db.query.oauthClients.findMany({
		where: isNull(oauthClients.revokedAt),
		orderBy: (t, { asc }) => [asc(t.createdAt)],
		limit: 100,
	});
	return c.json(rows.map(toClientView));
});

// Import a portable v1 manifest. Imports are idempotent by clientId so an
// administrator can correct a partial registration without creating duplicates.
oauthAppRoutes.post("/import", async (c) => {
	const parsed = oauthClientManifestSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const manifest = parsed.data;
	const existing = await db.query.oauthClients.findFirst({
		where: eq(oauthClients.clientId, manifest.clientId),
	});
	const now = new Date().toISOString();
	if (!existing) {
		const [row] = await db
			.insert(oauthClients)
			.values({
				id: generateId(),
				clientId: manifest.clientId,
				name: manifest.name,
				redirectUris: manifest.redirectUris,
				scopes: manifest.scopes,
				grantTypes: manifest.grantTypes,
				publicClient: manifest.publicClient,
				policyJson: manifest.policy,
				createdBy: c.get("user").sub,
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		return c.json({ client: toClientView(row), created: true, updated: false }, 201);
	}
	if (existing.revokedAt) {
		throw new ValidationError("OAuth client is revoked and cannot be imported");
	}

	const scopesChanged = !valuesEqual(existing.scopes, manifest.scopes);
	const policyChanged = !valuesEqual(
		normalizeOAuthClientPolicy(existing.policyJson),
		manifest.policy,
	);
	const changed =
		existing.name !== manifest.name ||
		!valuesEqual(existing.redirectUris, manifest.redirectUris) ||
		scopesChanged ||
		policyChanged ||
		!valuesEqual(existing.grantTypes, manifest.grantTypes) ||
		!existing.publicClient;
	if (!changed) {
		return c.json({ client: toClientView(existing), created: false, updated: false });
	}

	const [row] = await db
		.update(oauthClients)
		.set({
			name: manifest.name,
			redirectUris: manifest.redirectUris,
			scopes: manifest.scopes,
			grantTypes: manifest.grantTypes,
			publicClient: manifest.publicClient,
			policyJson: manifest.policy,
			updatedAt: now,
		})
		.where(eq(oauthClients.id, existing.id))
		.returning();
	if (scopesChanged || policyChanged) {
		await propagateOAuthClientRestriction(
			existing.id,
			"OAuth client imported with changed policy or scopes",
		);
	}
	return c.json({ client: toClientView(row), created: false, updated: true });
});

// Register a new client. The public clientId is returned here; public clients
// hold no secret (they authenticate via PKCE), so nothing else needs to be
// persisted by the caller.
oauthAppRoutes.post("/", async (c) => {
	const parsed = createOAuthClientSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const clientId = parsed.data.clientId ?? generateClientId();
	const duplicate = await db.query.oauthClients.findFirst({
		where: eq(oauthClients.clientId, clientId),
		columns: { id: true },
	});
	if (duplicate) throw new ValidationError("OAuth clientId is already registered");

	const now = new Date().toISOString();
	const [row] = await db
		.insert(oauthClients)
		.values({
			id: generateId(),
			clientId,
			name: parsed.data.name,
			redirectUris: parsed.data.redirectUris,
			scopes: parsed.data.scopes,
			grantTypes: ["authorization_code", "refresh_token"],
			publicClient: parsed.data.publicClient ?? true,
			policyJson: parsed.data.policy ?? DEFAULT_OAUTH_CLIENT_POLICY,
			createdBy: c.get("user").sub,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return c.json(toClientView(row), 201);
});

// Export the portable registration data only; no runtime metadata or secrets.
oauthAppRoutes.get("/:id/export", async (c) => {
	const existing = await db.query.oauthClients.findFirst({
		where: eq(oauthClients.id, c.req.param("id")),
	});
	if (!existing || existing.revokedAt) throw new ValidationError("OAuth client not found");
	return c.json(exportOAuthClientManifest(existing));
});

// Update a client's name / redirect allow-list / scopes.
oauthAppRoutes.patch("/:id", async (c) => {
	const parsed = updateOAuthClientSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const existing = await db.query.oauthClients.findFirst({
		where: eq(oauthClients.id, c.req.param("id")),
	});
	if (!existing || existing.revokedAt) throw new ValidationError("OAuth client not found");

	const { policy: policyPatch, ...clientPatch } = parsed.data;
	let policyJson: OAuthClientPolicy | undefined;
	if (policyPatch) {
		const mergedPolicy = oauthClientPolicySchema.safeParse({
			...normalizeOAuthClientPolicy(existing.policyJson),
			...policyPatch,
		});
		if (!mergedPolicy.success) throw new ValidationError(mergedPolicy.error.message);
		policyJson = mergedPolicy.data;
	}

	const [row] = await db
		.update(oauthClients)
		.set({
			...clientPatch,
			...(policyJson ? { policyJson } : {}),
			updatedAt: new Date().toISOString(),
		})
		.where(eq(oauthClients.id, existing.id))
		.returning();
	if (clientPatch.scopes !== undefined || policyPatch !== undefined) {
		eventBus.emit({
			type: "oauth:client_changed",
			oauthClientId: existing.id,
			change: "restricted",
			reasonCode: "client_policy_or_scope_restricted",
		});
		await propagateOAuthClientRestriction(existing.id, "OAuth client policy or scopes changed");
	}
	return c.json(toClientView(row));
});

// Soft-revoke a client: every flow (authorize/token/refresh) rejects it.
oauthAppRoutes.delete("/:id", async (c) => {
	const existing = await db.query.oauthClients.findFirst({
		where: eq(oauthClients.id, c.req.param("id")),
	});
	if (!existing || existing.revokedAt) throw new ValidationError("OAuth client not found");

	const now = new Date().toISOString();
	const [row] = await db
		.update(oauthClients)
		.set({
			revokedAt: now,
			revokedByUserId: c.get("user").sub,
			revokedReason: "Revoked by administrator",
			updatedAt: now,
		})
		.where(eq(oauthClients.id, existing.id))
		.returning();
	eventBus.emit({
		type: "oauth:client_changed",
		oauthClientId: existing.id,
		change: "revoked",
		reasonCode: "client_revoked",
	});
	await propagateOAuthClientRestriction(existing.id, "OAuth client revoked");
	return c.json({ success: true, ...toClientView(row) });
});
