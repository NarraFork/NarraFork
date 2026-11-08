import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { updateNarratorCwdSchema } from "../lib/validators";
import { switchWorkingDirectorySchema } from "../lib/validators/workspace-context";
import { workspaceContextService } from "../services/workspace-context-service";

/**
 * A directory switch may target any device this narrator can actually execute on.
 *
 * The list is exactly what its tools are authorized against (project axis + OAuth
 * device allowlist), so an unknown, unauthorized or offline device is refused here
 * rather than becoming a session that cannot run — and a device slug resolves to the
 * canonical device id before it is persisted.
 */
async function resolveWorkspaceDevice(narratorId: string, deviceId: string): Promise<string> {
	if (deviceId === "local") return "local";
	const { getNarratorExecutionDeviceState, resolveNarratorDefaultDeviceRequest } = await import(
		"../services/narrator-session"
	);
	const state = await getNarratorExecutionDeviceState(narratorId);
	return (
		resolveNarratorDefaultDeviceRequest(deviceId, state.devices, { allowLocal: true }) ?? "local"
	);
}

/** Mounted only after narratorRoutes' read/write ACL and history admission middleware. */
export const narratorWorkspaceContextRoutes = new Hono();
narratorWorkspaceContextRoutes.use("/:id/workspace-context/*", bodyLimit({ maxSize: 16 * 1024 }));
narratorWorkspaceContextRoutes.get("/:id/workspace-context", async (c) => {
	return c.json(await workspaceContextService.getForDirectorySwitch(c.req.param("id")));
});
narratorWorkspaceContextRoutes.post("/:id/workspace-context/switch", async (c) => {
	const id = c.req.param("id");
	const request = switchWorkingDirectorySchema.parse(await c.req.json());
	const deviceId = await resolveWorkspaceDevice(id, request.target.deviceId);
	return c.json(
		await workspaceContextService.switch(
			id,
			{ ...request, target: { ...request.target, deviceId } },
			{ origin: "http", userId: c.get("user").sub },
		),
	);
});

// Legacy callers share exactly the same admission/CAS/install path.
narratorWorkspaceContextRoutes.patch("/:id/cwd", async (c) => {
	const id = c.req.param("id");
	const parsed = updateNarratorCwdSchema.parse(await c.req.json());
	const previous = await workspaceContextService.getForDirectorySwitch(id);
	const result = await workspaceContextService.switch(
		id,
		{
			expectedRevision: previous.revision,
			requestId: randomUUID(),
			target: {
				deviceId: await resolveWorkspaceDevice(id, previous.deviceId),
				cwd: parsed.cwd,
			},
		},
		{ origin: "http", userId: c.get("user").sub },
	);
	return c.json({ ok: true, cwd: result.current.cwd, ...result });
});
