import { beforeAll, describe, expect, test } from "bun:test";
import { createHighlighterCore } from "shiki/core";
import { createShikiOnigurumaEngine, createWorkerShiki, type ShikiModule } from "./shiki-loader";
import {
	DerivedDocumentCache,
	IncrementalDocumentTokenizer,
	LatestDocumentTask,
	PagedTextDocument,
} from "./text-document-pure-core";
import { documentPacketBytes, sendDocumentParts } from "./text-document-worker-protocol";

let shiki: ShikiModule;
let reference: Awaited<ReturnType<typeof createHighlighterCore>>;
const loadedUrls: string[] = [];
beforeAll(async () => {
	reference = await createHighlighterCore({
		engine: createShikiOnigurumaEngine(),
		langs: [import("@shikijs/langs/javascript")],
		themes: [import("@shikijs/themes/github-dark"), import("@shikijs/themes/github-light")],
	});
	shiki = await createWorkerShiki("https://example.test/proxy/7778/", async (url) => {
		loadedUrls.push(url);
		if (url.endsWith("/javascript.mjs")) return import("@shikijs/langs/javascript");
		if (url.endsWith("/github-dark.mjs")) return import("@shikijs/themes/github-dark");
		if (url.endsWith("/github-light.mjs")) return import("@shikijs/themes/github-light");
		throw new Error(`Unexpected asset ${url}`);
	});
});

async function full(text: string, theme = "github-dark") {
	const output =
		text.length <= 5000
			? reference.codeToTokens(text, {
					lang: "javascript",
					theme,
					tokenizeMaxLineLength: 0,
					tokenizeTimeLimit: 0,
				})
			: await shiki.codeToTokens(text, { lang: "javascript", theme });
	return output.tokens.flatMap((line) =>
		line
			.filter((token) => token.content.length > 0)
			.map((token) => ({
				start: token.offset,
				end: token.offset + token.content.length,
				color: token.color,
				fontStyle: token.fontStyle,
			})),
	);
}
async function assertPrefix(
	source: PagedTextDocument,
	tokenizer: IncrementalDocumentTokenizer,
	text: string,
	theme = "github-dark",
) {
	await tokenizer.update(source);
	expect(tokenizer.range(source, 0, source.length)).toEqual(await full(text, theme));
}

describe("incremental TextMate grammar checkpoints", () => {
	test("every single-character prefix matches full Shiki, including CRLF, escapes, Unicode and recall", async () => {
		const text = `/* 中\r\n😀 */\r\nconst x = \`hi \${"a\\"b"}\nworld\`;\nconst lone = '\ud800';\r\n//tail`;
		const source = new PagedTextDocument();
		const tokenizer = new IncrementalDocumentTokenizer(shiki, "js", "github-dark");
		for (let i = 0; i < text.length; i++) {
			source.append(i, text[i]);
			await assertPrefix(source, tokenizer, text.slice(0, i + 1));
		}
		expect(source.slice(0, source.length)).toBe(text);
		expect(
			loadedUrls.every((url) => url.startsWith("https://example.test/proxy/7778/shiki/")),
		).toBe(true);
	});
	test("all two-part split positions and deterministic random chunk boundaries match full tokens", async () => {
		const text = `/*multi\nline*/\r\nconst template = \`中😀\${1 + 2}\`;\n'\\u1234';\n`;
		for (let split = 0; split <= text.length; split++) {
			const source = new PagedTextDocument();
			const tokenizer = new IncrementalDocumentTokenizer(shiki, "javascript", "github-dark");
			source.append(0, text.slice(0, split));
			await assertPrefix(source, tokenizer, text.slice(0, split));
			source.append(split, text.slice(split));
			await assertPrefix(source, tokenizer, text);
		}
	});
	test("completed rows reuse tokens/state rather than scan or tokenize prior text again", async () => {
		const source = new PagedTextDocument();
		const tokenizer = new IncrementalDocumentTokenizer(shiki, "javascript", "github-dark");
		source.append(0, "const a = 1;\n");
		await tokenizer.update(source);
		const stable = tokenizer.stable[0];
		const before = tokenizer.tokenizedCharacters;
		source.append(source.length, "/* incomplete");
		await tokenizer.update(source);
		expect(tokenizer.stable[0]).toBe(stable);
		expect(tokenizer.tokenizedCharacters - before).toBe("/* incomplete".length);
		await assertPrefix(source, tokenizer, source.slice(0, source.length));
	});
	test("100k and 1MiB single lines highlight without a length/window downgrade", async () => {
		for (const size of [100_000, 1024 * 1024]) {
			const text = `const long = "${"x".repeat(size)}";`;
			const source = new PagedTextDocument();
			const tokenizer = new IncrementalDocumentTokenizer(shiki, "javascript", "github-dark");
			for (let offset = 0; offset < text.length; offset += 8192)
				source.append(offset, text.slice(offset, offset + 8192));
			await assertPrefix(source, tokenizer, text);
			const tokens = tokenizer.range(source, 0, text.length);
			expect(tokens[0].start).toBe(0);
			expect(tokens[tokens.length - 1].end).toBe(text.length);
			expect(
				tokenizer
					.range(source, size - 100, size - 50)
					.every((token) => token.start >= size - 100 && token.end <= size - 50),
			).toBe(true);
		}
	}, 30_000);
	test("language/theme states never cross streams and theme changes match their own full pass", async () => {
		const source = new PagedTextDocument();
		source.append(0, "/* a\nb */ const x=1;");
		const dark = new IncrementalDocumentTokenizer(shiki, "javascript", "github-dark");
		const light = new IncrementalDocumentTokenizer(shiki, "javascript", "github-light");
		await assertPrefix(source, dark, source.slice(0, source.length));
		await assertPrefix(source, light, source.slice(0, source.length), "github-light");
		expect(dark.range(source, 0, source.length)).not.toEqual(light.range(source, 0, source.length));
	});
	test("Worker requires an explicit absolute mount base and failed imports can retry", async () => {
		expect(createWorkerShiki("/nf/")).rejects.toThrow();
		let failed = true;
		const module = await createWorkerShiki("https://example.test/nf/", async (url) => {
			if (failed) {
				failed = false;
				throw new Error("Transient");
			}
			return url.includes("/themes/")
				? import("@shikijs/themes/github-dark")
				: import("@shikijs/langs/javascript");
		});
		await expect(
			module.codeToTokens("const x=1", { lang: "javascript", theme: "github-dark" }),
		).rejects.toThrow("unavailable");
		expect(
			(await module.codeToTokens("const x=1", { lang: "javascript", theme: "github-dark" }))
				.tokens[0].length,
		).toBeGreaterThan(1);
	});
});

describe("bounded scheduling and token transport", () => {
	test("one running task plus one newest target drops only obsolete recomputations", async () => {
		const calls: number[] = [];
		let release!: () => void;
		const first = new Promise<void>((resolve) => {
			release = resolve;
		});
		let finish!: () => void;
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const task = new LatestDocumentTask<number>(
			async (target) => {
				calls.push(target);
				if (target === 1) await first;
				if (target === 100) finish();
			},
			() => {},
		);
		task.push(1);
		await new Promise((resolve) => setTimeout(resolve, 5));
		for (let i = 2; i <= 100; i++) task.push(i);
		expect(task.pending).toBe(1);
		expect(task.maxPending).toBe(1);
		release();
		await done;
		expect(calls).toEqual([1, 100]);
	});
	test("cancel prevents any queued re-computation", async () => {
		let calls = 0;
		const task = new LatestDocumentTask(
			async () => {
				calls++;
			},
			() => {},
		);
		task.push(1);
		task.cancel();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(calls).toBe(0);
	});
	test("cache budget is hard for rebuildable entries, including oversized entries", () => {
		const cache = new DerivedDocumentCache<string>(64);
		cache.set("a", "a", 32);
		cache.set("b", "b", 32);
		cache.get("a");
		cache.set("c", "c", 32);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe("a");
		expect(cache.bytes).toBe(64);
		cache.set("huge", "huge", 65);
		expect(cache.get("huge")).toBeUndefined();
		expect(cache.bytes).toBe(64);
	});
	test("only offsets/styles are sent and all packets stay within 64KiB", () => {
		const tokens = Array.from({ length: 100_000 }, (_, start) => ({
			start,
			end: start + 1,
			color: "#fff",
			fontStyle: 1,
		}));
		let count = 0,
			parts = 0;
		sendDocumentParts(1, "tokens", tokens, (packet) => {
			expect(documentPacketBytes(packet)).toBeLessThanOrEqual(64 * 1024);
			if (packet.type === "part") {
				count += packet.items.length;
				parts++;
				expect(JSON.stringify(packet)).not.toContain("content");
			}
		});
		expect(count).toBe(tokens.length);
		expect(parts).toBeGreaterThan(1);
	});
});
