import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { ValidationError } from "../lib/errors";
import { oauthRateLimit } from "../lib/oauth-rate-limit";
import {
	externalDeviceProvisionBodySchema,
	externalListQuerySchema,
	externalMessageListQuerySchema,
	externalNarratorProvisionBodySchema,
	externalProvisionKeySchema,
	externalSendMessageBodySchema,
} from "../lib/validators/external";
import { requireOAuthAuth } from "../middleware/auth";
import {
	getExternalDevice,
	getExternalNarrator,
	interruptExternalNarrator,
	listExternalDevices,
	listExternalNarratorMessages,
	listExternalProjects,
	provisionExternalDevice,
	provisionExternalNarrator,
	rotateExternalDeviceCredential,
	sendExternalNarratorMessage,
} from "../services/external-resource-service";
import {
	assertExternalScope,
	requireExternalOAuthContext,
} from "../services/oauth-resource-access";
import { issueOAuthWsTicket } from "../services/oauth-ws-ticket-service";

function parseOrThrow<T>(result: z.ZodSafeParseResult<T>): T {
	if (!result.success) throw new ValidationError(result.error.message);
	return result.data;
}

async function readJson(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new ValidationError("Invalid JSON body");
	}
}

function parseListQuery(c: Context) {
	return parseOrThrow(externalListQuerySchema.safeParse(c.req.query()));
}

function parseMessageListQuery(c: Context) {
	return parseOrThrow(externalMessageListQuerySchema.safeParse(c.req.query()));
}

function parseProvisionKey(c: Context): string {
	return parseOrThrow(externalProvisionKeySchema.safeParse(c.req.param("provisionKey")));
}

/** Versioned OAuth-only facade mounted by the application at /api/external/v1. */
export const externalV1Routes = new Hono();

externalV1Routes.use(
	"*",
	bodyLimit({
		maxSize: 160 * 1024,
		onError: (c) =>
			c.json({ error: "External API request is too large", code: "PAYLOAD_TOO_LARGE" }, 413),
	}),
);
externalV1Routes.use("*", oauthRateLimit("external-read"));

// Keep this boundary local to the facade: it must remain OAuth-only even if the
// parent application changes or mounts the router beneath a broader auth chain.
externalV1Routes.use("*", requireOAuthAuth);
externalV1Routes.use("*", async (c, next) => {
	const namespace = c.req.method === "GET" ? "external-read" : "external-write";
	return oauthRateLimit(namespace, { includePrincipal: true })(c, next);
});

externalV1Routes.post("/ws-tickets", async (c) => {
	const ctx = await requireExternalOAuthContext(c);
	assertExternalScope(ctx, "narrator.read");
	assertExternalScope(ctx, "event.subscribe");
	c.header("Cache-Control", "no-store");
	return c.json(issueOAuthWsTicket(ctx.principal));
});

externalV1Routes.get("/projects", async (c) => {
	const ctx = await requireExternalOAuthContext(c);
	return c.json(await listExternalProjects(ctx, parseListQuery(c)));
});

externalV1Routes.get("/devices", async (c) => {
	const ctx = await requireExternalOAuthContext(c);
	return c.json(await listExternalDevices(ctx, parseListQuery(c)));
});

externalV1Routes.put("/devices/provisions/:provisionKey", async (c) => {
	const ctx = await requireExternalOAuthContext(c);
	const provisionKey = parseProvisionKey(c);
	const input = parseOrThrow(externalDeviceProvisionBodySchema.safeParse(await readJson(c)));
	const result = await provisionExternalDevice(ctx, provisionKey, input);
	return c.json(result, result.created ? 201 : 200);
});

externalV1Routes.get("/devices/:id", async (c) => {
	const ctx = await requireExternalOAuthContext(c);
	return c.json(await getExternalDevice(ctx, c.req.param("id")));
});

externalV1Routes.post("/devices/:id/credentials/rotate", async (c) => {
	const ctx = await requireExternalOAuthContext(c);
	return c.json(await rotateExternalDeviceCredential(ctx, c.req.param("id")));
});

externalV1Routes.put("/narrators/provisions/:provisionKey", async (c) => {
	const ctx = await requireExternalOAuthContext(c);
	const provisionKey = parseProvisionKey(c);
	const input = parseOrThrow(externalNarratorProvisionBodySchema.safeParse(await readJson(c)));
	const result = await provisionExternalNarrator(ctx, provisionKey, input);
	return c.json(result, result.created ? 201 : 200);
});

externalV1Routes.get("/narrators/:id", async (c) => {
	const ctx = await requireExternalOAuthContext(c);
	return c.json(await getExternalNarrator(ctx, c.req.param("id")));
});

externalV1Routes.post("/narrators/:id/messages", async (c) => {
	const ctx = await requireExternalOAuthContext(c);
	const input = parseOrThrow(externalSendMessageBodySchema.safeParse(await readJson(c)));
	const result = await sendExternalNarratorMessage(
		ctx,
		c.req.param("id"),
		input,
		c.req.header("Accept-Language") ?? null,
	);
	return c.json(result, 202);
});

externalV1Routes.get("/narrators/:id/messages", async (c) => {
	const ctx = await requireExternalOAuthContext(c);
	return c.json(
		await listExternalNarratorMessages(ctx, c.req.param("id"), parseMessageListQuery(c)),
	);
});

externalV1Routes.post("/narrators/:id/interrupt", async (c) => {
	const ctx = await requireExternalOAuthContext(c);
	return c.json(await interruptExternalNarrator(ctx, c.req.param("id")));
});
