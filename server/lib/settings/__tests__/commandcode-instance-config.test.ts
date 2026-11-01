import { afterEach, describe, expect, test } from "bun:test";
import type { PlatformInstanceRow } from "@shared/platform-instances";
import { settings } from "../index";
import { commandCodeConfigForPrefix } from "../provider";

function instance(prefix: string, apiKey: string, baseUrl?: string): PlatformInstanceRow {
	return {
		id: `platform-${prefix}`,
		platform: "CommandCode",
		suffix: prefix === "CommandCode" ? "" : prefix,
		prefix,
		disabled: false,
		config: { apiKey, ...(baseUrl ? { baseUrl } : {}) },
	};
}

const original = settings.agent?.platformInstances;
const originalLegacy = settings.commandCode;
afterEach(() => {
	if (original === undefined) Reflect.deleteProperty(settings.agent, "platformInstances");
	else settings.agent.platformInstances = original;
	settings.commandCode = originalLegacy;
});

describe("Command Code 的实例配置解析", () => {
	test("默认取默认前缀那条实例，而不是旧单例字段", () => {
		settings.agent.platformInstances = [
			instance("CommandCode-2", "key-two"),
			instance("CommandCode", "key-default", "https://proxy.example/v1"),
		];
		settings.commandCode = { apiKey: "legacy-key" };
		expect(commandCodeConfigForPrefix()?.apiKey).toBe("key-default");
		expect(commandCodeConfigForPrefix()?.baseUrl).toBe("https://proxy.example/v1");
	});

	test("按前缀取对应实例；没有默认前缀时取第一条", () => {
		settings.agent.platformInstances = [
			instance("CommandCode-1", "key-one"),
			instance("CommandCode-2", "key-two"),
		];
		expect(commandCodeConfigForPrefix("CommandCode-2")?.apiKey).toBe("key-two");
		expect(commandCodeConfigForPrefix()?.apiKey).toBe("key-one");
	});

	test("没有任何实例时回落到旧单例字段（迁移前的安装）", () => {
		settings.agent.platformInstances = [];
		settings.commandCode = { apiKey: "legacy-key" };
		expect(commandCodeConfigForPrefix()?.apiKey).toBe("legacy-key");
	});
});
