// 「平台集成」实例的解析。
//
// 三个平台的实例都存进 `agent.platformInstances`，前缀可以是默认的（`codex`）也可以是
// 用户新增实例自动生成的（`codex-2`）。清单是唯一事实来源：清单里没有这个前缀，就没有
// 这个平台——删掉内置实例就等于删掉该平台，把清单删空也不会把旧配置合成回来。

import { isPlatformInstanceUsable, settings } from "../settings";
import { PLATFORM_DEFAULTS, type PlatformInstance } from "../settings/platform-instances";
import { getTokenDanceRuntimeConfig } from "../tokendance-runtime";
import { CodexProvider } from "./codex-provider";
import { buildCommandCodeProvider, type CommandCodeProviderSettings } from "./commandcode-provider";
import type { ProviderAdapter } from "./provider";
import { TokenDanceProvider } from "./tokendance-provider";

/** 当前生效的实例清单（清单为空就是没有平台）。 */
export function currentPlatformInstances(): PlatformInstance[] {
	return settings.agent?.platformInstances ?? [];
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value)
		? value.filter((id): id is string => typeof id === "string")
		: undefined;
}

/** 额外实例自己的 TokenDance apiKey；没配置就没有连接。 */
function instanceApiKey(instance: PlatformInstance): string | undefined {
	const apiKey = instance.config.apiKey;
	return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined;
}

/**
 * 这个前缀有没有 TokenDance 连接。
 *
 * 默认前缀沿用 `settings.tokendance` 那条记录（运行时桥按前缀解析）；额外实例只认自己
 * config 里的 apiKey——两边都不借用别人的连接。
 */
function hasTokenDanceConnection(instance: PlatformInstance): boolean {
	return instance.prefix === PLATFORM_DEFAULTS.tokendance.prefix
		? !!getTokenDanceRuntimeConfig(instance.prefix)
		: instanceApiKey(instance) !== undefined;
}

function codexOptions(config: Record<string, unknown>) {
	const credentialIds = stringList(config.credentialIds);
	return {
		useWebSocket: (config.useWebSocket as boolean | undefined) ?? true,
		useWebSearch: (config.useWebSearch as boolean | undefined) ?? true,
		useImageGeneration: (config.useImageGeneration as boolean | undefined) ?? true,
		// 只有实例自己选过凭据（键存在）才限定候选。初始实例没有这个键，沿用整个凭据池，
		// 升级前后的行为完全一致；额外实例选了空集合就是不配，不会借用别人的凭据。
		...(credentialIds ? { credentialIds } : {}),
	};
}

/**
 * 这个前缀是否已被自定义 API 供应商占用。
 *
 * TokenDance 与它们共用前缀空间；撞车时静默选错上游会把密钥发到别的服务，代价远高于
 * 一次明确的配置错误，所以解析直接报错、就绪判断也一律不通过。
 */
export function hasProviderPrefixConflict(prefix: string): boolean {
	return [
		...(settings.customApiProviders ?? []),
		...(settings.openaiProviders ?? []),
		...(settings.anthropicProviders ?? []),
		...(settings.geminiProviders ?? []),
		...(settings.nugProviders ?? []),
	].some((entry) => entry.prefix === prefix);
}

/** 与 API 供应商撞车的 TokenDance 实例前缀。 */
export function platformPrefixConflicts(
	instances: readonly PlatformInstance[] = currentPlatformInstances(),
): string[] {
	return instances
		.filter((instance) => instance.platform === "tokendance")
		.map((instance) => instance.prefix)
		.filter(hasProviderPrefixConflict);
}

/**
 * 解析一个平台实例前缀；返回 null 表示这个前缀不属于任何实例。
 *
 * 内置前缀与额外前缀走同一条路径，区别只在实例自己的 config。
 */
export function resolvePlatformInstanceAdapter(
	prefix: string,
	model: string,
	instances: readonly PlatformInstance[] = currentPlatformInstances(),
): ProviderAdapter | null {
	const instance = instances.find((entry) => entry.prefix === prefix);
	if (!instance) return null;
	switch (instance.platform) {
		case "codex":
			return new CodexProvider(codexOptions(instance.config));
		case "CommandCode":
			return (
				buildCommandCodeProvider(model, instance.config as CommandCodeProviderSettings) ?? null
			);
		case "tokendance":
			// 没连接就不接管这个前缀，让同名的自定义供应商继续用；有连接才不允许冲突。
			if (!hasTokenDanceConnection(instance)) return null;
			if (hasProviderPrefixConflict(prefix)) {
				throw new Error(
					"TokenDance prefix conflicts with an existing API provider. Rename the existing provider prefix before using TokenDance.",
				);
			}
			return new TokenDanceProvider(prefix);
		default:
			return null;
	}
}

/** 实例的就绪信息，内置与额外实例一视同仁。 */
export function listPlatformInstanceReadiness(
	instances: readonly PlatformInstance[] = currentPlatformInstances(),
): Array<{ id: string; prefix: string; name: string; ready: boolean }> {
	return instances.map((instance) => ({
		id: instance.id,
		prefix: instance.prefix,
		name: instance.name,
		ready: isPlatformInstanceUsable(instance),
	}));
}
