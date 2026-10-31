import { afterEach, describe, expect, test } from "bun:test";
import type { PlatformInstanceRow } from "@shared/platform-instances";
import { settings } from "../../settings";
import { CodexProvider } from "../codex-provider";
import {
	listPlatformInstanceReadiness,
	resolvePlatformInstanceAdapter,
} from "../platform-instance-providers";
import { resolveProviderAndModel } from "../provider";

function instance(overrides: Partial<PlatformInstanceRow> = {}): PlatformInstanceRow {
	return {
		id: "platform-codex-1",
		platform: "codex",
		suffix: "1",
		prefix: "codex-1",
		disabled: false,
		config: { useWebSocket: false },
		...overrides,
	};
}

const original = settings.agent?.platformInstances;
afterEach(() => {
	if (original === undefined) Reflect.deleteProperty(settings.agent, "platformInstances");
	else settings.agent.platformInstances = original;
});

describe("平台实例的解析（清单驱动）", () => {
	test("清单里的任意前缀都能解析成对应平台的适配器", () => {
		expect(resolvePlatformInstanceAdapter("codex-1", "gpt-5", [instance()])).toBeInstanceOf(
			CodexProvider,
		);
		// 默认前缀同样是清单里的一条，没有特殊照顾。
		expect(
			resolvePlatformInstanceAdapter("codex", "gpt-5", [
				instance({ id: "platform-codex", suffix: "", prefix: "codex" }),
			]),
		).toBeInstanceOf(CodexProvider);
	});

	test("清单里没有这个前缀就不是平台", () => {
		expect(resolvePlatformInstanceAdapter("codex", "gpt-5", [instance()])).toBeNull();
		expect(resolvePlatformInstanceAdapter("codex-2", "gpt-5", [instance()])).toBeNull();
	});

	test("就绪信息覆盖清单里的每一条", () => {
		const entries = listPlatformInstanceReadiness([
			instance(),
			instance({ id: "x", suffix: "2", prefix: "codex-2", disabled: true }),
		]);
		expect(entries.map((entry) => entry.prefix)).toEqual(["codex-1", "codex-2"]);
		// 卡片名：带后缀是 前缀-后缀。
		expect(entries.map((entry) => entry.name)).toEqual(["codex-1", "codex-2"]);
		expect(entries[1]?.ready).toBe(false);
	});

	test("Codex 实例没有选中可用凭据时不算就绪，也不借用账号池", () => {
		expect(
			listPlatformInstanceReadiness([instance({ config: { credentialIds: ["gone"] } })])[0]
				?.ready,
		).toBe(false);
		expect(
			listPlatformInstanceReadiness([instance({ config: { credentialIds: [] } })])[0]?.ready,
		).toBe(false);
	});
});

describe("平台实例在真实解析链路上", () => {
	test("删掉默认前缀那条实例后，该平台不再解析", () => {
		settings.agent.platformInstances = [
			instance({ id: "platform-codex", suffix: "", prefix: "codex" }),
		];
		expect(resolveProviderAndModel("codex:gpt-5.4").provider).toBe("codex");

		settings.agent.platformInstances = [];
		expect(() => resolveProviderAndModel("codex:gpt-5.4")).toThrow();
		expect(() => resolveProviderAndModel("tokendance:model")).toThrow();
	});

	test("清单为空时不会把旧的单例字段合成回来", () => {
		settings.agent.platformInstances = [];
		expect(() => resolveProviderAndModel("CommandCode:chat")).toThrow();
		expect(() => resolveProviderAndModel("codex:gpt-5.4")).toThrow();
	});

	test("删掉之后同一个前缀可以给新实例复用", () => {
		settings.agent.platformInstances = [
			instance({ id: "later", suffix: "", prefix: "codex", config: { useWebSearch: false } }),
		];
		const resolved = resolveProviderAndModel("codex:gpt-5.4");
		expect(resolved.provider).toBe("codex");
		expect(resolved.adapter).toBeDefined();
	});

	test("同一平台的两个实例各用自己的前缀解析", () => {
		settings.agent.platformInstances = [
			instance({ id: "a", suffix: "1", prefix: "codex-1" }),
			instance({ id: "b", suffix: "2", prefix: "codex-2" }),
		];
		expect(resolveProviderAndModel("codex-1:gpt-5.4").provider).toBe("codex-1");
		expect(resolveProviderAndModel("codex-2:gpt-5.4").provider).toBe("codex-2");
		expect(resolveProviderAndModel("codex-1:gpt-5.4").model).toBe("codex-1:gpt-5.4");
	});
});
