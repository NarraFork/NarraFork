import { describe, expect, test } from "bun:test";
import en from "../../../frontend/locales/en/plugins.json";
import zhCN from "../../../frontend/locales/zh-CN/plugins.json";

function flattenKeys(value: unknown, prefix = ""): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) return [prefix];
	return entries.flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

describe("plugins admin i18n resources", () => {
	test("en and zh-CN plugin locale keys match exactly", () => {
		const enKeys = flattenKeys(en).sort();
		const zhKeys = flattenKeys(zhCN).sort();
		expect(zhKeys).toEqual(enKeys);
	});

	test("admin surface keys exist in both locales", () => {
		for (const locale of [en, zhCN]) {
			const admin = (locale as Record<string, unknown>).admin as Record<string, unknown>;
			expect(admin).toBeDefined();
			expect(typeof admin.title).toBe("string");
			expect(typeof admin.install).toBe("string");
			expect(typeof admin.disabledBannerTitle).toBe("string");
			const errors = admin.errors as Record<string, unknown>;
			expect(typeof errors.PLUGINS_DISABLED).toBe("string");
			expect(typeof errors.PLUGIN_OPERATION_FAILED).toBe("string");
			expect(typeof errors.PLUGIN_RETRY_REQUIRES_RESTART).toBe("string");
			expect(typeof errors.UNKNOWN).toBe("string");
			const grants = ((admin.detail as Record<string, unknown>).grants ?? {}) as Record<
				string,
				unknown
			>;
			expect(typeof grants.readOnlyMessage).toBe("string");
		}
	});
});
