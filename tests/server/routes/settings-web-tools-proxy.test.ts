import { describe, expect, test } from "bun:test";
import { updateSettingsSchema } from "../../../server/routes/settings";

describe("web tool proxy settings write validation", () => {
	test("update proxy uses the same validation without requiring source fields", () => {
		for (const mode of ["default", "direct", "system"] as const) {
			const patch = { update: { proxy: { mode } } };
			expect(updateSettingsSchema.parse(patch)).toEqual(patch);
		}
		expect(
			updateSettingsSchema.parse({
				update: { proxy: { mode: "custom", url: " proxy.example:8080 " } },
			}),
		).toEqual({ update: { proxy: { mode: "custom", url: "http://proxy.example:8080" } } });
		for (const url of [undefined, "http://", "http://a b", "socks5://host:1080"]) {
			expect(
				updateSettingsSchema.safeParse({ update: { proxy: { mode: "custom", url } } }).success,
			).toBe(false);
		}
	});

	test("accepts independent minimal tool proxy patches", () => {
		for (const mode of ["default", "direct", "system"] as const) {
			const patch = { agent: { browserProxy: { mode } } };
			expect(updateSettingsSchema.parse(patch)).toEqual(patch);
			const fetchPatch = { agent: { webFetchPolicy: { proxy: { mode } } } };
			expect(updateSettingsSchema.parse(fetchPatch)).toEqual(fetchPatch);
		}
	});

	test("normalizes custom proxy URLs and preserves WebFetch permission policy", () => {
		const result = updateSettingsSchema.parse({
			agent: {
				browserProxy: { mode: "custom", url: " browser.example:8080 " },
				webFetchPolicy: {
					proxy: { mode: "custom", url: "fetch.example:8081" },
					allowAll: false,
					whitelist: [{ pattern: "example.test", enabled: true }],
				},
			},
		});
		expect(result.agent?.browserProxy?.url).toBe("http://browser.example:8080");
		expect(result.agent?.webFetchPolicy).toEqual({
			proxy: { mode: "custom", url: "http://fetch.example:8081" },
			allowAll: false,
			whitelist: [{ pattern: "example.test", enabled: true }],
		});
	});

	test("rejects invalid or missing custom URLs for either tool", () => {
		for (const url of [undefined, "", "not a proxy", "socks5://proxy.example:1080"]) {
			expect(
				updateSettingsSchema.safeParse({ agent: { browserProxy: { mode: "custom", url } } })
					.success,
			).toBe(false);
			expect(
				updateSettingsSchema.safeParse({
					agent: { webFetchPolicy: { proxy: { mode: "custom", url } } },
				}).success,
			).toBe(false);
		}
	});
});
