import { describe, expect, test } from "bun:test";
import { instanceCardName, nextInstanceSuffix, resolveInstancePrefix } from "./platform-instances";

describe("平台实例命名", () => {
	test("卡片名：默认那一条用平台显示名，带后缀时用 前缀-后缀", () => {
		expect(instanceCardName("codex", "")).toBe("Codex");
		expect(instanceCardName("codex", "1")).toBe("codex-1");
		expect(instanceCardName("codex", "teamA")).toBe("codex-teamA");
		expect(instanceCardName("CommandCode", "2")).toBe("CommandCode-2");
		expect(instanceCardName("tokendance", "")).toBe("TokenDance");
	});

	test("默认后缀从 1 开始，跳过已占用的卡片名与前缀", () => {
		expect(nextInstanceSuffix({ platform: "codex", takenNames: [], takenPrefixes: [] })).toBe("1");
		expect(
			nextInstanceSuffix({
				platform: "codex",
				takenNames: ["codex", "codex-1"],
				takenPrefixes: ["codex", "codex-1"],
			}),
		).toBe("2");
		// 前缀被别人单独占用时也要避开——它和卡片名共享同一命名空间。
		expect(
			nextInstanceSuffix({
				platform: "codex",
				takenNames: ["codex"],
				takenPrefixes: ["codex", "codex-1"],
			}),
		).toBe("2");
	});

	test("模型前缀留空时等于卡片名", () => {
		expect(resolveInstancePrefix("codex", "1", "")).toBe("codex-1");
		expect(resolveInstancePrefix("codex", "1", "  ")).toBe("codex-1");
		expect(resolveInstancePrefix("codex", "1", "my-codex")).toBe("my-codex");
	});
});
