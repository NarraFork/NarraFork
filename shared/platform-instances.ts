/**
 * 平台实例的命名与后缀规则。
 *
 * 「平台集成」（Codex / Command Code / TokenDance）允许同一平台存在多个实例，实例靠
 * `prefix` 区分（模型 value 是 `<prefix>:<model>`），而 `prefix` 必须唯一且能安全用于
 * 模型 ID。添加新实例时默认给一个数字后缀（`codex-2`、`codex-3`…），用户可以在弹窗里
 * 改成任意合法后缀；这里只负责纯计算与校验，不碰设置存储。
 */

/** 后缀允许的字符与模型 ID 的约束一致：不接受冒号，避免把 `<prefix>:<model>` 拆错。 */
const SUFFIX_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidInstanceSuffix(suffix: string): boolean {
	return SUFFIX_PATTERN.test(suffix);
}

/** 把平台基础前缀与后缀拼成实例前缀；空后缀表示沿用基础前缀。 */
export function composeInstancePrefix(basePrefix: string, suffix: string): string {
	const trimmed = suffix.trim();
	return trimmed ? `${basePrefix}-${trimmed}` : basePrefix;
}

/** 从实例前缀里拆回后缀，用于回显（`codex-2` → `2`，`codex` → ""）。 */
export function splitInstanceSuffix(basePrefix: string, prefix: string): string {
	if (prefix === basePrefix) return "";
	const head = `${basePrefix}-`;
	return prefix.startsWith(head) ? prefix.slice(head.length) : "";
}

/**
 * 默认后缀：从 2 开始取第一个未被占用的数字。
 *
 * 用「已有前缀」而不是「已有后缀」判断，才能避开 `codex-2` 与用户自定义 `codex-2` 撞车；
 * `taken` 里应当同时包含其他平台实例的前缀。
 */
export function nextInstanceSuffix(basePrefix: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	for (let n = 2; ; n += 1) {
		if (!used.has(composeInstancePrefix(basePrefix, String(n)))) return String(n);
	}
}

export interface InstanceNamingInput {
	basePrefix: string;
	/** 平台显示名，例如 `Codex`。 */
	baseName: string;
	/** 已存在的实例前缀（含其他平台）。 */
	takenPrefixes: Iterable<string>;
	/** 已存在的实例显示名，用于避免重名。 */
	takenNames: Iterable<string>;
}

export interface InstanceNaming {
	suffix: string;
	name: string;
	prefix: string;
}

/**
 * 新实例的默认命名：后缀与名称同时递增到不冲突。
 *
 * 名称冲突与前缀冲突是两件事（用户可以只改一处），所以两者都从默认后缀出发各自避让。
 */
export function defaultInstanceNaming(input: InstanceNamingInput): InstanceNaming {
	const takenPrefixes = new Set(input.takenPrefixes);
	const takenNames = new Set(input.takenNames);
	for (let n = 2; ; n += 1) {
		const suffix = String(n);
		const prefix = composeInstancePrefix(input.basePrefix, suffix);
		const name = `${input.baseName}-${suffix}`;
		if (!takenPrefixes.has(prefix) && !takenNames.has(name)) return { suffix, name, prefix };
	}
}
