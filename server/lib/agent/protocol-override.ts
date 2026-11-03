/**
 * 逐模型协议切换时要带到新适配器上的连接字段。
 *
 * 协议只决定走哪一族请求格式。代理、指纹、额外头和官方 API 标志属于这条连接，
 * 换适配器时必须留下，否则选一次协议就会把连接上的其余配置丢掉。
 */

import { parseModelId } from "@shared/model-id";
import type { ProviderEndpointPolicy } from "@shared/provider-endpoints";
import type { ModelProtocol, ProxyOverride } from "../settings/types";
import type { UserAgentMode } from "../user-agent";

export interface ProtocolConnectionFields {
	id: string;
	name: string;
	prefix: string;
	apiKey: string;
	baseUrl?: string;
	baseUrls?: string[];
	endpointPolicy?: ProviderEndpointPolicy;
	defaultModel?: string;
	proxy?: ProxyOverride;
	userAgentMode?: UserAgentMode;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
	dynamicHeaders?: () => Record<string, string>;
	tlsRejectUnauthorized?: boolean;
	authorizationHeader?: string;
	officialApi?: boolean;
	nativeSearch?: boolean;
	geminiTransport?: "generate-content" | "interactions";
	defaultContextWindow?: number;
	defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null;
	apiMode?: "responses" | "completions" | "codex";
	responsesApi?: boolean;
}

/** OpenAI 连接当前已经在用的协议族。`codex` 与 `responses` 都算 Responses。 */
export function openAIFamilyProtocol(config: {
	apiMode?: string;
	responsesApi?: boolean;
}): ModelProtocol {
	if (config.apiMode === "completions") return "completions-compatible";
	if (config.apiMode === "responses" || config.apiMode === "codex") return "openai-responses";
	if (config.responsesApi === false) return "completions-compatible";
	return "openai-responses";
}

/**
 * 选中的协议和这条连接本来的适配器一致时，不要重建。
 * 重建会丢掉只存在于原配置对象上的字段（例如 Codex 的 account id）。
 */
export function protocolMatchesConnection(
	kind: string,
	config: { apiMode?: string; responsesApi?: boolean },
	protocol: ModelProtocol,
): boolean {
	if (kind === "anthropic") return protocol === "anthropic-messages";
	if (kind === "gemini") return protocol === "gemini-compatible";
	if (kind === "openai") return protocol === openAIFamilyProtocol(config);
	return false;
}

/** 复制连接字段。`defaultModel` 在原配置缺省时用这次请求的裸模型名。 */
export function connectionForProtocolSwitch(
	source: ProtocolConnectionFields,
	model: string,
): Omit<ProtocolConnectionFields, "apiMode" | "responsesApi"> & {
	baseUrl: string;
	defaultModel: string;
} {
	const bare = parseModelId(model).model;
	return {
		id: source.id,
		name: source.name,
		prefix: source.prefix,
		apiKey: source.apiKey,
		baseUrl: source.baseUrl ?? "",
		baseUrls: source.baseUrls,
		endpointPolicy: source.endpointPolicy,
		defaultModel: source.defaultModel?.trim() || bare || "default",
		proxy: source.proxy,
		userAgentMode: source.userAgentMode,
		customUserAgent: source.customUserAgent,
		extraHeaders: source.extraHeaders,
		dynamicHeaders: source.dynamicHeaders,
		tlsRejectUnauthorized: source.tlsRejectUnauthorized,
		authorizationHeader: source.authorizationHeader,
		officialApi: source.officialApi,
		nativeSearch: source.nativeSearch,
		geminiTransport: source.geminiTransport,
		defaultContextWindow: source.defaultContextWindow,
		defaultReasoningEffort: source.defaultReasoningEffort,
	};
}
