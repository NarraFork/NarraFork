import manifest from "../manifest.json";
import {
	DEEPSEEK_BALANCE_PATH,
	deepSeekQuotaData,
	isDeepSeekCustomApiProvider,
	parseDeepSeekBalanceResponse,
} from "./deepseek";
import { BalanceProbeRequestError, QuotaQueryError } from "./errors";
import {
	isKimiCustomApiProvider,
	KIMI_CLI_USER_AGENT,
	KIMI_USAGES_PATH,
	kimiQuotaData,
	parseKimiUsagesResponse,
} from "./kimi";
import {
	isOpencodeCustomApiProvider,
	opencodeQuotaData,
	opencodeUsageUrl,
	parseOpencodeUsageResponse,
} from "./opencode";
import {
	type HostRequest,
	PLUGIN_ID,
	plainText,
	type QuotaData,
	type QuotaQueryParams,
	type QuotaQueryResult,
	queryParamsSchema,
	queryResultSchema,
	record,
} from "./protocol";
import {
	buildBalanceRoots,
	normalizeBalanceRoot,
	type ProviderBalanceAdapter,
	parseNewApiUserQuota,
	probeProviderBalance,
	probeSiteQuota,
	refreshProviderBalance,
	refreshSiteQuota,
	relayQuotaData,
} from "./relay";
import {
	createJsonConnectionRequest,
	createRelayRequest,
	createSettingsConnectionRequest,
} from "./request";

export const QUOTA_SOURCES = manifest.contributes.quotaSources;
const unsupported = (): QuotaQueryResult => ({ status: "unsupported", data: null, error: null });
function safeResult(data: QuotaData | null, cursor?: string): QuotaQueryResult {
	if (!data) return unsupported();
	const result = queryResultSchema.safeParse({
		status: "supported",
		data,
		error: null,
		...(cursor ? { cursor } : {}),
	});
	return result.success ? result.data : { status: "error", data: null, error: "invalid_response" };
}
type RelayCursorConnection =
	| string
	| QuotaQueryParams["target"]
	| {
			siteUrl: string;
	  };

export function parseRelayCursor(
	cursor: string,
	connection: RelayCursorConnection,
): { adapter: ProviderBalanceAdapter; root: string } {
	if (cursor.length > 2048 || !plainText(cursor))
		throw new QuotaQueryError("invalid_configuration");
	let value: unknown;
	try {
		value = JSON.parse(cursor);
	} catch {
		throw new QuotaQueryError("invalid_configuration");
	}
	const settingsSiteUrl =
		typeof connection !== "string" && "siteUrl" in connection ? connection.siteUrl : undefined;
	const site =
		typeof connection !== "string" && "baseUrl" in connection ? connection.siteQuota : undefined;
	let roots: string[];
	try {
		roots = settingsSiteUrl
			? [normalizeBalanceRoot(settingsSiteUrl)]
			: site
				? site.root
					? [site.root]
					: []
				: typeof connection === "string" || "baseUrl" in connection
					? buildBalanceRoots(typeof connection === "string" ? connection : connection.baseUrl)
					: [];
	} catch {
		throw new QuotaQueryError("invalid_configuration");
	}
	const accountCursor = settingsSiteUrl !== undefined || site !== undefined;
	if (
		!record(value) ||
		Object.keys(value).length !== 2 ||
		typeof value.root !== "string" ||
		!roots.includes(value.root) ||
		(accountCursor
			? value.adapter !== "new-api-user"
			: value.adapter !== "sub2api" && value.adapter !== "new-api")
	) {
		throw new QuotaQueryError("invalid_configuration");
	}
	return { adapter: value.adapter as ProviderBalanceAdapter, root: value.root };
}
async function querySource(
	params: QuotaQueryParams,
	id: string,
	hostRequest: HostRequest,
	signal: AbortSignal,
): Promise<QuotaQueryResult> {
	const source = QUOTA_SOURCES.find((source) => source.id === id);
	if (!source) return unsupported();
	const useSiteAccount = params.settings?.values.useSiteAccount === true;
	if (params.settings && useSiteAccount) {
		if (id !== "relay") return unsupported();
		const siteUrl = params.settings.values.siteUrl;
		if (typeof siteUrl !== "string" || !siteUrl) throw new QuotaQueryError("invalid_configuration");
		const settingsRequest = createSettingsConnectionRequest(
			params,
			hostRequest,
			signal,
			source.limits,
		);
		const parseAccount = async () => {
			const body = await settingsRequest("balance");
			const balance = parseNewApiUserQuota(body);
			if (!balance) throw new BalanceProbeRequestError("invalid_response");
			return balance;
		};
		if (params.mode === "refresh" && params.cursor) {
			parseRelayCursor(params.cursor, { siteUrl });
			return safeResult(relayQuotaData(await parseAccount(), "new-api-user"), params.cursor);
		}
		const balance = await parseAccount();
		const root = normalizeBalanceRoot(siteUrl);
		const cursor = JSON.stringify({ adapter: "new-api-user", root });
		return safeResult(relayQuotaData(balance, "new-api-user"), cursor);
	}
	if (!params.settings && params.target.siteQuota) {
		const root = params.target.siteQuota.root;
		if (!root) throw new QuotaQueryError("invalid_configuration");
		const request = createRelayRequest(params, hostRequest, signal, source.limits);
		if (params.mode === "refresh" && params.cursor) {
			const cursor = parseRelayCursor(params.cursor, params.target);
			return safeResult(
				relayQuotaData(await refreshSiteQuota(cursor.root, request), "new-api-user"),
				params.cursor,
			);
		}
		const found = await probeSiteQuota(root, request);
		return safeResult(
			relayQuotaData(found.balance, found.adapter),
			JSON.stringify({ adapter: found.adapter, root: found.root }),
		);
	}
	const request = createJsonConnectionRequest(params, hostRequest, signal, source.limits);
	if (id === "deepseek") {
		if (!isDeepSeekCustomApiProvider(params.target)) return unsupported();
		const data = deepSeekQuotaData(
			parseDeepSeekBalanceResponse(await request(DEEPSEEK_BALANCE_PATH)),
		);
		return data ? safeResult(data) : { status: "error", data: null, error: "invalid_response" };
	}
	if (id === "kimi") {
		if (!isKimiCustomApiProvider(params.target)) return unsupported();
		return safeResult(
			kimiQuotaData(
				parseKimiUsagesResponse(
					await request(KIMI_USAGES_PATH, {
						accept: "application/json",
						"user-agent": KIMI_CLI_USER_AGENT,
					}),
				),
			),
		);
	}
	if (id === "opencode") {
		if (!isOpencodeCustomApiProvider(params.target)) return unsupported();
		const endpoint = new URL(opencodeUsageUrl(params.target.baseUrl));
		return safeResult(
			opencodeQuotaData(parseOpencodeUsageResponse(await request(endpoint.pathname))),
		);
	}
	const relayRequest = createRelayRequest(params, hostRequest, signal, source.limits);
	if (params.mode === "refresh" && params.cursor) {
		const cursor = parseRelayCursor(params.cursor, params.target);
		return safeResult(
			relayQuotaData(
				await refreshProviderBalance(cursor.adapter, cursor.root, relayRequest),
				cursor.adapter,
			),
			params.cursor,
		);
	}
	const result = await probeProviderBalance(params.target.baseUrl, relayRequest);
	if (!result) return unsupported();
	const cursor = JSON.stringify({ adapter: result.adapter, root: result.root });
	return safeResult(
		relayQuotaData(result.balance, result.adapter),
		cursor.length <= 2048 ? cursor : undefined,
	);
}

/** One host-bound subject per call. Credentials never enter the plugin process. */
export async function queryQuota(
	rawParams: unknown,
	hostRequest: HostRequest,
	parentSignal: AbortSignal = new AbortController().signal,
): Promise<QuotaQueryResult> {
	const parsed = queryParamsSchema.safeParse(rawParams);
	if (!parsed.success) return { status: "error", data: null, error: "invalid_configuration" };
	const params = parsed.data;
	const id = params.contributionId.startsWith(`${PLUGIN_ID}/`)
		? params.contributionId.slice(PLUGIN_ID.length + 1)
		: params.contributionId;
	const source = QUOTA_SOURCES.find((source) => source.id === id);
	if (!source) return unsupported();
	try {
		if (params.settings?.values.useSiteAccount === true) {
			const siteUrl = params.settings.values.siteUrl;
			if (typeof siteUrl !== "string" || !siteUrl) throw new Error("Missing site URL");
			normalizeBalanceRoot(siteUrl);
		} else {
			buildBalanceRoots(
				params.settings
					? params.target.baseUrl
					: (params.target.siteQuota?.root ?? params.target.baseUrl),
			);
		}
	} catch {
		return { status: "error", data: null, error: "invalid_configuration" };
	}
	const expectedId = params.target.keyId
		? `custom-api/${params.target.providerId}/keys/${params.target.keyId}`
		: `custom-api/${params.target.providerId}`;
	if (params.target.id !== expectedId)
		return { status: "error", data: null, error: "invalid_configuration" };
	if (params.deadlineAt <= Date.now()) return { status: "error", data: null, error: "timeout" };
	const controller = new AbortController();
	const signal = AbortSignal.any([parentSignal, controller.signal]);
	const timer = setTimeout(
		() => controller.abort(new QuotaQueryError("timeout")),
		Math.max(1, Math.min(source.limits.timeoutMs, params.deadlineAt - Date.now())),
	);
	try {
		if (signal.aborted) throw new QuotaQueryError("unavailable");
		const result = await querySource(params, id, hostRequest, signal);
		if (signal.aborted)
			throw signal.reason instanceof QuotaQueryError
				? signal.reason
				: new QuotaQueryError("unavailable");
		return result;
	} catch (error) {
		if (signal.aborted)
			return {
				status: "error",
				data: null,
				error: signal.reason instanceof QuotaQueryError ? signal.reason.code : "unavailable",
			};
		if (error instanceof BalanceProbeRequestError) {
			if (error.kind === "unsupported")
				return params.mode === "refresh" && params.cursor
					? { status: "error", data: null, error: "request_failed" }
					: unsupported();
			return { status: "error", data: null, error: error.code };
		}
		if (error instanceof QuotaQueryError) return { status: "error", data: null, error: error.code };
		return { status: "error", data: null, error: "invalid_response" };
	} finally {
		clearTimeout(timer);
	}
}
