import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { requireAdmin, requireSessionAuth } from "../middleware/auth";
import { dependencyService } from "../services/dependency-service";

const dependencyRoutes = new Hono();

/** GET / — check all dependency statuses */
dependencyRoutes.get("/", (c) => {
	return c.json(dependencyService.checkAll());
});

/** POST /:name/install — install a specific dependency (admin only). */
dependencyRoutes.post("/:name/install", requireSessionAuth, requireAdmin, async (c) => {
	const name = c.req.param("name");
	if (!name || !["git", "rg", "dtach"].includes(name)) {
		throw new ValidationError(`Invalid dependency name: ${name}`);
	}
	const result = await dependencyService.install(name);
	if (!result.ok) {
		// A missing sudo password is not a server fault and retrying this endpoint
		// cannot fix it — the user has to run the command somewhere a password can
		// be typed. 422 says "your request cannot be fulfilled as asked", which is
		// what lets the client offer the interactive terminal instead of showing
		// this as an internal error.
		const status = result.code === "SUDO_PASSWORD_REQUIRED" ? 422 : 500;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic status code
		return c.json(result, status as any);
	}
	return c.json(result);
});

export { dependencyRoutes };
