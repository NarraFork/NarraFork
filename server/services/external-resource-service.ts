import { createHash } from "node:crypto";
import { normalizeLocale } from "@shared/i18n-locales";
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
import { parseSubstatus } from "../lib/narrator-utils";
import { redactDiagnosticText } from "../lib/net/diagnostic-redaction";
import {
	OAUTH_NARRATOR_MAX_DEVICES,
	type OAuthExternalPermissionMode,
	type OAuthNarratorProvisionSnapshot,
} from "../lib/oauth-client-policy";
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
	type ExternalOAuthContext,
	externalProjectIdsForCapability,
	requireExternalOperation,
	requireOwnedExternalDevice,
	requireOwnedExternalNarrator,
} from "./oauth-resource-access";

export const EXTERNAL_MESSAGE_MAX_PAGE_LIMIT = 50;
export const EXTERNAL_MESSAGE_TEXT_MAX_BYTES = 64 * 1024;
/** Upper bound on substatus tags exposed to external clients. */
export const EXTERNAL_SUBSTATUS_MAX_TAGS = 20;
/** Upper bound on the redacted failure message exposed to external clients. */
export const EXTERNAL_ERROR_MESSAGE_MAX_CHARS = 1_000;

const PROVISION_KEY_PATTERN = /^[A-Za-z0-9._~-]+$/;
const PROVISION_KEY_MAX_CHARS = 80;
const provisionLock = new AsyncMutex();
const textEncoder = new TextEncoder();

type ExternalPermissionMode = OAuthExternalPermissionMode;
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
	projectId: string | null;
	lastMessageAt: string | null;
	createdAt: string;
	updatedAt: string;
	/**
	 * Substatus tags for the current turn (reasoning / compacting / error / interrupted / unread).
	 *
	 * Without these an external client cannot tell "the model is thinking", "a tool is running"
	 * and "the turn already failed" apart — all three look like `status: "working"` or a plain
	 * return to `"idle"`.
	 */
	substatus: string[];
	/**
	 * Last failure surfaced to the owner; null when the previous turn ended cleanly.
	 *
	 * Redacted and length-bounded. An upstream 429 / timeout / context overflow previously left
	 * no trace at all in this facade: the narrator simply went back to `idle` with no new
	 * assistant message, so clients rendered "done" for a turn that had actually failed.
	 */
	errorMessage: string | null;
	/**
	 * Whether the last failure is worth retrying; null when unknown.
	 *
	 * Lets a client distinguish a transient upstream 429 (offer "retry") from a permanent
	 * context-length failure (offer "start a new case") instead of showing one generic error.
	 */
	errorRetryable: boolean | null;
}

export interface ExternalNarratorProvisionResult {
	narrator: ExternalNarratorDto;
	created: boolean;
}

/**
 * Bounded per-message usage. Present only on assistant messages that recorded it.
 *
 * Without this an external client cannot tell the user how much context is left or how long a turn
 * actually took; every number here is already stored on the message row.
 */
export interface ExternalNarratorMessageUsageDto {
	inputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	/** Share of the model context used after this turn, 0-100. */
	contextPercent?: number;
	durationMs?: number;
	ttftMs?: number;
}

export interface ExternalNarratorMessageDto {
	id: string;
	seq: number;
	role: "user" | "assistant";
	text: string;
	textTruncated: boolean;
	createdAt: string;
	usage?: ExternalNarratorMessageUsageDto;
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
	projectId: string | null | undefined,
	scope: "global" | "project",
): ProvisionIdentity {
	return hashProvisionIdentity({
		version: 1,
		resourceType: "device",
		projectId: projectId ?? null,
		scope,
	});
}

/**
 * Every parameter that shapes the frozen runtime ceiling participates in the identity, so
 * reusing a provision key with different terms surfaces as a 409 conflict instead of
 * silently returning a narrator provisioned under the old terms. dangerReflectionPrompt is
 * included for the same reason permissionMode and systemPrompt are.
 *
 * Kept at version 2 with an explicit null for absent prompts: an identity that omitted the
 * field before hashes the same as one that now sends null, so narrators provisioned prior
 * to this field stay addressable by their original provision key.
 */
function narratorProvisionIdentity(input: {
	projectId: string | null | undefined;
	defaultDeviceId: string;
	deviceIds: readonly string[];
	permissionMode: ExternalPermissionMode;
	systemPrompt: string | undefined;
	dangerReflectionPrompt: string | undefined;
}): ProvisionIdentity {
	const base = {
		version: 2,
		resourceType: "narrator",
		projectId: input.projectId ?? null,
		defaultDeviceId: input.defaultDeviceId,
		deviceIds: [...input.deviceIds].sort(),
		permissionMode: input.permissionMode,
		systemPrompt: input.systemPrompt ?? null,
	};
	if (input.dangerReflectionPrompt === undefined) return hashProvisionIdentity(base);
	return hashProvisionIdentity({
		...base,
		dangerReflectionPrompt: input.dangerReflectionPrompt,
	});
}

function normalizeNarratorDeviceIds(input: ExternalNarratorProvisionInput): string[] {
	const deviceIds = [...new Set(input.deviceIds)].sort();
	if (deviceIds.length === 0 || deviceIds.length > OAUTH_NARRATOR_MAX_DEVICES) {
		throw new ValidationError(
			`deviceIds must contain between 1 and ${OAUTH_NARRATOR_MAX_DEVICES} devices`,
		);
	}
	if (!deviceIds.includes(input.deviceId)) {
		throw new ValidationError("deviceIds must include deviceId");
	}
	return deviceIds;
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

/** Collect the recorded usage scalars; returns undefined when the row has none. */
function externalMessageUsage(row: {
	tokensIn: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	contextPercent: number | null;
	durationMs: number | null;
	ttftMs: number | null;
}): ExternalNarratorMessageUsageDto | undefined {
	const usage: ExternalNarratorMessageUsageDto = {};
	if (typeof row.tokensIn === "number") usage.inputTokens = row.tokensIn;
	if (typeof row.outputTokens === "number") usage.outputTokens = row.outputTokens;
	if (typeof row.reasoningTokens === "number") usage.reasoningTokens = row.reasoningTokens;
	if (typeof row.contextPercent === "number") {
		usage.contextPercent = Math.max(0, Math.min(100, row.contextPercent));
	}
	if (typeof row.durationMs === "number") usage.durationMs = row.durationMs;
	if (typeof row.ttftMs === "number") usage.ttftMs = row.ttftMs;
	return Object.keys(usage).length > 0 ? usage : undefined;
}

function toExternalNarratorDto(row: typeof narrators.$inferSelect): ExternalNarratorDto {
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
		// Substatus tags are already a bounded string array on the row; cap the count so a
		// corrupted column can never blow up a response.
		substatus: parseSubstatus(row.substatus).slice(0, EXTERNAL_SUBSTATUS_MAX_TAGS),
		// errorMessage may embed provider payloads, so it goes through the same redaction the
		// internal diagnostics path uses before leaving the server.
		errorMessage: row.errorMessage
			? redactDiagnosticText(row.errorMessage).slice(0, EXTERNAL_ERROR_MESSAGE_MAX_CHARS)
			: null,
		// Only meaningful alongside a failure; a stale flag without a message would be misleading.
		errorRetryable: row.errorMessage ? (row.errorRetryable ?? null) : null,
	};
}

function freezePolicySnapshot(
	ctx: ExternalOAuthContext,
	permissionMode: ExternalPermissionMode,
	systemPrompt: string | undefined,
	dangerReflectionPrompt: string | undefined,
	projectId: string | null | undefined,
	defaultDeviceId: string,
	deviceIds: readonly string[],
): OAuthNarratorProvisionSnapshot {
	// Copied field by field on purpose: the snapshot is a frozen ceiling, so a new policy
	// dimension must be added here explicitly rather than inherited by spreading.
	const policy = {
		defaultPermissionMode: ctx.policy.defaultPermissionMode,
		allowedPermissionModes: [...ctx.policy.allowedPermissionModes],
		systemPromptMode: ctx.policy.systemPromptMode,
		maxSystemPromptChars: ctx.policy.maxSystemPromptChars,
		allowGlobalDevice: ctx.policy.allowGlobalDevice,
		allowKnowledgeWrite: ctx.policy.allowKnowledgeWrite,
		allowDangerReflectionPrompt: ctx.policy.allowDangerReflectionPrompt,
		maxDangerReflectionPromptChars: ctx.policy.maxDangerReflectionPromptChars,
		allowRobotDiagnosticPreset: ctx.policy.allowRobotDiagnosticPreset,
		deviceAccess: { ...ctx.policy.deviceAccess },
	};
	// version 2 remains for project-anchored narrators (backward compatible);
	// de-projectized narrators use version 3 with no project binding. Grant
	// ownership (integration_resource_bindings) is the sole isolation boundary.
	if (projectId) {
		return {
			version: 2,
			policy,
			permissionMode,
			systemPrompt: systemPrompt ?? null,
			dangerReflectionPrompt: dangerReflectionPrompt ?? null,
			projectId,
			defaultDeviceId,
			deviceIds: [...deviceIds].sort(),
		};
	}
	return {
		version: 3,
		policy,
		permissionMode,
		systemPrompt: systemPrompt ?? null,
		dangerReflectionPrompt: dangerReflectionPrompt ?? null,
		projectId: null,
		defaultDeviceId,
		deviceIds: [...deviceIds].sort(),
	};
}

/**
 * External clients may request any mode the administrator put in allowedPermissionModes.
 * bypassPermissions is included since v1.1: headless clients cannot answer an interactive
 * prompt, so the widened mode routes risky calls into the danger reflection loop instead
 * of denying them. It never bypasses catastrophic-command refusal or deviceAccess.
 */
function resolvePermissionMode(
	ctx: ExternalOAuthContext,
	requested: ExternalNarratorProvisionInput["permissionMode"],
): ExternalPermissionMode {
	const permissionMode = requested ?? ctx.policy.defaultPermissionMode;
	if (!ctx.policy.allowedPermissionModes.includes(permissionMode)) {
		throw externalPolicyForbidden("The requested narrator permission mode is not allowed");
	}
	return permissionMode;
}

/**
 * Resolve the client-supplied danger reflection appendix against the live policy.
 * Mirrors resolveSystemPrompt: a client that sends the field without the capability is
 * rejected outright rather than silently ignored, so misconfiguration is visible.
 */
function resolveDangerReflectionPrompt(
	ctx: ExternalOAuthContext,
	requested: string | undefined,
): string | undefined {
	if (!ctx.policy.allowDangerReflectionPrompt) {
		if (requested !== undefined) {
			throw externalPolicyForbidden("This OAuth client may not supply a danger reflection prompt");
		}
		return undefined;
	}
	if (requested === undefined || requested.length === 0) return undefined;
	if (requested.length > ctx.policy.maxDangerReflectionPromptChars) {
		throw new ValidationError(
			`dangerReflectionPrompt must not exceed ${ctx.policy.maxDangerReflectionPromptChars} characters`,
		);
	}
	return requested;
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
	projectId: string | null,
) {
	return {
		eventType,
		grantId: ctx.grantId,
		oauthClientId: ctx.oauthClientId,
		userId: ctx.userId,
		actorType: "client" as const,
		projectIds: projectId ? [projectId] : [],
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
	projectId: string | null,
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
	projectId: string | null,
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
	const limit = normalizeLimit(input, EXTERNAL_V1_MAX_LIMIT);
	const cursor = decodeResourceCursor(input?.cursor, "device");
	// Grant ownership (verified via the active resource binding EXISTS subquery
	// below) is the sole isolation boundary for OAuth-owned devices; the device
	// scope column is no longer a visibility gate after de-projectization.
	const rows = await db
		.select()
		.from(remoteDevices)
		.where(
			and(
				isNull(remoteDevices.revokedAt),
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
	// A project-scoped device requires a project anchor; without a projectId the
	// device is purely global with no anchor. Grant ownership (the resource
	// binding) is the sole isolation boundary for OAuth-owned devices, so no
	// allowGlobalDevice gate applies to a device the grant provisions for itself.
	const scope = input.scope ?? (input.projectId ? "project" : "global");
	const identity = deviceProvisionIdentity(input.projectId ?? null, scope);

	return provisionLock.acquire(`device:${ctx.grantId}:${provisionKey}`, async () => {
		const existing = await findDeviceByProvisionKey(ctx, provisionKey, identity);
		if (existing) {
			await requireOwnedExternalDevice(ctx, existing.id);
			ensureResourceProvisionedEvent(
				ctx,
				"device",
				existing.id,
				existing.projectId ?? input.projectId ?? null,
			);
			return { device: toExternalDeviceDto(existing), created: false, credential: null };
		}

		const prepared = await prepareDeviceCreation({
			name: input.name ?? `External device ${provisionKey}`,
			description: input.description,
			connectionMode: "reverse",
			scope,
			// Project-anchored devices keep their project; de-projectized devices
			// (no projectId) are purely global with no anchor. Grant ownership is
			// the sole isolation boundary.
			projectId: input.projectId ?? null,
			createdBy: ctx.userId,
			preserveGlobalProjectContext: scope === "global" && !!input.projectId,
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
					result.device.projectId ?? input.projectId ?? null,
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
			ensureResourceProvisionedEvent(
				ctx,
				"device",
				winner.id,
				winner.projectId ?? input.projectId ?? null,
			);
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
	// Grant ownership (verified by getOwnedDeviceRow) is the boundary; the initial
	// capability check above is integration-scoped, so no project re-assertion here.
	const device = await getOwnedDeviceRow(ctx, id);
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
	// Grant ownership is the boundary; the integration-scoped check above suffices.
	const existing = await getOwnedDeviceRow(ctx, id);
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
				existing.projectId ?? null,
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
	const deviceIds = normalizeNarratorDeviceIds(input);
	// requireOwnedExternalDevice already asserts the active grant-owned resource
	// binding (the sole isolation boundary after de-projectization), so a separate
	// assertExternalDeviceBinding call here would re-query the same binding.
	const devices = await Promise.all(
		deviceIds.map((deviceId) => requireOwnedExternalDevice(ctx, deviceId)),
	);
	const defaultDevice = devices.find((device) => device.id === input.deviceId);
	if (!defaultDevice) throw new ValidationError("deviceIds must include deviceId");
	const permissionMode = resolvePermissionMode(ctx, input.permissionMode);
	const systemPrompt = resolveSystemPrompt(ctx, input.systemPrompt);
	const dangerReflectionPrompt = resolveDangerReflectionPrompt(ctx, input.dangerReflectionPrompt);
	const identity = narratorProvisionIdentity({
		projectId: input.projectId ?? null,
		defaultDeviceId: defaultDevice.id,
		deviceIds,
		permissionMode,
		systemPrompt,
		dangerReflectionPrompt,
	});

	return provisionLock.acquire(`narrator:${ctx.grantId}:${provisionKey}`, async () => {
		const existing = await findNarratorByProvisionKey(ctx, provisionKey, identity);
		if (existing) {
			await requireOwnedExternalNarrator(ctx, existing.id);
			ensureResourceProvisionedEvent(
				ctx,
				"narrator",
				existing.id,
				existing.contextProjectId ?? input.projectId ?? null,
			);
			return { narrator: toExternalNarratorDto(existing), created: false };
		}

		try {
			const prepared = await prepareNarratorCreation({
				chapterId: null,
				title: input.title ?? `External narrator ${provisionKey}`,
				permissionMode,
				systemPrompt,
				contextProjectId: input.projectId ?? null,
				oauthPolicySnapshotJson: freezePolicySnapshot(
					ctx,
					permissionMode,
					systemPrompt,
					dangerReflectionPrompt,
					input.projectId ?? null,
					defaultDevice.id,
					deviceIds,
				),
				defaultDeviceId: defaultDevice.id,
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
					narrator.contextProjectId ?? input.projectId ?? null,
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
				winner.contextProjectId ?? input.projectId ?? null,
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
	// Grant ownership (via getExternalNarratorRow) is the boundary; the integration-scoped check above suffices.
	const narrator = await getExternalNarratorRow(ctx, id);
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
	// Grant ownership is the boundary; the integration-scoped check above suffices.
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
			// Bounded scalars only; still no contentJson, so tool payloads stay server-side.
			tokensIn: narratorMessages.tokensIn,
			outputTokens: narratorMessages.outputTokens,
			reasoningTokens: narratorMessages.reasoningTokens,
			contextPercent: narratorMessages.contextPercent,
			durationMs: narratorMessages.durationMs,
			ttftMs: narratorMessages.ttftMs,
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
			const usage = externalMessageUsage(row);
			return {
				id: row.id,
				seq: row.seq,
				role: row.role as "user" | "assistant",
				text: text.text,
				textTruncated: text.truncated,
				createdAt: row.createdAt,
				// Omit the key entirely when nothing was recorded, so the shape stays stable for
				// user messages and older rows.
				...(usage ? { usage } : {}),
			};
		}),
		nextCursor: hasMore ? encodeMessageCursor(pageRows.at(-1)?.seq ?? 0) : null,
	};
}

export async function sendExternalNarratorMessage(
	ctx: ExternalOAuthContext,
	narratorId: string,
	input: ExternalSendMessageInput,
	/** Raw `Accept-Language` value, used only when the body omits `locale`. */
	requestLocale?: string | null,
): Promise<{ accepted: true; narratorId: string }> {
	await requireExternalOperation(ctx, {
		operation: "narrator.send_message",
		capability: "narrator.send_message",
		resource: { type: "narrator", id: narratorId },
	});
	await requireOwnedExternalNarrator(ctx, narratorId);
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		// This service-level allowlist is deliberately independent of the route schema so a
		// direct caller cannot smuggle extra fields into sendMessage.
		Object.keys(input).some((key) => key !== "message" && key !== "locale") ||
		typeof input.message !== "string" ||
		input.message.length === 0 ||
		input.message.length > EXTERNAL_V1_MAX_MESSAGE_CHARS ||
		textEncoder.encode(input.message).byteLength > EXTERNAL_V1_MAX_MESSAGE_BYTES
	) {
		throw new ValidationError("External narrator messages must contain only bounded plain text");
	}
	// Grant ownership is the boundary; keep the integration-scoped operation to
	// enforce request-byte limits without re-asserting a project membership.
	await requireExternalOperation(ctx, {
		operation: "narrator.send_message",
		capability: "narrator.send_message",
		resource: { type: "narrator", id: narratorId },
		requestBytes: textEncoder.encode(input.message).byteLength,
	});
	await assertOAuthNarratorRuntimeActive(narratorId, ctx.userId);
	// Sent by a third-party integration on the grant user's behalf: keep the user
	// for attribution, but label the channel so it is not shown as a direct message.
	//
	// The locale is not cosmetic: it selects the language of the tool/system prompts injected
	// into the narrator context (server/lib/i18n.ts). Hardcoding "en" meant a Chinese diagnosis
	// session got English instructions mixed into its context on every turn.
	// Body wins over the request header; both fall back to the server default.
	await sendMessage(
		narratorId,
		input.message,
		undefined,
		normalizeLocale(input.locale ?? requestLocale ?? null),
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
): Promise<{ success: true; interrupted: boolean }> {
	await requireExternalOperation(ctx, {
		operation: "narrator.interrupt",
		capability: "narrator.interrupt",
		resource: { type: "narrator", id: narratorId },
	});
	// Grant ownership is the boundary; the integration-scoped check above suffices.
	await requireOwnedExternalNarrator(ctx, narratorId);
	// `success` keeps its original meaning (the request was accepted) so existing clients do not
	// break; `interrupted` reports whether a running turn was actually aborted. Dropping this
	// boolean previously made "stopped" indistinguishable from "nothing was running", which let
	// clients claim a stop that never happened.
	const interrupted = interruptNarrator(narratorId);
	return { success: true, interrupted };
}
