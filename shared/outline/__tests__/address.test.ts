import { describe, expect, test } from "bun:test";
import {
	addressCandidates,
	formatAddress,
	formatLink,
	formatLinkList,
	isAlias,
	isShortId,
	parseAddress,
	parseAliasValue,
	parseLink,
	parseLinkList,
	titleOf,
} from "../address";

describe("addresses", () => {
	test("space/sid parses and formats", () => {
		expect(parseAddress("P1/b2Xk9q")).toEqual({ space: "P1", sid: "b2Xk9q" });
		expect(parseAddress(" sess_V1StGXR8_Z5jdHi6B-myT/abc ")).toEqual({
			space: "sess_V1StGXR8_Z5jdHi6B-myT",
			sid: "abc",
		});
		expect(formatAddress({ space: "P1", sid: "b2" })).toBe("P1/b2");
		for (const bad of ["P1", "/b2", "P1/", "P1/b 2", "P 1/b2", "P1/b2/c", "空间/b2"])
			expect(parseAddress(bad)).toBeNull();
		expect(() => formatAddress({ space: "a/b", sid: "c" })).toThrow();
	});

	test("short ids and aliases", () => {
		expect(isShortId("b2Xk9q")).toBe(true);
		expect(isShortId("b2 x")).toBe(false);
		expect(isShortId("x".repeat(33))).toBe(false);
		for (const a of ["Q17", "D27", "auth-spec", "鉴权", "v1.2"]) expect(isAlias(a)).toBe(true);
		for (const a of ["17", "two words", "-x", "a/b", ""]) expect(isAlias(a)).toBe(false);
		expect(parseAliasValue(" Q17 ")).toEqual({ kind: "alias", alias: "Q17" });
		expect(parseAliasValue("Q?")).toEqual({ kind: "auto", prefix: "Q" });
		expect(parseAliasValue("two words")).toBeNull();
		expect(parseAliasValue("?")).toBeNull();
	});

	test("candidates come in resolution order: address, short id, alias, title", () => {
		expect(addressCandidates("P1/b2")).toEqual([
			{ kind: "address", space: "P1", sid: "b2" },
			{ kind: "alias", alias: "b2", space: "P1" },
			{ kind: "title", title: "b2", space: "P1" },
			{ kind: "title", title: "P1/b2", space: null },
		]);
		expect(addressCandidates("Q17")).toEqual([
			{ kind: "shortId", sid: "Q17" },
			{ kind: "alias", alias: "Q17", space: null },
			{ kind: "title", title: "Q17", space: null },
		]);
		expect(addressCandidates("token 刷新存在竞态")).toEqual([
			{ kind: "title", title: "token 刷新存在竞态", space: null },
		]);
		expect(addressCandidates("auth/store 的设计")).toEqual([
			{ kind: "title", title: "store 的设计", space: "auth" },
			{ kind: "title", title: "auth/store 的设计", space: null },
		]);
		expect(addressCandidates("  ")).toEqual([]);
		expect(addressCandidates("a|b")).toEqual([]);
	});
});

describe("links and embeds", () => {
	test("parse [[target]], [[target|display]] and ![[…]]", () => {
		expect(parseLink("[[P1/b2]]")).toEqual({ target: "P1/b2", label: null, embed: false });
		expect(parseLink(" [[补回归测试|测试]] ")).toEqual({
			target: "补回归测试",
			label: "测试",
			embed: false,
		});
		expect(parseLink("![[P2/b3|嵌入]]")).toEqual({ target: "P2/b3", label: "嵌入", embed: true });
		expect(parseLink("[[a\\*b]]")).toEqual({ target: "a*b", label: null, embed: false });
		for (const bad of ["[[]]", "[[a]] b", "[a]", "`[[a]]`", "[[a]b]]", "[[a\nb]]"])
			expect(parseLink(bad)).toBeNull();
	});

	test("inside a table cell the separator is an escaped pipe", () => {
		expect(parseLink("[[P1/x\\|显示]]", { table: true })).toEqual({
			target: "P1/x",
			label: "显示",
			embed: false,
		});
		expect(formatLink({ target: "P1/x", label: "a|b" }, { table: true })).toBe("[[P1/x\\|a\\|b]]");
		expect(formatLink({ target: "P1/x", label: "a|b" })).toBe("[[P1/x|a|b]]");
	});

	test("format escapes what other markdown parsers would read as syntax", () => {
		expect(formatLink({ target: "a*b", label: "_x_" })).toBe("[[a\\*b|\\_x\\_]]");
		expect(formatLink({ target: "P2/b3", label: null, embed: true })).toBe("![[P2/b3]]");
		expect(() => formatLink({ target: "a]b", label: null })).toThrow();
		for (const link of [
			{ target: "a*b", label: "`c` & <d>", embed: false },
			{ target: "C++ 设计", label: null, embed: true },
		])
			expect(parseLink(formatLink(link))).toEqual(link);
	});

	test("link lists (depends::, tags::)", () => {
		expect(parseLinkList("[[a]], [[b|B]]")).toEqual({
			links: [
				{ target: "a", label: null },
				{ target: "b", label: "B" },
			],
			bare: [],
		});
		expect(parseLinkList("auth， 并发, [[c]]")).toEqual({
			links: [{ target: "c", label: null }],
			bare: ["auth", "并发"],
		});
		expect(
			formatLinkList([
				{ target: "a", label: null },
				{ target: "b", label: "B" },
			]),
		).toBe("[[a]], [[b|B]]");
	});
});

describe("titles", () => {
	test("the plain text of the first line", () => {
		expect(titleOf("**auth** 模块\n第二行")).toBe("auth 模块");
		expect(titleOf("## 设计 [[P1/x|决定]]")).toBe("设计 决定");
		expect(titleOf("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
		expect(titleOf("| a | b |\n| --- | --- |")).toBe("a | b");
		expect(titleOf("![[P2/b3]]")).toBe("P2/b3");
		expect(titleOf("")).toBe("");
	});
});
