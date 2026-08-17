/**
 * Remote device service — registration, token management, and CRUD for remote
 * executor devices.
 *
 * Phase 1 covers persistence + auth-token lifecycle. The live connection
 * manager (WebSocket sessions, RPC dispatch, RemoteBackend wiring) is layered
 * on in phase 2 via device-connection-service.ts, which imports these helpers.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ExecutorPathRule } from "@shared/executor-path-rules";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { projects, remoteDevices } from "../db/schema";
import { isSecureDirectDeviceUrl } from "../lib/device-url";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { integrationResourceBindingService } from "./integration-resource-binding-service";

export type RemoteDeviceRow = typeof remoteDevices.$inferSelect;

/** Public projection of a device (never includes tokenHash). */
export type DeviceScopeErrorCode =
	| "DEVICE_SCOPE_FORBIDDEN"
	| "DEVICE_OFFLINE"
	| "DEVICE_PTY_UNAVAILABLE"
	| "DEVICE_PLATFORM_UNSUPPORTED"
	| "DEVICE_EXECUTOR_UPGRADE_REQUIRED";

export class DeviceScopeError extends AppError {
	constructor(message: string, code: DeviceScopeErrorCode, statusCode = 422) {
		super(message, statusCode, code);
		this.name = "DeviceScopeError";
	}
}

export interface RemoteDeviceView {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	tokenPrefix: string;
	connectionMode: "reverse" | "direct";
	directUrl: string | null;
	/** Owner axis: "private" restricts the device to its creator. */
	ownerScope: "private" | "shared";
	/** User who registered the device; the owner for `ownerScope: "private"`. */
	createdBy: string;
	status: "online" | "offline";
	lastSeenAt: string | null;
	platformOs: string | null;
	platformArch: string | null;
	shellPath: string | null;
	defaultCwd: string | null;
	agentVersion: string | null;
	capabilities: Record<string, unknown> | null;
	/**
	 * Ordered path guard rules the operator configured (desired state). A record of
	 * intent only: the executor enforces the rules in its own config file, so this
	 * is never consulted to authorize a request.
	 */
	pathRules: ExecutorPathRule[] | null;
	/** Ordered rules the device reported enforcing at its last handshake. */
	reportedPathRules: ExecutorPathRule[] | null;
	scope: "global" | "project";
	projectId: string | null;
	createdAt: string;
	updatedAt: string;
	revokedAt: string | null;
}

type DeviceScopeRecord = Pick<RemoteDeviceView, "scope" | "projectId">;

/** Adds the user axis. `createdBy` is what makes a "private" device personal. */
type DeviceAuthorizationRecord = DeviceScopeRecord &
	Partial<Pick<RemoteDeviceView, "ownerScope" | "createdBy">>;

export interface DeviceAuthorizationContext {
	projectId?: string | null;
	/** Acting user, for the owner axis. Absent means "no user context". */
	userId?: string | null;
}

/**
 * Project axis only. Global devices are universally available; project devices
 * require an exact project match.
 *
 * Kept as its own function because several callers legitimately have no user
 * context (unattended recovery, snapshot revert). Prefer `isDeviceAuthorized`
 * where an acting user is known.
 */
export function isDeviceAuthorizedForProject(
	device: DeviceScopeRecord,
	projectId: string | null | undefined,
): boolean {
	if (device.scope === "global") return true;
	return !!projectId && !!device.projectId && device.projectId === projectId;
}

/**
 * Full two-axis authorization.
 *
 * The axes are independent and both must pass:
 *
 * - **project axis** (`scope`/`projectId`): which projects may use the device.
 * - **owner axis** (`ownerScope`/`createdBy`): "shared" is available to everyone
 *   the project axis allows; "private" is restricted to the user who registered
 *   it, which is what makes a personal dev box personal.
 *
 * Together they express the four real deployments: a personal machine that
 * follows its owner across projects (private + global), a project deploy target
 * (shared + project), a communal build machine (shared + global), and a
 * project-scoped personal box (private + project).
 *
 * A private device with no acting user in context is refused: an unattended path
 * has no way to prove it is the owner, and silently treating that as "allowed"
 * would make `private` meaningless on exactly the paths that need it most.
 */
export function isDeviceAuthorized(
	device: DeviceAuthorizationRecord,
	context: DeviceAuthorizationContext = {},
): boolean {
	if (!isDeviceAuthorizedForProject(device, context.projectId)) return false;
	// Rows predating the owner axis default to "shared" in the schema; treat a
	// missing value the same way so older callers keep working.
	const ownerScope = device.ownerScope ?? "shared";
	if (ownerScope === "shared") return true;
	const owner = device.createdBy;
	if (!owner) return false;
	return !!context.userId && context.userId === owner;
}

/**
 * May this principal manage (view details of, edit, or delete) this device?
 *
 * Distinct from `isDeviceAuthorized`, which answers "may a narrator run tool calls
 * on it". Usage and management are different powers: a shared device is *usable*
 * by everyone the project axis allows, but only its registrar or an admin may
 * rename it, change its scope, rotate its key, or revoke it. Letting any user who
 * can use a device also reconfigure it would let one member repoint a machine the
 * whole team depends on.
 */
export function canManageDevice(
	device: Pick<RemoteDeviceView, "createdBy">,
	principal: { userId: string | null | undefined; isAdmin: boolean },
): boolean {
	if (principal.isAdmin) return true;
	return !!principal.userId && principal.userId === device.createdBy;
}

export function deviceHasFeature(
	capabilities: Record<string, unknown> | null | undefined,
	feature: string,
): boolean {
	const features = capabilities?.features;
	if (Array.isArray(features)) return features.includes(feature);
	if (features && typeof features === "object") {
		return (features as Record<string, unknown>)[feature] === true;
	}
	return capabilities?.[feature] === true;
}

export function toDeviceView(row: RemoteDeviceRow): RemoteDeviceView {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		tokenPrefix: row.tokenPrefix,
		connectionMode: row.connectionMode,
		directUrl: row.directUrl,
		ownerScope: row.ownerScope,
		createdBy: row.createdBy,
		status: row.status,
		lastSeenAt: row.lastSeenAt,
		platformOs: row.platformOs,
		platformArch: row.platformArch,
		shellPath: row.shellPath,
		defaultCwd: row.defaultCwd,
		agentVersion: row.agentVersion,
		capabilities: (row.capabilitiesJson as Record<string, unknown> | null) ?? null,
		// Desired vs. reported are deliberately separate: the executor's own config
		// is the authority, so the UI has to be able to show that a saved change has
		// not been applied on the device yet.
		pathRules: row.pathRulesJson ?? null,
		reportedPathRules: row.reportedPathRulesJson ?? null,
		scope: row.scope,
		projectId: row.projectId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		revokedAt: row.revokedAt,
	};
}

/** Hash a device token for storage / comparison (SHA-256 hex). */
export function hashDeviceToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Generate a new device token. Format: `rdev_<40 hex chars>`. */
export function generateDeviceToken(): { token: string; prefix: string; hash: string } {
	const secret = randomBytes(20).toString("hex");
	const token = `rdev_${secret}`;
	// Prefix is non-secret: scheme + first 4 chars of the secret.
	const prefix = `rdev_${secret.slice(0, 4)}`;
	return { token, prefix, hash: hashDeviceToken(token) };
}

/** Derive a slug from a display name. */
export function slugifyDeviceName(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return base || "device";
}

/** Ensure a slug is unique, appending a short suffix on collision. */
async function ensureUniqueSlug(desired: string): Promise<string> {
	let candidate = desired;
	for (let attempt = 0; attempt < 20; attempt++) {
		const existing = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.slug, candidate),
			columns: { id: true },
		});
		if (!existing) return candidate;
		candidate = `${desired}-${randomBytes(2).toString("hex")}`;
	}
	// Extremely unlikely — fall back to a fully random slug.
	return `device-${randomBytes(4).toString("hex")}`;
}

export interface CreateDeviceInput {
	name: string;
	slug?: string;
	description?: string;
	connectionMode: "reverse" | "direct";
	directUrl?: string;
	/** Owner axis; defaults to "shared" to match the pre-existing behaviour. */
	ownerScope?: "private" | "shared";
	scope: "global" | "project";
	projectId?: string | null;
	createdBy: string;
	/** Preserve a project anchor for a global integration-owned device. */
	preserveGlobalProjectContext?: boolean;
}

export interface CreateDeviceResult {
	device: RemoteDeviceView;
	/** Plaintext token — returned exactly once, never stored. */
	token: string;
}

export interface PreparedDeviceCreation {
	row: typeof remoteDevices.$inferInsert;
	token: string;
}

type DeviceInsertExecutor = Pick<typeof db, "insert">;
type DeviceUpdateExecutor = Pick<typeof db, "update">;

function normalizeDirectUrl(
	connectionMode: "reverse" | "direct",
	directUrl: string | null | undefined,
): string | null {
	if (connectionMode === "reverse") return null;
	const value = directUrl?.trim();
	if (!value) throw new ValidationError("directUrl is required for direct connection mode");
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new ValidationError("directUrl must be a valid WebSocket URL");
	}
	if (!isSecureDirectDeviceUrl(parsed.href)) {
		throw new ValidationError("directUrl must use wss://, or ws:// with a loopback IP literal");
	}
	return value;
}

async function normalizeProjectScope(
	scope: "global" | "project",
	projectId: string | null | undefined,
	preserveGlobalProjectContext = false,
): Promise<string | null> {
	if (scope === "global" && !preserveGlobalProjectContext) return null;
	const value = projectId?.trim();
	if (!value) throw new ValidationError("projectId is required for this device scope");
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, value),
		columns: { id: true },
	});
	if (!project) throw new ValidationError("Project not found");
	return value;
}

export async function prepareDeviceCreation(
	input: CreateDeviceInput,
): Promise<PreparedDeviceCreation> {
	const name = input.name.trim();
	if (!name) throw new ValidationError("Device name is required");
	const slug = await ensureUniqueSlug(input.slug ?? slugifyDeviceName(name));
	const directUrl = normalizeDirectUrl(input.connectionMode, input.directUrl);
	const projectId = await normalizeProjectScope(
		input.scope,
		input.projectId,
		input.preserveGlobalProjectContext ?? false,
	);
	const { token, prefix, hash } = generateDeviceToken();
	const now = new Date().toISOString();
	return {
		token,
		row: {
			id: generateId(),
			name,
			slug,
			description: input.description?.trim() || null,
			tokenHash: hash,
			tokenPrefix: prefix,
			connectionMode: input.connectionMode,
			directUrl,
			ownerScope: input.ownerScope ?? "shared",
			status: "offline",
			scope: input.scope,
			projectId,
			createdBy: input.createdBy,
			createdAt: now,
			updatedAt: now,
		},
	};
}

export function createPreparedDeviceInTransaction(
	executor: DeviceInsertExecutor,
	prepared: PreparedDeviceCreation,
): CreateDeviceResult {
	const row = executor.insert(remoteDevices).values(prepared.row).returning().get();
	return { device: toDeviceView(row), token: prepared.token };
}

export function publishDeviceCreated(device: RemoteDeviceView): void {
	logger.info("Remote device registered", {
		deviceId: device.id,
		slug: device.slug,
		mode: device.connectionMode,
	});
	eventBus.emit({ type: "device:changed", deviceId: device.id });
}

export async function createDevice(input: CreateDeviceInput): Promise<CreateDeviceResult> {
	const prepared = await prepareDeviceCreation(input);
	const result = db.transaction((tx) => createPreparedDeviceInTransaction(tx, prepared));
	publishDeviceCreated(result.device);
	return result;
}

export async function listDevices(): Promise<RemoteDeviceView[]> {
	const rows = await db.query.remoteDevices.findMany({
		where: isNull(remoteDevices.revokedAt),
		orderBy: (d, { asc }) => [asc(d.createdAt)],
	});
	return rows.map(toDeviceView);
}

export async function getDevice(id: string): Promise<RemoteDeviceView | null> {
	const row = await db.query.remoteDevices.findFirst({
		where: and(eq(remoteDevices.id, id), isNull(remoteDevices.revokedAt)),
	});
	return row ? toDeviceView(row) : null;
}

export async function requireAuthorizedDeviceForProject(
	deviceId: string,
	projectId: string | null | undefined,
	/** Acting user, for the owner axis. Omit only where no user context exists. */
	actingUserId?: string | null,
): Promise<RemoteDeviceView> {
	const device = await getDevice(deviceId);
	if (!device) throw new NotFoundError("Remote device", deviceId);
	// Owner axis first so a private device reports the more specific reason rather
	// than a confusing project-scope message.
	if (!isDeviceAuthorized(device, { projectId, userId: actingUserId })) {
		if (isDeviceAuthorizedForProject(device, projectId)) {
			throw new DeviceScopeError(
				`Remote device "${deviceId}" is private to the user who registered it`,
				"DEVICE_SCOPE_FORBIDDEN",
				403,
			);
		}
	}
	if (!isDeviceAuthorizedForProject(device, projectId)) {
		throw new DeviceScopeError(
			projectId
				? `Remote device "${deviceId}" is not authorized for project "${projectId}"`
				: `Standalone terminals may only use global remote devices; "${deviceId}" is project-scoped`,
			"DEVICE_SCOPE_FORBIDDEN",
			403,
		);
	}
	return device;
}

/** Fetch the raw row (including tokenHash) — used by the connection layer. */
export async function getDeviceRow(id: string): Promise<RemoteDeviceRow | null> {
	const row = await db.query.remoteDevices.findFirst({
		where: eq(remoteDevices.id, id),
	});
	return row ?? null;
}

export interface UpdateDeviceInput {
	name?: string;
	description?: string | null;
	connectionMode?: "reverse" | "direct";
	directUrl?: string | null;
	ownerScope?: "private" | "shared";
	scope?: "global" | "project";
	projectId?: string | null;
}

export async function updateDevice(
	id: string,
	input: UpdateDeviceInput,
): Promise<RemoteDeviceView | null> {
	const existing = await getDeviceRow(id);
	if (!existing || existing.revokedAt) return null;

	const connectionMode = input.connectionMode ?? existing.connectionMode;
	const directUrl = normalizeDirectUrl(
		connectionMode,
		input.directUrl !== undefined ? input.directUrl : existing.directUrl,
	);
	const scope = input.scope ?? existing.scope;
	const binding = await integrationResourceBindingService.get("device", id);
	const projectId = await normalizeProjectScope(
		scope,
		input.projectId !== undefined ? input.projectId : existing.projectId,
		binding?.state === "active",
	);
	const patch: Partial<RemoteDeviceRow> = {
		updatedAt: new Date().toISOString(),
		connectionMode,
		directUrl,
		scope,
		projectId,
		ownerScope: input.ownerScope ?? existing.ownerScope,
	};
	if (input.name !== undefined) {
		const name = input.name.trim();
		if (!name) throw new ValidationError("Device name is required");
		patch.name = name;
	}
	if (input.description !== undefined) {
		patch.description = input.description?.trim() || null;
	}

	const [row] = await db
		.update(remoteDevices)
		.set(patch)
		.where(eq(remoteDevices.id, id))
		.returning();
	eventBus.emit({ type: "device:changed", deviceId: id });
	return row ? toDeviceView(row) : null;
}

/**
 * Records the operator's desired path guard rules.
 *
 * This does NOT change what the device enforces. The executor reads its rules
 * from its own config file on the target machine, which is the entire point: a
 * server-pushed guard could be widened by whoever controls the server. Saving
 * here only captures intent so the UI can render it, diff it against the rules
 * the device reports, and regenerate the config snippet to paste.
 *
 * Order is preserved exactly as supplied. Sorting or deduping would rewrite the
 * policy, because the last matching rule is the one that wins.
 */
export async function updateDevicePathRules(
	id: string,
	rules: ExecutorPathRule[],
): Promise<RemoteDeviceView | null> {
	const existing = await getDeviceRow(id);
	if (!existing || existing.revokedAt) return null;

	const [row] = await db
		.update(remoteDevices)
		.set({ pathRulesJson: rules, updatedAt: new Date().toISOString() })
		.where(eq(remoteDevices.id, id))
		.returning();
	logger.info("Remote device path rules updated", { deviceId: id, ruleCount: rules.length });
	eventBus.emit({ type: "device:changed", deviceId: id });
	return row ? toDeviceView(row) : null;
}

export function rotateDeviceTokenInTransaction(
	executor: DeviceUpdateExecutor,
	id: string,
	now = new Date().toISOString(),
): { token: string } | null {
	const { token, prefix, hash } = generateDeviceToken();
	const updated = executor
		.update(remoteDevices)
		.set({ tokenHash: hash, tokenPrefix: prefix, updatedAt: now })
		.where(and(eq(remoteDevices.id, id), isNull(remoteDevices.revokedAt)))
		.returning({ id: remoteDevices.id })
		.get();
	return updated ? { token } : null;
}

export function publishDeviceTokenRotated(id: string): void {
	logger.info("Remote device token rotated", { deviceId: id });
	// Force a reconnect: the live connection (if any) is torn down by the
	// connection layer, which listens for device:token-rotated.
	eventBus.emit({ type: "device:token-rotated", deviceId: id });
}

/** Rotate a device's token, returning the new plaintext token once. */
export async function rotateDeviceToken(id: string): Promise<{ token: string } | null> {
	const result = db.transaction((tx) => rotateDeviceTokenInTransaction(tx, id));
	if (!result) return null;
	publishDeviceTokenRotated(id);
	return result;
}

/** Soft-delete (revoke) a device. Revoked devices reject new connections. */
export async function revokeDevice(id: string): Promise<boolean> {
	const existing = await getDeviceRow(id);
	if (!existing || existing.revokedAt) return false;
	await db
		.update(remoteDevices)
		.set({ revokedAt: new Date().toISOString(), status: "offline" })
		.where(eq(remoteDevices.id, id));
	await integrationResourceBindingService.markRevoked("device", id);
	logger.info("Remote device revoked", { deviceId: id });
	eventBus.emit({ type: "device:revoked", deviceId: id });
	return true;
}

/**
 * Verify a presented token against a device by slug or id.
 * Returns the device row on success, null otherwise. Used by the reverse-dial
 * WebSocket handshake in phase 2.
 */
export async function verifyDeviceToken(
	identifier: string,
	token: string,
): Promise<RemoteDeviceRow | null> {
	const bySlug = await db.query.remoteDevices.findFirst({
		where: eq(remoteDevices.slug, identifier),
	});
	const row =
		bySlug ?? (await db.query.remoteDevices.findFirst({ where: eq(remoteDevices.id, identifier) }));
	if (!row || row.revokedAt) return null;
	// Constant-time compare of the SHA-256 hashes (both fixed 32-byte hex) so token
	// verification does not leak information through response timing.
	const presented = Buffer.from(hashDeviceToken(token), "hex");
	const stored = Buffer.from(row.tokenHash, "hex");
	if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
		return null;
	}
	return row;
}
