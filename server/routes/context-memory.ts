import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { activeDatabaseBackend } from "../db";
import { AppError, ForbiddenError, ValidationError } from "../lib/errors";
import { forgetContextMemorySchema } from "../lib/validators/context-memory";
import { getAuthPrincipal } from "../middleware/auth";
import type { ContextMemoryActor } from "../services/context-memory-access";
import { contextMemoryService } from "../services/context-memory-service";

export const contextMemoryRoutes = new Hono();

// Mounted behind requireSessionAuth; keep the human-only boundary explicit here too.
function actorOf(c: Context): ContextMemoryActor {
	const principal = getAuthPrincipal(c);
	if (principal?.type !== "session" || c.get("oauth")) {
		throw new ForbiddenError("Memory management requires a first-party user session");
	}
	return { userId: principal.user.sub, isAdmin: principal.user.role === "admin", kind: "user" };
}
async function jsonOf(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch (error) {
		if (error instanceof SyntaxError) throw new ValidationError("Request body must be valid JSON");
		throw error;
	}
}

contextMemoryRoutes.use("*", async (c, next) => {
	actorOf(c);
	if (activeDatabaseBackend !== "sqlite") {
		throw new AppError(
			"Memory management is not yet supported on this backend",
			503,
			"POSTGRES_UNSUPPORTED",
		);
	}
	await next();
});
contextMemoryRoutes.use(
	"*",
	bodyLimit({
		maxSize: 32 * 1024,
		onError: (c) =>
			c.json({ error: "Memory request is too large", code: "PAYLOAD_TOO_LARGE" }, 413),
	}),
);

contextMemoryRoutes.get("/", async (c) => {
	const kind = c.req.query("scope") ?? "user";
	const scope = kind === "user" ? { kind } : { kind, id: c.req.query("scopeId") };
	return c.json(
		await contextMemoryService.list(
			{ scope, cursor: c.req.query("cursor"), limit: Number(c.req.query("limit") ?? 20) },
			actorOf(c),
		),
	);
});
contextMemoryRoutes.post("/", async (c) => {
	return c.json(await contextMemoryService.propose(await jsonOf(c), actorOf(c)), 201);
});
contextMemoryRoutes.get("/:id", async (c) => {
	return c.json(await contextMemoryService.get(c.req.param("id"), actorOf(c)));
});
contextMemoryRoutes.get("/:id/events", async (c) => {
	return c.json(await contextMemoryService.events(c.req.param("id"), actorOf(c)));
});
contextMemoryRoutes.patch("/:id", async (c) => {
	return c.json(await contextMemoryService.revise(c.req.param("id"), await jsonOf(c), actorOf(c)));
});
contextMemoryRoutes.post("/:id/decision", async (c) => {
	return c.json(await contextMemoryService.decide(c.req.param("id"), await jsonOf(c), actorOf(c)));
});
contextMemoryRoutes.delete("/:id", async (c) => {
	const parsed = forgetContextMemorySchema.safeParse(await jsonOf(c));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await contextMemoryService.forget(c.req.param("id"), parsed.data.expectedVersion, actorOf(c)),
	);
});
