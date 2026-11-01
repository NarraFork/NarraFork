/**
 * Command Code Provider API 的接入信息与端点选择。
 *
 * 实测结论（`https://api.commandcode.ai/provider/v1`）：
 * - `GET /models` 返回 OpenAI 风格列表，每个模型带 `supported_endpoints`（权威依据）。
 * - `POST /chat/completions`、`POST /responses` 可用，覆盖 82 个模型（gpt / deepseek / qwen 等）。
 * - `POST /messages` 是 claude 系唯一支持的端点：把它们发到另外两个端点会得到 400
 *   "must be called via /provider/v1/messages"。该端点目前对实测账户恒返回 403（CLI 与 Studio
 *   两把 key、Bearer 与 x-api-key 两种认证都如此，而同一 key 的其它端点均 200），属上游问题。
 */

import {
	COMMAND_CODE_API_BASE as SHARED_COMMAND_CODE_API_BASE,
	COMMAND_CODE_PROVIDER_BASE as SHARED_COMMAND_CODE_PROVIDER_BASE,
} from "@shared/commandcode";

export const COMMAND_CODE_API_BASE = SHARED_COMMAND_CODE_API_BASE;
/** Provider API 根：各推理端点挂在其下（`/messages`、`/chat/completions`、`/responses`、`/models`）。 */
export const COMMAND_CODE_PROVIDER_BASE = SHARED_COMMAND_CODE_PROVIDER_BASE;
/**
 * 平台 provider 的前缀。
 *
 * 定义在这里（而不是 provider 装配模块）是因为 settings 加载期的迁移也要用它，
 * 而那条路径不能反过来依赖 agent 层（会形成初始化环）。
 */
export const COMMAND_CODE_PREFIX = "CommandCode";

export type CommandCodeEndpoint = "messages" | "completions" | "responses";

/** Provider API 根。自定义 base 去掉末尾斜杠；缺省是官方 Provider API。 */
export function commandCodeProviderBase(baseUrl?: string): string {
	const trimmed = baseUrl?.trim();
	return (trimmed || COMMAND_CODE_PROVIDER_BASE).replace(/\/+$/, "");
}

/**
 * 额度接口挂在站点根（`/alpha/...`），不在 `/provider/v1` 下面。
 * 自定义 provider base 时改用同一 origin，这样代理可以同时接到模型和额度。
 */
export function commandCodeApiOrigin(baseUrl?: string): string {
	try {
		return new URL(commandCodeProviderBase(baseUrl)).origin;
	} catch {
		return COMMAND_CODE_API_BASE;
	}
}

/** `CommandCode:claude-haiku` 与裸 id `claude-haiku` 都收成裸模型名；`prefix` 是实例自己的前缀。 */
export function bareCommandCodeModelId(modelRef: string, prefix = COMMAND_CODE_PREFIX): string {
	const trimmed = modelRef.trim();
	const separator = trimmed.indexOf(":");
	if (separator <= 0) return trimmed;
	if (trimmed.slice(0, separator) !== prefix) return trimmed;
	return trimmed.slice(separator + 1);
}

export interface CommandCodeModelInfo {
	id: string;
	name?: string;
	contextLength?: number;
	endpoints: string[];
}

/**
 * 模型该走哪个端点。
 *
 * 默认规则：`claude*` 只支持 `/messages`，其余模型走 OpenAI 协议并默认用 `/chat/completions`。
 * `overrides` 里针对单个模型的显式配置优先，用户可在设置页逐模型切换。
 */
export function resolveCommandCodeEndpoint(
	modelId: string,
	overrides?: Record<string, CommandCodeEndpoint>,
): CommandCodeEndpoint {
	const override = overrides?.[modelId];
	if (override) return override;
	return modelId.trim().toLowerCase().startsWith("claude") ? "messages" : "completions";
}

/**
 * 设置页协议到 Command Code 端点。
 * `gemini-compatible` 在上游没有对应端点，返回 undefined，交给能力列表或模型名规则。
 */
export function mapCommandCodeProtocol(protocol?: string): CommandCodeEndpoint | undefined {
	switch (protocol) {
		case "anthropic-messages":
			return "messages";
		case "openai-responses":
			return "responses";
		case "completions-compatible":
			return "completions";
		default:
			return undefined;
	}
}

/**
 * 用模型目录里的 `supported_endpoints` 选端点。只有 `/messages` 的模型走 Anthropic。
 *
 * 特例：其他平台在同时支持时优先 Anthropic Messages，这里仍然优先 `/responses`，
 * 因为 Command Code 的 `/messages` 对实测账户恒返回 403（见文件头注释）。
 */
export function endpointFromSupported(
	endpoints: readonly string[],
): CommandCodeEndpoint | undefined {
	const normalized = new Set(endpoints.map((endpoint) => endpoint.trim().toLowerCase()));
	const messages = normalized.has("/messages");
	const completions = normalized.has("/chat/completions");
	const responses = normalized.has("/responses");
	if (messages && !completions && !responses) return "messages";
	if (completions) return "completions";
	if (responses) return "responses";
	if (messages) return "messages";
	return undefined;
}

/**
 * 端点优先级：显式协议、`commandCode.endpoints`、目录里的 supported_endpoints、模型名。
 * `modelRef` 可以是裸 id，也可以是 `<prefix>:` 前缀的完整 id；`prefix` 省略时按内置前缀算。
 */
export function selectCommandCodeEndpoint(
	modelRef: string,
	options?: {
		protocol?: string;
		overrides?: Record<string, CommandCodeEndpoint>;
		supportedEndpoints?: readonly string[];
		prefix?: string;
	},
): CommandCodeEndpoint {
	const bare = bareCommandCodeModelId(modelRef, options?.prefix);
	const mapped = mapCommandCodeProtocol(options?.protocol);
	if (mapped) return mapped;
	const override = options?.overrides?.[bare] ?? options?.overrides?.[modelRef];
	if (override) return override;
	const fromCatalog = options?.supportedEndpoints
		? endpointFromSupported(options.supportedEndpoints)
		: undefined;
	if (fromCatalog) return fromCatalog;
	return resolveCommandCodeEndpoint(bare);
}

/** 解析 `/provider/v1/models` 的响应；字段缺失时保守地返回空列表。 */
export function parseCommandCodeModels(value: unknown): CommandCodeModelInfo[] {
	if (typeof value !== "object" || value === null) return [];
	const data = (value as { data?: unknown }).data;
	if (!Array.isArray(data)) return [];
	return data.flatMap((item) => {
		if (typeof item !== "object" || item === null) return [];
		const raw = item as Record<string, unknown>;
		if (typeof raw.id !== "string") return [];
		return [
			{
				id: raw.id,
				name: typeof raw.name === "string" ? raw.name : undefined,
				contextLength: typeof raw.context_length === "number" ? raw.context_length : undefined,
				endpoints: Array.isArray(raw.supported_endpoints)
					? raw.supported_endpoints.filter((e): e is string => typeof e === "string")
					: [],
			},
		];
	});
}
