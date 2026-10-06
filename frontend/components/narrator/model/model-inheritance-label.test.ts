import { describe, expect, it } from "bun:test";
import narratorEn from "../../../locales/en/narrator.json";
import narratorZh from "../../../locales/zh-CN/narrator.json";
import { modelInheritanceLabel } from "./model-inheritance-label";

function translator(dict: Record<string, unknown>) {
	return (key: string, opts?: Record<string, unknown>) =>
		String(dict[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] ?? ""));
}

describe("modelInheritanceLabel", () => {
	it("keeps the plain follow-parent state when no decision is known", () => {
		expect(modelInheritanceLabel(undefined, translator(narratorEn))).toBeNull();
	});

	it("labels a followed parent with its concrete model and no reason", () => {
		const label = modelInheritanceLabel(
			{ source: "parent", model: "opus", parentModel: "opus" },
			translator(narratorZh),
		);
		expect(label).toEqual({ label: "跟随 · opus", model: "opus", fallback: false });
	});

	it("keeps the fallback reason out of the short label", () => {
		const label = modelInheritanceLabel(
			{ source: "pool-fallback", model: "haiku", parentModel: "opus", poolKey: "explore" },
			translator(narratorZh),
		);
		expect(label?.label).toBe("回退 · haiku");
		expect(label?.reason).toBe("主代理的 opus 不在 explore 池中");
		expect(label?.fallback).toBe(true);
	});
});
