import { ProviderQuotaError, quotaAbortable } from "@server/lib/provider-quota-async";
import {
	QUOTA_MAX_SNAPSHOT_BYTES,
	QUOTA_QUERY_METHOD,
	type QuotaQueryParams,
	type QuotaQueryResult,
	quotaQueryParamsSchema,
	quotaQueryResultSchema,
} from "@shared/provider-quota";

/** Quota is an independent unary protocol, never a provider.describe/chat client. */
export interface PluginQuotaRuntime {
	state: string;
	getDiagnostics(): {
		runtimeId: string;
		generation: number;
		pluginVersion?: string;
		features?: string[];
	};
	request<T = unknown>(
		method: string,
		params?: unknown,
		options?: {
			signal?: AbortSignal;
			timeoutMs?: number;
			maxResponseBytes?: number;
			priority?: "control" | "unary" | "stream";
		},
	): Promise<T>;
}

export class PluginQuotaClient {
	constructor(private readonly runtime: PluginQuotaRuntime) {}

	async query(
		params: QuotaQueryParams,
		options: { signal: AbortSignal; timeoutMs: number },
	): Promise<QuotaQueryResult> {
		if (options.signal.aborted || options.timeoutMs <= 0) throw new ProviderQuotaError("timeout");
		const parsed = quotaQueryParamsSchema.safeParse(params);
		if (!parsed.success) throw new ProviderQuotaError("invalid_configuration");
		try {
			const response = await quotaAbortable(
				this.runtime
					.request(QUOTA_QUERY_METHOD, parsed.data, {
						signal: options.signal,
						timeoutMs: options.timeoutMs,
						priority: "unary",
						// This cap is per pending request. Other plugin inbound budgets are unchanged.
						maxResponseBytes: QUOTA_MAX_SNAPSHOT_BYTES + 1024,
					})
					.catch((error: unknown) => {
						const cause = error instanceof Error && "cause" in error ? error.cause : undefined;
						const code =
							cause instanceof Error && "code" in cause
								? String(cause.code)
								: error instanceof Error && "code" in error
									? String(error.code)
									: undefined;
						if (code === "RPC_TIMEOUT") throw new ProviderQuotaError("timeout");
						if (code === "RESPONSE_FRAME_LIMIT") throw new ProviderQuotaError("invalid_response");
						throw new ProviderQuotaError("request_failed");
					}),
				options.signal,
			);
			// SIZE FIRST: do not traverse oversized objects with the business schema.
			try {
				if (
					new TextEncoder().encode(JSON.stringify(response)).byteLength > QUOTA_MAX_SNAPSHOT_BYTES
				) {
					throw new ProviderQuotaError("invalid_response");
				}
				const result = quotaQueryResultSchema.safeParse(response);
				if (!result.success) throw new ProviderQuotaError("invalid_response");
				return result.data;
			} catch {
				throw new ProviderQuotaError("invalid_response");
			}
		} catch (error) {
			if (options.signal.aborted) {
				throw options.signal.reason instanceof ProviderQuotaError
					? options.signal.reason
					: new ProviderQuotaError("timeout");
			}
			if (error instanceof ProviderQuotaError && error.code !== "request_failed") throw error;
			const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
			if (code === "RPC_TIMEOUT") throw new ProviderQuotaError("timeout");
			if (code === "RESPONSE_FRAME_LIMIT") throw new ProviderQuotaError("invalid_response");
			throw new ProviderQuotaError("request_failed");
		}
	}
}
