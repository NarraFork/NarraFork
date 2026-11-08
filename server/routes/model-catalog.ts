import { OverrideValidationError } from "@shared/model-catalog/override";
import type { ModelOverrideRequest } from "@shared/model-catalog/schema/api";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { buildAppErrorResponse } from "../lib/app-error-response";
import { logger } from "../lib/logger";
import {
	applyModelCatalogUpdate,
	catalogModelFamily,
	catalogModelName,
	checkModelCatalogUpdate,
	getEffectiveModelCard,
	getModelCatalogStatus,
	restoreBuiltinModelCatalog,
	setModelCatalogAutoUpdate,
	setModelOverride,
} from "../lib/model-catalog";
import { describeModel, describeModels, MAX_DESCRIBED_MODELS } from "../lib/model-catalog/describe";
import { sanitizeCatalogErrorText } from "../lib/model-catalog/error-text";
import { listAutoModels } from "../lib/model-sourcing/auto-models";
import { requireAdmin } from "../middleware/auth";

const smallBody = bodyLimit({
	maxSize: 256 * 1024,
	onError: (c) => c.json({ error: "Request body is too large" }, 413),
});

export const modelCatalogRoutes = new Hono();
modelCatalogRoutes.onError((error, c) => {
	const appErrorResponse = buildAppErrorResponse(error, c);
	if (appErrorResponse) return appErrorResponse;
	if (error instanceof OverrideValidationError)
		return c.json({ error: error.message, code: "INVALID_OVERRIDE", field: error.field }, 400);
	logger.error("model-catalog request failed", {
		message: error instanceof Error ? error.message : String(error),
	});
	// Unexpected errors may embed host paths; the wire body must not.
	return c.json(
		{
			error: sanitizeCatalogErrorText(error) || "Model catalog request failed",
			code: "CATALOG_ERROR",
		},
		400,
	);
});

modelCatalogRoutes.get("/status", (c) => c.json(getModelCatalogStatus()));

/**
 * Every `auto:<model>` some provider serves, with its sources in routing order: the model
 * picker's first level and its "source" submenu. In-memory reads only; no secrets.
 */
modelCatalogRoutes.get("/auto", (c) =>
	c.json({ models: listAutoModels(catalogModelName, catalogModelFamily) }),
);

/** The resolved card a running narrator uses; read by the model menu and status bar. */
modelCatalogRoutes.get("/card", (c) => {
	const model = c.req.query("model")?.trim();
	if (!model) throw new Error("model is required");
	return c.json(getEffectiveModelCard(model));
});

/** Effective fields, their origins and overrides for provider entries. */
modelCatalogRoutes.post("/models", smallBody, async (c) => {
	const body = await c.req.json<{ models?: unknown }>();
	if (
		!Array.isArray(body.models) ||
		body.models.length > MAX_DESCRIBED_MODELS ||
		body.models.some((model) => typeof model !== "string")
	)
		throw new Error(`models must be an array of at most ${MAX_DESCRIBED_MODELS} model values`);
	return c.json(await describeModels(body.models as string[]));
});

modelCatalogRoutes.put("/overrides", requireAdmin, smallBody, async (c) => {
	const body = await c.req.json<Partial<ModelOverrideRequest> & { model?: string }>();
	if (body.scope !== "model" && body.scope !== "connection")
		throw new OverrideValidationError("scope", "scope must be model or connection");
	if (typeof body.key !== "string") throw new OverrideValidationError("key", "key is required");
	setModelOverride(body.scope, body.key, body.fields ?? null);
	// The entry being edited, re-described with the change applied.
	const model = typeof body.model === "string" && body.model.trim() ? body.model : undefined;
	return c.json(model ? describeModel(model) : { ok: true });
});

modelCatalogRoutes.post("/updates/check", requireAdmin, async (c) =>
	c.json(await checkModelCatalogUpdate()),
);
modelCatalogRoutes.post("/updates/apply", requireAdmin, (c) => c.json(applyModelCatalogUpdate()));
modelCatalogRoutes.post("/updates/restore-builtin", requireAdmin, (c) =>
	c.json(restoreBuiltinModelCatalog()),
);
modelCatalogRoutes.patch("/updates/settings", requireAdmin, smallBody, async (c) => {
	const body = await c.req.json<{ autoUpdate?: unknown }>();
	if (typeof body.autoUpdate !== "boolean") throw new Error("autoUpdate must be true or false");
	return c.json(setModelCatalogAutoUpdate(body.autoUpdate));
});
