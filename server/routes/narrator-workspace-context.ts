import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireNarratorAccess } from "../lib/narrator-access";
import { updateNarratorCwdSchema } from "../lib/validators";
import {
	listNarratorDeviceWorkspacesSchema,
	selectNarratorDeviceWorkspaceSchema,
	setNarratorDeviceWorkspaceSchema,
	switchWorkingDirectorySchema,
} from "../lib/validators/workspace-context";
import { narratorDeviceWorkspaceService } from "../services/narrator-device-workspace-service";
import { workspaceContextService } from "../services/workspace-context-service";

/** Mounted only after narratorRoutes' read/write ACL and history admission middleware. */
export const narratorWorkspaceContextRoutes = new Hono();
const boundedWorkspaceRequest = bodyLimit({
	maxSize: 16 * 1024,
	onError: (c) =>
		c.json(
			{ error: "Workspace request exceeds the byte limit", code: "WORKSPACE_REQUEST_TOO_LARGE" },
			413,
		),
});
narratorWorkspaceContextRoutes.use("/:id/workspace-context/*", boundedWorkspaceRequest);
narratorWorkspaceContextRoutes.use("/:id/device-workspaces", boundedWorkspaceRequest);
narratorWorkspaceContextRoutes.use("/:id/device-workspaces/*", boundedWorkspaceRequest);
narratorWorkspaceContextRoutes.get("/:id/device-workspaces", async (c) => {
	return c.json(
		await narratorDeviceWorkspaceService.list(
			c.req.param("id"),
			listNarratorDeviceWorkspacesSchema.parse(c.req.query()),
			{ userId: c.get("user").sub },
		),
	);
});
narratorWorkspaceContextRoutes.get("/:id/device-workspaces/selection-status", async (c) => {
	await requireNarratorAccess(c, c.req.param("id"), "read");
	return c.json(
		await narratorDeviceWorkspaceService.getSelectionInstallationStatus(c.req.param("id"), {
			userId: c.get("user").sub,
		}),
	);
});
narratorWorkspaceContextRoutes.post("/:id/device-workspaces/select", async (c) => {
	return c.json(
		await narratorDeviceWorkspaceService.select(
			c.req.param("id"),
			selectNarratorDeviceWorkspaceSchema.parse(await c.req.json()),
			{ origin: "http", userId: c.get("user").sub },
		),
	);
});
narratorWorkspaceContextRoutes.get("/:id/device-workspaces/requests/:requestId", async (c) => {
	const receipt = await narratorDeviceWorkspaceService.getRequest(
		c.req.param("id"),
		c.req.param("requestId"),
		{ userId: c.get("user").sub },
	);
	if (!receipt)
		return c.json(
			{ error: "Workspace request not found", code: "WORKSPACE_REQUEST_NOT_FOUND" },
			404,
		);
	return c.json({
		requestId: receipt.requestId,
		kind: receipt.kind,
		result: receipt.result,
		installState: receipt.installState,
	});
});
narratorWorkspaceContextRoutes.post(
	"/:id/device-workspaces/requests/:requestId/recover",
	async (c) => {
		return c.json(
			await narratorDeviceWorkspaceService.recoverRequest(
				c.req.param("id"),
				c.req.param("requestId"),
				{ origin: "http", userId: c.get("user").sub },
			),
		);
	},
);
narratorWorkspaceContextRoutes.get("/:id/device-workspaces/:deviceId", async (c) => {
	const binding = await narratorDeviceWorkspaceService.get(
		c.req.param("id"),
		c.req.param("deviceId"),
		{ userId: c.get("user").sub },
	);
	if (!binding)
		return c.json(
			{
				error: "Device workspace needs initialization",
				code: "WORKSPACE_DIRECTORY_NOT_CONFIGURED",
			},
			404,
		);
	return c.json(binding);
});
narratorWorkspaceContextRoutes.put("/:id/device-workspaces/:deviceId", async (c) => {
	// Path owns the target. A duplicate body deviceId is rejected rather than trusted.
	const request = {
		...setNarratorDeviceWorkspaceSchema.omit({ deviceId: true }).parse(await c.req.json()),
		deviceId: c.req.param("deviceId"),
	};
	return c.json(
		await narratorDeviceWorkspaceService.set(c.req.param("id"), request, {
			origin: "http",
			userId: c.get("user").sub,
		}),
	);
});
narratorWorkspaceContextRoutes.get("/:id/workspace-context", async (c) => {
	return c.json(
		await workspaceContextService.get(c.req.param("id"), { userId: c.get("user").sub }),
	);
});
narratorWorkspaceContextRoutes.get("/:id/workspace-context/requests/:requestId", async (c) => {
	const receipt = await workspaceContextService.getRequest(
		c.req.param("id"),
		c.req.param("requestId"),
	);
	if (!receipt) return c.json({ error: "Workspace request not found" }, 404);
	return c.json({
		requestId: receipt.requestId,
		result: receipt.result,
		installState: receipt.installState,
	});
});
narratorWorkspaceContextRoutes.post(
	"/:id/workspace-context/requests/:requestId/recover",
	async (c) => {
		return c.json(
			await workspaceContextService.recoverRequest(c.req.param("id"), c.req.param("requestId"), {
				origin: "http",
				userId: c.get("user").sub,
			}),
		);
	},
);
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
	const previous = await workspaceContextService.get(id, { userId: c.get("user").sub });
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
