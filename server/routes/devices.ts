import { listExecutorPlatformInfo } from "@shared/remote-executor";
import { Hono } from "hono";
import { DEVICE_PROTOCOL_VERSION } from "../lib/agent/execution/rpc-types";
import { ValidationError } from "../lib/errors";
import { getExecutorManifest } from "../lib/executor-binaries";
import { issueExecutorTicket } from "../lib/executor-bootstrap-ticket";
import { buildExecutorInstallScript } from "../lib/executor-install-script";
import {
	createRemoteDeviceSchema,
	deviceBrowseQuerySchema,
	deviceInstallScriptSchema,
	deviceStatQuerySchema,
	deviceTransferSchema,
	updateRemoteDeviceSchema,
} from "../lib/validators";
import { requireAdmin } from "../middleware/auth";
import {
	getDeviceConnectionDiagnostics,
	testDeviceConnection,
} from "../services/device-connection-service";
import {
	createDevice,
	getDevice,
	listDevices,
	revokeDevice,
	rotateDeviceToken,
	updateDevice,
} from "../services/device-service";
import {
	browseRemoteDirectory,
	cancelDeviceTransferTask,
	downloadDirectory,
	downloadFile,
	getDeviceTransferTask,
	listDeviceTransferTasks,
	pauseDeviceTransferTask,
	resumeDeviceTransferTask,
	startDeviceTransferTask,
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

// Published executor release info, for the install wizard and version badges.
// Registered before /:id so "executor" is not parsed as a device id.
deviceRoutes.get("/executor/manifest", async (c) => {
	const manifest = await getExecutorManifest({
		forceRefresh: c.req.query("refresh") === "1",
	});
	return c.json({
		manifest,
		/** Protocol version this server speaks; a mismatch requires an upgrade. */
		expectedProtocolVersion: DEVICE_PROTOCOL_VERSION,
		platforms: listExecutorPlatformInfo(),
	});
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
		ownerScope: data.ownerScope,
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

// Inspect the current connection state without starting or restarting a dial.
deviceRoutes.get("/:id/diagnostics", async (c) => {
	const diagnostics = await getDeviceConnectionDiagnostics(c.req.param("id"));
	if (!diagnostics) throw new ValidationError("Device not found");
	return c.json(diagnostics);
});

// Test connectivity/authentication and one bounded RPC round trip.
deviceRoutes.post("/:id/test", async (c) => {
	const result = await testDeviceConnection(c.req.param("id"));
	if (!result) throw new ValidationError("Device not found");
	return c.json(result);
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

// Generate a ready-to-run install script for one device and platform, along with
// the single-use ticket its download step will spend.
deviceRoutes.post("/:id/install-script", async (c) => {
	const device = await getDevice(c.req.param("id"));
	if (!device) throw new ValidationError("Device not found");
	const parsed = deviceInstallScriptSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { platform, mode, allowRoot, disableShell, serverBaseUrl } = parsed.data;

	const manifest = await getExecutorManifest();
	if (!manifest) {
		throw new ValidationError(
			"No published executor release is available. Check the update server URL in settings.",
		);
	}
	const artifact = manifest.platforms[platform];
	if (!artifact) {
		throw new ValidationError(
			`Executor v${manifest.version} does not publish a build for ${platform}`,
		);
	}

	// Prefer an explicit base URL: the target machine may reach this server on a
	// different host than the admin's browser did.
	const baseUrl = (serverBaseUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "");
	const deviceWsUrl =
		device.connectionMode === "direct" && device.directUrl
			? device.directUrl
			: `${baseUrl.replace(/^http/, "ws")}/ws/device`;

	const ticket = issueExecutorTicket(platform, { deviceId: device.id });
	const generated = buildExecutorInstallScript({
		platform,
		mode,
		serverBaseUrl: baseUrl,
		deviceWsUrl,
		deviceSlug: device.slug,
		deviceName: device.name,
		connectionMode: device.connectionMode,
		allowRoot,
		disableShell,
		artifactFilename: artifact.filename,
		expectedSha256: artifact.sha256,
		executorVersion: manifest.version,
		ticket: ticket.ticket,
	});

	return c.json({
		script: generated.script,
		filename: generated.filename,
		shell: generated.shell,
		executorVersion: manifest.version,
		platform,
		expiresAt: new Date(ticket.expiresAt).toISOString(),
	});
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

// List one level of a remote directory, for interactive path pickers. Separate
// from /fs above because that endpoint's recursive mode walks whole subtrees.
deviceRoutes.get("/:id/browse", async (c) => {
	const device = await getDevice(c.req.param("id"));
	if (!device) throw new ValidationError("Device not found");
	const parsed = deviceBrowseQuerySchema.safeParse({
		path: c.req.query("path") || undefined,
		showHidden: c.req.query("showHidden") === "1",
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	try {
		return c.json(
			await browseRemoteDirectory(device.id, parsed.data.path, {
				showHidden: parsed.data.showHidden,
			}),
		);
	} catch (err) {
		// Offline devices, missing directories and permission errors are all
		// user-correctable input problems here, not server faults.
		throw new ValidationError(err instanceof Error ? err.message : String(err));
	}
});

// Background transfer tasks return immediately and can be paused/resumed.
deviceRoutes.post("/:id/transfer-tasks", async (c) => {
	const device = await getDevice(c.req.param("id"));
	if (!device) throw new ValidationError("Device not found");
	const parsed = deviceTransferSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const task = await startDeviceTransferTask({
		deviceId: device.id,
		createdBy: c.get("user").sub,
		...parsed.data,
	});
	return c.json(task, 202);
});

deviceRoutes.get("/:id/transfer-tasks", async (c) => {
	const device = await getDevice(c.req.param("id"));
	if (!device) throw new ValidationError("Device not found");
	return c.json(await listDeviceTransferTasks(device.id));
});

deviceRoutes.get("/:id/transfer-tasks/:taskId", async (c) => {
	const task = await getDeviceTransferTask(c.req.param("id"), c.req.param("taskId"));
	if (!task) throw new ValidationError("Transfer task not found");
	return c.json(task);
});

deviceRoutes.post("/:id/transfer-tasks/:taskId/pause", async (c) => {
	const task = await pauseDeviceTransferTask(c.req.param("id"), c.req.param("taskId"));
	if (!task) throw new ValidationError("Transfer task not found");
	return c.json(task);
});

deviceRoutes.post("/:id/transfer-tasks/:taskId/cancel", async (c) => {
	const task = await cancelDeviceTransferTask(c.req.param("id"), c.req.param("taskId"));
	if (!task) {
		throw new ValidationError("Transfer task cannot be cancelled");
	}
	return c.json(task);
});

deviceRoutes.post("/:id/transfer-tasks/:taskId/resume", async (c) => {
	const task = await resumeDeviceTransferTask(c.req.param("id"), c.req.param("taskId"));
	if (!task) {
		throw new ValidationError("Transfer task is not resumable");
	}
	return c.json(task, 202);
});

// Synchronous compatibility endpoint. Progress is broadcast via transfer:* events.
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
