import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import {
	createRemoteDeviceSchema,
	deviceStatQuerySchema,
	deviceTransferSchema,
	updateRemoteDeviceSchema,
} from "../lib/validators";
import { requireAdmin } from "../middleware/auth";
import {
	createDevice,
	getDevice,
	listDevices,
	revokeDevice,
	rotateDeviceToken,
	updateDevice,
} from "../services/device-service";
import {
	downloadDirectory,
	downloadFile,
	statRemote,
	uploadDirectory,
	uploadFile,
} from "../services/device-transfer-service";

export const deviceRoutes = new Hono();

// Remote executor devices grant file/command execution on other machines, and
// the transfer endpoints read/write arbitrary server-local paths. Restrict the
// entire surface to admins (global requireAuth already ran before this router).
deviceRoutes.use("*", requireAdmin);

// List all (non-revoked) devices.
deviceRoutes.get("/", async (c) => {
	const devices = await listDevices();
	return c.json(devices);
});

// Get a single device.
deviceRoutes.get("/:id", async (c) => {
	const device = await getDevice(c.req.param("id"));
	if (!device) throw new ValidationError("Device not found");
	return c.json(device);
});

// Register a new device. Returns the plaintext token exactly once.
deviceRoutes.post("/", async (c) => {
	const userId = c.get("user").sub;
	const parsed = createRemoteDeviceSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const data = parsed.data;
	if (data.connectionMode === "direct" && !data.directUrl) {
		throw new ValidationError("directUrl is required for direct connection mode");
	}
	if (data.scope === "project" && !data.projectId) {
		throw new ValidationError("projectId is required for project scope");
	}

	const result = await createDevice({
		name: data.name,
		slug: data.slug,
		description: data.description,
		connectionMode: data.connectionMode,
		directUrl: data.directUrl,
		scope: data.scope,
		projectId: data.projectId,
		createdBy: userId,
	});
	// `token` is only ever returned here — the client must persist it.
	return c.json(result, 201);
});

// Update a device's metadata.
deviceRoutes.patch("/:id", async (c) => {
	const parsed = updateRemoteDeviceSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const device = await updateDevice(c.req.param("id"), parsed.data);
	if (!device) throw new ValidationError("Device not found");
	return c.json(device);
});

// Rotate the device token. Returns the new plaintext token once.
deviceRoutes.post("/:id/rotate-token", async (c) => {
	const result = await rotateDeviceToken(c.req.param("id"));
	if (!result) throw new ValidationError("Device not found");
	return c.json(result);
});

// Revoke (soft-delete) a device.
deviceRoutes.delete("/:id", async (c) => {
	const ok = await revokeDevice(c.req.param("id"));
	if (!ok) throw new ValidationError("Device not found");
	return c.json({ success: true });
});

// Browse a remote path (file/dir metadata; recursive lists a directory tree).
deviceRoutes.get("/:id/fs", async (c) => {
	const device = await getDevice(c.req.param("id"));
	if (!device) throw new ValidationError("Device not found");
	const parsed = deviceStatQuerySchema.safeParse({
		path: c.req.query("path"),
		recursive: c.req.query("recursive") === "true",
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const result = await statRemote(device.id, parsed.data.path, {
		recursive: parsed.data.recursive,
		maxEntries: 10_000,
	});
	return c.json(result);
});

// Start a file/directory transfer. Progress is broadcast via transfer:* events;
// the response resolves when the transfer completes.
deviceRoutes.post("/:id/transfers", async (c) => {
	const device = await getDevice(c.req.param("id"));
	if (!device) throw new ValidationError("Device not found");
	const parsed = deviceTransferSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { direction, remotePath, localPath, recursive } = parsed.data;

	if (recursive) {
		const result =
			direction === "download"
				? await downloadDirectory({
						deviceId: device.id,
						remoteDir: remotePath,
						localDir: localPath,
					})
				: await uploadDirectory({
						deviceId: device.id,
						localDir: localPath,
						remoteDir: remotePath,
					});
		return c.json({ ok: true, ...result });
	}

	if (direction === "download") {
		const stat = await statRemote(device.id, remotePath);
		if (!stat.exists) throw new ValidationError(`Remote file not found: ${remotePath}`);
		if (stat.isDirectory) {
			throw new ValidationError(`${remotePath} is a directory; use recursive: true`);
		}
		const result = await downloadFile({
			deviceId: device.id,
			remotePath,
			localDest: localPath,
			remoteSize: stat.size,
			remoteMtimeMs: stat.mtimeMs,
		});
		return c.json({ ok: true, filesTransferred: 1, bytesTransferred: result.bytes });
	}

	const result = await uploadFile({
		deviceId: device.id,
		localPath,
		remoteDest: remotePath,
	});
	return c.json({ ok: true, filesTransferred: 1, bytesTransferred: result.bytes });
});
