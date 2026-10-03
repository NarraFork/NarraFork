import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { updateNarratorCwdSchema } from "../lib/validators";
import { switchWorkingDirectorySchema } from "../lib/validators/workspace-context";
import { workspaceContextService } from "../services/workspace-context-service";

/** Mounted only after narratorRoutes' read/write ACL and history admission middleware. */
export const narratorWorkspaceContextRoutes = new Hono();
narratorWorkspaceContextRoutes.use("/:id/workspace-context/*", bodyLimit({ maxSize: 16 * 1024 }));
narratorWorkspaceContextRoutes.get("/:id/workspace-context", async (c) => {
	return c.json(await workspaceContextService.get(c.req.param("id")));
});
narratorWorkspaceContextRoutes.post("/:id/workspace-context/switch", async (c) => {
	const request = switchWorkingDirectorySchema.parse(await c.req.json());
	return c.json(
		await workspaceContextService.switch(c.req.param("id"), request, {
			origin: "http",
			userId: c.get("user").sub,
		}),
	);
});

// Legacy callers share exactly the same admission/CAS/install path.
narratorWorkspaceContextRoutes.patch("/:id/cwd", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorCwdSchema.parse(await c.req.json());
	const previous = await workspaceContextService.get(id);
	const result = await workspaceContextService.switch(
		id,
		{
			expectedRevision: previous.revision,
			requestId: randomUUID(),
			target: { deviceId: previous.deviceId, cwd: parsed.cwd },
		},
		{ origin: "http", userId: c.get("user").sub },
	);
	return c.json({ ok: true, cwd: result.current.cwd, ...result });
});
