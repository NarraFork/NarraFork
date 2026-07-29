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
		expect(findNode(ok.nodes, "version")).toEqual({
			kind: "leaf",
			key: "version",
			value: "3",
			valueType: "number",
		});
		expect(findNode(ok.nodes, "stable")).toEqual({
			kind: "leaf",
			key: "stable",
			value: "true",
			valueType: "boolean",
		});
		expect(findNode(ok.nodes, "missing")).toEqual({
			kind: "leaf",
			key: "missing",
			value: "null",
			valueType: "null",
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
