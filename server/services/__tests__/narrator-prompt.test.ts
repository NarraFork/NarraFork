import { describe, expect, test } from "bun:test";
import { getDynamicSpecSystemReminder } from "../../lib/prompt-i18n";
import { buildEffectiveSystemPrompt } from "../narrator-prompt";

describe("narrator prompt Dynamic Spec guidance", () => {
	test("injects Dynamic Spec usage into the effective system prompt", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: "Base prompt",
			cwd: `/tmp/narrafork-prompt-test-${Date.now()}`,
			locale: "en",
			replyInUserLanguage: false,
		});

		expect(prompt).toContain("# Dynamic Spec (`spec://`)");
		expect(prompt).toContain("spec://tasks.json");
		expect(prompt).not.toContain("spec://HOW_TO_USE_SPEC.md");
		expect(prompt).toContain('path: "spec://"');
		expect(prompt).toContain("Do not use Bash or Glob for `spec://` virtual files.");
	});

	test("has localized reminders for core Dynamic Spec rules", () => {
		const en = getDynamicSpecSystemReminder("en");
		const zh = getDynamicSpecSystemReminder("zh-CN");

		expect(en).toContain("`Read`, `Write`, `Edit`, and `Grep`");
		expect(en).toContain("Allowed statuses: `todo`, `doing`, `done`, `blocked`");
		expect(zh).toContain("直接用 `Read`、`Write`、`Edit`、`Grep`");
		expect(zh).toContain("允许的状态只有：`todo`、`doing`、`done`、`blocked`");
	});
});
