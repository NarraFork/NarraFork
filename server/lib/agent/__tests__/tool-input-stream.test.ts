import { describe, expect, test } from "bun:test";
import { ToolInputStream } from "../tool-input-stream";

describe("ToolInputStream", () => {
	test("every split preserves decoded UTF-16, escapes, CRLF and field closure order", () => {
		const input = { file_path: "a\r\nb", old_string: 'a\\"\b\f\n\r\t/😀', new_string: "尾😀\r\n" };
		const raw = JSON.stringify(input).replaceAll("😀", "\\ud83d\\ude00");
		for (let split = 0; split <= raw.length; split++) {
			const stream = new ToolInputStream(["file_path"], ["old_string", "new_string"]);
			const events = [];
			stream.feed(raw.slice(0, split));
			events.push(...stream.drainFields());
			stream.feed(raw.slice(split));
			events.push(...stream.drainFields());
			for (const name of ["old_string", "new_string"] as const) {
				const fields = events.filter((event) => event.name === name);
				let text = "";
				for (const field of fields) {
					expect(field.offset).toBe(text.length);
					text += field.delta;
				}
				expect(text).toBe(input[name]);
				expect(fields[0].startsField).toBe(true);
				expect(fields.at(-1)?.complete).toBe(true);
			}
			expect(stream.takeShortFields()).toEqual({ file_path: input.file_path });
			expect(stream.finish()).toEqual(input);
		}
	});

	test("one-character chunks scan linearly; ordinary feed never joins or parses prefixes", () => {
		const raw = JSON.stringify({ file_path: "x", content: "字😀\r\n".repeat(10000) });
		const stream = new ToolInputStream(["file_path"], ["content"]);
		let text = "";
		for (let i = 0; i < raw.length; i++) {
			stream.feed(raw[i]);
			if (i % 100 === 0) for (const field of stream.drainFields()) text += field.delta;
			stream.parseComplete();
			if (i < raw.length - 1) {
				expect(stream.stats.parseAttempts).toBe(0);
				expect(stream.stats.rawMaterializations).toBe(0);
			}
		}
		for (const field of stream.drainFields()) text += field.delta;
		expect(text).toBe("字😀\r\n".repeat(10000));
		expect(stream.finish()).toEqual(JSON.parse(raw));
		expect(stream.stats.scannedChars).toBe(raw.length);
		expect(stream.stats.parseAttempts).toBe(1);
		expect(stream.stats.rawMaterializations).toBe(1);
	});

	test("invalid escape is visible but cannot eager-complete; nested keys are not root fields", () => {
		const raw = '{"nested":{"content":"hidden"},"content":"bad\\q\\uZZZZtail"}';
		const stream = new ToolInputStream([], ["content"]);
		const fields = [];
		for (const ch of raw) {
			stream.feed(ch);
			fields.push(...stream.drainFields());
			expect(stream.parseComplete()).toBeUndefined();
		}
		expect(fields.map((field) => field.delta).join("")).toBe("bad\\q\\uZZZZtail");
		expect(stream.finish()).toEqual({ _raw: raw });
		expect(stream.stats.parseAttempts).toBe(1);
	});

	test("balanced invalid JSON and trailing garbage retain final fallback", () => {
		for (const raw of ['{"x":}', '{"x":1,}', '{"x":1]', '{"x":1}extra']) {
			const stream = new ToolInputStream();
			stream.feed(raw);
			expect(stream.parseComplete()).toBeUndefined();
			expect(stream.finish()).toEqual({ _raw: raw });
			expect(stream.stats.parseAttempts).toBeLessThanOrEqual(1);
		}
	});

	test("cached root validation rejects later garbage and only JSON whitespace is ignored", () => {
		for (const suffix of ["\u00a0", "extra"]) {
			const stream = new ToolInputStream();
			stream.feed('{"x":1}');
			expect(stream.hasCompleteInput()).toBe(true);
			stream.feed(suffix);
			expect(stream.hasCompleteInput()).toBe(false);
			expect(stream.finish()).toEqual({ _raw: `{"x":1}${suffix}` });
			expect(stream.stats.parseAttempts).toBe(1);
		}
		const valid = new ToolInputStream();
		valid.feed('{"x":1}');
		expect(valid.hasCompleteInput()).toBe(true);
		valid.feed(" \r\n\t");
		expect(valid.finish()).toEqual({ x: 1 });
	});

	test("malformed Unicode escapes preserve their raw spelling across every split", () => {
		for (const spelling of ["\\q", "\\uZZZZ", "\\u1", "\\u12x", "\\u12\\n"]) {
			const raw = `{"content":"${spelling}tail"}`;
			for (let split = 0; split <= raw.length; split++) {
				const stream = new ToolInputStream([], ["content"]);
				stream.feed(raw.slice(0, split));
				const fields = stream.drainFields();
				stream.feed(raw.slice(split));
				fields.push(...stream.drainFields());
				expect(fields.map((field) => field.delta).join("")).toBe(
					`${spelling.replace("\\n", "\n")}tail`,
				);
				expect(stream.finish()).toEqual({ _raw: raw });
			}
		}
	});

	test("primitive short fields, escaped keys, empty strings, and metadata materialization", () => {
		const stream = new ToolInputStream(["replace_all", "file_path"], ["old_string", "new_string"]);
		stream.feed('{"replace_all":true,"file_\\u0070ath":"x","old_string":"old","new_string":""}');
		expect(stream.takeShortFields()).toEqual({ replace_all: "true", file_path: "x" });
		expect(stream.takeShortFields()).toEqual({});
		const beforeMetadata = stream.stats.fieldMaterializations;
		expect(stream.getField("old_string")).toBe("old");
		expect(stream.getField("old_string")).toBe("old");
		expect(stream.stats.fieldMaterializations - beforeMetadata).toBe(1);
		expect(stream.drainFields()).toEqual([
			{ name: "old_string", delta: "old", startsField: true, offset: 0, complete: true },
			{ name: "new_string", delta: "", startsField: true, offset: 0, complete: true },
		]);
		expect(stream.drainFields()).toEqual([]);
	});
});
