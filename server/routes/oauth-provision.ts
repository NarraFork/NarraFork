/**
 * Deprecated compatibility shim for the original OAuth provisioning endpoints.
 *
 * New integrations must use `/api/external/v1`. These handlers keep the legacy
 * scopes and response field names, but delegate all ownership, project and
 * policy enforcement to the versioned external resource service.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { db } from "../db";
import { remoteDevices } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { oauthRateLimit } from "../lib/oauth-rate-limit";
import { requireOAuthAuth } from "../middleware/auth";
import {
	provisionExternalDevice,
	provisionExternalNarrator,
} from "../services/external-resource-service";
import {
	assertExternalProjectAllowed,
	assertExternalScope,
	type ExternalOAuthContext,
	requireExternalOAuthContext,
} from "../services/oauth-resource-access";

const legacyDeviceSchema = z
	.object({
		name: z.string().trim().min(1).max(120).optional(),
		label: z
			.string()
			.trim()
			.min(1)
			.max(48)
			.regex(/^[a-z0-9][a-z0-9_-]*$/, "label must match [a-z0-9_-]")
			.optional(),
		projectId: z.string().trim().min(1).max(128).optional(),
		// Retained only so older clients receive a validation-compatible response;
		// external resource identity is the provision key, never the display slug.
		slug: z
			.string()
			.trim()
			.min(1)
			.max(48)
			.regex(/^[a-z0-9][a-z0-9_-]*$/, "slug must match [a-z0-9_-]")
			.optional(),
	})
	.strict();

const legacyNarratorSchema = z
	.object({
		deviceRef: z.string().trim().min(1).max(128),
		projectId: z.string().trim().min(1).max(128).optional(),
		title: z.string().trim().min(1).max(200).optional(),
		systemPrompt: z.string().max(10_000).optional(),
		permissionMode: z.enum(["readOnly", "dontAsk"]).optional(),
	})
	.strict();

function markDeprecated(c: Context): void {
	c.header("Deprecation", "true");
	c.header("Link", '</api/external/v1>; rel="successor-version"');
	c.header("Warning", '299 NarraFork "Deprecated OAuth provisioning endpoint"');
}

function withCompatibilityScope(ctx: ExternalOAuthContext, scope: string): ExternalOAuthContext {
	return {
		...ctx,
		scopes: Object.freeze([...new Set([...ctx.scopes, scope])]),
	};
}

function resolveLegacyProjectId(ctx: ExternalOAuthContext, requested?: string): string {
	if (requested) {
		assertExternalProjectAllowed(ctx, requested);
		return requested;
	}
	if (ctx.projectIds.length === 1) return ctx.projectIds[0];
	if (ctx.projectIds.length === 0) {
		throw new ValidationError("The OAuth grant does not allow any projects");
	}
	throw new ValidationError("projectId is required when the OAuth grant allows multiple projects");
}

async function resolveOwnedLegacyDeviceId(
	ctx: ExternalOAuthContext,
	deviceRef: string,
): Promise<string> {
	const row = await db.query.remoteDevices.findFirst({
		where: and(
			eq(remoteDevices.oauthOwnerGrantId, ctx.grantId),
			isNull(remoteDevices.revokedAt),
			or(eq(remoteDevices.id, deviceRef), eq(remoteDevices.slug, deviceRef)),
		),
		columns: { id: true },
	});
	if (!row) throw new NotFoundError("Remote device", deviceRef);
	return row.id;
}

export const oauthProvisionRoutes = new Hono();

oauthProvisionRoutes.use(
	"*",
	bodyLimit({
		maxSize: 32 * 1024,
		onError: (c) => c.json({ error: "Request is too large", code: "PAYLOAD_TOO_LARGE" }, 413),
	}),
);
oauthProvisionRoutes.use("*", oauthRateLimit("external-write"));
oauthProvisionRoutes.use("*", requireOAuthAuth);
oauthProvisionRoutes.use("*", oauthRateLimit("external-write", { includePrincipal: true }));

oauthProvisionRoutes.post("/device", async (c) => {
	const ctx = await requireExternalOAuthContext(c);
	assertExternalScope(ctx, "device:manage");
	const parsed = legacyDeviceSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const projectId = resolveLegacyProjectId(ctx, parsed.data.projectId);
	const provisionKey = `legacy-device-${parsed.data.label ?? "default"}`;
	const result = await provisionExternalDevice(
		withCompatibilityScope(ctx, "device:provision"),
		provisionKey,
		{
			projectId,
			scope: "project",
			name: parsed.data.name,
		},
	);
	markDeprecated(c);
	logger.warn("Deprecated OAuth device provisioning endpoint used", {
		clientId: ctx.clientId,
		grantId: ctx.grantId,
	});
	return c.json(
		{
			deviceRef: result.device.slug,
			deviceId: result.device.id,
			deviceToken: result.credential?.token ?? null,
			created: result.created,
		},
		result.created ? 201 : 200,
	);
});

oauthProvisionRoutes.post("/narrator", async (c) => {
	const ctx = await requireExternalOAuthContext(c);
	assertExternalScope(ctx, "narrator:use");
	const parsed = legacyNarratorSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const projectId = resolveLegacyProjectId(ctx, parsed.data.projectId);
	const deviceId = await resolveOwnedLegacyDeviceId(ctx, parsed.data.deviceRef);
	const result = await provisionExternalNarrator(
		withCompatibilityScope(ctx, "narrator:provision"),
		"legacy-narrator-default",
		{
			projectId,
			deviceId,
			title: parsed.data.title,
			systemPrompt: parsed.data.systemPrompt,
			permissionMode: parsed.data.permissionMode,
		},
	);
	markDeprecated(c);
	logger.warn("Deprecated OAuth narrator provisioning endpoint used", {
		clientId: ctx.clientId,
		grantId: ctx.grantId,
	});
	return c.json(
		{ narratorId: result.narrator.id, created: result.created },
		result.created ? 201 : 200,
	);
});
