import type { ModelCatalogMutation } from "@shared/model-catalog/schema/api";
import type { ModelQuery } from "@shared/model-catalog/schema/catalog";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../lib/app-error-response";
import {
	applyModelCatalogUpdate,
	CatalogRevisionConflict,
	checkModelCatalogUpdate,
	exportModelCatalogUserLayer,
	getEffectiveModelMetadata,
	getModelCatalogSnapshot,
	mutateModelCatalog,
	previewModelCatalogDowngrade,
	queryForModel,
	resolveEffectiveMetadata,
	rollbackModelCatalog,
	setModelCatalogUpdateSettings,
} from "../lib/model-catalog";
import { requireAdmin } from "../middleware/auth";

export const modelCatalogRoutes = new Hono();
modelCatalogRoutes.onError(
	(error, c) =>
		buildAppErrorResponse(error, c) ??
		c.json(
			{
				error: error.message,
				...(error instanceof CatalogRevisionConflict
					? { snapshot: getModelCatalogSnapshot() }
					: {}),
			},
			error instanceof CatalogRevisionConflict ? 409 : 400,
		),
);
modelCatalogRoutes.get("/", (c) => c.json(getModelCatalogSnapshot()));
modelCatalogRoutes.get("/export", requireAdmin, (c) => c.json(exportModelCatalogUserLayer()));
modelCatalogRoutes.get("/downgrade-preview", requireAdmin, (c) =>
	c.json(previewModelCatalogDowngrade()),
);
modelCatalogRoutes.get("/resolve", (c) => {
	const model = c.req.query("model");
	if (!model) throw new Error("model is required");
	return c.json({ ...getEffectiveModelMetadata(model), resolvedQuery: queryForModel(model).query });
});
modelCatalogRoutes.post("/resolve", async (c) => {
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
modelCatalogRoutes.post("/mutate", requireAdmin, async (c) => {
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
