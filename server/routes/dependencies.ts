import { count } from "drizzle-orm";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import { db } from "../db";
import { users } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { dependencyService } from "../services/dependency-service";

const dependencyRoutes = new Hono();

async function requireAdminOrInitialSetup(c: Context, next: Next) {
	const [{ value: userCount }] = await db.select({ value: count() }).from(users);
	if (userCount === 0) {
		await next();
		return;
	}

	await requireAuth(c, async () => {
		await requireAdmin(c, next);
	});
}

/** GET / — check all dependency statuses */
dependencyRoutes.get("/", (c) => {
	return c.json(dependencyService.checkAll());
});

/** POST /:name/install — install a specific dependency (admin, or before first-user setup). */
dependencyRoutes.post("/:name/install", requireAdminOrInitialSetup, async (c) => {
	const name = c.req.param("name");
	if (!name || !["git", "rg", "dtach"].includes(name)) {
		throw new ValidationError(`Invalid dependency name: ${name}`);
	}
	const result = await dependencyService.install(name);
	if (!result.ok) {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic status code
		return c.json(result, 500 as any);
	}
	return c.json(result);
});

export { dependencyRoutes };
