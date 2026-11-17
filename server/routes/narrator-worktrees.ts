import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { NarratorWorktreeService } from "../services/narrator-worktree-service";

/** Mount under /api/narrators. Authentication and principal extraction stay with the caller. */
export function createNarratorWorktreeRoutes<Principal>(
	service: NarratorWorktreeService<Principal>,
	principalOf: (context: Context) => Principal,
) {
	const routes = new Hono();
	const path = "/:id/git/worktrees";
	routes.use(path, bodyLimit({ maxSize: 16 * 1024 }));
	routes.use(`${path}/*`, bodyLimit({ maxSize: 16 * 1024 }));
	routes.post(`${path}/prepare`, async (c) =>
		c.json(
			await service.prepare(
				principalOf(c),
				c.req.param("id"),
				await c.req.json(),
				c.req.raw.signal,
			),
		),
	);
	// Read-only recovery takes the original proposal; stale revisions never cause an add retry.
	routes.post(`${path}/reconcile`, async (c) =>
		c.json(
			await service.reconcileRequest(
				principalOf(c),
				c.req.param("id"),
				await c.req.json(),
				c.req.raw.signal,
			),
		),
	);
	routes.get(path, async (c) =>
		c.json(await service.list(principalOf(c), c.req.param("id"), c.req.query(), c.req.raw.signal)),
	);
	// Read-only removal preflight: blockers, dependents and what would be closed.
	routes.post(`${path}/removal/plan`, async (c) =>
		c.json(
			await service.planRemoval(
				principalOf(c),
				c.req.param("id"),
				await c.req.json(),
				c.req.raw.signal,
			),
		),
	);
	// Explicit destructive command. POST keeps the structured request body (revision, force,
	// acknowledgement) in one place; a retry is idempotent, never a second deletion.
	routes.post(`${path}/removal`, async (c) =>
		c.json(
			await service.remove(principalOf(c), c.req.param("id"), await c.req.json(), c.req.raw.signal),
		),
	);
	routes.post(path, async (c) => {
		const result = await service.create(
			principalOf(c),
			c.req.param("id"),
			await c.req.json(),
			c.req.raw.signal,
		);
		// Unknown is an outcome, not a retryable transport error.
		return c.json(result);
	});
	return routes;
}
