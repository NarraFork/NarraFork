import { z } from "zod";
import type { ProviderBalanceData } from "./provider-balance";

/**
 * Wire contract of the host-internal `query-balance` command contributed by the
 * `com.narrafork.apikey-quota` plugin.
 *
 * The plugin is a separate process and mirrors this shape in plain JavaScript
 * (`server/builtin-plugins/apikey-quota/server/index.js`), so the two sides are kept honest by
 * this schema plus a contract test rather than by a shared import. Everything here is
 * host-side validation: an output that does not parse is treated as "no answer" and the
 * caller falls back, so a broken plugin can never write junk into the balance cache.
 */
export const APIKEY_QUOTA_PLUGIN_ID = "com.narrafork.apikey-quota";
export const APIKEY_QUOTA_COMMAND_ID = "query-balance";

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

export const apikeyQuotaCommandOutputSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("ok"),
			balance: balanceDataSchema,
			adapter: z.enum(["sub2api", "new-api", "new-api-user"]).optional(),
			root: z.string().max(2048).optional(),
		})
		.strict(),
	z.object({ status: z.literal("unsupported") }).strict(),
	z
		.object({
			status: z.literal("failed"),
			/**
			 * `unsupported`/`transient` keep their original meaning. `auth`,
			 * `invalid_response` and `invalid_configuration` are deterministic: the host must
			 * surface them immediately and drop the cached allowance instead of retrying.
			 */
			kind: z.enum([
				"unsupported",
				"transient",
				"auth",
				"invalid_response",
				"invalid_configuration",
			]),
		})
		.strict(),
]);

export type ApikeyQuotaCommandOutput = z.infer<typeof apikeyQuotaCommandOutputSchema>;

export const apikeyQuotaCommandInputSchema = z
	.object({
		mode: z.enum(["probe", "refresh"]),
		baseUrl: z.string().max(2048),
		apiKey: z.string().min(1).max(4096),
		headers: z.record(z.string(), z.string()).optional(),
		userAgent: z.string().max(512).optional(),
		proxy: z.string().max(2048).nullable().optional(),
		tlsRejectUnauthorized: z.boolean().optional(),
		/**
		 * Per-request timeout, honoured verbatim exactly as the host transport does (which also
		 * accepts a fractional millisecond count). The only enforced ceiling is the timer's own
		 * limit, so a value the bundled path accepts cannot be rejected here and quietly
		 * answered by the fallback.
		 */
		timeoutMs: z.number().min(0).max(2_147_483_647).optional(),
		adapter: z.enum(["sub2api", "new-api", "new-api-user"]).optional(),
		root: z.string().max(2048).optional(),
		/**
		 * Site-account credit credentials. Sent per call like `apiKey` and never persisted by
		 * the plugin. When any of them is present the site query (`/api/user/self`) is
		 * authoritative, and `siteUrl` overrides the root derived from `baseUrl`.
		 */
		siteUrl: z.string().max(2048).optional(),
		accessToken: z.string().max(4096).optional(),
		userId: z.string().max(128).optional(),
	})
	.strict();

export type ApikeyQuotaCommandInput = z.infer<typeof apikeyQuotaCommandInputSchema>;

/** Narrow the validated projection to the shared DTO the cache and routes already use. */
export function toProviderBalanceData(
	balance: ApikeyQuotaCommandOutput & { status: "ok" },
): ProviderBalanceData {
	return balance.balance;
}
