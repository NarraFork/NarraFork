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
		config: { useWebSocket: false },
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
});
