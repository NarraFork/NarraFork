import { z } from "zod";
import { providerSettingsFieldNameSchema } from "./provider-settings";
import {
	providerSettingsRevisionSchema,
	providerSettingsValueStringSchema,
} from "./provider-settings-values";

/** Public quota DTOs. No host settings, credentials or provider implementation imports. */
export const QUOTA_PROTOCOL_VERSION = "1.0" as const;
export const QUOTA_QUERY_METHOD = "quota.query" as const;
export const PROVIDER_CONNECTION_METHOD = "provider.connection.request" as const;
export const QUOTA_MAX_SNAPSHOT_BYTES = 16 * 1024;
export const QUOTA_MAX_RESPONSE_BYTES = 256 * 1024;
export const QUOTA_MAX_QUERY_MS = 30_000;
export const QUOTA_MAX_REQUEST_MS = 20_000;
export const QUOTA_STATUSES = [
	"pending",
	"probing",
	"supported",
	"unsupported",
	"error",
	"unavailable",
] as const;
export const QUOTA_ERROR_CODES = [
	"request_failed",
	"invalid_configuration",
	"auth_failed",
	"invalid_response",
	"timeout",
	"unavailable",
	"permission_denied",
	"queue_full",
] as const;
export type ProviderQuotaStatus = (typeof QUOTA_STATUSES)[number];
export type ProviderQuotaErrorCode = (typeof QUOTA_ERROR_CODES)[number];

const text = (max = 256) =>
	z
		.string()
		.max(max)
		.refine(
			(value) =>
				![...value].some(
					(char) =>
						char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "<" || char === ">",
				),
			"plain text required",
		);
const id = text(256).min(1);
const value = z.number().finite().nullable();
const timestamp = z.string().datetime({ offset: true }).nullable();

export const providerQuotaAmountSchema = z
	.object({
		id,
		label: text().optional(),
		/** Omitted keeps legacy summary visibility; detail amounts stay in the expanded rows only. */
		display: z.enum(["summary", "detail"]).optional(),
		/**
		 * Omitted is required: each amount independently constrains quota. Alternatives within
		 * this data snapshot form one source-declared pool, exhausted only when all are known
		 * and spent; none is informational. No grouping is inferred from ids, labels or units.
		 * Display and quota semantics are independent; currencies are never added together.
		 */
		quota: z.enum(["required", "alternative", "none"]).optional(),
		unit: text(32).min(1),
		remaining: value,
		/** Optional exact decimal spelling, for currencies whose upstream precision matters. */
		remainingText: z
			.string()
			.min(1)
			.max(64)
			.regex(/^-?(?:\d+\.?\d*|\.\d+)$/)
			.optional(),
		used: value.optional(),
		total: value.optional(),
		unlimited: z.boolean().optional(),
		window: text(64).optional(),
		windowStart: timestamp.optional(),
	})
	.strict()
	.refine(
		(amount) =>
			amount.remainingText === undefined ||
			(Number.isFinite(Number(amount.remainingText)) &&
				amount.remaining !== null &&
				Number(amount.remainingText) === amount.remaining),
	);

export const providerQuotaWindowSchema = z
	.object({
		id,
		label: text().optional(),
		unit: text(32).optional(),
		used: value,
		limit: value,
		remaining: value,
		usedPercent: value.optional(),
		resetAt: timestamp,
		durationMs: z
			.number()
			.int()
			.positive()
			.max(366 * 86_400_000)
			.optional(),
		status: z.enum(["ok", "rate-limited"]).nullable().optional(),
	})
	.strict();

export const providerQuotaDataSchema = z
	.object({
		amounts: z.array(providerQuotaAmountSchema).max(32),
		windows: z.array(providerQuotaWindowSchema).max(32),
		scope: text(64).optional(),
		/** Optional upstream format name for legacy projections; generic UI never branches on it. */
		format: text(64).optional(),
		/** Unbounded amount allowance; independently reported windows and expiry still apply. */
		unlimited: z.boolean().optional(),
		/** False makes the account unavailable; true does not invent a balance or override a zero. */
		available: z.boolean().nullable().optional(),
		planName: text().optional(),
		/** Explicit allowance expiry only, never a timestamp inferred from a window start. */
		expiresAt: timestamp.optional(),
		details: text(4 * 1024).optional(),
	})
	.strict();
export type ProviderQuotaAmount = z.infer<typeof providerQuotaAmountSchema>;
export type ProviderQuotaWindow = z.infer<typeof providerQuotaWindowSchema>;
export type ProviderQuotaData = z.infer<typeof providerQuotaDataSchema>;

export const customApiQuotaTargetSchema = z
	.object({
		kind: z.literal("custom-api"),
		id,
		providerId: id.refine((value) => !value.includes(":"), "Custom API owner required"),
		keyId: id
			.refine((value) => !value.includes(":"), "Custom API inference key required")
			.optional(),
		generation: id,
		baseUrl: text(2_048).min(1),
		prefix: text().optional(),
		protocol: text(64).optional(),
		/** Presence selects the saved site account, including a deterministic incomplete config. */
		siteQuota: z
			.object({ root: text(2_048).min(1).nullable() })
			.strict()
			.optional(),
	})
	.strict();
export type CustomApiQuotaTarget = z.infer<typeof customApiQuotaTargetSchema>;

const pathRule = text(2_048)
	.min(1)
	.refine(
		(path) =>
			path.startsWith("/") &&
			!path.startsWith("//") &&
			!/[?#\\\s]/.test(path) &&
			!path.split("/").some((segment) => segment === "." || segment === "..") &&
			(!path.includes("*") || (path.startsWith("/**/") && !path.slice(4).includes("*"))),
		"expected an absolute path or a /**/ suffix rule",
	);
const requestRule = z
	.object({
		path: pathRule,
		auth: z.enum(["none", "bearer", "bearer-and-api-key", "site-token"]),
		queryKeys: z.array(text(64).min(1)).max(16).default([]),
		/** Only these harmless headers can be supplied by the plugin. */
		headers: z
			.array(z.enum(["accept", "user-agent"]))
			.max(2)
			.default([]),
	})
	.strict();

export const providerQuotaSourceSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
		title: text(200).min(1),
		/** Optional reference to this plugin's saved-provider settings contribution. */
		settingsContribution: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/)
			.optional(),
		/** Hosts OR within the array, AND with optional path prefixes. No provider enums. */
		match: z
			.object({
				hosts: z.array(text(253).min(1)).max(32).default([]),
				pathPrefixes: z.array(text(1_024).min(1)).max(32).default([]),
				fallback: z.boolean().default(false),
			})
			.strict(),
		requests: z.array(requestRule).min(1).max(32),
		refresh: z
			.object({
				staleMs: z.number().int().min(10_000).max(86_400_000).default(60_000),
				/** Optional retention after transient failures; omitted preserves the source's prior SWR. */
				keepLastGoodMs: z
					.number()
					.int()
					.min(0)
					.max(365 * 86_400_000)
					.optional(),
				retryMs: z.number().int().min(10_000).max(86_400_000).default(60_000),
				maxRetryMs: z.number().int().min(10_000).max(86_400_000).default(600_000),
				activityMs: z.number().int().min(10_000).max(86_400_000).default(20_000),
				unsupportedMs: z
					.number()
					.int()
					.min(60_000)
					.max(7 * 86_400_000)
					.default(3_600_000),
			})
			.strict()
			.prefault({}),
		limits: z
			.object({
				timeoutMs: z.number().int().min(100).max(QUOTA_MAX_QUERY_MS).default(QUOTA_MAX_QUERY_MS),
				requestTimeoutMs: z
					.number()
					.int()
					.min(100)
					.max(QUOTA_MAX_REQUEST_MS)
					.default(QUOTA_MAX_REQUEST_MS),
				maxResponseBytes: z
					.number()
					.int()
					.min(1_024)
					.max(QUOTA_MAX_RESPONSE_BYTES)
					.default(QUOTA_MAX_RESPONSE_BYTES),
				maxRequests: z.number().int().min(1).max(16).default(8),
			})
			.strict()
			.prefault({}),
	})
	.strict();
export type ProviderQuotaSourceDeclaration = z.infer<typeof providerQuotaSourceSchema>;

export const quotaQueryParamsSchema = z
	.object({
		protocolVersion: z.literal(QUOTA_PROTOCOL_VERSION),
		contributionId: id,
		target: customApiQuotaTargetSchema,
		mode: z.enum(["probe", "refresh"]),
		reference: id,
		deadlineAt: z.number().int().positive(),
		/** Bounded adapter state; never credentials or an upstream response. */
		cursor: text(2_048).optional(),
		settings: z
			.strictObject({
				reference: z.string().uuid(),
				revision: providerSettingsRevisionSchema,
				values: z.record(
					providerSettingsFieldNameSchema,
					z.union([providerSettingsValueStringSchema, z.boolean(), z.number()]),
				),
			})
			.optional(),
	})
	.strict();
export const quotaQueryResultSchema = z
	.object({
		status: z.enum(["supported", "unsupported", "error"]),
		data: providerQuotaDataSchema.nullable(),
		error: z.enum(QUOTA_ERROR_CODES).nullable(),
		cursor: text(2_048).optional(),
	})
	.strict()
	.refine((result) =>
		result.status === "supported"
			? result.data !== null && result.error === null
			: result.data === null,
	)
	.refine(
		(result) =>
			new TextEncoder().encode(JSON.stringify(result)).byteLength <= QUOTA_MAX_SNAPSHOT_BYTES,
	);
export type QuotaQueryParams = z.infer<typeof quotaQueryParamsSchema>;
export type QuotaQueryResult = z.infer<typeof quotaQueryResultSchema>;

export const providerConnectionRequestSchema = z
	.object({
		reference: id,
		method: z.literal("GET").default("GET"),
		destination: z.enum(["provider", "site-account"]).optional(),
		path: text(2_048).min(1),
		query: z.record(text(64).min(1), text(1_024)).optional(),
		headers: z.partialRecord(z.enum(["accept", "user-agent"]), text(512)).optional(),
	})
	.strict();
export type ProviderConnectionRequest = z.infer<typeof providerConnectionRequestSchema>;
export interface ProviderConnectionResponse {
	status: number;
	contentType: string | null;
	body: string;
	bytes: number;
}

export interface ProviderQuotaSnapshot {
	providerId: string;
	targetId: string;
	keyId?: string;
	/** False for an explicit account query that must not be replaced by inference-key push text. */
	pushCompatible?: boolean;
	generation: string;
	sourceId: string | null;
	status: ProviderQuotaStatus;
	data: ProviderQuotaData | null;
	fetchedAt: number;
	attemptedAt: number;
	stale: boolean;
	error: ProviderQuotaErrorCode | null;
	version: number;
}

export interface ProviderQuotaPage {
	snapshots: ProviderQuotaSnapshot[];
	nextCursor: string | null;
}

export function customApiQuotaTargetId(providerId: string, keyId?: string): string {
	return keyId ? `custom-api/${providerId}/keys/${keyId}` : `custom-api/${providerId}`;
}
