import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	affected,
	anchorMatches,
	check,
	find,
	loadNodes,
	parseNode,
	repoPath,
	stale,
	termIn,
} from "../../scripts/knowledge";

let root: string;

function git(...args: string[]) {
	const r = Bun.spawnSync(
		["git", "-C", root, "-c", "user.name=T", "-c", "user.email=t@e.test", ...args],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

function write(path: string, text: string) {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
}

function node(id: string, anchors: string[], body = "", keywords: string[] = []) {
	return [
		"---",
		`id: ${id}`,
		`title: ${id} title`,
		`summary: ${id} summary`,
		anchors.length ? "anchors:" : "anchors: []",
		...anchors.map((a) => `  - ${a}`),
		...(keywords.length ? ["keywords:", ...keywords.map((k) => `  - ${k}`)] : []),
		"status: draft",
		"verified_at: null",
		"---",
		`# ${id}`,
		body,
	].join("\n");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "knowledge-test-"));
	git("init", "-q", "-b", "main");
	write("server/services/alpha.ts", "export const a = 1;\n");
	write("server/services/beta/one.ts", "export const b = 1;\n");
	write("server/services/gamma.ts", "export const g = 1;\n");
	write("knowledge/index.md", node("root", [], "## 下面有什么\n\n- [Area](area/index.md)：x\n"));
	write(
		"knowledge/area/index.md",
		node("area", [], "## 下面有什么\n\n- [Alpha](alpha.md)：x\n- [Beta](beta.md)：x\n"),
	);
	write(
		"knowledge/area/alpha.md",
		node("area.alpha", ["server/services/alpha.ts"], "", ["审批", "FILE_HISTORY_DISABLED"]),
	);
	write(
		"knowledge/area/beta.md",
		node("area.beta", ["server/services/beta/"], "See [alpha](alpha.md)."),
	);
	git("add", "-A");
	git("commit", "-qm", "init");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("knowledge tree tool", () => {
	test("parses headers with lists, empty lists and keywords", () => {
		const n = parseNode("x.md", node("x", ["a.ts", "b/"], "body", ["k1"]));
		expect(n?.anchors).toEqual(["a.ts", "b/"]);
		expect(n?.keywords).toEqual(["k1"]);
		expect(parseNode("y.md", node("y", []))?.anchors).toEqual([]);
		expect(parseNode("z.md", "# no header")).toBeNull();
	});

	test("anchors match files, directories, globs and ignore a #symbol", () => {
		expect(anchorMatches("server/a.ts", "server/a.ts")).toBe(true);
		expect(anchorMatches("server/b/", "server/b/c/d.ts")).toBe(true);
		expect(anchorMatches("server/x-*.ts", "server/x-one.ts")).toBe(true);
		expect(anchorMatches("server/x-*.ts", "server/y-one.ts")).toBe(false);
		expect(anchorMatches("server/a.ts#run", "server/a.ts")).toBe(true);
	});

	test("find ranks keyword and path matches", () => {
		const nodes = loadNodes(root);
		expect(find(nodes, ["FILE_HISTORY_DISABLED"])[0]?.node.id).toBe("area.alpha");
		expect(find(nodes, ["server/services/beta/one.ts"])[0]?.node.id).toBe("area.beta");
	});

	test("short English terms match whole words only", () => {
		expect(termIn("pooled provider", "OLED")).toBe(false);
		expect(termIn("OLED/调色板", "OLED")).toBe(true);
		expect(termIn("FILE_HISTORY_DISABLED", "FILE_HISTORY_DISABLED")).toBe(true);
		expect(termIn("团队会话", "团队")).toBe(true);
	});

	test("affected lists touched nodes and changed files no node anchors", () => {
		const res = affected(loadNodes(root), [
			"server/services/beta/one.ts",
			"server/services/gamma.ts",
		]);
		expect(res.nodes.map((n) => n.node.id)).toEqual(["area.beta"]);
		expect(res.unanchored).toEqual(["server/services/gamma.ts"]);
	});

	test("a node is stale after its anchored code changes, fresh again once it is updated", () => {
		expect(stale(root, loadNodes(root))).toEqual([]);
		write("server/services/alpha.ts", "export const a = 2;\n");
		git("commit", "-qam", "change alpha");
		const s = stale(root, loadNodes(root));
		expect(s.map((x) => x.node.id)).toEqual(["area.alpha"]);
		expect(s[0].files).toEqual(["server/services/alpha.ts"]);
		write("knowledge/area/alpha.md", node("area.alpha", ["server/services/alpha.ts"], "updated"));
		git("commit", "-qam", "update node");
		expect(stale(root, loadNodes(root))).toEqual([]);
	});

	test("brace-glob anchors are dated like any other anchor", () => {
		write("knowledge/area/beta.md", node("area.beta", ["server/services/{alpha,gamma}.ts"]));
		git("commit", "-qam", "brace anchor");
		write("server/services/gamma.ts", "export const g = 2;\n");
		git("commit", "-qam", "change gamma");
		expect(stale(root, loadNodes(root)).map((x) => x.node.id)).toEqual(["area.beta"]);
	});

	test("a code change committed together with its node keeps the node fresh", () => {
		write("server/services/beta/one.ts", "export const b = 2;\n");
		write("knowledge/area/beta.md", node("area.beta", ["server/services/beta/"], "updated"));
		git("commit", "-qam", "change beta with its node");
		expect(stale(root, loadNodes(root))).toEqual([]);
	});

	test("CRLF headers parse like LF headers", () => {
		const n = parseNode("x.md", node("x", ["a.ts"], "body", ["k1"]).replace(/\n/g, "\r\n"));
		expect(n?.id).toBe("x");
		expect(n?.anchors).toEqual(["a.ts"]);
		expect(n?.keywords).toEqual(["k1"]);
	});

	test("node paths use forward slashes, so nested index nodes check out", () => {
		const nodes = loadNodes(root);
		expect(nodes.every((n) => !n.file.includes("\\"))).toBe(true);
		expect(nodes.map((n) => n.file)).toContain("knowledge/area/index.md");
		expect(repoPath("knowledge\\area\\index.md", "\\")).toBe("knowledge/area/index.md");
	});

	test("check reports markdown files that are not nodes", () => {
		write("knowledge/area/loose.md", "# Loose page\n");
		const invalid: string[] = [];
		const errors = check(root, loadNodes(root, invalid), invalid).join("\n");
		expect(invalid).toEqual(["knowledge/area/loose.md"]);
		expect(errors).toContain("knowledge/area/loose.md: no node header");
	});

	test("check catches broken anchors, links, duplicate ids and unlisted children", () => {
		expect(check(root, loadNodes(root))).toEqual([]);
		write("knowledge/area/gamma.md", node("area.alpha", ["server/missing.ts"], "[x](nope.md)"));
		const errors = check(root, loadNodes(root)).join("\n");
		expect(errors).toContain("id area.alpha also used");
		expect(errors).toContain("anchor matches nothing: server/missing.ts");
		expect(errors).toContain("broken link nope.md");
		expect(errors).toContain("child not listed: gamma.md");
	});
});
