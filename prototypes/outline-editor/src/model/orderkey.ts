/**
 * 同级排序键（分数索引）：字符串按码元比较。字母表 0-9A-Za-z。
 * keyBetween(a, b) 返回严格位于 a、b 之间的键；a 为 null 表示最前，b 为 null 表示最后。
 */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

function digit(s: string, i: number, fallback: number): number {
	if (i >= s.length) return fallback;
	return DIGITS.indexOf(s[i]);
}

export function keyBetween(a: string | null, b: string | null): string {
	if (a !== null && b !== null && a >= b) throw new Error(`keyBetween: ${a} >= ${b}`);
	const lo = a ?? "";
	let out = "";
	for (let i = 0; ; i++) {
		const da = digit(lo, i, 0);
		const db = b === null ? BASE : digit(b, i, BASE);
		if (da === db) {
			out += DIGITS[da];
			continue;
		}
		if (db - da > 1) {
			const mid = Math.floor((da + db) / 2);
			const key = out + DIGITS[mid];
			// 不以 0 结尾，避免出现 "a" 与 "a0" 之间没有空间
			return key.endsWith("0") ? `${key}V` : key;
		}
		// 相邻：取 a 的这一位，往后找
		out += DIGITS[da];
		// 之后上界不再受 b 约束
		const rest = keyBetween(lo.length > i + 1 ? lo.slice(i + 1) : null, null);
		return out + rest;
	}
}

/** 在 a、b 之间生成 n 个递增的键。 */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
	const out: string[] = [];
	let lo = a;
	for (let i = 0; i < n; i++) {
		const k = keyBetween(lo, b);
		out.push(k);
		lo = k;
	}
	return out;
}
