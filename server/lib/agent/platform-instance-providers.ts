// 额外的「平台集成」实例。
//
// 三个平台原本各有一个固定前缀（codex / CommandCode / tokendance），由 provider.ts 里各自的
// 单例注册解析。方案 A 允许同一平台存在多个实例，实例存进 `agent.platformInstances`，
// 前缀由用户决定（如 `codex-2`）。这里只负责**内置前缀之外**的那些实例：
// 内置前缀仍走原注册，行为与升级前完全一致。

import { settings } from "../settings";
import {
	PLATFORM_DEFAULTS,
	type PlatformInstance,
	type PlatformInstanceKind,
	resolvePlatformInstances,
} from "../settings/platform-instances";
import { CodexProvider } from "./codex-provider";
import { buildCommandCodeProvider, type CommandCodeProviderSettings } from "./commandcode-provider";
import type { ProviderAdapter } from "./provider";
import { TokenDanceProvider } from "./tokendance-provider";

const BUILTIN_PREFIXES = new Set<string>(Object.values(PLATFORM_DEFAULTS).map((d) => d.prefix));

/** 当前生效的实例清单（实例优先，否则由旧单例合成）。 */
export function currentPlatformInstances(): PlatformInstance[] {
	return resolvePlatformInstances({
		instances: settings.agent?.platformInstances,
		legacy: { codex: settings.codex, commandCode: settings.commandCode },
		disabledProviders: settings.agent?.disabledProviders,
	});
}

function codexOptions(config: Record<string, unknown>) {
	const credentialIds = Array.isArray(config.credentialIds)
		? config.credentialIds.filter((id): id is string => typeof id === "string")
		: [];
	return {
		useWebSocket: (config.useWebSocket as boolean | undefined) ?? true,
		useWebSearch: (config.useWebSearch as boolean | undefined) ?? true,
		useImageGeneration: (config.useImageGeneration as boolean | undefined) ?? true,
		// 实例只在自己的凭据集合里选；没选就是没配置，不会借用内置平台的凭据。
		...(credentialIds.length > 0 ? { credentialIds } : {}),
	};
}

/** 实例自己的 TokenDance apiKey；没有再回退是刻意的——实例绝不共用其它平台的连接。 */
function instanceTokenDanceApiKey(instance: PlatformInstance): string | undefined {
	const apiKey = instance.config?.apiKey;
	return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined;
}

/**
 * 解析一个**非内置前缀**的平台实例。
 *
 * 返回 null 表示这个前缀不属于额外实例，交给其它 provider 来源继续匹配。
 */
export function resolvePlatformInstanceAdapter(
	prefix: string,
	model: string,
	instances: readonly PlatformInstance[] = currentPlatformInstances(),
): ProviderAdapter | null {
	if (BUILTIN_PREFIXES.has(prefix)) return null;
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
			// 每个实例必须有自己的 apiKey；没配置就没有 adapter，不借用全局连接。
			return instanceTokenDanceApiKey(instance) ? new TokenDanceProvider() : null;
		default:
			return null;
	}
}

function isConfigured(instance: PlatformInstance): boolean {
	switch (instance.platform) {
		case "tokendance":
			return instanceTokenDanceApiKey(instance) !== undefined;
		case "codex":
			return (
				Array.isArray(instance.config?.credentialIds) && instance.config.credentialIds.length > 0
			);
		default:
			return Object.keys(instance.config ?? {}).length > 0;
	}
}

/** 额外实例的就绪信息；内置前缀的条目由 provider.ts 原有注册负责。 */
export function listPlatformInstanceReadiness(
	instances: readonly PlatformInstance[] = currentPlatformInstances(),
): Array<{ id: string; prefix: string; name: string; ready: boolean }> {
	return instances
		.filter((instance) => !BUILTIN_PREFIXES.has(instance.prefix))
		.map((instance) => ({
			id: instance.id,
			prefix: instance.prefix,
			name: instance.name,
			ready: !instance.disabled && isConfigured(instance),
		}));
}

/** 供 UI 与诊断使用：实例的平台种类。 */
export function platformKindOf(instance: PlatformInstance): PlatformInstanceKind {
	return instance.platform;
}
