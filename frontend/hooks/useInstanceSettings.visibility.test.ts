import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_CONTEXT_THRESHOLDS } from "@shared/context-thresholds";
import en from "../locales/en/settings.json";
import zh from "../locales/zh-CN/settings.json";

const hook = readFileSync(new URL("./useInstanceSettings.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../routes/settings/agent.tsx", import.meta.url), "utf8");
const section = readFileSync(
	new URL("../components/settings/AgentSection.tsx", import.meta.url),
	"utf8",
);

describe("default narrator write audience settings wiring", () => {
	test("has an independent type and defaults missing settings to auto", () => {
		expect(hook).toContain(
			'export type DefaultNarratorWriteAudience = "auto" | "owner" | "project" | "public"',
		);
		expect(hook).toContain("defaultNarratorWriteAudience: DefaultNarratorWriteAudience");
		expect(hook).toContain('defaultNarratorWriteAudience: "auto"');
		expect(hook).toContain(
			'defaultNarratorWriteAudience: settings.agent?.defaultNarratorWriteAudience ?? "auto"',
		);
	});

	test("saves independently and wires the controlled selector and setter", () => {
		expect(hook).toContain("defaultNarratorWriteAudience: state.defaultNarratorWriteAudience");
		expect(page).toContain("defaultNarratorWriteAudience={is.defaultNarratorWriteAudience}");
		expect(page).toContain("setDefaultNarratorWriteAudience={is.setDefaultNarratorWriteAudience}");
		expect(section).toContain("value={props.defaultNarratorWriteAudience}");
		expect(section).toContain("props.setDefaultNarratorWriteAudience(");
		expect(section).toContain('v === "owner" || v === "project" || v === "public" ? v : "auto"');
	});

	test("offers four bilingual choices and explains visibility limits and inheritance", () => {
		for (const [value, suffix] of [
			["auto", "Auto"],
			["owner", "Owner"],
			["project", "Project"],
			["public", "Public"],
		]) {
			const key = `defaultNarratorWriteAudience${suffix}` as keyof typeof en;
			expect(section).toContain(`{ value: "${value}", label: t("${key}") }`);
			expect(en[key]).toBeTruthy();
			expect(zh[key]).toBeTruthy();
		}
		for (const text of [
			"newly created",
			"existing sessions are unchanged",
			"Forks inherit",
			"Auto follows visibility",
			"administrators and explicit grants",
			"project members with write access",
			"meet project access requirements",
			"never expands visibility",
			"automatically narrowed at creation",
			"effective visibility",
		])
			expect(en.defaultNarratorWriteAudienceDesc).toContain(text);
		for (const text of [
			"仅对新建叙述者生效",
			"不改变已有会话",
			"分叉继承来源会话的权限",
			"跟随可见范围",
			"管理员和显式授权仍按现有规则",
			"具有项目操作权限的成员",
			"所有符合项目访问条件的登录用户",
			"不会扩大可见范围",
			"创建时会自动收窄",
			"有效可见性",
		])
			expect(zh.defaultNarratorWriteAudienceDesc).toContain(text);
	});
});

describe("compaction-only context settings", () => {
	test("uses shared standard 95 and large 75 defaults in both editors", () => {
		const panel = readFileSync(
			new URL("../components/narrator/NarratorPanel.tsx", import.meta.url),
			"utf8",
		);
		expect(DEFAULT_CONTEXT_THRESHOLDS).toEqual({
			standard: { compactStart: 95 },
			large: { compactStart: 75 },
		});
		expect(hook).toContain("cloneDefaultContextThresholds()");
		for (const size of ["standard", "large"]) {
			expect(section).toContain(`DEFAULT_CONTEXT_THRESHOLDS.${size}.compactStart`);
			expect(panel).toContain(`DEFAULT_CONTEXT_THRESHOLDS.${size}.compactStart`);
		}
		expect(panel).toContain("api.triggerCompact(narratorId)");
		expect(panel).toContain('t("contextThresholdSettingsTitle")');
		for (const source of [hook, page, section, panel]) {
			expect(source).not.toMatch(/prun/i);
		}
	});

	test("keeps bilingual compaction labels and unrelated avatar cropping", () => {
		for (const locale of [en, zh]) {
			expect(locale.compactStart).toBeTruthy();
			expect(locale.compactStartDesc).toContain("95%");
			expect(locale.compactStartDesc).toContain("75%");
			expect(locale.avatarCropTitle).toBeTruthy();
			expect(Object.keys(locale).filter((key) => /prun/i.test(key))).toEqual([]);
		}
	});
});

// Source-level wiring guards follow the existing hook contract test convention.
describe("default narrator visibility settings wiring", () => {
	test("defaults to auto and loads older settings with an auto fallback", () => {
		expect(hook).toContain('defaultNarratorVisibility: "auto"');
		expect(hook).toContain(
			'defaultNarratorVisibility: settings.agent?.defaultNarratorVisibility ?? "auto"',
		);
	});

	test("saves the selected value and exposes its generated setter to the section", () => {
		expect(hook).toContain("defaultNarratorVisibility: state.defaultNarratorVisibility");
		expect(hook).toContain("Object.keys(makeDefaults())");
		expect(page).toContain("defaultNarratorVisibility={is.defaultNarratorVisibility}");
		expect(page).toContain("setDefaultNarratorVisibility={is.setDefaultNarratorVisibility}");
		expect(section).toContain("value={props.defaultNarratorVisibility}");
		expect(section).toContain(
			'props.setDefaultNarratorVisibility(v === "private" || v === "public" ? v : "auto")',
		);
	});

	test("offers all three choices with bilingual labels and scope explanations", () => {
		for (const [value, suffix] of [
			["auto", "Auto"],
			["private", "Private"],
			["public", "Public"],
		]) {
			const key = `defaultNarratorVisibility${suffix}` as keyof typeof en;
			expect(section).toContain(`{ value: "${value}", label: t("${key}") }`);
			expect(en[key]).toBeTruthy();
			expect(zh[key]).toBeTruthy();
		}
		expect(en.defaultNarratorVisibilityDesc).toContain("newly created");
		expect(en.defaultNarratorVisibilityDesc).toContain("Forks inherit");
		expect(en.defaultNarratorVisibilityDesc).toContain("separate default write audience");
		expect(en.defaultNarratorVisibilityDesc).not.toContain("who can continue them");
		expect(zh.defaultNarratorVisibilityDesc).toContain("操作权限由独立的默认可操作范围设置决定");
		expect(zh.defaultNarratorVisibilityDesc).not.toContain("并可按现有规则接续操作");
		expect(zh.defaultNarratorVisibilityDesc).toContain("仅对新建叙述者生效");
		expect(zh.defaultNarratorVisibilityDesc).toContain("分叉继承来源会话的权限");
		expect(zh.defaultNarratorVisibilityDesc).toContain("所有登录用户可见");
	});
});
