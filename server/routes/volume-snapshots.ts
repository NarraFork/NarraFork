import { Hono } from "hono";
import {
	applyVolumeSnapshotSchema,
	createVolumeSnapshotSchema,
	updateVolumeSnapshotSchema,
} from "../lib/validators";
import { volumeSnapshotService } from "../services/volume-snapshot-service";

export const volumeSnapshotRoutes = new Hono();

// GET /api/projects/:projectId/volume-snapshots
volumeSnapshotRoutes.get("/:projectId/volume-snapshots", async (c) => {
	const projectId = c.req.param("projectId");
	const serviceName = c.req.query("serviceName");
	const containerPath = c.req.query("containerPath");
	const snapshots = await volumeSnapshotService.listSnapshots(projectId, {
		serviceName: serviceName || undefined,
		containerPath: containerPath || undefined,
	});
	return c.json(snapshots);
});

// POST /api/projects/:projectId/volume-snapshots
volumeSnapshotRoutes.post("/:projectId/volume-snapshots", async (c) => {
	const projectId = c.req.param("projectId");
	const body = createVolumeSnapshotSchema.parse(await c.req.json());
	const userId = c.get("user").sub;
	const snapshot = await volumeSnapshotService.createSnapshot({
		projectId,
		chapterId: body.chapterId,
		serviceName: body.serviceName,
		containerPath: body.containerPath,
		name: body.name,
		description: body.description,
		userId,
	});
	return c.json(snapshot, 201);
});

// GET /api/volume-snapshots/:id
volumeSnapshotRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	const snapshot = await volumeSnapshotService.getSnapshot(id);
	return c.json(snapshot);
});

// PATCH /api/volume-snapshots/:id
volumeSnapshotRoutes.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const body = updateVolumeSnapshotSchema.parse(await c.req.json());
	const snapshot = await volumeSnapshotService.updateSnapshot(id, body);
	return c.json(snapshot);
});

// DELETE /api/volume-snapshots/:id
volumeSnapshotRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await volumeSnapshotService.deleteSnapshot(id);
	return c.json({ success: true });
});

// POST /api/volume-snapshots/:id/apply
volumeSnapshotRoutes.post("/:id/apply", async (c) => {
	const id = c.req.param("id");
	const body = applyVolumeSnapshotSchema.parse(await c.req.json());
	const userId = c.get("user").sub;
	const result = await volumeSnapshotService.applySnapshot({
		snapshotId: id,
		targetChapterId: body.targetChapterId,
		userId,
	});
	return c.json(result);
});

// GET /api/volume-snapshots/:id/applications
volumeSnapshotRoutes.get("/:id/applications", async (c) => {
	const id = c.req.param("id");
	const applications = await volumeSnapshotService.getApplicationHistory({
		snapshotId: id,
	});
	return c.json(applications);
});
