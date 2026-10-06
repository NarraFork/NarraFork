import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { customSubagentService, type ToolAccessMode } from "../services/custom-subagent-service";

export const customSubagentRoutes = new Hono();

customSubagentRoutes.use("/*", requireAuth);

/**
 * GET /api/custom-subagents
 * List all custom subagent definitions.
 */
customSubagentRoutes.get("/", async (c) => {
	const defs = await customSubagentService.loadAll();
	return c.json(
		defs.map((d) => ({
			name: d.name,
			description: d.description,
			toolAccess: d.toolAccess,
			customTools: d.customTools,
			defaultModel: d.defaultModel,
			prompt: d.prompt,
		})),
	);
});

/**
 * GET /api/custom-subagents/:name
 * Get a single custom subagent definition.
 */
customSubagentRoutes.get("/:name", async (c) => {
	const name = c.req.param("name");
	const def = await customSubagentService.loadByName(name);
	if (!def) return c.json({ error: "Not found" }, 404);
	return c.json({
		name: def.name,
		description: def.description,
		toolAccess: def.toolAccess,
		customTools: def.customTools,
		defaultModel: def.defaultModel,
		prompt: def.prompt,
	});
});

/**
 * POST /api/custom-subagents
 * Create a new custom subagent definition.
 */
customSubagentRoutes.post("/", async (c) => {
	const body = await c.req.json<{
		name?: string;
		description?: string;
		toolAccess?: string;
		customTools?: string[];
		defaultModel?: string;
		prompt?: string;
	}>();

	const name = body.name?.trim();
	if (!name) throw new ValidationError("name is required");
	const description = body.description?.trim() ?? "";
	const toolAccess = validateToolAccess(body.toolAccess);
	const customTools = Array.isArray(body.customTools) ? body.customTools : [];
	const defaultModel = body.defaultModel?.trim() ?? "";
	const prompt = body.prompt?.trim() ?? "";

	const def = await customSubagentService.create({
		name,
		description,
		toolAccess,
		customTools,
		defaultModel,
		prompt,
	});
	return c.json(
		{
			name: def.name,
			description: def.description,
			toolAccess: def.toolAccess,
			customTools: def.customTools,
			defaultModel: def.defaultModel,
			prompt: def.prompt,
		},
		201,
	);
});

/**
 * PUT /api/custom-subagents/:name
 * Update an existing custom subagent definition.
 */
customSubagentRoutes.put("/:name", async (c) => {
	const currentName = c.req.param("name");
	const body = await c.req.json<{
		name?: string;
		description?: string;
		toolAccess?: string;
		customTools?: string[];
		defaultModel?: string;
		prompt?: string;
	}>();

	const name = body.name?.trim() || currentName;
	const description = body.description?.trim() ?? "";
	const toolAccess = validateToolAccess(body.toolAccess);
	const customTools = Array.isArray(body.customTools) ? body.customTools : [];
	const defaultModel = body.defaultModel?.trim() ?? "";
	const prompt = body.prompt?.trim() ?? "";

	const def = await customSubagentService.update(currentName, {
		name,
		description,
		toolAccess,
		customTools,
		defaultModel,
		prompt,
	});
	return c.json({
		name: def.name,
		description: def.description,
		toolAccess: def.toolAccess,
		customTools: def.customTools,
		defaultModel: def.defaultModel,
		prompt: def.prompt,
	});
});

/**
 * DELETE /api/custom-subagents/:name
 * Delete a custom subagent definition.
 */
customSubagentRoutes.delete("/:name", async (c) => {
	const name = c.req.param("name");
	await customSubagentService.remove(name);
	return c.json({ ok: true });
});

function validateToolAccess(value: string | undefined): ToolAccessMode {
	if (value === "general" || value === "custom") return value;
	return "readOnly";
}
