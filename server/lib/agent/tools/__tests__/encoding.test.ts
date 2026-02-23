import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "@server/lib/settings";
import iconv from "iconv-lite";
import type { ToolContext } from "../../types";
import { editTool } from "../edit";
import { readTool } from "../read";

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
	settings.editor.legacyEncoding = false;
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
		settings.editor.legacyEncoding = false;
		const result = await readTool.execute({ file_path: GBK_FILE }, makeCtx());
		// UTF-8 decoding of GBK bytes produces garbled text
		expect(result.output).not.toContain("你好世界");
	});

	test("read decodes GBK correctly when legacyEncoding is on", async () => {
		settings.editor.legacyEncoding = true;
		const result = await readTool.execute({ file_path: GBK_FILE }, makeCtx());
		expect(result.output).toContain("你好世界");
		expect(result.output).toContain("这是GBK编码的文件");
	});

	test("edit preserves GBK encoding when legacyEncoding is on", async () => {
		settings.editor.legacyEncoding = true;
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
		settings.editor.legacyEncoding = false;
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

		settings.editor.legacyEncoding = true;
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
});
