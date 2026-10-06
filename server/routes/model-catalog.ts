import type { ModelCardMutation } from "@shared/model-catalog/card-local";
import type { ModelCatalogMutation } from "@shared/model-catalog/schema/api";
import type { ModelQuery } from "@shared/model-catalog/schema/catalog";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { buildAppErrorResponse } from "../lib/app-error-response";
import { logger } from "../lib/logger";
import {
	applyModelCatalogUpdate,
	CatalogRevisionConflict,
	checkModelCatalogUpdate,
	exportModelCatalogUserLayer,
	getEffectiveModelCard,
	getEffectiveModelMetadata,
	getModelCardSnapshot,
	getModelCatalogSnapshot,
	mutateModelCard,
	mutateModelCatalog,
	previewModelCatalogDowngrade,
	queryForModel,
	resolveEffectiveMetadata,
	resolveEffectiveModelCard,
	rollbackModelCatalog,
	setModelCatalogUpdateSettings,
} from "../lib/model-catalog";
import {
	CATALOG_IO_ERROR_BODY,
	isHostIoError,
	sanitizeCatalogErrorText,
} from "../lib/model-catalog/error-text";
import { requireAdmin } from "../middleware/auth";

const resolveBodyLimit = bodyLimit({
	maxSize: 1024 * 1024,
	onError: (c) => c.json({ error: "Model card request exceeds 1 MiB" }, 413),
});

export const modelCatalogRoutes = new Hono();
modelCatalogRoutes.onError((error, c) => {
	const appErrorResponse = buildAppErrorResponse(error, c);
	if (appErrorResponse) return appErrorResponse;
	if (error instanceof CatalogRevisionConflict) {
		return c.json(
			{
				error: error.message,
				code: "CATALOG_REVISION_CONFLICT",
				snapshot: c.req.path.includes("/v2/") ? getModelCardSnapshot() : getModelCatalogSnapshot(),
			},
			409,
		);
	}
	// Unexpected errors may embed host absolute paths (`~/.narrafork/...`). Log the
	// original message; the wire body must stay free of OS usernames and host paths.
	logger.error("model-catalog request failed", {
		message: error instanceof Error ? error.message : String(error),
	});
	if (isHostIoError(error)) return c.json(CATALOG_IO_ERROR_BODY, 400);
	return c.json(
		{
			error: sanitizeCatalogErrorText(error) || CATALOG_IO_ERROR_BODY.error,
			code: "CATALOG_ERROR",
		},
		400,
	);
});
modelCatalogRoutes.get("/", (c) => c.json(getModelCatalogSnapshot()));
modelCatalogRoutes.get("/v2", (c) => c.json(getModelCardSnapshot()));
modelCatalogRoutes.get("/v2/resolve", (c) => {
	const model = c.req.query("model");
	if (!model) throw new Error("model is required");
	return c.json(getEffectiveModelCard(model));
});
modelCatalogRoutes.post("/v2/resolve", resolveBodyLimit, async (c) => {
	const body = await c.req.json<{ query?: ModelQuery; model?: string }>();
	if (body.model) return c.json(getEffectiveModelCard(body.model));
	if (!body.query || typeof body.query.upstreamModelId !== "string")
		throw new Error("query.upstreamModelId is required");
	return c.json(resolveEffectiveModelCard(body.query));
});
modelCatalogRoutes.get("/export", requireAdmin, (c) => c.json(exportModelCatalogUserLayer()));
modelCatalogRoutes.get("/downgrade-preview", requireAdmin, (c) =>
	c.json(previewModelCatalogDowngrade()),
);
modelCatalogRoutes.get("/resolve", (c) => {
	const model = c.req.query("model");
	if (!model) throw new Error("model is required");
	return c.json({ ...getEffectiveModelMetadata(model), resolvedQuery: queryForModel(model).query });
});
modelCatalogRoutes.post("/resolve", resolveBodyLimit, async (c) => {
	const body = await c.req.json<{ query?: ModelQuery; model?: string }>();
	if (body.model)
		return c.json({
			...getEffectiveModelMetadata(body.model),
			resolvedQuery: queryForModel(body.model).query,
		});
	if (!body.query || typeof body.query.upstreamModelId !== "string")
		throw new Error("query.upstreamModelId is required");
	return c.json(resolveEffectiveMetadata(body.query));
});
modelCatalogRoutes.post("/v2/mutate", requireAdmin, resolveBodyLimit, async (c) =>
	c.json(mutateModelCard(await c.req.json<ModelCardMutation>())),
);
modelCatalogRoutes.post("/mutate", requireAdmin, resolveBodyLimit, async (c) => {
	const mutation = await c.req.json<ModelCatalogMutation>();
	if (!Number.isInteger(mutation.baseRevision) || mutation.baseRevision < 0)
		throw new Error("baseRevision is required");
	return c.json(mutateModelCatalog(mutation));
});
modelCatalogRoutes.post("/updates/check", requireAdmin, async (c) =>
	c.json(await checkModelCatalogUpdate()),
);
modelCatalogRoutes.post("/updates/apply", requireAdmin, async (c) => {
	const body = await c.req.json<{ version?: string }>();
	return c.json(applyModelCatalogUpdate(body.version));
});
modelCatalogRoutes.post("/updates/rollback", requireAdmin, async (c) => {
	const body = await c.req.json<{ version: string }>();
	if (typeof body.version !== "string") throw new Error("version is required");
	return c.json(rollbackModelCatalog(body.version));
});
modelCatalogRoutes.patch("/updates/settings", requireAdmin, async (c) =>
	c.json(setModelCatalogUpdateSettings(await c.req.json())),
);
