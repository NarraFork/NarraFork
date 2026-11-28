import { OverrideValidationError } from "@shared/model-catalog/override";
import type { ModelOverrideRequest } from "@shared/model-catalog/schema/api";
import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
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
import { modelOptionsClient } from "../lib/model-options";
import { ModelOptionsError, parseModelOptionsQuery } from "../lib/model-options-contract";
import { buildRuntimeModelSummary } from "../lib/model-runtime";
import { listAutoModels } from "../lib/model-sourcing/auto-models";
import { requireNarratorAccess } from "../lib/narrator-access";
import { FOLLOW_DEFAULT_MODEL } from "../lib/settings";
import { requireAdmin } from "../middleware/auth";
import { getNarratorRuntimeModel } from "../services/narrator-session-state";
import { resolveSubagentModelInheritance } from "../services/subagent-model";

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

// Session authentication is enforced by app.ts before this router. Each request validates
// its own bounds and revision; this path never calls legacy full-list/card builders.
modelCatalogRoutes.get("/options", async (c) => {
	try {
		const query = parseModelOptionsQuery(c.req.query());
		return c.json(await modelOptionsClient.query(query, c.req.raw.signal));
	} catch (error) {
		if (error instanceof ModelOptionsError)
			return c.json(
				{ error: error.message, code: error.code, retryable: error.status !== 400 },
				error.status,
			);
		if (c.req.raw.signal.aborted) throw error;
		return c.json(
			{
				error: "Model options worker is unavailable",
				code: "MODEL_OPTIONS_UNAVAILABLE",
				retryable: true,
			},
			503,
		);
	}
});

modelCatalogRoutes.get("/runtime", async (c) => {
	const narratorId = c.req.query("narratorId");
	const requested = c.req.query("model")?.trim();
	if (requested && requested.length > 1024) return c.json({ error: "Model is too long" }, 400);
	if (narratorId && narratorId.length > 128) return c.json({ error: "Invalid narrator id" }, 400);
	const narrator = narratorId ? await requireNarratorAccess(c, narratorId, "read") : null;
	const selection = requested || narrator?.model?.trim() || FOLLOW_DEFAULT_MODEL;
	const inheritance =
		narrator && selection === FOLLOW_PARENT_MODEL
			? await resolveSubagentModelInheritance(narrator, c.get("user").sub, 0, {
					signal: c.req.raw.signal,
					deadlineAt: Date.now() + 2_000,
				}).then((value) => value.inheritance)
			: undefined;
	const summary = buildRuntimeModelSummary({
		selection,
		inheritance,
		observation:
			narratorId && narrator
				? getNarratorRuntimeModel(narratorId, narrator.model?.trim() || FOLLOW_DEFAULT_MODEL)
				: null,
	});
	if (narratorId) await requireNarratorAccess(c, narratorId, "read");
	return c.json(summary);
});

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
