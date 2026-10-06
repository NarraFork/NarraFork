/**
 * Title generation must follow the user's actual request, not the skill body
 * that `/skill` injects into the message (issue #98).
 *
 * Slash-skill send builds:
 *   `<command-name>…</command-name>\n<skill_content>…docs…</skill_content>\n\n{userInput}`
 * and that expanded string is what provisional / quick / full title paths
 * receive. Without stripping, the summary model titles the skill manual.
 */
import { describe, expect, test } from "bun:test";
import {
	buildProvisionalTitle,
	buildQuickTitleSource,
	buildTitleConversationText,
	extractUserRequestForTitle,
} from "./narrator-title";

const SKILL_INTRO = `<command-name>release</command-name>
<skill_content name="release">
# Skill: release

完整的版本发布流程：从 git 提交记录生成双语更新日志，执行版本发布。

## When to use
Use this skill whenever the user asks for a changelog, release notes, or to cut a release.
Do not invent versions. Do not push without confirmation. Always verify the working tree.

## Steps
1. Collect commits since the last tag
2. Translate into bilingual entries
3. Write changelogs/v{version}.json
4. Run bun scripts/release.ts
5. Upload artifacts

Base directory for this skill: /home/user/.narrafork/skills/release

<skill_files>
<file>/home/user/.narrafork/skills/release/references/api.md</file>
</skill_files>
</skill_content>`;

const USER_REQUEST = "帮我给当前版本生成中英文更新日志，不要发布";

describe("extractUserRequestForTitle", () => {
	test("keeps the user request after skill expansion", () => {
		const raw = `${SKILL_INTRO}\n\n${USER_REQUEST}`;
		expect(extractUserRequestForTitle(raw)).toBe(USER_REQUEST);
	});

	test("does not leak skill documentation into the title source", () => {
		const raw = `${SKILL_INTRO}\n\n${USER_REQUEST}`;
		const extracted = extractUserRequestForTitle(raw);
		expect(extracted).not.toContain("Skill: release");
		expect(extracted).not.toContain("完整的版本发布流程");
		expect(extracted).not.toContain("skill_content");
		expect(extracted).not.toContain("When to use");
	});

	test("falls back to skill name when the user sent no free-form request", () => {
		expect(extractUserRequestForTitle(SKILL_INTRO)).toBe("release");
	});

	test("handles skill body containing a literal close tag", () => {
		const tricky = `<command-name>commit</command-name>
<skill_content name="commit">
# Skill: commit
Example: </skill_content> is an XML tag.
</skill_content>

fix the login bug`;
		expect(extractUserRequestForTitle(tricky)).toBe("fix the login bug");
	});

	test("leaves ordinary user messages unchanged", () => {
		expect(extractUserRequestForTitle("rename Foo to Bar")).toBe("rename Foo to Bar");
	});

	test("preserves literal skill tags and command wrappers in ordinary user code", () => {
		for (const message of [
			'Fix parser for "</skill_content>" please',
			'Explain this XML: <skill_content name="x">docs</skill_content> tail',
			"Code: ```xml\n<command-name>x</command-name>\n</skill_content>\n```",
		])
			expect(extractUserRequestForTitle(message)).toBe(message.replace(/\s+/g, " ").trim());
	});

	test("preserves a trailing request containing another literal close tag", () => {
		const request = "Fix XML renderer: ```xml\n</skill_content>\n```";
		expect(extractUserRequestForTitle(`${SKILL_INTRO}\n\n${request}`)).toBe(
			request.replace(/\s+/g, " ").trim(),
		);
	});

	test("does not strip mismatched or incomplete leading skill envelopes", () => {
		for (const message of [
			'<command-name>x</command-name>\n<skill_content name="y">\ndocs\n</skill_content>\nrequest',
			'<command-name>x</command-name>\n<skill_content name="x">unclosed',
		]) {
			expect(extractUserRequestForTitle(message)).toBe(message.replace(/\s+/g, " ").trim());
		}
	});

	test("strips a bare command-name wrapper without skill body", () => {
		expect(extractUserRequestForTitle("<command-name>commit</command-name>\n\nplease commit")).toBe(
			"please commit",
		);
	});
});

describe("buildProvisionalTitle (provisional path)", () => {
	test("titles from the user request, not the skill intro", () => {
		const raw = `${SKILL_INTRO}\n\n${USER_REQUEST}`;
		const title = buildProvisionalTitle(raw);
		expect(title).toBe(USER_REQUEST);
		expect(title).not.toContain("发布流程");
		expect(title).not.toContain("release");
	});

	test("falls back to skill name for a bare skill invocation", () => {
		expect(buildProvisionalTitle(SKILL_INTRO)).toBe("release");
	});

	test("still truncates long user requests to 50 chars", () => {
		const longRequest =
			"请把登录模块的超时时间从三十秒改成五秒，并补充对应的单元测试和集成测试覆盖，另外把审计日志里的脱敏规则也一并核对补齐";
		const title = buildProvisionalTitle(`${SKILL_INTRO}\n\n${longRequest}`);
		expect(title).not.toBeNull();
		expect(Array.from(title ?? "").length).toBeLessThanOrEqual(50);
		expect(title?.endsWith("…")).toBe(true);
		expect(title).not.toContain("Skill");
	});
});

describe("buildQuickTitleSource (quick path)", () => {
	test("prefers the user request over skill documentation", () => {
		const raw = `${SKILL_INTRO}\n\n${USER_REQUEST}`;
		const source = buildQuickTitleSource(raw);
		expect(source).toBe(USER_REQUEST);
		expect(source).not.toContain("完整的版本发布流程");
		expect(source).not.toContain("# Skill:");
	});

	test("falls back to skill name when there is no user request", () => {
		expect(buildQuickTitleSource(SKILL_INTRO)).toBe("release");
	});

	test("truncates oversized user requests", () => {
		const longRequest = "x".repeat(600);
		const source = buildQuickTitleSource(`${SKILL_INTRO}\n\n${longRequest}`);
		expect(source.length).toBeLessThanOrEqual(503);
		expect(source.startsWith("x")).toBe(true);
		expect(source.endsWith("...")).toBe(true);
	});
});

describe("buildTitleConversationText (full path)", () => {
	test("early user turn is the request, not the skill body", () => {
		const text = buildTitleConversationText(
			[
				{ role: "user", contentText: `${SKILL_INTRO}\n\n${USER_REQUEST}` },
				{ role: "assistant", contentText: "已生成 changelogs/v0.3.1.json" },
			],
			1,
		);
		expect(text).toContain("(early) [User]: 帮我给当前版本生成中英文更新日志，不要发布");
		expect(text).not.toContain("完整的版本发布流程");
		expect(text).not.toContain("# Skill: release");
		expect(text).toContain("(recent) [Assistant]: 已生成 changelogs/v0.3.1.json");
	});

	test("recent user turn is also stripped of skill expansion", () => {
		const text = buildTitleConversationText(
			[
				{ role: "user", contentText: "开始吧" },
				{ role: "user", contentText: `${SKILL_INTRO}\n\n${USER_REQUEST}` },
			],
			1,
		);
		expect(text).toContain("(recent) [User]: 帮我给当前版本生成中英文更新日志，不要发布");
		expect(text).not.toContain("skill_content");
		expect(text).not.toContain("When to use");
	});
});
