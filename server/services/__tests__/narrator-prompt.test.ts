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

describe("narrator prompt execution device guidance", () => {
	test("keeps the local-only prompt free of remote routing guidance", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: null,
			cwd: `/tmp/narrafork-prompt-local-${Date.now()}`,
			locale: "en",
			devices: [],
			defaultDeviceId: null,
		});

		expect(prompt).not.toContain("## Execution Devices");
	});

	test("describes an online session default remote device", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: null,
			cwd: `/tmp/narrafork-prompt-remote-${Date.now()}`,
			locale: "en",
			devices: [{ id: "device-1", name: "Device One", online: true }],
			defaultDeviceId: "device-1",
		});

		expect(prompt).toContain("Current default execution target: **Device One (remote)**");
		expect(prompt).not.toContain("unknown or offline");
	});

	test("warns when the session default remote device is offline", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: null,
			cwd: `/tmp/narrafork-prompt-offline-${Date.now()}`,
			locale: "en",
			devices: [{ id: "device-1", name: "Device One", online: false }],
			defaultDeviceId: "device-1",
		});

		expect(prompt).toContain(
			"Current default execution target: **Device One (remote, unavailable)**",
		);
		expect(prompt).toContain("unknown or offline");
		expect(prompt).toContain("will NOT fall back to local execution");
		expect(prompt).toContain('SwitchDevice with `device: "local"`');
		expect(prompt).not.toContain("Current default execution target: **local");
	});

	test("warns for an unknown stale default even when no device record remains", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: null,
			cwd: `/tmp/narrafork-prompt-stale-${Date.now()}`,
			locale: "en",
			devices: [],
			defaultDeviceId: "deleted-device",
		});

		expect(prompt).toContain("deleted-device (remote, unavailable)");
		expect(prompt).toContain("Available remote devices: none currently online.");
	});
});
