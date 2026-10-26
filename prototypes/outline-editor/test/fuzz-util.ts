/** 模糊测试用的随机块体生成与比较工具（不依赖 DOM）。 */
import type { Body, Inline, Mark } from "../src/dialect/types";

export function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PIECES = [
	"a",
	"b",
	"word",
	"snake_case",
	"中文",
	"块",
	" ",
	" ",
	"  ",
	"*",
	"_",
	"~",
	"`",
	"[",
	"]",
	"(",
	")",
	"!",
	"<",
	">",
	"&",
	"&amp;",
	"$",
	"|",
	"#",
	"-",
	"+",
	"=",
	":",
	".",
	"1.",
	"\\",
	'"',
	"'",
	"::",
	"http://x.y",
	"[[",
	"]]",
	"<b>",
	"---",
	"```",
];

export function randomText(r: () => number, max = 6): string {
	let s = "";
	const n = 1 + Math.floor(r() * max);
	for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)];
	return s;
}

const MARKS: Mark["type"][] = ["strong", "em", "code", "strike", "link"];

export function randomInline(r: () => number, opts: { br: boolean; mention: boolean }): Inline[] {
	const out: Inline[] = [];
	const n = 1 + Math.floor(r() * 6);
	for (let i = 0; i < n; i++) {
		const x = r();
		if (opts.br && x < 0.1) {
			out.push({ type: "br" });
			continue;
		}
		const marks: Mark[] = [];
		for (const m of MARKS) {
			if (r() < 0.18)
				marks.push(
					m === "link" ? { type: "link", href: "https://e.x/a", title: null } : { type: m },
				);
		}
		if (opts.mention && x < 0.2) {
			out.push({
				type: "mention",
				ref: r() < 0.5 ? "sp/abc" : "P1/b2",
				label: r() < 0.5 ? null : "标签",
				marks: marks.filter((m) => m.type !== "code" && m.type !== "link"),
			});
			continue;
		}
		out.push({ type: "text", text: randomText(r), marks });
	}
	return out;
}

export function randomBody(r: () => number): Body {
	const x = r();
	if (x < 0.55) return { type: "paragraph", content: randomInline(r, { br: true, mention: true }) };
	if (x < 0.65)
		return {
			type: "heading",
			level: (1 + Math.floor(r() * 3)) as 1 | 2 | 3,
			content: randomInline(r, { br: false, mention: true }),
		};
	if (x < 0.75) return { type: "quote", content: randomInline(r, { br: true, mention: true }) };
	if (x < 0.85) {
		const lines = Array.from({ length: 1 + Math.floor(r() * 3) }, () => randomText(r));
		return { type: "code", lang: r() < 0.5 ? "" : "ts", text: lines.join("\n") };
	}
	const cols = 1 + Math.floor(r() * 3);
	const rows = 1 + Math.floor(r() * 3);
	return {
		type: "table",
		align: Array.from(
			{ length: cols },
			() => [null, "left", "center", "right"][Math.floor(r() * 4)] as never,
		),
		rows: Array.from({ length: rows }, () =>
			Array.from({ length: cols }, () => randomInline(r, { br: false, mention: true })),
		),
	};
}

/** 逐字符的「字 + 标记集合」，空白字符上的标记不计（序列化会把边缘空白挪到标记外面）。 */
export function charMarks(content: Inline[]): string[] {
	const out: string[] = [];
	for (const n of content) {
		if (n.type === "br") out.push("\n");
		else if (n.type === "mention") {
			const ms = n.marks
				.map((m) => m.type)
				.sort()
				.join(",");
			out.push(`@${n.ref}|${n.label ?? ""}{${ms}}`);
		} else {
			const ms = n.marks
				.map((m) => (m.type === "link" ? `link:${m.href}` : m.type))
				.sort()
				.join(",");
			for (const ch of n.text)
				out.push(/\s/.test(ch) && !ms.includes("code") ? ch : `${ch}{${ms}}`);
		}
	}
	return out;
}

export function plain(content: Inline[]): string {
	return content
		.map((n) => (n.type === "br" ? "\n" : n.type === "mention" ? `@${n.ref}` : n.text))
		.join("");
}

export function bodyInline(b: Body): Inline[][] {
	if (b.type === "table") return b.rows.flat();
	if (b.type === "code") return [[{ type: "text", text: b.text, marks: [] }]];
	if (b.type === "embed") return [];
	return [b.content];
}
