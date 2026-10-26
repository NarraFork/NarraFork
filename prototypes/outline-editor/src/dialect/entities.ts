/** 字符实体解码（不依赖 DOM）。原型只认数字实体和常见命名实体；不认识的保持原样。 */
const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	laquo: "«",
	raquo: "»",
	middot: "·",
	times: "×",
};

export const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/y;

/** 在 s[i] 处尝试解码一个实体，返回 [解码结果, 消耗的源码长度] 或 null。 */
export function decodeEntityAt(s: string, i: number): [string, number] | null {
	if (s.charCodeAt(i) !== 38 /* & */) return null;
	ENTITY_RE.lastIndex = i;
	const m = ENTITY_RE.exec(s);
	if (!m) return null;
	const body = m[1];
	let out: string | undefined;
	if (body[0] === "#") {
		const cp =
			body[1] === "x" || body[1] === "X"
				? Number.parseInt(body.slice(2), 16)
				: Number.parseInt(body.slice(1), 10);
		if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) out = "�";
		else out = String.fromCodePoint(cp);
	} else {
		out = NAMED[body];
	}
	if (out === undefined) return null;
	return [out, m[0].length];
}

/** 文本里的 & 后面如果像实体，序列化时要转义。 */
export function looksLikeEntity(s: string, i: number): boolean {
	ENTITY_RE.lastIndex = i;
	return ENTITY_RE.test(s);
}
