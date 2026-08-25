import { describe, expect, test } from "bun:test";
import {
	MCP_SECRET_KEEP_PLACEHOLDER,
	type McpJsonDraft,
	mcpDraftToJsonText,
	parseMcpDraftJson,
} from "./mcp-json-draft";
import { buildMcpSecretPatch } from "./mcp-secrets";

function stdioDraft(overrides: Partial<McpJsonDraft> = {}): McpJsonDraft {
	return {
		name: "filesystem",
		transport: "stdio",
		command: "npx",
		args: "-y\n@modelcontextprotocol/server-filesystem",
		cwd: "",
		url: "",
		env: [],
		headers: [],
		originalEnvKeys: [],
		originalHeaderKeys: [],
		enabled: true,
		defaultBehavior: "",
		...overrides,
	};
}

function httpDraft(overrides: Partial<McpJsonDraft> = {}): McpJsonDraft {
	return stdioDraft({
		transport: "streamable-http",
		command: "",
		args: "",
		url: "https://example.test/mcp",
		...overrides,
	});
}

describe("mcpDraftToJsonText", () => {
	test("emits stdio fields and omits transport-irrelevant keys", () => {
		const json = JSON.parse(mcpDraftToJsonText(stdioDraft({ cwd: "/srv" })));

		expect(json).toEqual({
			name: "filesystem",
			transport: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem"],
			cwd: "/srv",
			enabled: true,
		});
		expect("url" in json).toBe(false);
		expect("headers" in json).toBe(false);
	});

	test("emits url and headers for http transports instead of command", () => {
		const json = JSON.parse(
			mcpDraftToJsonText(
				httpDraft({
					headers: [{ key: "X-Trace", value: "on", dirty: true }],
					defaultBehavior: "ask",
				}),
			),
		);

		expect(json).toEqual({
			name: "filesystem",
			transport: "streamable-http",
			url: "https://example.test/mcp",
			headers: { "X-Trace": "on" },
			enabled: true,
			defaultBehavior: "ask",
		});
		expect("command" in json).toBe(false);
	});

	test("prints the keep placeholder for saved secrets whose values are not in memory", () => {
		const json = JSON.parse(
			mcpDraftToJsonText(
				stdioDraft({
					env: [
						{ key: "TOKEN", value: "", preserved: true },
						{ key: "RETYPED", value: "fresh", preserved: true, dirty: true },
						{ key: "NEW", value: "plain" },
					],
					originalEnvKeys: ["TOKEN", "RETYPED"],
				}),
			),
		);

		expect(json.env).toEqual({
			TOKEN: MCP_SECRET_KEEP_PLACEHOLDER,
			RETYPED: "fresh",
			NEW: "plain",
		});
	});
});

describe("parseMcpDraftJson", () => {
	test("round-trips a draft without mutating any field", () => {
		const original = stdioDraft({ cwd: "/srv", defaultBehavior: "readOnly", enabled: false });
		const result = parseMcpDraftJson(mcpDraftToJsonText(original), original);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.draft).toEqual(original);
	});

	test("round-trips preserved secrets back into a patch that keeps stored values", () => {
		const original = stdioDraft({
			env: [{ key: "TOKEN", value: "", preserved: true }],
			originalEnvKeys: ["TOKEN"],
		});
		const result = parseMcpDraftJson(mcpDraftToJsonText(original), original);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.draft.env).toEqual([{ key: "TOKEN", value: "", preserved: true }]);
		// The whole point of the placeholder: an untouched secret must produce no
		// patch at all, otherwise saving overwrites it.
		expect(buildMcpSecretPatch(result.draft.env, result.draft.originalEnvKeys)).toBeUndefined();
	});

	test("treats a removed key as a deletion", () => {
		const current = stdioDraft({
			env: [
				{ key: "KEEP", value: "", preserved: true },
				{ key: "DROP", value: "", preserved: true },
			],
			originalEnvKeys: ["KEEP", "DROP"],
		});
		const result = parseMcpDraftJson(
			JSON.stringify({
				name: "filesystem",
				transport: "stdio",
				command: "npx",
				env: { KEEP: MCP_SECRET_KEEP_PLACEHOLDER },
			}),
			current,
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.draft.env.map((e) => e.key)).toEqual(["KEEP"]);
		expect(buildMcpSecretPatch(result.draft.env, result.draft.originalEnvKeys)).toEqual({
			delete: ["DROP"],
		});
	});

	test("does not persist the placeholder as a literal value for an unsaved key", () => {
		const result = parseMcpDraftJson(
			JSON.stringify({
				name: "filesystem",
				transport: "stdio",
				command: "npx",
				env: { NEVER_SAVED: MCP_SECRET_KEEP_PLACEHOLDER },
			}),
			stdioDraft(),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.draft.env).toEqual([]);
	});

	test("accepts transport aliases and the type field from pasted configs", () => {
		const viaType = parseMcpDraftJson(
			JSON.stringify({ type: "SSE", url: "https://example.test/sse" }),
			stdioDraft(),
		);
		expect(viaType.ok).toBe(true);
		if (viaType.ok) expect(viaType.draft.transport).toBe("sse");

		const viaAlias = parseMcpDraftJson(
			JSON.stringify({ transport: "http", url: "https://example.test/mcp" }),
			stdioDraft(),
		);
		expect(viaAlias.ok).toBe(true);
		if (viaAlias.ok) expect(viaAlias.draft.transport).toBe("streamable-http");
	});

	test("drops headers when the document switches an http server to stdio", () => {
		const current = httpDraft({
			headers: [{ key: "Authorization", value: "", preserved: true }],
			originalHeaderKeys: ["Authorization"],
		});
		const result = parseMcpDraftJson(
			JSON.stringify({ name: "filesystem", transport: "stdio", command: "node" }),
			current,
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.draft.headers).toEqual([]);
		expect(result.draft.url).toBe("");
		// Deleting the stored header is the visible consequence, and it matches
		// what the JSON says: an stdio server has no headers.
		expect(buildMcpSecretPatch(result.draft.headers, result.draft.originalHeaderKeys)).toEqual({
			delete: ["Authorization"],
		});
	});

	test("clears defaultBehavior on null or empty string and maps the allow alias", () => {
		const cleared = parseMcpDraftJson(
			JSON.stringify({ command: "npx", defaultBehavior: null }),
			stdioDraft({ defaultBehavior: "deny" }),
		);
		expect(cleared.ok).toBe(true);
		if (cleared.ok) expect(cleared.draft.defaultBehavior).toBe("");

		const legacy = parseMcpDraftJson(
			JSON.stringify({ command: "npx", defaultBehavior: "allow" }),
			stdioDraft(),
		);
		expect(legacy.ok).toBe(true);
		if (legacy.ok) expect(legacy.draft.defaultBehavior).toBe("readWrite");
	});

	test("clears fields the document omits instead of inheriting them", () => {
		// Deleting a line is how a config file unsets something; inheriting the old
		// value would make that edit disappear with no feedback.
		const current = stdioDraft({ cwd: "/srv", defaultBehavior: "ask" });
		const result = parseMcpDraftJson(JSON.stringify({ command: "node" }), current);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.draft.name).toBe("");
		expect(result.draft.args).toBe("");
		expect(result.draft.cwd).toBe("");
		expect(result.draft.defaultBehavior).toBe("");
		// Absent `enabled` means enabled, matching the create API default and every
		// MCP config format we import from.
		expect(result.draft.enabled).toBe(true);
	});

	test("keeps the persisted secret key lists, which the document cannot carry", () => {
		const current = stdioDraft({
			env: [{ key: "TOKEN", value: "", preserved: true }],
			originalEnvKeys: ["TOKEN"],
			originalHeaderKeys: ["Authorization"],
		});
		const result = parseMcpDraftJson(JSON.stringify({ command: "node" }), current);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.draft.originalEnvKeys).toEqual(["TOKEN"]);
		expect(result.draft.originalHeaderKeys).toEqual(["Authorization"]);
	});

	test("keeps the current transport when the document omits it", () => {
		const result = parseMcpDraftJson(
			JSON.stringify({ url: "https://example.test/mcp" }),
			httpDraft(),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.draft.transport).toBe("streamable-http");
		expect(result.draft.url).toBe("https://example.test/mcp");
	});

	test("rejects malformed documents with a specific error key", () => {
		expect(parseMcpDraftJson("{", stdioDraft())).toEqual({
			ok: false,
			errorKey: "mcpJsonInvalidJson",
		});
		expect(parseMcpDraftJson("[]", stdioDraft())).toEqual({
			ok: false,
			errorKey: "mcpJsonNotObject",
		});
		expect(parseMcpDraftJson(JSON.stringify({ transport: "grpc" }), stdioDraft())).toEqual({
			ok: false,
			errorKey: "mcpJsonInvalidTransport",
		});
		expect(parseMcpDraftJson(JSON.stringify({ defaultBehavior: "maybe" }), stdioDraft())).toEqual({
			ok: false,
			errorKey: "mcpJsonInvalidBehavior",
		});
		expect(parseMcpDraftJson(JSON.stringify({ args: [1, 2] }), stdioDraft())).toEqual({
			ok: false,
			errorKey: "mcpJsonInvalidField",
			params: { field: "args" },
		});
		expect(parseMcpDraftJson(JSON.stringify({ env: { A: 5 } }), stdioDraft())).toEqual({
			ok: false,
			errorKey: "mcpJsonInvalidField",
			params: { field: "env" },
		});
		expect(parseMcpDraftJson(JSON.stringify({ enabled: "yes" }), stdioDraft())).toEqual({
			ok: false,
			errorKey: "mcpJsonInvalidField",
			params: { field: "enabled" },
		});
	});
});
