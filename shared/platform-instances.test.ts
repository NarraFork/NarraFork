import { describe, expect, test } from "bun:test";
import {
	composeInstancePrefix,
	defaultInstanceNaming,
	isValidInstanceSuffix,
	nextInstanceSuffix,
	splitInstanceSuffix,
} from "./platform-instances";

describe("platform instance naming", () => {
	test("前缀与后缀互转", () => {
		expect(composeInstancePrefix("codex", "2")).toBe("codex-2");
		expect(composeInstancePrefix("codex", "")).toBe("codex");
		expect(splitInstanceSuffix("codex", "codex-2")).toBe("2");
		expect(splitInstanceSuffix("codex", "codex")).toBe("");
		expect(splitInstanceSuffix("codex", "other-2")).toBe("");
	});

	test("默认后缀从 2 起，跳过已占用的前缀", () => {
		expect(nextInstanceSuffix("codex", ["codex"])).toBe("2");
		expect(nextInstanceSuffix("codex", ["codex", "codex-2"])).toBe("3");
		expect(nextInstanceSuffix("codex", ["codex", "codex-2", "codex-4"])).toBe("3");
	});

	test("后缀不能含冒号或空白，否则会破坏 prefix:model 的拆分", () => {
		expect(isValidInstanceSuffix("2")).toBe(true);
		expect(isValidInstanceSuffix("beta_2")).toBe(true);
		expect(isValidInstanceSuffix("a:b")).toBe(false);
		expect(isValidInstanceSuffix("a b")).toBe(false);
		expect(isValidInstanceSuffix("")).toBe(false);
	});

	test("默认命名让名称与前缀各自避让", () => {
		expect(
			defaultInstanceNaming({
				basePrefix: "codex",
				baseName: "Codex",
				takenPrefixes: ["codex"],
				takenNames: ["Codex"],
			}),
		).toEqual({ suffix: "2", name: "Codex-2", prefix: "codex-2" });

		// 前缀空着但名字被占：继续递增，不产生重名
		expect(
			defaultInstanceNaming({
				basePrefix: "codex",
				baseName: "Codex",
				takenPrefixes: ["codex"],
				takenNames: ["Codex", "Codex-2"],
			}),
		).toEqual({ suffix: "3", name: "Codex-3", prefix: "codex-3" });
	});
});
