/**
 * 平台集成实例的命名规则。
 *
 * 「平台集成」（Codex / Command Code / TokenDance）本来每个平台只有一条固定记录。现在同一
 * 平台可以加多条，每条有自己的 `suffix` 与模型前缀 `prefix`：
 *   - 卡片名 = `<平台默认前缀>-<suffix>`（`codex-2`），后缀为空就是平台默认名（`codex`）；
 *   - 模型前缀默认等于卡片名，模型 ID 形如 `codex-2:<model>`；
 *   - 两个字段都留空时，后缀自动取第一个空闲数字（从 1 开始）。
 *
 * 纯计算，不碰设置存储。
 */

export type PlatformInstanceKind = "codex" | "CommandCode" | "tokendance";

/** 平台固定清单：类型只能是这几个，名称与默认前缀在这里定义一次。 */
export const PLATFORM_DEFAULTS: Record<PlatformInstanceKind, { prefix: string; label: string }> = {
	codex: { prefix: "codex", label: "Codex" },
	CommandCode: { prefix: "CommandCode", label: "Command Code" },
	tokendance: { prefix: "tokendance", label: "TokenDance" },
};

export const PLATFORM_INSTANCE_KINDS = Object.keys(PLATFORM_DEFAULTS) as PlatformInstanceKind[];

/** 一条平台实例；`config` 的字段由所属平台决定。 */
export interface PlatformInstanceRow {
	id: string;
	platform: PlatformInstanceKind;
	/** 卡片标记的后缀，任意可见字符；空串表示平台默认那一条。 */
	suffix: string;
	/** 模型 ID 前缀（`<prefix>:<model>`），全局唯一。 */
	prefix: string;
	disabled: boolean;
	config: Record<string, unknown>;
}

/** 卡片名：默认那一条用平台的显示名，带后缀时用 `平台前缀-后缀`（`codex-1`）。 */
export function instanceCardName(platform: PlatformInstanceKind, suffix: string): string {
	const { prefix, label } = PLATFORM_DEFAULTS[platform];
	const trimmed = suffix.trim();
	return trimmed ? `${prefix}-${trimmed}` : label;
}

/**
 * 新建实例的默认后缀：从 1 开始取第一个让卡片名与模型前缀都不冲突的数字。
 *
 * 两个集合都要看：前缀可以单独填，所以别人的前缀也可能正好等于这张卡片名。
 */
export function nextInstanceSuffix(input: {
	platform: PlatformInstanceKind;
	takenNames: Iterable<string>;
	takenPrefixes: Iterable<string>;
}): string {
	const takenNames = new Set(input.takenNames);
	const takenPrefixes = new Set(input.takenPrefixes);
	for (let n = 1; ; n += 1) {
		const suffix = String(n);
		const name = instanceCardName(input.platform, suffix);
		if (!takenNames.has(name) && !takenPrefixes.has(name)) return suffix;
	}
}

/** 模型前缀留空时用卡片名。 */
export function resolveInstancePrefix(
	platform: PlatformInstanceKind,
	suffix: string,
	prefix: string,
): string {
	return prefix.trim() || instanceCardName(platform, suffix);
}
