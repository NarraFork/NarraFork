import { describe, expect, test } from "bun:test";
import {
	duplicateInstancePrefixes,
	PLATFORM_DEFAULTS,
	resolvePlatformInstances,
} from "./platform-instances";

describe("platform instance resolution", () => {
	test("有实例清单时以清单为准，忽略旧单例", () => {
		const resolved = resolvePlatformInstances({
			instances: [
				{
					id: "a",
					platform: "codex",
					name: "Codex",
					suffix: "",
					prefix: "codex",
					disabled: false,
					config: {},
				},
			],
			legacy: { codex: { apiKey: "legacy" }, commandCode: { apiKey: "legacy" } },
		});
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.prefix).toBe("codex");
	});

	test("没有实例时把旧单例合成实例，prefix 用平台默认值", () => {
		const resolved = resolvePlatformInstances({
			legacy: { codex: { loadBalancingMode: "tier-balanced" }, commandCode: { apiKey: "k" } },
			disabledProviders: ["CommandCode"],
		});
		expect(resolved.map((instance) => instance.prefix)).toEqual(["codex", "CommandCode"]);
		expect(resolved[0]).toMatchObject({
			platform: "codex",
			name: PLATFORM_DEFAULTS.codex.name,
			suffix: "",
			disabled: false,
		});
		// 旧版的停用清单映射到实例的 disabled
		expect(resolved[1]).toMatchObject({ prefix: "CommandCode", disabled: true });
	});

	test("从未配置过的平台不凭空生成实例", () => {
		expect(resolvePlatformInstances({})).toEqual([]);
		expect(resolvePlatformInstances({ legacy: { codex: {} } })).toEqual([]);
	});

	test("前缀重复能被检出", () => {
		expect(duplicateInstancePrefixes([{ prefix: "codex" }, { prefix: "codex-2" }])).toEqual([]);
		expect(duplicateInstancePrefixes([{ prefix: "codex" }, { prefix: "codex" }])).toEqual([
			"codex",
		]);
	});
});
