import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { requireAdmin } from "../middleware/auth";
import { dependencyService } from "../services/dependency-service";

const dependencyRoutes = new Hono();

/** GET / — check all dependency statuses */
dependencyRoutes.get("/", (c) => {
	return c.json(dependencyService.checkAll());
});

/** POST /:name/install — install a specific dependency (admin only) */
dependencyRoutes.post("/:name/install", requireAdmin, async (c) => {
	const name = c.req.param("name");
	if (!["git", "rg", "dtach"].includes(name)) {
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
