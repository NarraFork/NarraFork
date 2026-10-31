// 「平台集成」实例的统一视图。
//
// 方案 A：同一平台可以存在多个实例，它们存在 `agent.platformInstances` 里；更早的版本把
// 每个平台写成单例字段（`agent.codex`、`agent.commandCode`、TokenDance 的连接记录）。
// 这里把两种来源合成同一份清单，供解析、列表与迁移使用：
//   - 有实例清单就用它（不再看旧字段，避免同一条配置出现两次）；
//   - 没有实例时按旧字段合成，prefix 沿用平台默认值，disabled 取自 `disabledProviders`。
//
// 纯函数，不读全局 settings，便于单测与迁移脚本复用。

export type PlatformInstanceKind = "codex" | "CommandCode" | "tokendance";

export interface PlatformInstance {
	id: string;
	platform: PlatformInstanceKind;
	name: string;
	/** 用户可改的后缀；空串表示沿用平台默认前缀。 */
	suffix: string;
	/** 模型 ID 前缀（`<prefix>:<model>`），必须全局唯一。 */
	prefix: string;
	disabled: boolean;
	/** 各平台原有的配置形状。 */
	config: Record<string, unknown>;
}

/** 平台默认前缀与显示名：旧单例迁移与「添加」弹窗的默认值都用它。 */
export const PLATFORM_DEFAULTS: Record<PlatformInstanceKind, { prefix: string; name: string }> = {
	codex: { prefix: "codex", name: "Codex" },
	CommandCode: { prefix: "CommandCode", name: "Command Code" },
	tokendance: { prefix: "tokendance", name: "TokenDance" },
};

export interface PlatformInstanceSource {
	instances?: readonly PlatformInstance[] | null;
	/** 旧单例字段；键是设置里的字段名（`commandCode` 小写开头）；空对象表示从未配置过。 */
	legacy?: Partial<Record<"codex" | "commandCode" | "tokendance", unknown>>;
	/** 旧版的逐 provider 停用清单，迁移时映射到实例的 disabled。 */
	disabledProviders?: readonly string[];
}

/** 平台标识 → 旧单例字段名。 */
const LEGACY_KEYS: Record<PlatformInstanceKind, "codex" | "commandCode" | "tokendance"> = {
	codex: "codex",
	CommandCode: "commandCode",
	tokendance: "tokendance",
};

function hasConfig(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

/**
 * 合成实例清单。
 *
 * 旧单例只有在「确实配置过」（非空对象）时才生成实例：空对象意味着用户从未启用该平台，
 * 凭空造一条实例会让供应商列表多出三个未配置的条目。
 */
export function resolvePlatformInstances(source: PlatformInstanceSource): PlatformInstance[] {
	const explicit = source.instances ?? [];
	if (explicit.length > 0) return explicit.map((instance) => ({ ...instance }));

	const disabled = new Set(source.disabledProviders ?? []);
	const result: PlatformInstance[] = [];
	for (const platform of Object.keys(PLATFORM_DEFAULTS) as PlatformInstanceKind[]) {
		// 设置字段名与平台标识只有 CommandCode 大小写不同，这里显式映射一次。
		const config = source.legacy?.[LEGACY_KEYS[platform]];
		if (!hasConfig(config)) continue;
		const defaults = PLATFORM_DEFAULTS[platform];
		result.push({
			id: `platform-${platform}`,
			platform,
			name: defaults.name,
			suffix: "",
			prefix: defaults.prefix,
			disabled: disabled.has(defaults.prefix),
			config: { ...config },
		});
	}
	return result;
}

/** 前缀唯一性校验，供保存前检查与「添加」弹窗使用。 */
export function duplicateInstancePrefixes(
	instances: readonly Pick<PlatformInstance, "prefix">[],
): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const { prefix } of instances) {
		if (seen.has(prefix)) duplicates.add(prefix);
		seen.add(prefix);
	}
	return [...duplicates];
}
