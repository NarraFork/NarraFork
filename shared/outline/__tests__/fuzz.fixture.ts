/** Random dialect bodies for the fuzz tests (deterministic, seeded). */
import type { Align, Body, Inline, Mark } from "../dialect/types";

/** mulberry32: small, fast, deterministic. */
export function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function pick<T>(r: () => number, xs: readonly T[]): T {
	return xs[Math.floor(r() * xs.length)] as T;
}

/** Per-test timeout for fuzz tests, generous enough for large `OUTLINE_FUZZ_N` runs. */
export const FUZZ_TIMEOUT_MS = 10 * 60_000;

/** Fuzz case count: `OUTLINE_FUZZ_N` overrides the default (e.g. `OUTLINE_FUZZ_N=14000`). */
export function fuzzCount(defaultN: number): number {
	const n = Number(process.env.OUTLINE_FUZZ_N);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultN;
}

/** Adversarial pieces: delimiters, escapes, entities, line-start constructs, URLs. */
const PIECES = [
	"a",
	"b",
	"word",
	"snake_case",
	"中文",
	"块",
	"，",
	"：",
	"「",
	"」",
	" ",
	" ",
	"  ",
	"\t",
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
	"&hearts;",
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
	"@",
	"http://x.y",
	"https://e.x/a_b?c=1",
	"www.e.x",
	"me@e.x",
	"[[",
	"]]",
	"<b>",
	"---",
	"```",
];

export function randomText(r: () => number, max = 6): string {
	let s = "";
	const n = 1 + Math.floor(r() * max);
	for (let i = 0; i < n; i++) s += pick(r, PIECES);
	return s;
}

const MARKS: Mark["type"][] = ["strong", "em", "code", "strike", "link"];
const REFS = ["sp/abc", "P1/b2", "Q17", "token 刷新", "a*b", "_x_", "C++", "a\\", "x&amp;y", "<b>"];
const LABELS = ["标签", "a|b", "*x*", " 空格 ", "", "~~s~~", "\\", "`c`"];
const HREFS = ["https://e.x/a", "https://e.x/a b", "/p_q", "https://e.x/(x)"];

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
					m === "link"
						? { type: "link", href: pick(r, HREFS), title: r() < 0.2 ? 'a "t"' : null }
						: { type: m },
				);
		}
		if (opts.mention && x < 0.2) {
			out.push({
				type: "mention",
				ref: pick(r, REFS),
				label: r() < 0.5 ? null : pick(r, LABELS),
				marks: marks.filter((m) => m.type !== "code" && m.type !== "link"),
			});
			continue;
		}
		out.push({ type: "text", text: randomText(r), marks });
	}
	return out;
}

const ALIGNS: Align[] = [null, "left", "center", "right"];

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
	if (x < 0.88) return { type: "embed", ref: pick(r, REFS), label: r() < 0.5 ? null : "e" };
	const cols = 1 + Math.floor(r() * 3);
	const rows = 1 + Math.floor(r() * 3);
	return {
		type: "table",
		align: Array.from({ length: cols }, () => pick(r, ALIGNS)),
		rows: Array.from({ length: rows }, () =>
			Array.from({ length: cols }, () => randomInline(r, { br: false, mention: true })),
		),
	};
}

/** Mixed Chinese/English prose with marks on word boundaries and next to CJK punctuation. */
const WORDS = [
	"大纲",
	"编辑器",
	"块",
	"模型",
	"是",
	"真相",
	"，",
	"。",
	"：",
	"「",
	"」",
	"（",
	"）",
	"outline",
	"block",
	"editor",
	" ",
	" ",
	"100%",
	"D23",
	"snake_case",
	"!",
];

export function realisticParagraph(r: () => number): Body {
	const content: Inline[] = [];
	const n = 2 + Math.floor(r() * 8);
	for (let i = 0; i < n; i++) {
		let text = "";
		const k = 1 + Math.floor(r() * 4);
		for (let j = 0; j < k; j++) text += pick(r, WORDS);
		const marks: Mark[] = [];
		const x = r();
		if (x < 0.15) marks.push({ type: "strong" });
		else if (x < 0.25) marks.push({ type: "em" });
		else if (x < 0.3) marks.push({ type: "code" });
		else if (x < 0.33) marks.push({ type: "strike" });
		if (r() < 0.08) content.push({ type: "mention", ref: "P1/b2", label: null, marks: [] });
		content.push({ type: "text", text, marks });
	}
	return { type: "paragraph", content };
}

export function plain(content: Inline[]): string {
	return content
		.map((n) => (n.type === "br" ? "\n" : n.type === "mention" ? `@${n.ref}` : n.text))
		.join("");
}
