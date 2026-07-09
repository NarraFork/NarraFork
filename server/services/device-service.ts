/**
 * Remote device service — registration, token management, and CRUD for remote
 * executor devices.
 *
 * Phase 1 covers persistence + auth-token lifecycle. The live connection
 * manager (WebSocket sessions, RPC dispatch, RemoteBackend wiring) is layered
 * on in phase 2 via device-connection-service.ts, which imports these helpers.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { remoteDevices } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";

export type RemoteDeviceRow = typeof remoteDevices.$inferSelect;

/** Public projection of a device (never includes tokenHash). */
export interface RemoteDeviceView {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	tokenPrefix: string;
	connectionMode: "reverse" | "direct";
	directUrl: string | null;
	status: "online" | "offline";
	lastSeenAt: string | null;
	platformOs: string | null;
	platformArch: string | null;
	shellPath: string | null;
	defaultCwd: string | null;
	agentVersion: string | null;
	capabilities: Record<string, unknown> | null;
	scope: "global" | "project";
	projectId: string | null;
	createdAt: string;
	updatedAt: string;
	revokedAt: string | null;
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
		status: row.status,
		lastSeenAt: row.lastSeenAt,
		platformOs: row.platformOs,
		platformArch: row.platformArch,
		shellPath: row.shellPath,
		defaultCwd: row.defaultCwd,
		agentVersion: row.agentVersion,
		capabilities: (row.capabilitiesJson as Record<string, unknown> | null) ?? null,
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
	scope: "global" | "project";
	projectId?: string;
	createdBy: string;
}

export interface CreateDeviceResult {
	device: RemoteDeviceView;
	/** Plaintext token — returned exactly once, never stored. */
	token: string;
}

export async function createDevice(input: CreateDeviceInput): Promise<CreateDeviceResult> {
	const slug = await ensureUniqueSlug(input.slug ?? slugifyDeviceName(input.name));
	const { token, prefix, hash } = generateDeviceToken();
	const now = new Date().toISOString();
	const id = generateId();

	const [row] = await db
		.insert(remoteDevices)
		.values({
			id,
			name: input.name,
			slug,
			description: input.description ?? null,
			tokenHash: hash,
			tokenPrefix: prefix,
			connectionMode: input.connectionMode,
			directUrl: input.directUrl ?? null,
			status: "offline",
			scope: input.scope,
			projectId: input.scope === "project" ? (input.projectId ?? null) : null,
			createdBy: input.createdBy,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	logger.info("Remote device registered", { deviceId: id, slug, mode: input.connectionMode });
	eventBus.emit({ type: "device:changed", deviceId: id });
	return { device: toDeviceView(row), token };
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
	scope?: "global" | "project";
	projectId?: string | null;
}

export async function updateDevice(
	id: string,
	input: UpdateDeviceInput,
): Promise<RemoteDeviceView | null> {
	const existing = await getDeviceRow(id);
	if (!existing || existing.revokedAt) return null;

	const patch: Partial<RemoteDeviceRow> = { updatedAt: new Date().toISOString() };
	if (input.name !== undefined) patch.name = input.name;
	if (input.description !== undefined) patch.description = input.description;
	if (input.connectionMode !== undefined) patch.connectionMode = input.connectionMode;
	if (input.directUrl !== undefined) patch.directUrl = input.directUrl;
	if (input.scope !== undefined) patch.scope = input.scope;
	if (input.projectId !== undefined) patch.projectId = input.projectId;

	const [row] = await db
		.update(remoteDevices)
		.set(patch)
		.where(eq(remoteDevices.id, id))
		.returning();
	eventBus.emit({ type: "device:changed", deviceId: id });
	return row ? toDeviceView(row) : null;
}

/** Rotate a device's token, returning the new plaintext token once. */
export async function rotateDeviceToken(id: string): Promise<{ token: string } | null> {
	const existing = await getDeviceRow(id);
	if (!existing || existing.revokedAt) return null;

	const { token, prefix, hash } = generateDeviceToken();
	await db
		.update(remoteDevices)
		.set({ tokenHash: hash, tokenPrefix: prefix, updatedAt: new Date().toISOString() })
		.where(eq(remoteDevices.id, id));
	logger.info("Remote device token rotated", { deviceId: id });
	// Force a reconnect: the live connection (if any) is torn down by the
	// connection layer, which listens for device:token-rotated.
	eventBus.emit({ type: "device:token-rotated", deviceId: id });
	return { token };
}

/** Soft-delete (revoke) a device. Revoked devices reject new connections. */
export async function revokeDevice(id: string): Promise<boolean> {
	const existing = await getDeviceRow(id);
	if (!existing || existing.revokedAt) return false;
	await db
		.update(remoteDevices)
		.set({ revokedAt: new Date().toISOString(), status: "offline" })
		.where(eq(remoteDevices.id, id));
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
