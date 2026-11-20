/**
 * Command Code provider 装配。
 *
 * 上游把两种协议分开：claude 系只支持 Anthropic 的 `/messages`，其余模型走 OpenAI 的
 * `/chat/completions` 或 `/responses`。因此这里按模型选择已有的 AnthropicProvider /
 * OpenAIProvider，不写新适配器，只注入凭据与 base。
 */

import { resolveCommandCodeToken } from "../commandcode-manager";
import { getCachedCommandCodeModel } from "../commandcode-models";
import {
	bareCommandCodeModelId,
	COMMAND_CODE_PREFIX,
	type CommandCodeEndpoint,
	commandCodeProviderBase,
	selectCommandCodeEndpoint,
} from "../commandcode-protocol";
import { resolveModelProtocol } from "../settings";
import type { ProxyOverride } from "../settings/types";
import type { UserAgentMode } from "../user-agent";
import { AnthropicProvider } from "./anthropic-provider";
import { OpenAIProvider } from "./openai-provider";
import type { ProviderAdapter } from "./provider";

export { COMMAND_CODE_PREFIX };

export interface CommandCodeProviderSettings {
	disabled?: boolean;
	/** 从 Studio 生成的 API key；填了就完全不需要安装 CLI。 */
	apiKey?: string;
	/** 自定义 base，便于上游改址或走代理；默认是 Provider API 根。 */
	baseUrl?: string;
	/** 逐模型的端点覆盖，优先于按模型名的默认规则。 */
	endpoints?: Record<string, CommandCodeEndpoint>;
	/** 代理覆盖；与其它 provider 的语义一致（默认跟随全局）。 */
	proxy?: ProxyOverride;
	/** UA 指纹：默认 narrafork，可伪装成 Claude Code / Codex。 */
	userAgentMode?: UserAgentMode;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
}

/** 未登录或已停用时返回 undefined，由上层给出可读提示。 */
export function buildCommandCodeProvider(
	model: string,
	config?: CommandCodeProviderSettings,
	/** 实例自己的前缀；省略时是内置的那一条。 */
	prefix: string = COMMAND_CODE_PREFIX,
): ProviderAdapter | undefined {
	if (config?.disabled) return undefined;
	const auth = resolveCommandCodeToken(config?.apiKey);
	if (!auth.credential) return undefined;
	const bare = bareCommandCodeModelId(model, prefix);
	const shared = {
		id: "CommandCode",
		name: "Command Code",
		prefix,
		apiKey: auth.credential.token,
		defaultModel: bare || model,
		baseUrl: commandCodeProviderBase(config?.baseUrl),
		proxy: config?.proxy,
		userAgentMode: config?.userAgentMode,
		customUserAgent: config?.customUserAgent,
		extraHeaders: config?.extraHeaders,
	};
	// 逐模型协议：优先取设置页里为该模型显式选择的协议（「编辑此连接覆盖」保存的那层优先），
	// 其次用 commandCode.endpoints、目录里的 supported_endpoints，最后按裸模型名推断。
	const chosen = resolveModelProtocol(prefix, model);
	const endpoint = selectCommandCodeEndpoint(bare || model, {
		protocol: chosen,
		overrides: config?.endpoints,
		// 目录按实例自己的凭据缓存：不同实例可能是不同上游。
		supportedEndpoints: getCachedCommandCodeModel(bare, config?.apiKey, config?.baseUrl)?.endpoints,
		prefix,
	});
	if (endpoint === "messages") {
		return new AnthropicProvider(shared);
	}
	return new OpenAIProvider({
		...shared,
		apiMode: endpoint === "responses" ? "responses" : "completions",
	});
}
