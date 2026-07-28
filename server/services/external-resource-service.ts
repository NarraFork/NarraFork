import { createHash } from "node:crypto";
import { formatOriginLabel } from "@shared/message-origin";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
	integrationResourceBindings,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	oauthGrantEvents,
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
import {
	createPreparedDeviceInTransaction,
	prepareDeviceCreation,
	publishDeviceCreated,
	publishDeviceTokenRotated,
	type RemoteDeviceView,
	rotateDeviceTokenInTransaction,
} from "./device-service";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import {
	type IntegrationProjectSummary,
	listIntegrationProjects,
	toIntegrationDeviceSummary,
} from "./integration-resource-service";
import {
	createPreparedNarratorInTransaction,
	prepareNarratorCreation,
	publishNarratorCreated,
} from "./narrator-service";
import { interruptNarrator, sendMessage } from "./narrator-session";
import { recordOAuthGrantEventInTransaction } from "./oauth-grant-service";
import { assertOAuthNarratorRuntimeActive } from "./oauth-narrator-runtime-policy";
import {
	assertExternalDeviceBinding,
	type ExternalOAuthContext,
	externalProjectIdsForCapability,
	requireExternalOperation,
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

const PROVISION_IDENTITY_VERSION = 1;
const PROVISION_IDENTITY_ALGORITHM = "sha256";

interface ProvisionIdentity {
	version: typeof PROVISION_IDENTITY_VERSION;
	algorithm: typeof PROVISION_IDENTITY_ALGORITHM;
	digest: string;
}

interface ProvisionBindingMetadata extends Record<string, unknown> {
	provisionIdentity: ProvisionIdentity;
}

type ExternalResourceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ExternalResourceTransactionHooks {
	beforeDeviceCreateAttempt?: () => void | Promise<void>;
	beforeDeviceTransactionCommit?: () => void;
	beforeDeviceRotateTransactionCommit?: () => void;
	beforeNarratorTransactionCommit?: (tx: ExternalResourceTransaction, narratorId: string) => void;
}

type ExternalResourceEventExecutor = Pick<typeof db, "insert" | "select">;

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
		`The ${resourceType} provision key conflicts with its original provisioning request`,
		409,
		"RESOURCE_PROVISION_CONFLICT",
	);
}

function hashProvisionIdentity(value: Record<string, unknown>): ProvisionIdentity {
	return {
		version: PROVISION_IDENTITY_VERSION,
		algorithm: PROVISION_IDENTITY_ALGORITHM,
		digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
	};
}

function deviceProvisionIdentity(
	projectId: string,
	scope: "global" | "project",
): ProvisionIdentity {
	return hashProvisionIdentity({ version: 1, resourceType: "device", projectId, scope });
}

function narratorProvisionIdentity(input: {
	projectId: string;
	deviceId: string;
	permissionMode: ExternalPermissionMode;
	systemPrompt: string | undefined;
}): ProvisionIdentity {
	return hashProvisionIdentity({
		version: 1,
		resourceType: "narrator",
		projectId: input.projectId,
		deviceId: input.deviceId,
		permissionMode: input.permissionMode,
		systemPrompt: input.systemPrompt ?? null,
	});
}

function provisionBindingMetadata(identity: ProvisionIdentity): ProvisionBindingMetadata {
	return { provisionIdentity: identity };
}

function assertProvisionIdentity(
	resourceType: ResourceType,
	metadata: Record<string, unknown> | null,
	expected: ProvisionIdentity,
): void {
	const candidate = metadata?.provisionIdentity;
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
		throw resourceProvisionConflict(resourceType);
	}
	const identity = candidate as Record<string, unknown>;
	if (
		identity.version !== PROVISION_IDENTITY_VERSION ||
		identity.algorithm !== PROVISION_IDENTITY_ALGORITHM ||
		identity.digest !== expected.digest
	) {
		throw resourceProvisionConflict(resourceType);
	}
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

type ExternalResourceCursorKind = "project" | "device";

interface ExternalResourceCursor {
	kind: ExternalResourceCursorKind;
	primary: string;
	id: string;
}

function encodeResourceCursor(cursor: ExternalResourceCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeResourceCursor(
	value: string | undefined,
	kind: ExternalResourceCursorKind,
): ExternalResourceCursor | null {
	if (!value) return null;
	if (Buffer.byteLength(value, "utf8") > EXTERNAL_V1_MAX_CURSOR_BYTES) {
		throw new ValidationError("External list cursor is invalid");
	}
	try {
		const parsed = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		) as Partial<ExternalResourceCursor>;
		if (
			parsed.kind !== kind ||
			typeof parsed.primary !== "string" ||
			typeof parsed.id !== "string" ||
			!parsed.id
		) {
			throw new Error("invalid cursor shape");
		}
		return { kind, primary: parsed.primary, id: parsed.id };
	} catch {
		throw new ValidationError("External list cursor is invalid");
	}
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

function toExternalProjectDto(row: IntegrationProjectSummary): ExternalProjectDto {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		status: row.status,
	};
}

function toExternalDeviceDto(row: typeof remoteDevices.$inferSelect): ExternalDeviceDto {
	return toIntegrationDeviceSummary(row);
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
		where: and(eq(remoteDevices.id, id), isNull(remoteDevices.revokedAt)),
	});
	if (!row) throw new NotFoundError("Remote device", id);
	return row;
}

async function findProvisionBinding(
	ctx: ExternalOAuthContext,
	resourceType: ResourceType,
	provisionKey: string,
) {
	const binding = await integrationResourceBindingService.getByProvisionKey({
		authorityType: "oauth_grant",
		authorityId: ctx.grantId,
		resourceType,
		provisionKey,
	});
	if (!binding) return null;
	if (
		binding.state !== "active" ||
		binding.sourceType !== "oauth_client" ||
		binding.sourceId !== ctx.oauthClientId
	) {
		throw resourceProvisionConflict(resourceType);
	}
	return binding;
}

async function findDeviceByProvisionKey(
	ctx: ExternalOAuthContext,
	provisionKey: string,
	identity: ProvisionIdentity,
) {
	const binding = await findProvisionBinding(ctx, "device", provisionKey);
	if (!binding) return null;
	assertProvisionIdentity("device", binding.metadataJson, identity);
	const device = await db.query.remoteDevices.findFirst({
		where: eq(remoteDevices.id, binding.resourceId),
	});
	if (!device || device.revokedAt) throw resourceProvisionConflict("device");
	return device;
}

async function getExternalNarratorRow(ctx: ExternalOAuthContext, id: string) {
	await requireOwnedExternalNarrator(ctx, id);
	const row = await db.query.narrators.findFirst({ where: eq(narrators.id, id) });
	if (!row) throw new NotFoundError("Narrator", id);
	return row;
}

async function findNarratorByProvisionKey(
	ctx: ExternalOAuthContext,
	provisionKey: string,
	identity: ProvisionIdentity,
) {
	const binding = await findProvisionBinding(ctx, "narrator", provisionKey);
	if (!binding) return null;
	assertProvisionIdentity("narrator", binding.metadataJson, identity);
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, binding.resourceId),
	});
	if (!narrator) throw resourceProvisionConflict("narrator");
	return narrator;
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

function resourceProvisionEventRequestId(resourceType: ResourceType, resourceId: string): string {
	return `resource-provisioned:${resourceType}:${resourceId}`;
}

function resourceEventInput(
	ctx: ExternalOAuthContext,
	eventType: "resource_provisioned" | "device_credential_rotated",
	resourceType: ResourceType,
	resourceId: string,
	projectId: string,
) {
	return {
		eventType,
		grantId: ctx.grantId,
		oauthClientId: ctx.oauthClientId,
		userId: ctx.userId,
		actorType: "client" as const,
		projectIds: [projectId],
		metadata: { resourceId, resourceType },
		requestId:
			eventType === "resource_provisioned"
				? resourceProvisionEventRequestId(resourceType, resourceId)
				: null,
	};
}

function ensureResourceProvisionedEventInTransaction(
	executor: ExternalResourceEventExecutor,
	ctx: ExternalOAuthContext,
	resourceType: ResourceType,
	resourceId: string,
	projectId: string,
	createdAt = new Date().toISOString(),
): boolean {
	const requestId = resourceProvisionEventRequestId(resourceType, resourceId);
	const existing = executor
		.select({ id: oauthGrantEvents.id })
		.from(oauthGrantEvents)
		.where(
			and(
				eq(oauthGrantEvents.grantId, ctx.grantId),
				eq(oauthGrantEvents.oauthClientId, ctx.oauthClientId),
				eq(oauthGrantEvents.eventType, "resource_provisioned"),
				or(
					eq(oauthGrantEvents.requestId, requestId),
					and(
						sql`json_extract(${oauthGrantEvents.metadata}, '$.resourceType') = ${resourceType}`,
						sql`json_extract(${oauthGrantEvents.metadata}, '$.resourceId') = ${resourceId}`,
					),
				),
			),
		)
		.limit(1)
		.get();
	if (existing) return false;
	recordOAuthGrantEventInTransaction(
		executor,
		resourceEventInput(ctx, "resource_provisioned", resourceType, resourceId, projectId),
		createdAt,
	);
	return true;
}

function ensureResourceProvisionedEvent(
	ctx: ExternalOAuthContext,
	resourceType: ResourceType,
	resourceId: string,
	projectId: string,
): void {
	db.transaction((tx) =>
		ensureResourceProvisionedEventInTransaction(tx, ctx, resourceType, resourceId, projectId),
	);
}

export async function listExternalProjects(
	ctx: ExternalOAuthContext,
	input?: ExternalListQuery,
): Promise<ExternalPage<ExternalProjectDto>> {
	await requireExternalOperation(ctx, {
		operation: "project.list",
		capability: "project.read",
		resource: { type: "project", id: `collection:${ctx.grantId}` },
	});
	const projectIds = externalProjectIdsForCapability(ctx, "project.read");
	if (projectIds.length === 0) return { items: [], nextCursor: null };
	const limit = normalizeLimit(input, EXTERNAL_V1_MAX_LIMIT);
	const cursor = decodeResourceCursor(input?.cursor, "project");
	const rows = await listIntegrationProjects({
		limit: limit + 1,
		order: "name_asc",
		after: cursor ? { primary: cursor.primary, id: cursor.id } : undefined,
		allowedProjectIds: [...projectIds],
	});
	const hasMore = rows.length > limit;
	const pageRows = hasMore ? rows.slice(0, limit) : rows;
	const last = pageRows.at(-1);
	return {
		items: pageRows.map(toExternalProjectDto),
		nextCursor:
			hasMore && last
				? encodeResourceCursor({ kind: "project", primary: last.name, id: last.id })
				: null,
	};
}

export async function listExternalDevices(
	ctx: ExternalOAuthContext,
	input?: ExternalListQuery,
): Promise<ExternalPage<ExternalDeviceDto>> {
	await requireExternalOperation(ctx, {
		operation: "device.list",
		capability: "device.read",
		resource: { type: "device", id: `collection:${ctx.grantId}` },
	});
	const projectIds = externalProjectIdsForCapability(ctx, "device.read");
	if (projectIds.length === 0) return { items: [], nextCursor: null };
	const limit = normalizeLimit(input, EXTERNAL_V1_MAX_LIMIT);
	const cursor = decodeResourceCursor(input?.cursor, "device");
	const projectVisibility = and(
		eq(remoteDevices.scope, "project"),
		inArray(remoteDevices.projectId, [...projectIds]),
	);
	const anchoredGlobalVisibility = and(
		eq(remoteDevices.scope, "global"),
		inArray(remoteDevices.projectId, [...projectIds]),
	);
	const visibility = ctx.policy.allowGlobalDevice
		? or(projectVisibility, anchoredGlobalVisibility)
		: projectVisibility;
	const rows = await db
		.select()
		.from(remoteDevices)
		.where(
			and(
				isNull(remoteDevices.revokedAt),
				visibility,
				cursor
					? or(
							gt(remoteDevices.createdAt, cursor.primary),
							and(eq(remoteDevices.createdAt, cursor.primary), gt(remoteDevices.id, cursor.id)),
						)
					: undefined,
				sql`exists (
					select 1 from ${integrationResourceBindings}
					where ${integrationResourceBindings.resourceType} = 'device'
						and ${integrationResourceBindings.resourceId} = ${remoteDevices.id}
						and ${integrationResourceBindings.sourceType} = 'oauth_client'
						and ${integrationResourceBindings.sourceId} = ${ctx.oauthClientId}
						and ${integrationResourceBindings.authorityType} = 'oauth_grant'
						and ${integrationResourceBindings.authorityId} = ${ctx.grantId}
						and ${integrationResourceBindings.state} = 'active'
				)`,
			),
		)
		.orderBy(asc(remoteDevices.createdAt), asc(remoteDevices.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const pageRows = hasMore ? rows.slice(0, limit) : rows;
	const last = pageRows.at(-1);
	return {
		items: pageRows.map(toExternalDeviceDto),
		nextCursor:
			hasMore && last
				? encodeResourceCursor({ kind: "device", primary: last.createdAt, id: last.id })
				: null,
	};
}

export async function provisionExternalDevice(
	ctx: ExternalOAuthContext,
	provisionKeyInput: string,
	input: ExternalDeviceProvisionInput,
	hooks: ExternalResourceTransactionHooks = {},
): Promise<ExternalDeviceProvisionResult> {
	const provisionKey = validateProvisionKey(provisionKeyInput);
	await requireExternalOperation(ctx, {
		operation: "device.provision",
		capability: "device.provision",
		resource: { type: "device", id: `provision:${provisionKey}` },
		projectId: input.projectId,
	});
	const scope = input.scope ?? "project";
	if (scope === "global" && !ctx.policy.allowGlobalDevice) {
		throw externalPolicyForbidden("This OAuth client may not provision global devices");
	}
	const identity = deviceProvisionIdentity(input.projectId, scope);

	return provisionLock.acquire(`device:${ctx.grantId}:${provisionKey}`, async () => {
		const existing = await findDeviceByProvisionKey(ctx, provisionKey, identity);
		if (existing) {
			await requireOwnedExternalDevice(ctx, existing.id);
			ensureResourceProvisionedEvent(
				ctx,
				"device",
				existing.id,
				existing.projectId ?? input.projectId,
			);
			return { device: toExternalDeviceDto(existing), created: false, credential: null };
		}

		const prepared = await prepareDeviceCreation({
			name: input.name ?? `External device ${provisionKey}`,
			description: input.description,
			connectionMode: "reverse",
			scope,
			// Global external devices still retain a project anchor so allow-list
			// removal immediately hides them from the owning grant.
			projectId: input.projectId,
			createdBy: ctx.userId,
			preserveGlobalProjectContext: scope === "global",
		});
		await hooks.beforeDeviceCreateAttempt?.();

		try {
			const committed = db.transaction((tx) => {
				const result = createPreparedDeviceInTransaction(tx, prepared);
				const binding = integrationResourceBindingService.createInTransaction(
					tx,
					{
						resourceType: "device",
						resourceId: result.device.id,
						sourceType: "oauth_client",
						sourceId: ctx.oauthClientId,
						authorityType: "oauth_grant",
						authorityId: ctx.grantId,
						state: "active",
						provisionKey,
						metadataJson: provisionBindingMetadata(identity),
					},
					result.device.createdAt,
				);
				ensureResourceProvisionedEventInTransaction(
					tx,
					ctx,
					"device",
					result.device.id,
					input.projectId,
					result.device.createdAt,
				);
				hooks.beforeDeviceTransactionCommit?.();
				return { result, binding };
			});
			publishDeviceCreated(committed.result.device);
			await integrationResourceBindingService.recordTransitionAudit(
				"resource_binding.create",
				committed.binding.transition,
			);
			return {
				device: externalDeviceDtoFromView(committed.result.device),
				created: true,
				credential: { token: committed.result.token },
			};
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			const winner = await findDeviceByProvisionKey(ctx, provisionKey, identity);
			if (!winner) throw resourceProvisionConflict("device");
			await requireOwnedExternalDevice(ctx, winner.id);
			ensureResourceProvisionedEvent(ctx, "device", winner.id, winner.projectId ?? input.projectId);
			return { device: toExternalDeviceDto(winner), created: false, credential: null };
		}
	});
}

export async function getExternalDevice(
	ctx: ExternalOAuthContext,
	id: string,
): Promise<ExternalDeviceDto> {
	await requireExternalOperation(ctx, {
		operation: "device.get",
		capability: "device.read",
		resource: { type: "device", id },
	});
	const device = await getOwnedDeviceRow(ctx, id);
	if (!device.projectId) throw new NotFoundError("Remote device", id);
	await requireExternalOperation(ctx, {
		operation: "device.get",
		capability: "device.read",
		resource: { type: "device", id },
		projectId: device.projectId,
	});
	return toExternalDeviceDto(device);
}

export async function rotateExternalDeviceCredential(
	ctx: ExternalOAuthContext,
	id: string,
	hooks: ExternalResourceTransactionHooks = {},
): Promise<ExternalDeviceCredentialResult> {
	await requireExternalOperation(ctx, {
		operation: "device.rotate",
		capability: "device.rotate",
		resource: { type: "device", id },
	});
	const existing = await getOwnedDeviceRow(ctx, id);
	if (!existing.projectId) throw new NotFoundError("Remote device", id);
	await requireExternalOperation(ctx, {
		operation: "device.rotate",
		capability: "device.rotate",
		resource: { type: "device", id },
		projectId: existing.projectId,
	});
	const now = new Date().toISOString();
	const rotated = db.transaction((tx) => {
		const result = rotateDeviceTokenInTransaction(tx, existing.id, now);
		if (!result) return null;
		recordOAuthGrantEventInTransaction(
			tx,
			resourceEventInput(
				ctx,
				"device_credential_rotated",
				"device",
				id,
				existing.projectId as string,
			),
			now,
		);
		hooks.beforeDeviceRotateTransactionCommit?.();
		return result;
	});
	if (!rotated) throw new NotFoundError("Remote device", id);
	publishDeviceTokenRotated(id);
	return { credential: { token: rotated.token } };
}

export async function provisionExternalNarrator(
	ctx: ExternalOAuthContext,
	provisionKeyInput: string,
	input: ExternalNarratorProvisionInput,
	hooks: ExternalResourceTransactionHooks = {},
): Promise<ExternalNarratorProvisionResult> {
	const provisionKey = validateProvisionKey(provisionKeyInput);
	await requireExternalOperation(ctx, {
		operation: "narrator.provision",
		capability: "narrator.provision",
		resource: { type: "narrator", id: `provision:${provisionKey}` },
		projectId: input.projectId,
	});
	const device = await requireOwnedExternalDevice(ctx, input.deviceId);
	await assertExternalDeviceBinding(ctx, device, input.projectId);
	const permissionMode = resolvePermissionMode(ctx, input.permissionMode);
	const systemPrompt = resolveSystemPrompt(ctx, input.systemPrompt);
	const identity = narratorProvisionIdentity({
		projectId: input.projectId,
		deviceId: device.id,
		permissionMode,
		systemPrompt,
	});

	return provisionLock.acquire(`narrator:${ctx.grantId}:${provisionKey}`, async () => {
		const existing = await findNarratorByProvisionKey(ctx, provisionKey, identity);
		if (existing) {
			await requireOwnedExternalNarrator(ctx, existing.id);
			ensureResourceProvisionedEvent(
				ctx,
				"narrator",
				existing.id,
				existing.contextProjectId ?? input.projectId,
			);
			return { narrator: toExternalNarratorDto(existing), created: false };
		}

		try {
			const prepared = await prepareNarratorCreation({
				chapterId: null,
				title: input.title ?? `External narrator ${provisionKey}`,
				permissionMode,
				systemPrompt,
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
			const committed = db.transaction((tx) => {
				const narrator = createPreparedNarratorInTransaction(tx, prepared);
				const binding = integrationResourceBindingService.createInTransaction(
					tx,
					{
						resourceType: "narrator",
						resourceId: narrator.id,
						sourceType: "oauth_client",
						sourceId: ctx.oauthClientId,
						authorityType: "oauth_grant",
						authorityId: ctx.grantId,
						state: "active",
						provisionKey,
						metadataJson: provisionBindingMetadata(identity),
					},
					narrator.createdAt,
				);
				ensureResourceProvisionedEventInTransaction(
					tx,
					ctx,
					"narrator",
					narrator.id,
					input.projectId,
					narrator.createdAt,
				);
				hooks.beforeNarratorTransactionCommit?.(tx, narrator.id);
				return { narrator, binding };
			});
			publishNarratorCreated(committed.narrator);
			await integrationResourceBindingService.recordTransitionAudit(
				"resource_binding.create",
				committed.binding.transition,
			);
			return { narrator: toExternalNarratorDto(committed.narrator), created: true };
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			const winner = await findNarratorByProvisionKey(ctx, provisionKey, identity);
			if (!winner) throw resourceProvisionConflict("narrator");
			await requireOwnedExternalNarrator(ctx, winner.id);
			ensureResourceProvisionedEvent(
				ctx,
				"narrator",
				winner.id,
				winner.contextProjectId ?? input.projectId,
			);
			return { narrator: toExternalNarratorDto(winner), created: false };
		}
	});
}

export async function getExternalNarrator(
	ctx: ExternalOAuthContext,
	id: string,
): Promise<ExternalNarratorDto> {
	await requireExternalOperation(ctx, {
		operation: "narrator.get",
		capability: "narrator.read",
		resource: { type: "narrator", id },
	});
	const narrator = await getExternalNarratorRow(ctx, id);
	if (!narrator.contextProjectId) throw new NotFoundError("Narrator", id);
	await requireExternalOperation(ctx, {
		operation: "narrator.get",
		capability: "narrator.read",
		resource: { type: "narrator", id },
		projectId: narrator.contextProjectId,
	});
	return toExternalNarratorDto(narrator);
}

export async function listExternalNarratorMessages(
	ctx: ExternalOAuthContext,
	narratorId: string,
	input?: ExternalListQuery,
): Promise<ExternalPage<ExternalNarratorMessageDto>> {
	await requireExternalOperation(ctx, {
		operation: "narrator.messages.list",
		capability: "narrator.read",
		resource: { type: "narrator", id: narratorId },
	});
	const narrator = await requireOwnedExternalNarrator(ctx, narratorId);
	if (!narrator.contextProjectId) throw new NotFoundError("Narrator", narratorId);
	await requireExternalOperation(ctx, {
		operation: "narrator.messages.list",
		capability: "narrator.read",
		resource: { type: "narrator", id: narratorId },
		projectId: narrator.contextProjectId,
	});
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
	await requireExternalOperation(ctx, {
		operation: "narrator.send_message",
		capability: "narrator.send_message",
		resource: { type: "narrator", id: narratorId },
	});
	const narrator = await requireOwnedExternalNarrator(ctx, narratorId);
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
	if (!narrator.contextProjectId) throw new NotFoundError("Narrator", narratorId);
	await requireExternalOperation(ctx, {
		operation: "narrator.send_message",
		capability: "narrator.send_message",
		resource: { type: "narrator", id: narratorId },
		projectId: narrator.contextProjectId,
		requestBytes: textEncoder.encode(input.message).byteLength,
	});
	await assertOAuthNarratorRuntimeActive(narratorId, ctx.userId);
	// Sent by a third-party integration on the grant user's behalf: keep the user
	// for attribution, but label the channel so it is not shown as a direct message.
	await sendMessage(
		narratorId,
		input.message,
		undefined,
		"en",
		false,
		null,
		ctx.userId,
		undefined,
		null,
		{ origin: "user", originLabel: formatOriginLabel("oauth", ctx.clientId) },
	);
	return { accepted: true, narratorId };
}

export async function interruptExternalNarrator(
	ctx: ExternalOAuthContext,
	narratorId: string,
): Promise<{ success: true }> {
	await requireExternalOperation(ctx, {
		operation: "narrator.interrupt",
		capability: "narrator.interrupt",
		resource: { type: "narrator", id: narratorId },
	});
	const narrator = await requireOwnedExternalNarrator(ctx, narratorId);
	if (!narrator.contextProjectId) throw new NotFoundError("Narrator", narratorId);
	await requireExternalOperation(ctx, {
		operation: "narrator.interrupt",
		capability: "narrator.interrupt",
		resource: { type: "narrator", id: narratorId },
		projectId: narrator.contextProjectId,
	});
	interruptNarrator(narratorId);
	return { success: true };
}
