import { afterEach, describe, expect, test } from "bun:test";
import { settings } from "../../settings";
import { resolveProviderAndModel } from "../provider";

// 端到端验证「额外平台实例」在真实解析链路上可用：settings 里放一条 codex-2 实例，
// resolveProviderAndModel 解析 `codex-2:<model>` 时应拿到该实例，而不是回退或报错。
const original = settings.agent?.platformInstances;

afterEach(() => {
	if (original === undefined) Reflect.deleteProperty(settings.agent, "platformInstances");
	else settings.agent.platformInstances = original;
});

describe("platform instance resolution (end to end)", () => {
	test("codex-2:model 解析到 codex-2 provider", () => {
		settings.agent.platformInstances = [
			{
				id: "platform-codex-2",
				platform: "codex",
				name: "Codex-2",
				suffix: "2",
				prefix: "codex-2",
				disabled: false,
				config: { useWebSocket: false },
			},
		];
		const resolved = resolveProviderAndModel("codex-2:gpt-5.4");
		expect(resolved.provider).toBe("codex-2");
		// 带前缀的 model 在解析结果里保持原样（与其它 provider 一致），
		// 由适配器自己拆分；这里只确认它没有回退到内置 codex。
		expect(resolved.model).toBe("codex-2:gpt-5.4");
		expect(resolved.adapter).toBeDefined();
	});

	test("未配置的实例前缀不会凭空解析成功", () => {
		settings.agent.platformInstances = [];
		expect(() => resolveProviderAndModel("codex-9:gpt-5.4")).toThrow();
	});
});
