import { describe, expect, it } from "bun:test";
import { deepMerge, stripObsoleteSettingsKeys } from "../../../server/lib/settings";

describe("settings deepMerge", () => {
	it("merges nested objects", () => {
		const defaults = { server: { port: 7778 }, agent: { model: "claude" } };
		const overrides = { server: { port: 9000 } };
		const result = deepMerge(defaults, overrides);
		expect(result.server.port).toBe(9000);
		expect(result.agent.model).toBe("claude");
	});

	it("does not merge arrays", () => {
		const defaults = { items: [1, 2] };
		const overrides = { items: [3] };
		const result = deepMerge(defaults, overrides);
		expect(result.items).toEqual([3]);
	});

	it("preserves defaults for missing keys", () => {
		const defaults = { a: { x: 1, y: 2 }, b: "hello" };
		const overrides = { a: { x: 10 } };
		const result = deepMerge(defaults, overrides);
		expect(result.a.x).toBe(10);
		expect(result.a.y).toBe(2);
		expect(result.b).toBe("hello");
	});

	it("ignores unknown top-level keys", () => {
		const defaults = { a: 1 };
		const overrides = { a: 2, unknown: "foo" };
		const result = deepMerge(defaults, overrides);
		expect(result.a).toBe(2);
		// biome-ignore lint/suspicious/noExplicitAny: test utility cast
		expect((result as any).unknown).toBe("foo");
	});
});

describe("stripObsoleteSettingsKeys", () => {
		const value: Record<string, unknown> = {
			customApiProviders: [],
			nugProviders: [],
		};

		expect(stripObsoleteSettingsKeys(value)).toBe(true);
		expect(value).toEqual({ customApiProviders: [], nugProviders: [] });
	});

		const value: Record<string, unknown> = { customApiProviders: [] };

		expect(stripObsoleteSettingsKeys(value)).toBe(false);
		expect(value).toEqual({ customApiProviders: [] });
	});
});
