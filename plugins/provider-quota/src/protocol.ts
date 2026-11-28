import { z } from "zod";
import manifest from "../manifest.json";

// Public quota wire contract, copied locally so the released plugin has no host import graph.
export const QUOTA_PROTOCOL_VERSION = "1.0" as const;
export const PLUGIN_ID = "io.narrafork.provider-quota";
export const PLUGIN_VERSION = manifest.version;
export const RPC_PROTOCOL = "narrafork.rpc/1";
export const FEATURES = [
	"host_api.requests",
	"rpc.cancel",
	"host_api.provider_connection",
	"host_api.provider_settings",
] as const;
export const MAX_SNAPSHOT_BYTES = 16 * 1024;
export const ERROR_CODES = [
	"request_failed",
	"invalid_configuration",
	"auth_failed",
	"invalid_response",
	"timeout",
	"unavailable",
	"permission_denied",
	"queue_full",
] as const;
export type QuotaErrorCode = (typeof ERROR_CODES)[number];
export function plainText(value: string): boolean {
	for (const char of value) {
		if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "<" || char === ">")
			return false;
	}
	return true;
}
const text = (max = 256) => z.string().max(max).refine(plainText);
const id = text().min(1);
const number = z.number().finite().nullable();
const timestamp = z.string().datetime({ offset: true }).nullable();

export const quotaDataSchema = z
	.object({
		amounts: z
			.array(
				z
					.object({
						id,
						label: text().optional(),
						/** Omitted keeps legacy summary visibility; detail amounts stay in expanded rows only. */
						display: z.enum(["summary", "detail"]).optional(),
						/**
						 * Required by default; alternatives in this snapshot form one source-declared pool.
						 * None is informational. Never infer groups or add different currencies together.
						 */
						quota: z.enum(["required", "alternative", "none"]).optional(),
						unit: text(32).min(1),
						remaining: number,
						remainingText: z
							.string()
							.min(1)
							.max(64)
							.regex(/^-?(?:\d+\.?\d*|\.\d+)$/)
							.optional(),
						used: number.optional(),
						total: number.optional(),
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
					),
			)
			.max(32),
		windows: z
			.array(
				z
					.object({
						id,
						label: text().optional(),
						unit: text(32).optional(),
						used: number,
						limit: number,
						remaining: number,
						usedPercent: number.optional(),
						resetAt: timestamp,
						durationMs: z
							.number()
							.int()
							.positive()
							.max(366 * 86_400_000)
							.optional(),
						status: z.enum(["ok", "rate-limited"]).nullable().optional(),
					})
					.strict(),
			)
			.max(32),
		scope: text(64).optional(),
		format: text(64).optional(),
		/** Unbounded amount allowance; independently reported windows and expiry still apply. */
		unlimited: z.boolean().optional(),
		/** False makes the account unavailable; true does not invent a balance or override a zero. */
		available: z.boolean().nullable().optional(),
		planName: text().optional(),
		/** Explicit allowance expiry only, never a timestamp inferred from a window start. */
		expiresAt: timestamp.optional(),
		details: text(4096).optional(),
	})
	.strict();
export type QuotaData = z.infer<typeof quotaDataSchema>;
export type QuotaWindow = QuotaData["windows"][number];
export const queryParamsSchema = z
	.object({
		protocolVersion: z.literal(QUOTA_PROTOCOL_VERSION),
		contributionId: id,
		target: z
			.object({
				kind: z.literal("custom-api"),
				id,
				providerId: id.refine((value) => !value.includes(":"), "Custom API owner required"),
				keyId: id
					.refine((value) => !value.includes(":"), "Custom API inference key required")
					.optional(),
				generation: id,
				baseUrl: text(2048).min(1),
				prefix: text().optional(),
				protocol: text(64).optional(),
				siteQuota: z
					.object({ root: text(2048).min(1).nullable() })
					.strict()
					.optional(),
			})
			.strict(),
		settings: z
			.object({
				reference: z.string().uuid(),
				revision: z.number().int().nonnegative().safe(),
				values: z
					.record(
						z.string().min(1).max(128),
						z.union([z.string().max(4096), z.number().finite(), z.boolean()]),
					)
					.refine((values) => Object.keys(values).length <= 32),
			})
			.strict()
			.optional(),
		mode: z.enum(["probe", "refresh"]),
		reference: id,
		deadlineAt: z.number().int().positive(),
		cursor: text(2048).optional(),
	})
	.strict();
export const queryResultSchema = z
	.object({
		status: z.enum(["supported", "unsupported", "error"]),
		data: quotaDataSchema.nullable(),
		error: z.enum(ERROR_CODES).nullable(),
		cursor: text(2048).optional(),
	})
	.strict()
	.refine((r) => r.status !== "supported" || (r.data !== null && r.error === null))
	.refine((r) => r.status === "supported" || r.data === null)
	.refine((r) => new TextEncoder().encode(JSON.stringify(r)).byteLength <= MAX_SNAPSHOT_BYTES);
export type QuotaQueryParams = z.infer<typeof queryParamsSchema>;
export type QuotaQueryResult = z.infer<typeof queryResultSchema>;
export interface ConnectionRequest {
	reference: string;
	method: "GET";
	destination?: "provider" | "site-account";
	path: string;
	query?: Record<string, string>;
	headers?: Partial<Record<"accept" | "user-agent", string>>;
}
export interface SettingsConnectionRequest {
	reference: string;
	connectionId: string;
}
export type HostRequestMethod =
	| "provider.connection.request"
	| "provider.settings.connection.request";
export interface ConnectionResponse {
	status: number;
	contentType: string | null;
	body: string;
	bytes: number;
}
export interface HostRequest {
	/** Legacy provider request call shape. */
	(params: ConnectionRequest, signal: AbortSignal): Promise<ConnectionResponse>;
	/** Negotiated method-aware call shape for provider and saved-settings connections. */
	(
		method: "provider.connection.request",
		params: ConnectionRequest,
		signal: AbortSignal,
	): Promise<ConnectionResponse>;
	(
		method: "provider.settings.connection.request",
		params: SettingsConnectionRequest,
		signal: AbortSignal,
	): Promise<ConnectionResponse>;
}

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decoded upstream data is limited independently of the Content-Length frame. */
export function boundedJson(value: unknown, depth = 0, budget = { left: 8192 }): boolean {
	if (--budget.left < 0 || depth > 16) return false;
	if (typeof value === "string") return value.length <= 64 * 1024;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value))
		return value.length <= 256 && value.every((v) => boundedJson(v, depth + 1, budget));
	if (record(value)) {
		let count = 0;
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			if (
				++count > 256 ||
				key.length > 256 ||
				["__proto__", "constructor", "prototype"].includes(key)
			)
				return false;
			if (!boundedJson(value[key], depth + 1, budget)) return false;
		}
		return true;
	}
	return value === null || typeof value === "boolean";
}

export function isoTimestamp(value: unknown): string | null {
	if (typeof value !== "string" || value.length > 128) return null;
	const result = timestamp.safeParse(value);
	if (!result.success || result.data === null) return null;
	const ms = Date.parse(result.data);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
