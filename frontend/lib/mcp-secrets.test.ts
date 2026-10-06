import { describe, expect, test } from "bun:test";
import {
	buildMcpSecretPatch,
	createPreservedMcpSecretEntries,
	secretEntriesToRecord,
} from "./mcp-secrets";

describe("MCP secret draft patches", () => {
	test("preserves untouched keys and only deletes removed keys", () => {
		const entries = createPreservedMcpSecretEntries(["TOKEN", "KEEP"]);
		entries[0].value = "new-token";
		entries[0].dirty = true;
		entries.splice(1, 1);
		entries.push({ key: "ADDED", value: "value" });

		expect(buildMcpSecretPatch(entries, ["TOKEN", "KEEP"])).toEqual({
			set: { TOKEN: "new-token", ADDED: "value" },
			delete: ["KEEP"],
		});
	});

	test("returns no patch when preserved values are untouched", () => {
		const entries = createPreservedMcpSecretEntries(["TOKEN"]);
		expect(buildMcpSecretPatch(entries, ["TOKEN"])).toBeUndefined();
	});

	test("serializes complete values for a new server", () => {
		expect(
			secretEntriesToRecord([
				{ key: "TOKEN", value: "secret" },
				{ key: "", value: "ignored" },
			]),
		).toEqual({ TOKEN: "secret" });
	});
});
