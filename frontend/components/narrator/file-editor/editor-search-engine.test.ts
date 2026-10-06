import { describe, expect, test } from "bun:test";
import { EditorText, encodeText, replaceText, searchText } from "./editor-search-engine";
import { EDITOR_WORKER_LIMITS as L, type SearchOptions } from "./editor-worker-protocol";

const options = (query: string, patch: Partial<SearchOptions> = {}): SearchOptions => ({
	query,
	caseSensitive: true,
	wholeWord: false,
	regexp: false,
	...patch,
});
const oracle = (source: string, query: string, flags = "gmu") =>
	[...source.matchAll(new RegExp(query, flags))].map((match) => ({
		offset: match.index,
		length: match[0].length,
	}));

describe("bounded editor search engine", () => {
	test("literal crosses binary chunk boundaries with original UTF-16 offsets", async () => {
		const source = `${" ".repeat(32767)}😀中文 target\nTARGET\nİ target`;
		const text = new EditorText([source.slice(0, 32768), source.slice(32768)]);
		expect((await searchText(text, options("😀中文"))).matches).toEqual([
			{ offset: 32767, length: 4 },
		]);
		expect((await searchText(text, options("target", { caseSensitive: false }))).matches).toEqual(
			oracle(source, "target", "gim"),
		);
	});
	test("literal NFKD/lowercase preserves legacy sharp-s and astral source offsets", async () => {
		expect(
			(await searchText(new EditorText(["ẞ ß ss"]), options("ß", { caseSensitive: false })))
				.matches,
		).toEqual([
			{ offset: 0, length: 1 },
			{ offset: 2, length: 1 },
		]);
		expect(
			(await searchText(new EditorText(["Σ σ ς"]), options("σ", { caseSensitive: false }))).matches,
		).toEqual([
			{ offset: 0, length: 1 },
			{ offset: 2, length: 1 },
		]);
		expect(
			(await searchText(new EditorText(["K K k"]), options("k", { caseSensitive: false }))).count,
		).toBe(3);
		const source = `${" ".repeat(32767)}𐐀 𐐨`;
		expect(
			(await searchText(new EditorText([source]), options("𐐨", { caseSensitive: false }))).matches,
		).toEqual([
			{ offset: 32767, length: 2 },
			{ offset: 32770, length: 2 },
		]);
	});
	test("partial normalized glyphs are highlighted but never replaced", async () => {
		const text = new EditorText(["İ ﬀ é"]);
		expect((await searchText(text, options("i", { caseSensitive: false }))).matches).toEqual([
			{ offset: 0, length: 1, precise: false },
		]);
		expect(
			(await replaceText(text, options("i", { caseSensitive: false }), "X", true, 0, 1)).edits,
		).toEqual([]);
		expect((await searchText(text, options("ff"))).matches).toEqual([{ offset: 2, length: 1 }]);
		expect((await replaceText(text, options("f"), "X", true, 0, 1)).edits).toEqual([]);
		expect(
			text.apply((await replaceText(text, options("ff"), "X", true, 0, 1)).edits).flatten(),
		).toBe("İ X é");
	});
	test("Unicode regex properties and astral zero-width matches agree with the full-string oracle", async () => {
		const source = "😀𐐀a\n中文 ßẞ\n";
		for (const query of [
			"\\p{L}+",
			"\\p{Script=Han}+",
			"\\p{Emoji}",
			"(?=)",
			"(?<=😀)",
			".",
			"^|$",
		]) {
			for (const caseSensitive of [true, false]) {
				expect(
					(
						await searchText(
							new EditorText([source]),
							options(query, { regexp: true, caseSensitive }),
						)
					).matches,
				).toEqual(oracle(source, query, caseSensitive ? "gmu" : "gimu"));
			}
		}
		const text = new EditorText(["😀𐐀"]);
		const plan = await replaceText(text, options("(?=)", { regexp: true }), "-", true, 0, 1);
		expect(text.apply(plan.edits).flatten()).toBe("😀𐐀".replace(/(?=)/gmu, "-"));
	});
	test("negative chunk prefilter preserves crossing matches and combining/sigma exceptions", async () => {
		const crossing = new EditorText([`${"a".repeat(32765)}bcXYZ`]);
		expect((await searchText(crossing, options("bcXYZ"))).matches).toEqual([
			{ offset: 32765, length: 5 },
		]);
		const combining = new EditorText([`${"x".repeat(1000)}a\u0315\u0300${"x".repeat(40000)}`]);
		expect((await searchText(combining, options("a\u0315"))).matches).toEqual([
			{ offset: 1000, length: 2 },
		]);
		expect(
			(await searchText(new EditorText(["ΟΣ "]), options("σ", { caseSensitive: false }))).matches,
		).toEqual([{ offset: 1, length: 1 }]);
	});
	test("ASCII native path agrees with complete-string results for mixed CJK/emoji chunks", async () => {
		const alphabet = ["a", "b", "C", " ", "\n", "中", "😀"];
		let seed = 123456789;
		let source = Array.from({ length: 50000 }, () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return alphabet[seed % alphabet.length];
		}).join("");
		source = `${source.slice(0, 32766)}abc${source.slice(32766)}`;
		for (const query of ["abc", "aa", "b C", "\nabc", "C"]) {
			for (const caseSensitive of [true, false]) {
				const expected = oracle(source, query, caseSensitive ? "gmu" : "gimu");
				const actual = await searchText(
					new EditorText([source]),
					options(query, { caseSensitive }),
				);
				expect(actual.matches).toEqual(expected.slice(0, L.page));
				expect(actual.count).toBe(Math.min(expected.length, L.cache));
				expect(actual.more).toBe(expected.length > L.cache);
			}
		}
	});
	test("ASCII native path rejects width-changing or partial astral compatibility glyphs", async () => {
		const text = new EditorText(["🅊 HV ﬀ𝔸"]);
		expect((await searchText(text, options("H"))).matches).toEqual([
			{ offset: 0, length: 2, precise: false },
			{ offset: 3, length: 1 },
		]);
		expect((await searchText(text, options("HV"))).matches).toEqual([
			{ offset: 0, length: 2 },
			{ offset: 3, length: 2 },
		]);
		expect((await searchText(text, options("f"))).matches).toEqual([
			{ offset: 6, length: 1, precise: false },
		]);
		expect((await replaceText(text, options("H"), "X", true, 0, 1)).edits).toEqual([
			{ offset: 3, length: 1, text: "X" },
		]);
	});
	test("whole word recognizes CJK, combining marks and astral letters", async () => {
		const source = "x x字 x😀 𐐀x x\u0301 (x)";
		expect(
			(await searchText(new EditorText([source]), options("x", { wholeWord: true }))).matches,
		).toEqual([
			{ offset: 0, length: 1 },
			{ offset: 5, length: 1 },
			{ offset: 17, length: 1 },
		]);
	});
	test("multiline regex, anchors, lookarounds and empty matches agree with full oracle", async () => {
		const source = `${"x".repeat(32760)}\nstart😀\n中文 end\nstart\nlast\n`;
		for (const query of [
			"^start.*$",
			"start[\\s\\S]*?end",
			"(?<=start)😀",
			"(?<name>中文) (end)",
			"^|$",
			"(?=start)",
		])
			expect(
				(await searchText(new EditorText([source]), options(query, { regexp: true }))).matches,
			).toEqual(oracle(source, query));
	});
	test("capture replacement agrees with JS including group-number fallback", async () => {
		const source = "ab\nac\nab";
		const query = "(?<first>a)(b)?";
		for (const replacement of ["$<first>-$2-$$-$&", "$`-$'", "$01-$12-$99-$00", "$<missing>"]) {
			const text = new EditorText([source]);
			const plan = await replaceText(
				text,
				options(query, { regexp: true }),
				replacement,
				true,
				0,
				7,
			);
			expect(plan.revision).toBe(7);
			expect(text.apply(plan.edits).flatten()).toBe(
				source.replace(new RegExp(query, "gm"), replacement),
			);
		}
	});
	test("UTF8 encoder carries valid split surrogate pairs and preserves CRLF", async () => {
		const source = `${"a".repeat(32767)}😀\r\n中`;
		const result = await encodeText(new EditorText([source]));
		expect(result.chunks.every((chunk) => chunk.byteLength <= L.chunkBytes)).toBe(true);
		expect(
			new Uint8Array(
				await new Blob(result.chunks.map((chunk) => new Uint8Array(chunk).buffer)).arrayBuffer(),
			),
		).toEqual(new TextEncoder().encode(source));
		expect(result.bytes).toBe(new TextEncoder().encode(source).byteLength);
	});
	test("UTF8 validation rejects lone surrogates, including at EOF, but permits repairing replacements", async () => {
		for (const value of ["\ud800", "\udc00", "\ud800x", "x\udc00", `${"a".repeat(32768)}\ud800`]) {
			await expect(encodeText(new EditorText([value]))).rejects.toThrow("EDITOR_INVALID_UNICODE");
		}
		await expect(
			replaceText(new EditorText(["valid"]), options("valid"), "\ud800", true, 0, 1),
		).rejects.toThrow("EDITOR_INVALID_UNICODE");
		const broken = new EditorText(["x\ud800"]);
		const repair = await replaceText(broken, options("\ud800"), "", true, 0, 1);
		expect(broken.apply(repair.edits).flatten()).toBe("x");
		expect((await encodeText(new EditorText(["\ufffd"]))).bytes).toBe(3);
	});
	test("paging and batch limits reject instead of partially applying", async () => {
		const text = new EditorText(["x ".repeat(10001)]);
		const page = await searchText(text, options("x"));
		expect(page.matches).toHaveLength(256);
		expect(page.count).toBe(10000);
		expect(page.more).toBe(true);
		expect((await searchText(text, options("x"), 20000)).matches[0].offset).toBe(20000);
		expect((await searchText(text, options("x"), 0, true)).matches[0].offset).toBe(20000);
		await expect(searchText(text, options("x"), 0, false, true)).rejects.toThrow(
			"EDITOR_SELECT_LIMIT",
		);
		await expect(replaceText(text, options("x"), "y", true, 0, 1)).rejects.toThrow(
			"EDITOR_REPLACE_LIMIT",
		);
		expect(text.flatten()).toBe("x ".repeat(10001));
		expect(
			(await replaceText(new EditorText(["x".repeat(10000)]), options("x"), "y", true, 0, 1)).edits,
		).toHaveLength(10000);
		expect(
			(await searchText(new EditorText(["x".repeat(1000)]), options("x"), 0, false, true)).matches,
		).toHaveLength(1000);
	});
	test("invalid regex/query, document limit and pathological replacement expansion", async () => {
		expect(() => new EditorText(["x".repeat(L.textLength + 1)])).toThrow("EDITOR_TEXT_LIMIT");
		await expect(searchText(new EditorText(["a"]), options("x".repeat(4097)))).rejects.toThrow(
			"EDITOR_QUERY_LIMIT",
		);
		await expect(searchText(new EditorText(["a"]), options("[", { regexp: true }))).rejects.toThrow(
			"EDITOR_INVALID_REGEX",
		);
		await expect(
			replaceText(
				new EditorText(["a".repeat(11000)]),
				options("a$", { regexp: true }),
				"$`".repeat(2048),
				true,
				0,
				1,
			),
		).rejects.toThrow("EDITOR_TEXT_LIMIT");
	});
	test("immutable rope applies sorted edits and rejects overlap", () => {
		const text = new EditorText(["abc😀def"]);
		expect(
			text
				.apply([
					{ offset: 1, length: 2, text: "中" },
					{ offset: 5, length: 1, text: "!" },
				])
				.flatten(),
		).toBe("a中😀!ef");
		expect(text.flatten()).toBe("abc😀def");
		expect(() =>
			text.apply([
				{ offset: 2, length: 3, text: "" },
				{ offset: 3, length: 0, text: "" },
			]),
		).toThrow("EDITOR_PROTOCOL");
	});
});
