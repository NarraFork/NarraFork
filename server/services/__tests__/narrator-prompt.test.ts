import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getDynamicSpecSystemReminder,
	getSubagentParentReportingHint,
} from "../../lib/prompt-i18n";
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
		expect(en).toContain("Every open task must be finite, executable");
		expect(en).toContain("may start another turn automatically");
		expect(en).toContain("Never store standing behavior rules");
		expect(en).not.toContain("Do not bypass this requirement");
		expect(en).toContain("add a concrete actionable unblock task");
		expect(en).toContain("do not end the turn by merely explaining the blocker");
		expect(zh).toContain("直接用 `Read`、`Write`、`Edit`、`Grep`");
		expect(zh).toContain("允许的状态只有：`todo`、`doing`、`done`、`blocked`");
		expect(zh).toContain("每条开放任务都必须是有限、可执行");
		expect(zh).toContain("可能在回合结束后自动开始下一轮");
		expect(zh).toContain("绝不能把长期行为规则");
		expect(zh).not.toContain("不能绕过的要求");
		expect(zh).toContain("新增一个具体、可执行的解阻任务");
		expect(zh).toContain("不能只解释阻塞");
	});
});

describe("plan mode designated plan file state", () => {
	function makeWorkdir(): string {
		return mkdtempSync(join(tmpdir(), "narrafork-plan-state-"));
	}

	test("keeps the plain write-first flow when the plan file does not exist yet", async () => {
		const cwd = makeWorkdir();
		try {
			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "en",
				planMode: true,
				planFileId: "fresh-plan--0000000000000000",
			});

			expect(prompt).toContain(".narrafork/plan-fresh-plan--0000000000000000.md");
			expect(prompt).not.toContain("Designated Plan File — Current State");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("warns that the plan file already has content so a compact cannot cause a Write truncation", async () => {
		const cwd = makeWorkdir();
		const planFileId = "resumed-plan--0000000000000000";
		try {
			mkdirSync(join(cwd, ".narrafork"), { recursive: true });
			writeFileSync(join(cwd, ".narrafork", `plan-${planFileId}.md`), "# Plan\n\nStep one.\n");

			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "en",
				planMode: true,
				planFileId,
			});

			expect(prompt).toContain("Designated Plan File — Current State");
			expect(prompt).toContain("bytes of plan content you wrote earlier");
			expect(prompt).toContain("Write on this path REPLACES the entire file");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("localizes the plan file state section", async () => {
		const cwd = makeWorkdir();
		const planFileId = "zh-plan--0000000000000000";
		try {
			mkdirSync(join(cwd, ".narrafork"), { recursive: true });
			writeFileSync(join(cwd, ".narrafork", `plan-${planFileId}.md`), "# 计划\n");

			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "zh-CN",
				planMode: true,
				planFileId,
			});

			expect(prompt).toContain("指定计划文件 — 当前状态");
			expect(prompt).toContain("对该路径使用 Write 会整体替换文件");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("ignores a plan identity that could escape the worktree", async () => {
		const cwd = makeWorkdir();
		try {
			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "en",
				planMode: true,
				planFileId: "../../escaped",
			});

			expect(prompt).not.toContain("Designated Plan File — Current State");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("subagent communication guidance", () => {
	test("requires asynchronous Send and delegates agent dependencies to the parent", () => {
		const en = getSubagentParentReportingHint("en", false);
		const zh = getSubagentParentReportingHint("zh-CN", false);

		expect(en).toContain("Every Send issued by a subagent is asynchronous");
		expect(en).toContain("never set await:true");
		expect(en).toContain('Await({ type: "agent", id: "..." })');
		expect(en).toContain("foreground subagent");
		expect(zh).toContain("你发出的所有 Send 都是异步的");
		expect(zh).toContain('不要使用 Await({ type: "agent", id: "..." })');
		expect(zh).toContain("当前是前台子代理");
	});

	test("background guidance permits asynchronous parent progress reports", () => {
		const en = getSubagentParentReportingHint("en", true);
		const zh = getSubagentParentReportingHint("zh-CN", true);

		expect(en).toContain('Send({ id: "parent"');
		expect(zh).toContain('Send({ id: "parent"');
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

	test("forbids local routing in OAuth-restricted device guidance", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: null,
			cwd: `/tmp/narrafork-prompt-oauth-${Date.now()}`,
			locale: "en",
			devices: [
				{ id: "device-1", name: "Device One", online: true },
				{ id: "device-2", name: "Device Two", online: true },
			],
			defaultDeviceId: "device-1",
			allowLocalExecution: false,
		});

		expect(prompt).toContain('device: "device-1"');
		expect(prompt).toContain("local server is forbidden by runtime policy");
		expect(prompt).not.toContain('or `"local"` for the server');
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
