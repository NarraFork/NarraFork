import { describe, expect, test } from "bun:test";
import type { PlatformInstance } from "../settings/platform-instances";
import { CodexProvider } from "./codex-provider";
import {
	listPlatformInstanceReadiness,
	resolvePlatformInstanceAdapter,
} from "./platform-instance-providers";

function instance(overrides: Partial<PlatformInstance> = {}): PlatformInstance {
	return {
		id: "platform-codex-2",
		platform: "codex",
		name: "Codex-2",
		suffix: "2",
		prefix: "codex-2",
		disabled: false,
		config: { useWebSocket: false, credentialIds: ["cred-1"] },
		...overrides,
	};
}

describe("platform instance providers", () => {
	test("默认前缀的实例和额外实例走同一条解析路径", () => {
		const builtin = instance({ id: "platform-codex", prefix: "codex", suffix: "", name: "Codex" });
		expect(resolvePlatformInstanceAdapter("codex", "gpt-5", [builtin])).toBeInstanceOf(
			CodexProvider,
		);
		expect(resolvePlatformInstanceAdapter("codex-2", "gpt-5", [instance()])).toBeInstanceOf(
			CodexProvider,
		);
	});

	test("清单里没有这个前缀就不是平台，交给其它来源继续匹配", () => {
		// 删掉内置实例后，同一个前缀不再被平台接管。
		expect(resolvePlatformInstanceAdapter("codex", "gpt-5", [instance()])).toBeNull();
		expect(resolvePlatformInstanceAdapter("codex-9", "gpt-5", [instance()])).toBeNull();
		// 清单为空时没有任何平台。
		expect(resolvePlatformInstanceAdapter("codex", "gpt-5", [])).toBeNull();
		expect(listPlatformInstanceReadiness([])).toEqual([]);
	});

	test("删掉的内置实例前缀可以给新实例复用", () => {
		const reused = instance({ id: "later", prefix: "codex", suffix: "", name: "第二个 Codex" });
		expect(resolvePlatformInstanceAdapter("codex", "gpt-5", [reused])).toBeInstanceOf(
			CodexProvider,
		);
		expect(listPlatformInstanceReadiness([reused])).toHaveLength(1);
	});

	test("就绪信息覆盖清单里的每一条，停用的实例标记为未就绪", () => {
		const entries = listPlatformInstanceReadiness([
			instance(),
			instance({ id: "x", prefix: "codex-3", suffix: "3", name: "Codex-3", disabled: true }),
		]);
		expect(entries.map((entry) => entry.prefix)).toEqual(["codex-2", "codex-3"]);
		expect(entries[1]?.ready).toBe(false);
	});

	test("Codex 实例没有可用凭据时不算就绪，也不会借用内置凭据", () => {
		// 选中了不存在的凭据
		expect(listPlatformInstanceReadiness([instance()])[0]?.ready).toBe(false);
		// 选了空集合 = 不配
		expect(
			listPlatformInstanceReadiness([instance({ config: { credentialIds: [] } })])[0]?.ready,
		).toBe(false);
	});

	test("TokenDance 实例只在自带 apiKey 时生成适配器并算就绪", () => {
		const withoutKey = instance({ platform: "tokendance", prefix: "tokendance-2", config: {} });
		expect(resolvePlatformInstanceAdapter("tokendance-2", "model", [withoutKey])).toBeNull();
		expect(listPlatformInstanceReadiness([withoutKey])[0]?.ready).toBe(false);

		const withKey = instance({
			platform: "tokendance",
			prefix: "tokendance-2",
			config: { apiKey: "td-key" },
		});
		expect(resolvePlatformInstanceAdapter("tokendance-2", "model", [withKey])).not.toBeNull();
		expect(listPlatformInstanceReadiness([withKey])[0]?.ready).toBe(true);
	});
});
