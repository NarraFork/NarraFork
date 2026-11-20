// 「平台集成」实例的解析。
//
// 平台集成本来每个平台只有一条固定记录，现在同一平台可以有多条实例：清单
// `agent.platformInstances` 是唯一事实来源，前缀与配置都来自实例自己的条目。清单里没有
// 这个前缀就没有这个平台——删掉实例（哪怕是迁移出来的那一条）就等于删掉该平台。

import type { PlatformInstanceRow } from "@shared/platform-instances";
import { instanceCardName } from "@shared/platform-instances";
import { isPlatformInstanceUsable, settings } from "../settings";
import type { ProxyOverride } from "../settings/types";
import { getTokenDanceRuntimeConfig } from "../tokendance-runtime";
import { CodexProvider } from "./codex-provider";
import { buildCommandCodeProvider, type CommandCodeProviderSettings } from "./commandcode-provider";
import type { ProviderAdapter } from "./provider";
import { TokenDanceProvider } from "./tokendance-provider";

/** 当前生效的实例清单。 */
export function currentPlatformInstances(): readonly PlatformInstanceRow[] {
	return settings.agent?.platformInstances ?? [];
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value)
		? value.filter((id): id is string => typeof id === "string")
		: undefined;
}

function codexOptions(instance: PlatformInstanceRow) {
	const config = instance.config;
	const credentialIds = stringList(config.credentialIds);
	return {
		prefix: instance.prefix,
		useWebSocket: (config.useWebSocket as boolean | undefined) ?? true,
		useWebSearch: (config.useWebSearch as boolean | undefined) ?? true,
		useImageGeneration: (config.useImageGeneration as boolean | undefined) ?? true,
		// 键存在就用实例自己选的凭据集合（空集合 = 一个都不用）；键不存在才沿用整个账号池。
		...(credentialIds ? { credentialIds } : {}),
		proxy: config.proxy as ProxyOverride | undefined,
		userAgentMode: config.userAgentMode as
			| "narrafork"
			| "claude-code"
			| "codex"
			| "custom"
			| undefined,
		customUserAgent: config.customUserAgent as string | undefined,
		extraHeaders: config.extraHeaders as Record<string, string> | undefined,
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
	instances: readonly PlatformInstanceRow[] = currentPlatformInstances(),
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
	instances: readonly PlatformInstanceRow[] = currentPlatformInstances(),
): ProviderAdapter | null {
	const instance = instances.find((entry) => entry.prefix === prefix);
	if (!instance) return null;
	switch (instance.platform) {
		case "codex":
			return new CodexProvider(codexOptions(instance));
		case "CommandCode":
			return (
				buildCommandCodeProvider(
					model,
					instance.config as CommandCodeProviderSettings,
					instance.prefix,
				) ?? null
			);
		case "tokendance": {
			// 没连接就不接管这个前缀，让同名的自定义供应商继续用；有连接才不允许冲突。
			if (!getTokenDanceRuntimeConfig(prefix)) return null;
			if (hasProviderPrefixConflict(prefix)) {
				throw new Error(
					"TokenDance prefix conflicts with an existing API provider. Rename the existing provider prefix before using TokenDance.",
				);
			}
			return new TokenDanceProvider(prefix);
		}
		default:
			return null;
	}
}

/** 实例的就绪信息，内置与额外实例一视同仁。 */
export function listPlatformInstanceReadiness(
	instances: readonly PlatformInstanceRow[] = currentPlatformInstances(),
): Array<{ id: string; prefix: string; name: string; ready: boolean }> {
	return instances.map((instance) => ({
		id: instance.id,
		prefix: instance.prefix,
		name: instanceCardName(instance.platform, instance.suffix),
		ready: isPlatformInstanceUsable(instance),
	}));
}
