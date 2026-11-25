/**
 * narrator-rounds-no-large-fields.test.ts — 列表接口禁止读大字段（CLAUDE.md 硬规则）。
 *
 * 轮次索引是**列表**接口，一次可能返回几百轮。只要有一个实现者顺手加一个
 * `contentJson`（SDK content blocks，几百 KB 到几 MB）来选择列，长会话的
 * 导航轨请求就会把主线程拖住、把响应体撑到几十 MB。
 *
 * 读源码断言而不是跑查询：这类回归不会产生错误结果，只会变慢，任何行为测试
 * 都抓不到。同 NarraFork 既有的列表接口守卫范式。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = join(import.meta.dir, "..", "narrator-rounds.ts");

/** 这些列名一旦出现在该服务里就是回归（大字段 / 全量正文）。 */
const FORBIDDEN = [
	"contentJson",
	"content_json",
	"originalContentJson",
	"original_content_json",
	"composerDocument",
	"composer_document",
	"outputJson",
	"output_json",
];

describe("narrator-rounds 服务不读大字段", () => {
	const source = readFileSync(SERVICE, "utf8");

	// 只检查代码：本文件的文档注释里正当地写着「绝不 SELECT content_json」这类
	// 说明，把注释一起扫会让守卫永远红。
	const code = source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n");

	for (const field of FORBIDDEN) {
		test(`不出现 ${field}`, () => {
			expect(code).not.toContain(field);
		});
	}

	test("用户原话取 content_text 并在 SQL 侧截断", () => {
		// 断言「有截断」而不只是「有取列」：不截断同样会把整段正文带进响应。
		expect(source).toContain("contentText");
		expect(source).toContain("substr");
		expect(source).toContain("ROUND_USER_TEXT_MAX_CHARS");
	});
});
