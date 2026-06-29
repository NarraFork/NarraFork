import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "@server/lib/settings";
import iconv from "iconv-lite";
import type { ToolContext } from "../../types";
import { editTool } from "../edit";
import { createStreamDecoder } from "../encoding";
import { grepTool, isRgAvailable } from "../grep";
import { readTool } from "../read";
import { writeTool } from "../write";

const TEST_DIR = join(tmpdir(), `narrafork-encoding-test-${Date.now()}`);

function makeCtx(cwd = TEST_DIR): ToolContext {
	return {
		narratorId: "test-narrator",
		cwd,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" as const }),
	};
}

beforeAll(() => {
	mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	// Restore setting
	settings.agent.legacyEncoding = false;
});

describe("Legacy encoding support", () => {
	const GBK_FILE = join(TEST_DIR, "gbk-test.txt");
	const GBK_CONTENT = "你好世界\n这是GBK编码的文件\n";

	beforeEach(() => {
		// Write a GBK-encoded file
		const gbkBuffer = iconv.encode(GBK_CONTENT, "gbk");
		writeFileSync(GBK_FILE, gbkBuffer);
	});

	test("read garbles GBK when legacyEncoding is off", async () => {
		settings.agent.legacyEncoding = false;
		const result = await readTool.execute({ file_path: GBK_FILE }, makeCtx());
		// UTF-8 decoding of GBK bytes produces garbled text
		expect(result.output).not.toContain("你好世界");
	});

	test("read decodes GBK correctly when legacyEncoding is on", async () => {
		settings.agent.legacyEncoding = true;
		const result = await readTool.execute({ file_path: GBK_FILE }, makeCtx());
		expect(result.output).toContain("你好世界");
		expect(result.output).toContain("这是GBK编码的文件");
	});

	test("edit preserves GBK encoding when legacyEncoding is on", async () => {
		settings.agent.legacyEncoding = true;
		const result = await editTool.execute(
			{ file_path: GBK_FILE, old_string: "你好世界", new_string: "再见世界" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();

		// Verify the file is still GBK-encoded
		const rawBuffer = Buffer.from(await Bun.file(GBK_FILE).arrayBuffer());
		const decoded = iconv.decode(rawBuffer, "gbk");
		expect(decoded).toContain("再见世界");
		expect(decoded).toContain("这是GBK编码的文件");
	});

	test("edit with legacyEncoding off corrupts GBK file", async () => {
		settings.agent.legacyEncoding = false;
		// This will fail to find the old_string because UTF-8 decoding garbles it
		const result = await editTool.execute(
			{ file_path: GBK_FILE, old_string: "你好世界", new_string: "再见世界" },
			makeCtx(),
		);
		expect(result.isError).toBe(true);
	});

	test("UTF-8 files work normally regardless of legacyEncoding setting", async () => {
		const UTF8_FILE = join(TEST_DIR, "utf8-test.txt");
		writeFileSync(UTF8_FILE, "你好世界\nUTF-8编码\n");

		settings.agent.legacyEncoding = true;
		const readResult = await readTool.execute({ file_path: UTF8_FILE }, makeCtx());
		expect(readResult.output).toContain("你好世界");

		const editResult = await editTool.execute(
			{ file_path: UTF8_FILE, old_string: "你好世界", new_string: "再见世界" },
			makeCtx(),
		);
		expect(editResult.isError).toBeFalsy();

		const content = await Bun.file(UTF8_FILE).text();
		expect(content).toContain("再见世界");
	});

	test("write preserves GBK encoding when overwriting existing file", async () => {
		settings.agent.legacyEncoding = true;
		const result = await writeTool.execute(
			{ file_path: GBK_FILE, content: "新的内容\n第二行\n" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();

		// Verify the file is still GBK-encoded (not UTF-8)
		const rawBuffer = Buffer.from(await Bun.file(GBK_FILE).arrayBuffer());
		const decoded = iconv.decode(rawBuffer, "gbk");
		expect(decoded).toContain("新的内容");
		expect(decoded).toContain("第二行");
	});

	test("write uses UTF-8 for new files even with legacyEncoding on", async () => {
		settings.agent.legacyEncoding = true;
		const NEW_FILE = join(TEST_DIR, "new-file.txt");
		const result = await writeTool.execute(
			{ file_path: NEW_FILE, content: "全新文件\n" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();

		// New files should be UTF-8
		const content = await Bun.file(NEW_FILE).text();
		expect(content).toContain("全新文件");
	});

	test.skipIf(!isRgAvailable)(
		"grep finds content in GBK file when legacyEncoding is on",
		async () => {
			settings.agent.legacyEncoding = true;
			// Use files_with_matches mode — rg should not skip the GBK file
			const result = await grepTool.execute(
				{
					pattern: "GBK",
					path: TEST_DIR,
					output_mode: "files_with_matches",
				},
				makeCtx(),
			);
			expect(result.isError).toBeFalsy();
			expect(result.output).toContain("gbk-test.txt");
		},
	);
});

describe("Shell output stream decoder", () => {
	test("decodes UTF-8 output when detection is enabled", () => {
		settings.agent.legacyEncoding = true;
		const dec = createStreamDecoder();
		const buf = Buffer.from("你好世界 hello\n", "utf-8");
		let out = dec.write(buf);
		out += dec.end();
		expect(out).toContain("你好世界");
		expect(out).toContain("hello");
	});

	test("decodes GBK output when detection is enabled", () => {
		settings.agent.legacyEncoding = true;
		const dec = createStreamDecoder();
		// Repeat to give chardet enough confidence on the GBK byte distribution.
		const gbk = iconv.encode("Windows 命令行工具 这是GBK编码的输出内容\n".repeat(6), "gbk");
		let out = dec.write(gbk);
		out += dec.end();
		expect(out).toContain("命令行工具");
		expect(out).toContain("这是GBK编码的输出内容");
	});

	test("handles multibyte chars split across chunks (UTF-8)", () => {
		settings.agent.legacyEncoding = true;
		const dec = createStreamDecoder();
		const full = Buffer.from("中文测试输出内容需要足够长以触发检测逻辑分支\n".repeat(4), "utf-8");
		// Split at an arbitrary point that may land mid-codepoint.
		const mid = 17;
		let out = dec.write(full.subarray(0, mid));
		out += dec.write(full.subarray(mid));
		out += dec.end();
		expect(out).toContain("中文测试输出内容");
	});

	test("plain UTF-8 fast path when detection disabled (non-Windows)", () => {
		// On non-Windows with legacyEncoding off, behaves like StringDecoder("utf-8").
		settings.agent.legacyEncoding = false;
		const dec = createStreamDecoder();
		let out = dec.write(Buffer.from("plain ascii output\n", "utf-8"));
		out += dec.end();
		expect(out).toBe("plain ascii output\n");
	});
});
