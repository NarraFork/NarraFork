import { listExecutorPlatformInfo } from "@shared/remote-executor";
import { type Context, Hono } from "hono";
import { DEVICE_PROTOCOL_VERSION } from "../lib/agent/execution/rpc-types";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors";
import { getExecutorManifest } from "../lib/executor-binaries";
import { attachExecutorTicketScript, issueExecutorTicket } from "../lib/executor-bootstrap-ticket";
import {
	enrollmentRefusalMessage,
	evaluateEnrollmentTransport,
} from "../lib/executor-enrollment-policy";
import { resolveExecutorInstallCa } from "../lib/executor-install-ca";
import {
	buildExecutorInstallOneLiner,
	buildExecutorInstallScript,
} from "../lib/executor-install-script";
import { resolvePublicOrigin } from "../lib/public-origin";
import { settings } from "../lib/settings";
import { getTlsPaths } from "../lib/tls";
import {
	buildPathRulesConfigSnippet,
	createRemoteDeviceSchema,
	deviceBrowseQuerySchema,
	deviceInstallScriptSchema,
	deviceStatQuerySchema,
	deviceTransferSchema,
	updateDevicePathRulesSchema,
	updateRemoteDeviceSchema,
} from "../lib/validators";
import { assertAdmin } from "../middleware/auth";
import {
	getDeviceConnectionDiagnostics,
	testDeviceConnection,
} from "../services/device-connection-service";
import {
	canManageDevice,
	createDevice,
	getDevice,
	listDevices,
	revokeDevice,
	rotateDeviceToken,
	updateDevice,
	updateDevicePathRules,
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

/**
 * Authorization on this router is per-endpoint, not blanket-admin.
 *
 * Three tiers, because the endpoints differ by orders of magnitude in blast radius:
 *
 * 1. **Any authenticated user** — register a device, read the executor manifest.
 *    Registering only creates a record plus a key; nothing can execute until the
 *    operator installs the executor on a machine they already control.
 * 2. **Device manager** (registrar or admin, see `canManageDevice`) — inspect,
 *    edit, set path rules, rotate the key, revoke, generate an install script.
 *    Usage and management are separate powers: a shared device is usable by
 *    everyone the project axis allows, but only its registrar or an admin may
 *    reconfigure the machine the team depends on.
 * 3. **Admin only** — `scope: "global"`, and every filesystem/transfer endpoint.
 *    The transfer endpoints take an unbounded server-local `localPath`
 *    (`validateLocalAbsolutePath` checks only that it is absolute), so they are
 *    effectively arbitrary read/write on the NarraFork server itself. Opening them
 *    to non-admins would be a privilege escalation regardless of device ownership.
 */

/** Load a device and assert the caller may manage it. */
async function requireManagedDevice(c: Context) {
	const id = c.req.param("id") ?? "";
	const device = await getDevice(id);
	// Same not-found result either way: distinguishing "exists but not yours" from
	// "does not exist" would let any user enumerate device ids.
	if (!device) throw new NotFoundError("Device", id);
	const user = c.get("user");
	if (!canManageDevice(device, { userId: user.sub, isAdmin: user.role === "admin" })) {
		throw new NotFoundError("Device", id);
	}
	return device;
}

function isAdminPrincipal(c: Context): boolean {
	return c.get("user").role === "admin";
}

// List devices. Admins see every device; everyone else sees the ones they
// registered, which is what a management page can act on. Devices merely usable by
// this user are surfaced through the narrator device list, not here, so another
// user's directUrl and key prefix are not handed out.
deviceRoutes.get("/", async (c) => {
	const devices = await listDevices();
	if (isAdminPrincipal(c)) return c.json(devices);
	const userId = c.get("user").sub;
	return c.json(devices.filter((device) => device.createdBy === userId));
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
	return c.json(await requireManagedDevice(c));
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
	// A global device is reachable from every project, so making one is an
	// admin-level act. It is also the marker that makes a device inject by default,
	// which is precisely the power a non-admin must not be able to grant itself.
	if (data.scope === "global" && !isAdminPrincipal(c)) {
		throw new ForbiddenError("Only an administrator may register a global device");
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
	await requireManagedDevice(c);
	const parsed = updateRemoteDeviceSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	// Same gate as creation: promoting an existing device to global would otherwise
	// be an unguarded back door to the admin-only scope.
	if (parsed.data.scope === "global" && !isAdminPrincipal(c)) {
		throw new ForbiddenError("Only an administrator may make a device global");
	}

	const device = await updateDevice(c.req.param("id"), parsed.data);
	if (!device) throw new NotFoundError("Device", c.req.param("id"));
	return c.json(device);
});

/**
 * Read the device's path guard rules.
 *
 * `rules` is the desired state recorded here; `reportedRules` is what the device
 * said it was enforcing at its last handshake. They can differ whenever a saved
 * change has not been applied on the target machine yet, and the UI is expected to
 * surface that rather than implying the save took effect.
 */
deviceRoutes.get("/:id/path-rules", async (c) => {
	const device = await requireManagedDevice(c);
	return c.json({
		rules: device.pathRules ?? [],
		reportedRules: device.reportedPathRules,
		configSnippet: buildPathRulesConfigSnippet(device.pathRules ?? []),
	});
});

/**
 * Record desired path guard rules.
 *
 * Saving does not change what the device enforces: the executor reads its rules
 * from its own config file, so the operator still has to apply the snippet and
 * restart the service. That is a deliberate trust boundary, not an oversight —
 * see `updateDevicePathRules`.
 */
deviceRoutes.put("/:id/path-rules", async (c) => {
	await requireManagedDevice(c);
	const parsed = updateDevicePathRulesSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const device = await updateDevicePathRules(c.req.param("id"), parsed.data.rules);
	if (!device) throw new NotFoundError("Device", c.req.param("id"));
	return c.json({
		rules: device.pathRules ?? [],
		reportedRules: device.reportedPathRules,
		configSnippet: buildPathRulesConfigSnippet(device.pathRules ?? []),
	});
});

// Inspect the current connection state without starting or restarting a dial.
deviceRoutes.get("/:id/diagnostics", async (c) => {
	await requireManagedDevice(c);
	const diagnostics = await getDeviceConnectionDiagnostics(c.req.param("id"));
	if (!diagnostics) throw new NotFoundError("Device", c.req.param("id"));
	return c.json(diagnostics);
});

// Test connectivity/authentication and one bounded RPC round trip.
deviceRoutes.post("/:id/test", async (c) => {
	await requireManagedDevice(c);
	const result = await testDeviceConnection(c.req.param("id"));
	if (!result) throw new NotFoundError("Device", c.req.param("id"));
	return c.json(result);
});

// Rotate the device token. Returns the new plaintext token once.
deviceRoutes.post("/:id/rotate-token", async (c) => {
	await requireManagedDevice(c);
	const result = await rotateDeviceToken(c.req.param("id"));
	if (!result) throw new NotFoundError("Device", c.req.param("id"));
	return c.json(result);
});

// Revoke (soft-delete) a device.
deviceRoutes.delete("/:id", async (c) => {
	await requireManagedDevice(c);
	const ok = await revokeDevice(c.req.param("id"));
	if (!ok) throw new NotFoundError("Device", c.req.param("id"));
	return c.json({ success: true });
});

// Generate a ready-to-run install command for one device and platform, along with
// the enrollment ticket its steps will spend.
deviceRoutes.post("/:id/install-script", async (c) => {
	// Available to the registrar: without it, registering a device is useless, and
	// the script grants nothing beyond enrolling a machine the operator already
	// controls. The ticket it mints is scoped to this device.
	const device = await requireManagedDevice(c);
	const parsed = deviceInstallScriptSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { platform, mode, disableShell, serverBaseUrl, tokenDelivery } = parsed.data;

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

	/*
	 * Which URL the target machine should use, in order of trustworthiness:
	 *
	 * 1. An explicit `serverBaseUrl` — the operator knows their topology, and the
	 *    target machine may well reach this server on a different host than the
	 *    browser did (split-horizon DNS, a VPN-only name).
	 * 2. The forwarded public origin, for the ordinary reverse-proxy deployment.
	 *
	 * What it must NOT be is `new URL(c.req.url).origin`: behind a proxy that is the
	 * proxy's upstream target, i.e. `http://127.0.0.1:7779`, which is unreachable
	 * from any other machine. Baking that into the script was the original defect —
	 * the URL was always localhost because the browser's own origin never reached
	 * this code.
	 */
	const baseUrl = (serverBaseUrl ?? resolvePublicOrigin(c).origin).replace(/\/+$/, "");
	const deviceWsUrl =
		device.connectionMode === "direct" && device.directUrl
			? device.directUrl
			: `${baseUrl.replace(/^http/, "ws")}/ws/device`;

	// Evaluated against the URL the target machine will really use, not the request
	// origin: an operator who overrode the base URL is telling us how the key will
	// travel, and that is what has to be safe.
	let resolvedBaseUrl: URL;
	try {
		resolvedBaseUrl = new URL(baseUrl);
	} catch {
		throw new ValidationError("Server base URL must be a valid absolute URL");
	}
	if (tokenDelivery === "enroll") {
		const transport = evaluateEnrollmentTransport({
			origin: resolvedBaseUrl,
			allowPrivateNetworkPlaintext:
				settings.devices?.allowPlaintextEnrollmentOnPrivateNetwork ?? false,
		});
		// Refused here rather than at redemption time so the operator finds out while
		// still in the UI, where the remedy (https, the setting, or manual key entry)
		// is actionable — instead of on the target machine mid-install.
		if (!transport.allowed) {
			throw new ValidationError(
				enrollmentRefusalMessage(transport.reason, { hostname: resolvedBaseUrl.hostname }),
			);
		}
	}

	// Resolve local public trust material before creating a ticket. The trusted
	// management response carries the CA needed for the very first script fetch.
	const caCertPem = await resolveExecutorInstallCa({
		serverUrl: resolvedBaseUrl,
		tls: settings.server.tls,
		builtinCaCertPath: getTlsPaths().caCertPath,
	});

	/*
	 * The script embeds its own ticket, and the ticket must carry the script so the
	 * public fetch endpoint can serve it without touching the database — a cycle.
	 * Broken by minting the ticket first and attaching the rendered body after.
	 */
	const ticket = issueExecutorTicket(platform, {
		deviceId: device.id,
		deviceSlug: device.slug,
		// Structural, not cosmetic: a prompt-mode ticket must be unable to hand out a
		// key even if something later points it at the enroll endpoint.
		allowTokenDelivery: tokenDelivery === "enroll",
	});
	const generated = buildExecutorInstallScript({
		platform,
		mode,
		serverBaseUrl: baseUrl,
		deviceWsUrl,
		deviceSlug: device.slug,
		deviceName: device.name,
		connectionMode: device.connectionMode,
		disableShell,
		artifactFilename: artifact.filename,
		expectedSha256: artifact.sha256,
		executorVersion: manifest.version,
		ticket: ticket.ticket,
		tokenDelivery,
		caCertPem,
	});
	attachExecutorTicketScript(ticket.ticket, {
		body: generated.script,
		filename: generated.filename,
		shell: generated.shell,
	});

	const scriptUrl = `${baseUrl}/api/executor/install/${platform}?ticket=${ticket.ticket}`;
	return c.json({
		script: generated.script,
		filename: generated.filename,
		shell: generated.shell,
		scriptUrl,
		oneLiner: buildExecutorInstallOneLiner({ scriptUrl, shell: generated.shell, caCertPem }),
		tokenDelivery,
		executorVersion: manifest.version,
		platform,
		expiresAt: new Date(ticket.expiresAt).toISOString(),
	});
});

/*
 * ── Filesystem and transfer surface: admin only ───────────────────────────────
 *
 * These endpoints below are gated individually rather than by a router-wide
 * middleware, so that adding a new endpoint above does not silently inherit (or
 * silently lose) the wrong tier. The transfer endpoints accept an arbitrary
 * server-local `localPath`, which makes them equivalent to filesystem access on
 * the NarraFork server — see the tier notes at the top of this file.
 */

// Browse a remote path (file/dir metadata; recursive lists a directory tree).
deviceRoutes.get("/:id/fs", async (c) => {
	assertAdmin(c);
	const device = await getDevice(c.req.param("id"));
	if (!device) throw new NotFoundError("Device", c.req.param("id"));
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
	// Manager tier, not admin: this reads directory names on the *device* only and
	// touches no server-local path, and the path-rules editor needs it to let an
	// operator pick real directories instead of typing them from memory.
	const device = await requireManagedDevice(c);
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
	assertAdmin(c);
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
	assertAdmin(c);
	const device = await getDevice(c.req.param("id"));
	if (!device) throw new ValidationError("Device not found");
	return c.json(await listDeviceTransferTasks(device.id));
});

deviceRoutes.get("/:id/transfer-tasks/:taskId", async (c) => {
	assertAdmin(c);
	const task = await getDeviceTransferTask(c.req.param("id"), c.req.param("taskId"));
	if (!task) throw new ValidationError("Transfer task not found");
	return c.json(task);
});

deviceRoutes.post("/:id/transfer-tasks/:taskId/pause", async (c) => {
	assertAdmin(c);
	const task = await pauseDeviceTransferTask(c.req.param("id"), c.req.param("taskId"));
	if (!task) throw new ValidationError("Transfer task not found");
	return c.json(task);
});

deviceRoutes.post("/:id/transfer-tasks/:taskId/cancel", async (c) => {
	assertAdmin(c);
	const task = await cancelDeviceTransferTask(c.req.param("id"), c.req.param("taskId"));
	if (!task) {
		throw new ValidationError("Transfer task cannot be cancelled");
	}
	return c.json(task);
});

deviceRoutes.post("/:id/transfer-tasks/:taskId/resume", async (c) => {
	assertAdmin(c);
	const task = await resumeDeviceTransferTask(c.req.param("id"), c.req.param("taskId"));
	if (!task) {
		throw new ValidationError("Transfer task is not resumable");
	}
	return c.json(task, 202);
});

// Synchronous compatibility endpoint. Progress is broadcast via transfer:* events.
deviceRoutes.post("/:id/transfers", async (c) => {
	assertAdmin(c);
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
