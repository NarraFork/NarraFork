import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../tool-registry";
import type { ToolDefinition } from "../types";

/**
 * The shell tool used to be registered as `Shell` whenever the detected shell was
 * not bash. Sessions and stored history created under that rule still carry the
 * old name, and a model replaying such history may emit it again. Lookup has to
 * resolve it, because the failure mode is a bare `Unknown tool: Shell` tool result
 * that neither logs nor alerts — it only shows up as a 0s failed tool card.
 */

function stub(name: string): ToolDefinition {
	return {
		name,
		description: `${name} stub`,
		parameters: z.object({}),
		execute: async () => ({ output: name }),
	};
}

describe("ToolRegistry legacy alias lookup", () => {
	const registry = new ToolRegistry();

	afterEach(() => {
		registry.unregister("Bash");
		registry.unregister("Shell");
	});

	test("resolves the legacy Shell name to the registered Bash tool", () => {
		registry.register(stub("Bash"));
		expect(registry.get("Shell")?.name).toBe("Bash");
	});

	test("returns undefined for Shell when no Bash tool is registered", () => {
		expect(registry.get("Shell")).toBeUndefined();
	});

	test("an exact registration wins over the alias fallback", () => {
		// A plugin/MCP tool that genuinely owns the name must not be shadowed by
		// the compatibility mapping.
		registry.register(stub("Bash"));
		registry.register(stub("Shell"));
		expect(registry.get("Shell")?.description).toBe("Shell stub");
	});

	test("non-aliased unknown names still resolve to undefined", () => {
		registry.register(stub("Bash"));
		expect(registry.get("Execute")).toBeUndefined();
		expect(registry.get("PowerShell")).toBeUndefined();
	});
});
