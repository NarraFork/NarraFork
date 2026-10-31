// 「平台集成」实例的初始清单。
//
// 同一平台可以有多条实例，它们存在 `agent.platformInstances` 里，每条有自己的模型前缀与
// 配置。清单的第一个版本由旧的单例字段（`codex` / `commandCode` / `tokendance`）生成：
// 每个平台一条、后缀为空、前缀用平台默认值，配置从旧字段原样搬过来，因此升级前后的行为
// 完全一致。之后清单就是唯一事实来源。

import {
	PLATFORM_DEFAULTS,
	type PlatformInstanceKind,
	type PlatformInstanceRow,
} from "../../../shared/platform-instances";

export type { PlatformInstanceKind, PlatformInstanceRow };

/** 迁移来源：三个平台旧的单例字段，键是设置里的字段名（`commandCode` 小写开头）。 */
export interface LegacyPlatformSettings {
	codex?: Record<string, unknown>;
	commandCode?: Record<string, unknown>;
	tokendance?: Record<string, unknown>;
}

/** Codex 实例里属于实例自己的字段；账号池的负载均衡与分层顺序仍是全局策略。 */
const CODEX_INSTANCE_FIELDS = [
	"useWebSocket",
	"useWebSearch",
	"useImageGeneration",
	"proxy",
	"userAgentMode",
	"customUserAgent",
	"extraHeaders",
	"defaultReasoningEffort",
] as const;

function pick(source: Record<string, unknown> | undefined, keys: readonly string[]) {
	const result: Record<string, unknown> = {};
	for (const key of keys) {
		if (source?.[key] !== undefined) result[key] = source[key];
	}
	return result;
}

/**
 * 每个平台一条初始实例。
 *
 * 只在设置文件里还没有清单时调用一次；之后删掉实例（哪怕全删）都不会再生成。
 */
export function initialPlatformInstances(legacy: LegacyPlatformSettings): PlatformInstanceRow[] {
	return (Object.keys(PLATFORM_DEFAULTS) as PlatformInstanceKind[]).map((platform) => {
		const config =
			platform === "codex"
				? pick(legacy.codex, CODEX_INSTANCE_FIELDS)
				: { ...(legacy[platform === "CommandCode" ? "commandCode" : platform] ?? {}) };
		return {
			id: `platform-${platform}`,
			platform,
			suffix: "",
			prefix: PLATFORM_DEFAULTS[platform].prefix,
			disabled: false,
			config,
		};
	});
}
