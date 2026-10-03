import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classifyToolDetail } from "@shared/pretext-layout/tool-detail";
import { extractDataRevision } from "../vlist/measure-cache";
import { resolveToolDetailModelTargets, sameViewTarget } from "../vlist/vlist-content-view-target";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
describe("complete document UI architecture", () => {
	test("live and settled Write use one painter without the legacy highlight/clamp budgets", () => {
		const inline = read("../vlist/render/RenderToolCall.tsx");
		const modal = read("../vlist/vlist-content-view-body.tsx");
		const body = read("./DocumentCodeBody.tsx");
		expect(inline).toContain("{model.textDocument ? (");
		expect(inline).toContain("<DocumentCodeBody");
		expect(modal).toContain("<DocumentCodeBody");
		expect(body).not.toMatch(
			/maxHighlightChars|MAX_HIGHLIGHT|120_000|20_000|HighlightedCode|useShikiTokens\s*\(/,
		);
		const fullscreen = read("../vlist/VListContentViewModal.tsx");
		expect(fullscreen).toMatch(
			/target\.textDocument\s*\?\s*\{ text: "", clamped: false \}\s*:\s*clampViewText\(target.text\)/,
		);
	});
	test("only viewport visual slices become DOM; original source stays out of hidden inputs", () => {
		const source = read("./DocumentCodeBody.tsx");
		expect(source).toContain("paintRows.map");
		expect(source).toContain("left: row.left");
		expect(source).not.toMatch(/\.client(?:Width|Height)|getComputedStyle|\bmeasureText\s*\(/);
		expect(source).not.toMatch(/<textarea|dangerouslySetInnerHTML|readAll\(/);
		expect(source).toContain("viewport.setContentSize");
		expect(source).toContain("viewport.notifyLayout");
		expect(source).toContain("viewport.subscribeViewport");
		for (const path of [
			"./DocumentCodeBody.tsx",
			"./DocumentSearch.tsx",
			"./DocumentCopyButton.tsx",
			"./document-clipboard.ts",
			"./document-search.ts",
		])
			expect(read(path)).not.toMatch(/(?:from\s+|import\()["'][^"']*vlist\//);
	});
	test("copy and search read raw source with credential policy injected above components", () => {
		const clipboard = read("./document-clipboard.ts");
		expect(clipboard).toContain("new ClipboardItem");
		expect(clipboard).toContain("readCurrentDocumentRange");
		const recovery = read("./document-range-recovery.ts");
		expect(recovery).toContain("textDocumentStore.readRange");
		expect(recovery).toContain("textDocumentStore.register(rebound, recover)");
		expect(recovery).toContain("throw new DocumentSourceReboundError");
		expect(read("./document-search.ts")).toContain("textDocumentStore.search");
		expect(read("../vlist/vlist-data-source.ts")).toContain("fetchTextDocumentRange?");
		for (const path of [
			"./DocumentCodeBody.tsx",
			"./document-source.ts",
			"./document-clipboard.ts",
			"./document-search.ts",
		])
			expect(read(path)).not.toMatch(/authorizedFetch|\/api\/|getToken\(|Authorization/);
	});
	test("doc refs survive target extraction and change bounded equality/cache signatures", () => {
		const ref = {
			id: "doc",
			epoch: "e",
			length: 1_000_000,
			revision: 7,
			complete: true,
			originKnown: true,
		};
		const detail = classifyToolDetail({
			toolUseId: "write",
			toolName: "Write",
			category: "file",
			inputJson: { textDocument: ref, content: "small measurement" },
		});
		const target = resolveToolDetailModelTargets("row", detail)[0];
		expect(target?.textDocument).toBe(ref);
		expect(target?.text.length).toBeLessThan(2049);
		if (!target) throw new Error("document target missing");
		expect(sameViewTarget(target, { ...target, textDocument: { ...ref, revision: 8 } })).toBe(
			false,
		);
		const first = extractDataRevision({ detail });
		const revised = classifyToolDetail({
			toolUseId: "write",
			toolName: "Write",
			category: "file",
			inputJson: { textDocument: { ...ref, revision: 8 }, content: "small measurement" },
		});
		expect(extractDataRevision({ detail: revised })).not.toBe(first);
		expect(first?.length).toBeLessThan(1000);
	});
	test("document errors and search text have both locale entries", () => {
		const en = JSON.parse(read("../../../locales/en/narrator.json"));
		const zh = JSON.parse(read("../../../locales/zh-CN/narrator.json"));
		for (const key of [
			"documentCodeBody",
			"documentFind",
			"documentFindPrevious",
			"documentFindNext",
			"documentFindClose",
			"documentNotFound",
			"documentSearchFailed",
			"documentCopyFailed",
			"documentLoadFailed",
			"documentRetry",
		]) {
			expect(typeof en[key]).toBe("string");
			expect(typeof zh[key]).toBe("string");
			expect(en[key]).not.toBe(zh[key]);
		}
	});
});
