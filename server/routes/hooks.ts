import { Hono } from "hono";
import { NotFoundError, ValidationError } from "../lib/errors";
import { createHookSchema, updateHookSchema } from "../lib/validators";
import { requireAdmin } from "../middleware/auth";
import { hookService } from "../services/hook-service";

export const hookRoutes = new Hono();

// Hooks can execute arbitrary shell commands — restrict to admin users
hookRoutes.use("/*", requireAdmin);

// List hooks (global or by project)
hookRoutes.get("/", async (c) => {
	const projectId = c.req.query("projectId");
	const hooks = projectId ? await hookService.list(projectId) : await hookService.list(null);
	return c.json(hooks);
});

// List all hooks (global + all projects)
hookRoutes.get("/all", async (c) => {
	const hooks = await hookService.listAll();
	return c.json(hooks);
});

// Get single hook
hookRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	const hook = await hookService.get(id);
	if (!hook) throw new NotFoundError("Hook", id);
	return c.json(hook);
});

// Create hook
hookRoutes.post("/", async (c) => {
	const body = await c.req.json();
	const data = createHookSchema.parse(body);
	// biome-ignore lint/suspicious/noExplicitAny: Zod output type mismatch with service input
	const hook = await hookService.create(data as any);
	return c.json(hook, 201);
});

// Update hook
hookRoutes.put("/:id", async (c) => {
	const id = c.req.param("id");
	const existing = await hookService.get(id);
	if (!existing) throw new NotFoundError("Hook", id);
	const body = await c.req.json();
	const data = updateHookSchema.parse(body);

	// Context-aware validation: prevent clearing the active payload field
	// without changing the hook type (would leave hook in invalid state).
	const effectiveType = data.type ?? existing.type;
	if (effectiveType === "command" && data.command === null) {
		throw new ValidationError(
			"Cannot clear command without changing hook type — the hook would have no command to execute",
		);
	}
	if (effectiveType === "http" && data.url === null) {
		throw new ValidationError(
			"Cannot clear url without changing hook type — the hook would have no URL to call",
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: Zod output type mismatch with service input
	const hook = await hookService.update(id, data as any);
	return c.json(hook);
});

// Delete hook
hookRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const existing = await hookService.get(id);
	if (!existing) throw new NotFoundError("Hook", id);
	await hookService.delete(id);
	return c.json({ ok: true });
});
