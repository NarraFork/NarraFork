import { describe, expect, it } from "bun:test";
import {
	detectStructuredFormat,
	isStructuredParseError,
	MAX_STRUCTURED_DEPTH,
	MAX_STRUCTURED_NODES,
	parseStructured,
	type StructuredNode,
	type StructuredParseOk,
} from "./structured-parse";

function expectOk(result: ReturnType<typeof parseStructured>): StructuredParseOk {
	if (isStructuredParseError(result)) {
		throw new Error(`expected a successful parse, got error: ${result.error}`);
	}
	return result;
}

function findNode(nodes: StructuredNode[], key: string): StructuredNode | undefined {
	return nodes.find((node) => node.key === key);
}

function branch(nodes: StructuredNode[], key: string): StructuredNode[] {
	const node = findNode(nodes, key);
	if (!node || node.kind !== "branch") throw new Error(`no branch named ${key}`);
	return node.children;
}

function leafValue(nodes: StructuredNode[], key: string): string {
	const node = findNode(nodes, key);
	if (!node || node.kind !== "leaf") throw new Error(`no leaf named ${key}`);
	return node.value;
}

describe("detectStructuredFormat", () => {
	it("maps supported extensions", () => {
		expect(detectStructuredFormat("/tmp/a.json")).toBe("json");
		expect(detectStructuredFormat("/tmp/a.jsonc")).toBe("json");
		expect(detectStructuredFormat("/tmp/Cargo.toml")).toBe("toml");
		expect(detectStructuredFormat("/tmp/php.ini")).toBe("ini");
		expect(detectStructuredFormat("C:\\conf\\app.CFG")).toBe("ini");
	});

	it("returns null for markdown, code, yaml and extensionless files", () => {
		expect(detectStructuredFormat("/tmp/README.md")).toBeNull();
		expect(detectStructuredFormat("/tmp/main.ts")).toBeNull();
		expect(detectStructuredFormat("/tmp/notes.txt")).toBeNull();
		// YAML is deliberately out of scope (see module docs).
		expect(detectStructuredFormat("/tmp/compose.yaml")).toBeNull();
		expect(detectStructuredFormat("/tmp/compose.yml")).toBeNull();
		expect(detectStructuredFormat("/tmp/Makefile")).toBeNull();
		expect(detectStructuredFormat("/tmp/.gitignore")).toBeNull();
	});
});

describe("parseStructured — json", () => {
	it("builds branches and typed leaves", () => {
		const ok = expectOk(
			parseStructured(
				JSON.stringify({
					name: "narrafork",
					version: 3,
					stable: true,
					missing: null,
					scripts: { dev: "bun run dev", build: "vite build" },
				}),
				"json",
			),
		);
		expect(ok.truncated).toBe(false);
		expect(leafValue(ok.nodes, "name")).toBe("narrafork");
		// Minified single-line input: every node anchors to line 0.
		expect(findNode(ok.nodes, "version")).toEqual({
			kind: "leaf",
			key: "version",
			value: "3",
			valueType: "number",
			line: 0,
		});
		expect(findNode(ok.nodes, "stable")).toEqual({
			kind: "leaf",
			key: "stable",
			value: "true",
			valueType: "boolean",
			line: 0,
		});
		expect(findNode(ok.nodes, "missing")).toEqual({
			kind: "leaf",
			key: "missing",
			value: "null",
			valueType: "null",
			line: 0,
		});
		const scripts = findNode(ok.nodes, "scripts");
		expect(scripts?.kind).toBe("branch");
		if (scripts?.kind === "branch") expect(scripts.childCount).toBe(2);
	});

	it("indexes array items", () => {
		const ok = expectOk(parseStructured(JSON.stringify({ tags: ["a", "b"] }), "json"));
		const tags = branch(ok.nodes, "tags");
		expect(tags.map((n) => n.key)).toEqual(["[0]", "[1]"]);
	});

	it("fails on invalid json, empty input and bare scalars", () => {
		expect(isStructuredParseError(parseStructured("{oops", "json"))).toBe(true);
		expect(isStructuredParseError(parseStructured("   \n", "json"))).toBe(true);
		expect(isStructuredParseError(parseStructured("42", "json"))).toBe(true);
	});

	it("truncates beyond the node cap", () => {
		const big: Record<string, number> = {};
		for (let i = 0; i < MAX_STRUCTURED_NODES + 50; i++) big[`k${i}`] = i;
		const ok = expectOk(parseStructured(JSON.stringify(big), "json"));
		expect(ok.truncated).toBe(true);
		expect(ok.nodes.length).toBeLessThanOrEqual(MAX_STRUCTURED_NODES);
	});

	it("truncates beyond the depth cap", () => {
		// Build { a: { a: { … } } } deeper than the cap.
		let deep = "1";
		for (let i = 0; i < MAX_STRUCTURED_DEPTH + 5; i++) deep = `{"a":${deep}}`;
		const ok = expectOk(parseStructured(deep, "json"));
		expect(ok.truncated).toBe(true);
	});
});

describe("parseStructured — ini", () => {
	it("parses sections, comments and quoted values", () => {
		const text = [
			"; leading comment",
			"# another comment",
			"[server]",
			"host = localhost",
			'name = "my app"',
			"",
			"[limits]",
			"max=10",
		].join("\r\n");
		const ok = expectOk(parseStructured(text, "ini"));
		const server = branch(ok.nodes, "server");
		expect(leafValue(server, "host")).toBe("localhost");
		expect(leafValue(server, "name")).toBe("my app");
		expect(leafValue(branch(ok.nodes, "limits"), "max")).toBe("10");
	});

	it("keeps top-level keys before the first section", () => {
		const ok = expectOk(parseStructured("global = 1\n[s]\nk = v\n", "ini"));
		expect(leafValue(ok.nodes, "global")).toBe("1");
		expect(leafValue(branch(ok.nodes, "s"), "k")).toBe("v");
	});

	it("merges repeated sections", () => {
		const ok = expectOk(parseStructured("[s]\na = 1\n[s]\nb = 2\n", "ini"));
		const s = branch(ok.nodes, "s");
		expect(s.map((n) => n.key)).toEqual(["a", "b"]);
	});

	it("fails on malformed lines and empty documents", () => {
		expect(isStructuredParseError(parseStructured("[unterminated\n", "ini"))).toBe(true);
		expect(isStructuredParseError(parseStructured("just text\n", "ini"))).toBe(true);
		expect(isStructuredParseError(parseStructured("[]\n", "ini"))).toBe(true);
		expect(isStructuredParseError(parseStructured("\n\n; only comments\n", "ini"))).toBe(true);
	});
});

describe("parseStructured — toml", () => {
	it("parses tables, dotted keys, scalars and inline arrays", () => {
		const text = [
			"# top comment",
			'title = "NarraFork"  # trailing comment',
			"port = 7_779",
			"ratio = 1.5",
			"enabled = true",
			'tags = ["a", "b",]',
			"",
			"[server.http]",
			'host = "127.0.0.1"',
			"",
			"[meta]",
			'owner.name = "team"',
			"released = 2026-04-01",
		].join("\n");
		const ok = expectOk(parseStructured(text, "toml"));
		expect(leafValue(ok.nodes, "title")).toBe("NarraFork");
		expect(findNode(ok.nodes, "port")).toEqual({
			kind: "leaf",
			key: "port",
			value: "7779",
			valueType: "number",
			line: 2,
		});
		expect(leafValue(ok.nodes, "ratio")).toBe("1.5");
		expect(leafValue(ok.nodes, "enabled")).toBe("true");
		expect(branch(ok.nodes, "tags").map((n) => n.key)).toEqual(["[0]", "[1]"]);
		expect(leafValue(branch(branch(ok.nodes, "server"), "http"), "host")).toBe("127.0.0.1");
		const meta = branch(ok.nodes, "meta");
		expect(leafValue(branch(meta, "owner"), "name")).toBe("team");
		expect(leafValue(meta, "released")).toBe("2026-04-01");
	});

	it("parses arrays of tables and later sub-tables of the last element", () => {
		const text = [
			"[[bin]]",
			'name = "one"',
			"[[bin]]",
			'name = "two"',
			"[bin.meta]",
			"pinned = true",
		].join("\n");
		const ok = expectOk(parseStructured(text, "toml"));
		const bins = branch(ok.nodes, "bin");
		expect(bins.map((n) => n.key)).toEqual(["[0]", "[1]"]);
		const second = branch(bins, "[1]");
		expect(leafValue(second, "name")).toBe("two");
		expect(leafValue(branch(second, "meta"), "pinned")).toBe("true");
	});

	it("keeps a # inside a quoted value", () => {
		const ok = expectOk(parseStructured('color = "#fff"\n', "toml"));
		expect(leafValue(ok.nodes, "color")).toBe("#fff");
	});

	it("degrades on multi-line strings, multi-line arrays and inline tables", () => {
		expect(isStructuredParseError(parseStructured('a = """\nhi\n"""\n', "toml"))).toBe(true);
		expect(isStructuredParseError(parseStructured("a = [\n 1,\n 2,\n]\n", "toml"))).toBe(true);
		expect(isStructuredParseError(parseStructured('a = { b = "c" }\n', "toml"))).toBe(true);
	});

	it("fails on malformed lines and empty documents", () => {
		expect(isStructuredParseError(parseStructured("no equals here\n", "toml"))).toBe(true);
		expect(isStructuredParseError(parseStructured("[unterminated\n", "toml"))).toBe(true);
		expect(isStructuredParseError(parseStructured("[[unterminated]\n", "toml"))).toBe(true);
		expect(isStructuredParseError(parseStructured("# only a comment\n", "toml"))).toBe(true);
	});

	it("strips a UTF-8 BOM from the first key", () => {
		const ok = expectOk(parseStructured('\uFEFFtitle = "x"\n', "toml"));
		expect(findNode(ok.nodes, "title")).toBeDefined();
	});
});

describe("parseStructured — source lines", () => {
	it("json: records the key line for pretty-printed objects", () => {
		const ok = expectOk(parseStructured('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}', "json"));
		expect(findNode(ok.nodes, "a")?.line).toBe(1);
		const b = findNode(ok.nodes, "b");
		expect(b?.line).toBe(2);
		if (b?.kind === "branch") expect(findNode(b.children, "c")?.line).toBe(3);
	});

	it("json: records element start lines for arrays, including nested objects", () => {
		const ok = expectOk(parseStructured('{\n"list": [\n{"x": 1},\n2,\nnull\n]\n}', "json"));
		const list = findNode(ok.nodes, "list");
		expect(list?.line).toBe(1);
		if (list?.kind !== "branch") throw new Error("list must be a branch");
		expect(findNode(list.children, "[0]")?.line).toBe(2);
		expect(findNode(list.children, "[1]")?.line).toBe(3);
		expect(findNode(list.children, "[2]")?.line).toBe(4);
		const first = findNode(list.children, "[0]");
		if (first?.kind === "branch") expect(findNode(first.children, "x")?.line).toBe(2);
	});

	it("json: leading blank lines do not shift line numbers", () => {
		const ok = expectOk(parseStructured('\n\n{"a": 1}', "json"));
		expect(findNode(ok.nodes, "a")?.line).toBe(2);
	});

	it("json: counts \\r\\n and bare \\r as one line break each", () => {
		const ok = expectOk(parseStructured('{\r\n"a": 1,\r\n"b": 2\r}', "json"));
		expect(findNode(ok.nodes, "a")?.line).toBe(1);
		expect(findNode(ok.nodes, "b")?.line).toBe(2);
	});

	it("json: decodes escaped keys before anchoring them", () => {
		const ok = expectOk(parseStructured('{\n"a\\"b": 1,\n"c": 2\n}', "json"));
		expect(findNode(ok.nodes, 'a"b')?.line).toBe(1);
		expect(findNode(ok.nodes, "c")?.line).toBe(2);
	});

	it("json: keys containing path separators anchor their own node", () => {
		// "a/b" must not collide with the nested path a → b.
		const ok = expectOk(parseStructured('{\n"a/b": 1,\n"a": {\n"b": 2\n}\n}', "json"));
		expect(findNode(ok.nodes, "a/b")?.line).toBe(1);
		const a = findNode(ok.nodes, "a");
		expect(a?.line).toBe(2);
		if (a?.kind === "branch") expect(findNode(a.children, "b")?.line).toBe(3);
	});

	it("json: survives nesting past the depth cap without recording it", () => {
		let deep = "1";
		for (let i = 0; i < MAX_STRUCTURED_DEPTH + 10; i++) deep = `{"a":${deep}}`;
		const ok = expectOk(parseStructured(deep, "json"));
		expect(ok.truncated).toBe(true);
		// Depth-capped nodes have no line, but shallower ones do.
		expect(findNode(ok.nodes, "a")?.line).toBe(0);
	});

	it("toml: records table, entry and dotted-key lines", () => {
		const text = [
			'title = "demo"', // line 0
			"",
			"[server.http]", // line 2
			'host = "x"', // line 3
			"",
			"[meta]", // line 5
			'owner.name = "team"', // line 6
		].join("\n");
		const ok = expectOk(parseStructured(text, "toml"));
		expect(findNode(ok.nodes, "title")?.line).toBe(0);
		// The intermediate `server` branch anchors to the header that created it.
		expect(findNode(ok.nodes, "server")?.line).toBe(2);
		const http = branch(branch(ok.nodes, "server"), "http");
		expect(findNode(ok.nodes, "server")?.kind).toBe("branch");
		expect(findNode(http, "host")?.line).toBe(3);
		const meta = branch(ok.nodes, "meta");
		expect(findNode(branch(meta, "owner"), "name")?.line).toBe(6);
	});

	it("toml: records array-of-tables element lines per entry", () => {
		const text = [
			"[[bin]]", // line 0
			'name = "one"', // line 1
			"[[bin]]", // line 2
			'name = "two"', // line 3
		].join("\n");
		const ok = expectOk(parseStructured(text, "toml"));
		const bins = branch(ok.nodes, "bin");
		expect(findNode(ok.nodes, "bin")?.line).toBe(0);
		expect(findNode(bins, "[0]")?.line).toBe(0);
		expect(findNode(bins, "[1]")?.line).toBe(2);
		const first = findNode(bins, "[0]");
		if (first?.kind === "branch") expect(findNode(first.children, "name")?.line).toBe(1);
	});

	it("ini: records section and key lines", () => {
		const text = [
			"root = 1", // line 0
			"; comment", // line 1
			"[sec]", // line 2
			"k = v", // line 3
		].join("\n");
		const ok = expectOk(parseStructured(text, "ini"));
		expect(findNode(ok.nodes, "root")?.line).toBe(0);
		expect(findNode(ok.nodes, "sec")?.line).toBe(2);
		expect(findNode(branch(ok.nodes, "sec"), "k")?.line).toBe(3);
	});
});
