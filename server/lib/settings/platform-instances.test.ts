import { describe, expect, test } from "bun:test";
import { initialPlatformInstances } from "./platform-instances";

describe("平台实例的初始清单", () => {
	test("每个平台一条，后缀为空、前缀用平台默认值", () => {
		const instances = initialPlatformInstances({});
		expect(instances.map((entry) => entry.prefix)).toEqual(["codex", "CommandCode", "tokendance"]);
		expect(instances.map((entry) => entry.platform)).toEqual([
			"codex",
			"CommandCode",
			"tokendance",
		]);
		for (const entry of instances) expect(entry.suffix).toBe("");
	});

	test("旧单例的配置原样搬进对应实例", () => {
		const [, commandCode, tokendance] = initialPlatformInstances({
			commandCode: { apiKey: "cc-key", baseUrl: "https://cc.example" },
			tokendance: { apiKey: "td-key", generation: 7, disabled: false, models: [] },
		});
		expect(commandCode?.config).toEqual({ apiKey: "cc-key", baseUrl: "https://cc.example" });
		expect(tokendance?.config).toMatchObject({ apiKey: "td-key", generation: 7 });
	});

	test("Codex 只搬实例自己的字段，账号池策略仍是全局设置", () => {
		const [codex] = initialPlatformInstances({
			codex: {
				useWebSocket: false,
				useWebSearch: false,
				proxy: { mode: "custom", url: "http://127.0.0.1:7890" },
				userAgentMode: "codex",
				loadBalancingMode: "tier-balanced",
				tierOrder: ["pro", "plus"],
			},
		});
		expect(codex?.config).toEqual({
			useWebSocket: false,
			useWebSearch: false,
			proxy: { mode: "custom", url: "http://127.0.0.1:7890" },
			userAgentMode: "codex",
		});
	});
});
