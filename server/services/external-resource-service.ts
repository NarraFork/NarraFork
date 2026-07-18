import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
	remoteDevices,
} from "../db/schema";
import { AsyncMutex } from "../lib/async-mutex";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import type { OAuthNarratorProvisionSnapshot } from "../lib/oauth-client-policy";
import {
	EXTERNAL_V1_DEFAULT_LIMIT,
	EXTERNAL_V1_MAX_CURSOR_BYTES,
	EXTERNAL_V1_MAX_LIMIT,
	EXTERNAL_V1_MAX_MESSAGE_BYTES,
	EXTERNAL_V1_MAX_MESSAGE_CHARS,
	type ExternalDeviceProvisionInput,
	type ExternalListQuery,
	type ExternalNarratorProvisionInput,
	type ExternalSendMessageInput,
} from "../lib/validators/external";
import { createDevice, type RemoteDeviceView, rotateDeviceToken } from "./device-service";
import { narratorService } from "./narrator-service";
import { interruptNarrator, sendMessage } from "./narrator-session";
import { recordOAuthGrantEvent } from "./oauth-grant-service";
import { assertOAuthNarratorRuntimeActive } from "./oauth-narrator-runtime-policy";
import {
	assertExternalDeviceBinding,
	assertExternalProjectAllowed,
	assertExternalScope,
	type ExternalOAuthContext,
	requireExternalResourceOwner,
	requireOwnedExternalDevice,
	requireOwnedExternalNarrator,
} from "./oauth-resource-access";

export const EXTERNAL_MESSAGE_MAX_PAGE_LIMIT = 50;
export const EXTERNAL_MESSAGE_TEXT_MAX_BYTES = 64 * 1024;

const PROVISION_KEY_PATTERN = /^[A-Za-z0-9._~-]+$/;
const PROVISION_KEY_MAX_CHARS = 80;
const provisionLock = new AsyncMutex();
const textEncoder = new TextEncoder();

type ExternalPermissionMode = "readOnly" | "dontAsk";
type ResourceType = "device" | "narrator";

export interface ExternalPage<T> {
	items: T[];
	nextCursor: string | null;
}

export interface ExternalProjectDto {
	id: string;
	name: string;
	description: string | null;
	status: "active" | "archived";
}

export interface ExternalDeviceDto {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	status: "online" | "offline";
	lastSeenAt: string | null;
	platformOs: string | null;
	platformArch: string | null;
	agentVersion: string | null;
	capabilities: Record<string, unknown> | null;
	scope: "global" | "project";
	projectId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ExternalDeviceProvisionResult {
	device: ExternalDeviceDto;
	created: boolean;
	/** Plaintext registration credential. Present only on the first successful provision. */
	credential: { token: string } | null;
}

export interface ExternalDeviceCredentialResult {
	credential: { token: string };
}

export interface ExternalNarratorDto {
	id: string;
	title: string | null;
	status: "idle" | "working" | "waiting" | "archived";
	permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "readOnly" | "dontAsk" | null;
	defaultDeviceId: string | null;
	projectId: string;
	lastMessageAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ExternalNarratorProvisionResult {
	narrator: ExternalNarratorDto;
	created: boolean;
}

export interface ExternalNarratorMessageDto {
	id: string;
	seq: number;
	role: "user" | "assistant";
	text: string;
	textTruncated: boolean;
	createdAt: string;
}

function externalPolicyForbidden(message: string): AppError {
	return new AppError(message, 403, "OAUTH_POLICY_FORBIDDEN");
}

function resourceProvisionConflict(resourceType: ResourceType): AppError {
	return new AppError(
		`The ${resourceType} provision key is already bound to an unavailable resource`,
		409,
		"RESOURCE_PROVISION_CONFLICT",
	);
}

function validateProvisionKey(provisionKey: string): string {
	if (
		typeof provisionKey !== "string" ||
		provisionKey.length === 0 ||
		provisionKey.length > PROVISION_KEY_MAX_CHARS ||
		!PROVISION_KEY_PATTERN.test(provisionKey)
	) {
		throw new ValidationError("Invalid external provision key");
	}
	return provisionKey;
}

function isUniqueConstraintError(error: unknown): boolean {
	return /unique constraint|SQLITE_CONSTRAINT_UNIQUE/i.test(String(error));
}

function normalizeLimit(input: ExternalListQuery | undefined, maxLimit: number): number {
	const limit = input?.limit ?? EXTERNAL_V1_DEFAULT_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
		throw new ValidationError(`limit must be an integer from 1 to ${maxLimit}`);
	}
	return limit;
}

function encodeMessageCursor(seq: number): string {
	return Buffer.from(JSON.stringify({ seq }), "utf8").toString("base64url");
}

function decodeMessageCursor(value: string | undefined): number | null {
	if (!value) return null;
	if (Buffer.byteLength(value, "utf8") > EXTERNAL_V1_MAX_CURSOR_BYTES) {
		throw new ValidationError("External message cursor is invalid");
	}
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
			seq?: unknown;
		};
		if (!Number.isSafeInteger(parsed.seq) || (parsed.seq as number) < 0) {
			throw new Error("invalid cursor seq");
		}
		return parsed.seq as number;
	} catch {
		throw new ValidationError("External message cursor is invalid");
	}
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
	let bytes = 0;
	let end = 0;
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		const characterBytes =
			codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
		if (bytes + characterBytes > maxBytes) {
			return { text: value.slice(0, end), truncated: true };
		}
		bytes += characterBytes;
		end += character.length;
	}
	return { text: value, truncated: false };
}

function toExternalProjectDto(row: typeof projects.$inferSelect): ExternalProjectDto {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		status: row.status,
	};
}

function toExternalDeviceDto(row: typeof remoteDevices.$inferSelect): ExternalDeviceDto {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		status: row.status,
		lastSeenAt: row.lastSeenAt,
		platformOs: row.platformOs,
		platformArch: row.platformArch,
		agentVersion: row.agentVersion,
		capabilities: (row.capabilitiesJson as Record<string, unknown> | null) ?? null,
		scope: row.scope,
		projectId: row.projectId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function externalDeviceDtoFromView(view: RemoteDeviceView): ExternalDeviceDto {
	return {
		id: view.id,
		name: view.name,
		slug: view.slug,
		description: view.description,
		status: view.status,
		lastSeenAt: view.lastSeenAt,
		platformOs: view.platformOs,
		platformArch: view.platformArch,
		agentVersion: view.agentVersion,
		capabilities: view.capabilities,
		scope: view.scope,
		projectId: view.projectId,
		createdAt: view.createdAt,
		updatedAt: view.updatedAt,
	};
}

async function getOwnedDeviceRow(ctx: ExternalOAuthContext, id: string) {
	await requireOwnedExternalDevice(ctx, id);
	const row = await db.query.remoteDevices.findFirst({
		where: and(
			eq(remoteDevices.id, id),
			eq(remoteDevices.oauthOwnerGrantId, ctx.grantId),
			isNull(remoteDevices.revokedAt),
		),
	});
	return requireExternalResourceOwner(ctx, row, "Remote device", id);
}

async function findDeviceByProvisionKey(ctx: ExternalOAuthContext, provisionKey: string) {
	return db.query.remoteDevices.findFirst({
		where: and(
			eq(remoteDevices.oauthOwnerGrantId, ctx.grantId),
			eq(remoteDevices.oauthProvisionKey, provisionKey),
		),
	});
}

async function getExternalNarratorRow(ctx: ExternalOAuthContext, id: string) {
	await requireOwnedExternalNarrator(ctx, id);
	const row = await db.query.narrators.findFirst({
		where: and(eq(narrators.id, id), eq(narrators.oauthOwnerGrantId, ctx.grantId)),
	});
	return requireExternalResourceOwner(ctx, row, "Narrator", id);
}

async function findNarratorByProvisionKey(ctx: ExternalOAuthContext, provisionKey: string) {
	return db.query.narrators.findFirst({
		where: and(
			eq(narrators.oauthOwnerGrantId, ctx.grantId),
			eq(narrators.oauthProvisionKey, provisionKey),
		),
	});
}

function toExternalNarratorDto(row: typeof narrators.$inferSelect): ExternalNarratorDto {
	if (!row.contextProjectId) {
		throw new NotFoundError("Narrator", row.id);
	}
	return {
		id: row.id,
		title: row.title,
		status: row.status,
		permissionMode: row.permissionMode,
		defaultDeviceId: row.defaultDeviceId,
		projectId: row.contextProjectId,
		lastMessageAt: row.lastMessageAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function freezePolicySnapshot(
	ctx: ExternalOAuthContext,
	permissionMode: ExternalPermissionMode,
	systemPrompt: string | undefined,
	projectId: string,
	deviceId: string,
): OAuthNarratorProvisionSnapshot {
	return {
		version: 1,
		policy: {
			defaultPermissionMode: ctx.policy.defaultPermissionMode,
			allowedPermissionModes: [...ctx.policy.allowedPermissionModes],
			systemPromptMode: ctx.policy.systemPromptMode,
			maxSystemPromptChars: ctx.policy.maxSystemPromptChars,
			allowGlobalDevice: ctx.policy.allowGlobalDevice,
			allowKnowledgeWrite: ctx.policy.allowKnowledgeWrite,
		},
		permissionMode,
		systemPrompt: systemPrompt ?? null,
		projectId,
		deviceId,
	};
}

function resolvePermissionMode(
	ctx: ExternalOAuthContext,
	requested: ExternalNarratorProvisionInput["permissionMode"],
): ExternalPermissionMode {
	const permissionMode = requested ?? ctx.policy.defaultPermissionMode;
	if (permissionMode !== "readOnly" && permissionMode !== "dontAsk") {
		throw new ValidationError(
			"External narrators only support readOnly or dontAsk permission mode",
		);
	}
	if (!ctx.policy.allowedPermissionModes.includes(permissionMode)) {
		throw externalPolicyForbidden("The requested narrator permission mode is not allowed");
	}
	return permissionMode;
}

function resolveSystemPrompt(
	ctx: ExternalOAuthContext,
	requested: string | undefined,
): string | undefined {
	if (ctx.policy.systemPromptMode === "managed") {
		if (requested !== undefined) {
			throw externalPolicyForbidden("This OAuth client uses a managed narrator system prompt");
		}
		return undefined;
	}
	if (requested === undefined || requested.length === 0) return undefined;
	if (requested.length > ctx.policy.maxSystemPromptChars) {
		throw new ValidationError(
			`systemPrompt must not exceed ${ctx.policy.maxSystemPromptChars} characters`,
		);
	}
	return requested;
}

async function recordResourceEvent(
	ctx: ExternalOAuthContext,
	eventType: "resource_provisioned" | "device_credential_rotated",
	resourceType: ResourceType,
	resourceId: string,
	projectId: string,
): Promise<void> {
	await recordOAuthGrantEvent({
		eventType,
		grantId: ctx.grantId,
		userId: ctx.userId,
		actorType: "client",
		projectIds: [projectId],
		metadata: { resourceId, resourceType },
	});
}

export async function listExternalProjects(
	ctx: ExternalOAuthContext,
	_input?: ExternalListQuery,
): Promise<{ items: ExternalProjectDto[]; nextCursor: null }> {
	assertExternalScope(ctx, "project:read");
	if (ctx.projectIds.length === 0) return { items: [], nextCursor: null };
	const rows = await db
		.select()
		.from(projects)
		.where(inArray(projects.id, [...ctx.projectIds]))
		.orderBy(asc(projects.name), asc(projects.id))
		.limit(EXTERNAL_V1_MAX_LIMIT);
	return { items: rows.map(toExternalProjectDto), nextCursor: null };
}

export async function listExternalDevices(
	ctx: ExternalOAuthContext,
	_input?: ExternalListQuery,
): Promise<{ items: ExternalDeviceDto[] }> {
	assertExternalScope(ctx, "device:read");
	if (ctx.projectIds.length === 0) return { items: [] };

	const projectVisibility = and(
		eq(remoteDevices.scope, "project"),
		inArray(remoteDevices.projectId, [...ctx.projectIds]),
	);
	const visibility = ctx.policy.allowGlobalDevice
		? or(projectVisibility, eq(remoteDevices.scope, "global"))
		: projectVisibility;
	const rows = await db
		.select()
		.from(remoteDevices)
		.where(
			and(
				eq(remoteDevices.oauthOwnerGrantId, ctx.grantId),
				isNull(remoteDevices.revokedAt),
				visibility,
			),
		)
		.orderBy(asc(remoteDevices.createdAt), asc(remoteDevices.id))
		.limit(EXTERNAL_V1_MAX_LIMIT);
	for (const row of rows) {
		requireExternalResourceOwner(ctx, row, "Remote device", row.id);
	}
	return { items: rows.map(toExternalDeviceDto) };
}

export async function provisionExternalDevice(
	ctx: ExternalOAuthContext,
	provisionKeyInput: string,
	input: ExternalDeviceProvisionInput,
): Promise<ExternalDeviceProvisionResult> {
	assertExternalScope(ctx, "device:provision");
	const provisionKey = validateProvisionKey(provisionKeyInput);
	assertExternalProjectAllowed(ctx, input.projectId);
	const scope = input.scope ?? "project";
	if (scope === "global" && !ctx.policy.allowGlobalDevice) {
		throw externalPolicyForbidden("This OAuth client may not provision global devices");
	}

	return provisionLock.acquire(`device:${ctx.grantId}:${provisionKey}`, async () => {
		const existing = await findDeviceByProvisionKey(ctx, provisionKey);
		if (existing) {
			if (existing.revokedAt) throw resourceProvisionConflict("device");
			await requireOwnedExternalDevice(ctx, existing.id);
			return { device: toExternalDeviceDto(existing), created: false, credential: null };
		}

		try {
			const result = await createDevice({
				name: input.name ?? `External device ${provisionKey}`,
				description: input.description,
				connectionMode: "reverse",
				scope,
				// Global external devices still retain a project anchor so allow-list
				// removal immediately hides them from the owning grant.
				projectId: input.projectId,
				createdBy: ctx.userId,
				oauthOwnerGrantId: ctx.grantId,
				oauthProvisionKey: provisionKey,
			});
			await recordResourceEvent(
				ctx,
				"resource_provisioned",
				"device",
				result.device.id,
				input.projectId,
			);
			return {
				device: externalDeviceDtoFromView(result.device),
				created: true,
				credential: { token: result.token },
			};
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			const winner = await findDeviceByProvisionKey(ctx, provisionKey);
			if (!winner || winner.revokedAt) throw resourceProvisionConflict("device");
			await requireOwnedExternalDevice(ctx, winner.id);
			return { device: toExternalDeviceDto(winner), created: false, credential: null };
		}
	});
}

export async function getExternalDevice(
	ctx: ExternalOAuthContext,
	id: string,
): Promise<ExternalDeviceDto> {
	assertExternalScope(ctx, "device:read");
	return toExternalDeviceDto(await getOwnedDeviceRow(ctx, id));
}

export async function rotateExternalDeviceCredential(
	ctx: ExternalOAuthContext,
	id: string,
): Promise<ExternalDeviceCredentialResult> {
	assertExternalScope(ctx, "device:rotate");
	const existing = await getOwnedDeviceRow(ctx, id);
	const rotated = await rotateDeviceToken(existing.id);
	if (!rotated) throw new NotFoundError("Remote device", id);
	await recordResourceEvent(
		ctx,
		"device_credential_rotated",
		"device",
		id,
		existing.projectId ?? ctx.projectIds[0] ?? "",
	);
	return { credential: { token: rotated.token } };
}

export async function provisionExternalNarrator(
	ctx: ExternalOAuthContext,
	provisionKeyInput: string,
	input: ExternalNarratorProvisionInput,
): Promise<ExternalNarratorProvisionResult> {
	assertExternalScope(ctx, "narrator:provision");
	const provisionKey = validateProvisionKey(provisionKeyInput);
	assertExternalProjectAllowed(ctx, input.projectId);
	const device = await requireOwnedExternalDevice(ctx, input.deviceId);
	assertExternalDeviceBinding(ctx, device, input.projectId);
	const permissionMode = resolvePermissionMode(ctx, input.permissionMode);
	const systemPrompt = resolveSystemPrompt(ctx, input.systemPrompt);

	return provisionLock.acquire(`narrator:${ctx.grantId}:${provisionKey}`, async () => {
		const existing = await findNarratorByProvisionKey(ctx, provisionKey);
		if (existing) {
			await requireOwnedExternalNarrator(ctx, existing.id);
			return { narrator: toExternalNarratorDto(existing), created: false };
		}

		try {
			const created = await narratorService.create({
				chapterId: null,
				title: input.title ?? `External narrator ${provisionKey}`,
				permissionMode,
				systemPrompt,
				oauthOwnerGrantId: ctx.grantId,
				oauthProvisionKey: provisionKey,
				contextProjectId: input.projectId,
				oauthPolicySnapshotJson: freezePolicySnapshot(
					ctx,
					permissionMode,
					systemPrompt,
					input.projectId,
					device.id,
				),
				defaultDeviceId: device.id,
			});
			await recordResourceEvent(
				ctx,
				"resource_provisioned",
				"narrator",
				created.id,
				input.projectId,
			);
			return { narrator: toExternalNarratorDto(created), created: true };
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			const winner = await findNarratorByProvisionKey(ctx, provisionKey);
			if (!winner) throw resourceProvisionConflict("narrator");
			await requireOwnedExternalNarrator(ctx, winner.id);
			return { narrator: toExternalNarratorDto(winner), created: false };
		}
	});
}

export async function getExternalNarrator(
	ctx: ExternalOAuthContext,
	id: string,
): Promise<ExternalNarratorDto> {
	assertExternalScope(ctx, "narrator:read");
	return toExternalNarratorDto(await getExternalNarratorRow(ctx, id));
}

export async function listExternalNarratorMessages(
	ctx: ExternalOAuthContext,
	narratorId: string,
	input?: ExternalListQuery,
): Promise<ExternalPage<ExternalNarratorMessageDto>> {
	assertExternalScope(ctx, "narrator:read");
	await requireOwnedExternalNarrator(ctx, narratorId);
	const limit = normalizeLimit(input, EXTERNAL_MESSAGE_MAX_PAGE_LIMIT);
	const cursor = decodeMessageCursor(input?.cursor);
	const rows = await db
		.select({
			id: narratorMessages.id,
			seq: narratorMessageRefs.seq,
			role: narratorMessages.role,
			contentText: narratorMessages.contentText,
			createdAt: narratorMessages.createdAt,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				cursor === null ? undefined : gt(narratorMessageRefs.seq, cursor),
				inArray(narratorMessages.role, ["user", "assistant"]),
			),
		)
		.orderBy(asc(narratorMessageRefs.seq))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const pageRows = hasMore ? rows.slice(0, limit) : rows;
	return {
		items: pageRows.map((row) => {
			const text = truncateUtf8(row.contentText ?? "", EXTERNAL_MESSAGE_TEXT_MAX_BYTES);
			return {
				id: row.id,
				seq: row.seq,
				role: row.role as "user" | "assistant",
				text: text.text,
				textTruncated: text.truncated,
				createdAt: row.createdAt,
			};
		}),
		nextCursor: hasMore ? encodeMessageCursor(pageRows.at(-1)?.seq ?? 0) : null,
	};
}

export async function sendExternalNarratorMessage(
	ctx: ExternalOAuthContext,
	narratorId: string,
	input: ExternalSendMessageInput,
): Promise<{ accepted: true; narratorId: string }> {
	assertExternalScope(ctx, "narrator:message");
	await requireOwnedExternalNarrator(ctx, narratorId);
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.keys(input).some((key) => key !== "message") ||
		typeof input.message !== "string" ||
		input.message.length === 0 ||
		input.message.length > EXTERNAL_V1_MAX_MESSAGE_CHARS ||
		textEncoder.encode(input.message).byteLength > EXTERNAL_V1_MAX_MESSAGE_BYTES
	) {
		throw new ValidationError("External narrator messages must contain only bounded plain text");
	}
	await assertOAuthNarratorRuntimeActive(narratorId, ctx.userId);
	await sendMessage(narratorId, input.message, undefined, "en", false, null, ctx.userId);
	return { accepted: true, narratorId };
}

export async function interruptExternalNarrator(
	ctx: ExternalOAuthContext,
	narratorId: string,
): Promise<{ success: true }> {
	assertExternalScope(ctx, "narrator:interrupt");
	await requireOwnedExternalNarrator(ctx, narratorId);
	interruptNarrator(narratorId);
	return { success: true };
}
