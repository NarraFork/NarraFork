import { describe, expect, test } from "bun:test";
import type { PlatformInstance } from "../settings/platform-instances";
import { CodexProvider } from "./codex-provider";
import {
	listPlatformInstanceReadiness,
	resolvePlatformInstanceAdapter,
} from "./platform-instance-providers";
import { TokenDanceProvider } from "./tokendance-provider";

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
	test("内置前缀不由这里解析（保持原有注册的行为）", () => {
		expect(resolvePlatformInstanceAdapter("codex", "gpt-5", [instance()])).toBeNull();
		expect(resolvePlatformInstanceAdapter("CommandCode", "x", [instance()])).toBeNull();
	});

	test("额外实例按前缀解析成对应平台的适配器", () => {
		const adapter = resolvePlatformInstanceAdapter("codex-2", "gpt-5", [instance()]);
		expect(adapter).toBeInstanceOf(CodexProvider);
	});

	test("未登记的实例前缀返回 null，交给其它来源继续匹配", () => {
		expect(resolvePlatformInstanceAdapter("codex-9", "gpt-5", [instance()])).toBeNull();
	});

	test("就绪信息只列额外实例，停用的实例标记为未就绪", () => {
		const entries = listPlatformInstanceReadiness([
			instance(),
			instance({ id: "platform-codex", prefix: "codex", suffix: "", name: "Codex" }),
			instance({ id: "x", prefix: "codex-3", suffix: "3", name: "Codex-3", disabled: true }),
		]);
		expect(entries.map((entry) => entry.prefix)).toEqual(["codex-2", "codex-3"]);
		expect(entries[0]?.ready).toBe(true);
		expect(entries[1]?.ready).toBe(false);
	});

	test("Codex 实例没选中凭据时不算就绪，也不借用内置凭据", () => {
		const entries = listPlatformInstanceReadiness([instance({ config: { useWebSocket: false } })]);
		expect(entries[0]?.ready).toBe(false);
	});

	test("TokenDance 实例只在自带 apiKey 时生成适配器并算就绪", () => {
		const withoutKey = instance({
			platform: "tokendance",
			prefix: "tokendance-2",
			config: {},
		});
		expect(resolvePlatformInstanceAdapter("tokendance-2", "model", [withoutKey])).toBeNull();
		expect(listPlatformInstanceReadiness([withoutKey])[0]?.ready).toBe(false);

		const withKey = instance({
			platform: "tokendance",
			prefix: "tokendance-2",
			config: { apiKey: "td-key" },
		});
		expect(resolvePlatformInstanceAdapter("tokendance-2", "model", [withKey])).toBeInstanceOf(
			TokenDanceProvider,
		);
		expect(listPlatformInstanceReadiness([withKey])[0]?.ready).toBe(true);
	});
});
