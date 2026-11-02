import { z } from "zod";
import type { ProviderBalanceData } from "./provider-balance";

/**
 * Wire contract of the `query-balance` tool contributed by the
 * `com.narrafork.apikey-quota` plugin.
 *
 * The plugin is a separate process and mirrors this shape in plain JavaScript
 * (`plugins/apikey-quota/server/index.js`), so the two sides are kept honest by
 * this schema plus a contract test rather than by a shared import. Everything here is
 * host-side validation: an output that does not parse is treated as "no answer" and the
 * caller falls back, so a broken plugin can never write junk into the balance cache.
 */
export const APIKEY_QUOTA_PLUGIN_ID = "com.narrafork.apikey-quota";
export const APIKEY_QUOTA_TOOL_ID = "query-balance";

const amountSchema = z
	.object({
		unit: z.string().min(1).max(32),
		remaining: z.number().nullable(),
		used: z.number().optional(),
		total: z.number().optional(),
		window: z.string().max(32).optional(),
		windowStart: z.string().max(64).optional(),
	})
	.strict();

const balanceDataSchema = z
	.object({
		scope: z.enum(["wallet", "key", "subscription"]),
		unlimited: z.boolean(),
		amounts: z.array(amountSchema).max(32),
		planName: z.string().max(128).optional(),
		expiresAt: z.string().max(64).optional(),
	})
	.strict();

export const apikeyQuotaToolOutputSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("ok"),
			balance: balanceDataSchema,
			adapter: z.enum(["sub2api", "new-api"]).optional(),
			root: z.string().max(2048).optional(),
		})
		.strict(),
	z.object({ status: z.literal("unsupported") }).strict(),
	z.object({ status: z.literal("failed"), kind: z.enum(["unsupported", "transient"]) }).strict(),
]);

export type ApikeyQuotaToolOutput = z.infer<typeof apikeyQuotaToolOutputSchema>;

export const apikeyQuotaToolInputSchema = z
	.object({
		mode: z.enum(["probe", "refresh"]),
		baseUrl: z.string().max(2048),
		apiKey: z.string().min(1).max(4096),
		headers: z.record(z.string(), z.string()).optional(),
		userAgent: z.string().max(512).optional(),
		proxy: z.string().max(2048).nullable().optional(),
		tlsRejectUnauthorized: z.boolean().optional(),
		adapter: z.enum(["sub2api", "new-api"]).optional(),
		root: z.string().max(2048).optional(),
	})
	.strict();

export type ApikeyQuotaToolInput = z.infer<typeof apikeyQuotaToolInputSchema>;

/** Narrow the validated projection to the shared DTO the cache and routes already use. */
export function toProviderBalanceData(
	balance: ApikeyQuotaToolOutput & { status: "ok" },
): ProviderBalanceData {
	return balance.balance;
}
