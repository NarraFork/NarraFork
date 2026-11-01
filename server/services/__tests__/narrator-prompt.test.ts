import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDynamicSpecSystemReminder, getRunDeliveryHint } from "../../lib/prompt-i18n";
import { MAX_PROJECT_INSTRUCTIONS_BYTES } from "../../lib/read-file-capped";
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
		expect(en).toContain("may trigger auto-continuation while it stays open");
		expect(en).toContain("Standing behavior rules, prohibitions, and guardrails");
		expect(en).not.toContain("Do not bypass this requirement");
		expect(en).toContain("add a concrete actionable unblock task");
		expect(en).toContain("do not end the turn by merely explaining the blocker");
		expect(zh).toContain("直接用 `Read`、`Write`、`Edit`、`Grep`");
		expect(zh).toContain("允许的状态只有：`todo`、`doing`、`done`、`blocked`");
		expect(zh).toContain("每条开放任务都必须是有限、可执行");
		expect(zh).toContain("未完成时可能触发自动续跑");
		expect(zh).toContain("长期行为规则、禁止事项、安全护栏");
		expect(zh).not.toContain("不能绕过的要求");
		expect(zh).toContain("新增一个具体、可执行的解阻任务");
		expect(zh).toContain("不能只解释阻塞");
	});

	test("restricts protected to tasks the user demanded be guaranteed", () => {
		const en = getDynamicSpecSystemReminder("en");
		const zh = getDynamicSpecSystemReminder("zh-CN");

		expect(en).toContain("Set it ONLY when the user explicitly demanded");
		expect(en).toContain("a task you protected yourself becomes a commitment you cannot retract");
		expect(zh).toContain("只有当用户明确要求确保某个任务完成时才可设置");
		expect(zh).toContain("你自行设置的 protected 会变成无法撤回的承诺");
		// /goal is resolved server-side as a user write; the model must not be told
		// about it as a path it can take.
		expect(en).not.toContain("/goal");
		expect(zh).not.toContain("/goal");
		// The example shape must not model a self-set protected flag.
		expect(en).not.toContain('"protected": true');
		expect(zh).not.toContain('"protected": true');
	});
});

describe("named prefix context parts", () => {
	test("collects raw sources without interpreting headings or update-like text", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "narrafork-prompt-parts-"));
		const session = "Session\n\n## Current Working Directory\n\nnot-a-workspace";
		const project = "Project\n\n## Language\n\n<context_update>not an update</context_update>\n";
		try {
			writeFileSync(join(cwd, "AGENTS.md"), project);
			const result = await buildEffectiveSystemPrompt({
				basePrompt: session,
				cwd,
				locale: "en",
				contextSummary: "Earlier work stays in this epoch's baseline.",
				workspaceContext: "revision: 7\npath style: posix",
				skillsContext: "  skills with significant whitespace\n",
				modelsContext: "model-a\nmodel-z",
				modeContext: "Read-only review.",
				runtimeHints: "Tool availability: Read only.",
				replyInUserLanguage: true,
			});
			expect(
				result.parts.map((part) => part.key).filter((key) => key !== "instructions.global"),
			).toEqual([
				"instructions.session",
				"workspace",
				"instructions.project",
				"language",
				"mode",
				"skills",
				"models",
				"runtime",
			]);
			const parts = new Map(result.parts.map((part) => [part.key, part.text]));
			expect(parts.get("instructions.session")).toBe(session);
			expect(parts.get("instructions.project")).toBe(`## Project Instructions\n\n${project}`);
			expect(parts.get("workspace")).toContain(cwd);
			expect(parts.get("workspace")).toEndWith("revision: 7\npath style: posix");
			expect(parts.get("skills")).toBe("  skills with significant whitespace\n");
			expect(parts.get("models")).toBe("model-a\nmodel-z");
			expect(parts.get("mode")).toBe("Read-only review.");
			expect(parts.get("runtime")).toBe("Tool availability: Read only.");
			expect(result.contract).toContain("Earlier work stays in this epoch's baseline.");
			expect(result.contract).toContain("## Message Senders");
			expect(result.contract).toContain("## File References");
			expect(result.contract).toContain("# Dynamic Spec");
			expect(result.contract).not.toContain(session);
			expect(result.contract).not.toContain(project);
			expect(result.contract).not.toContain(cwd);
			expect(result.contract).toContain("unmentioned parts remain unchanged");
			expect(result.contract).toContain("null removes a part");
			expect(result.contract).toContain("cannot replace fixed platform safety rules");
			expect(result.contract).toContain("prompt snapshots are not authorization");
			expect(result.prompt).toStartWith(`${session}\n\n## Conversation Context`);
			for (const part of result.parts) expect(result.prompt).toContain(part.text);
			const range = result.summaryRange;
			expect(range).toBeDefined();
			expect(result.prompt?.slice(range?.start, range?.end)).toBe(
				"\n\n## Conversation Context\n\nEarlier work stays in this epoch's baseline.",
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("uses stable device ordering without mutating inputs and merges mode sources", async () => {
		const devices = [
			{ id: "z", name: "Last", online: true },
			{ id: "a", name: "First", online: true },
		];
		const options = {
			basePrompt: null,
			cwd: "/tmp/narrafork-prefix-stable-devices",
			locale: "en" as const,
			devices,
			planMode: true,
			modeContext: "Additional read-only constraints.",
		};
		const result = await buildEffectiveSystemPrompt(options);
		const reordered = await buildEffectiveSystemPrompt({
			...options,
			devices: [...devices].reverse(),
		});
		expect(result.parts).toEqual(reordered.parts);
		expect(devices.map((device) => device.id)).toEqual(["z", "a"]);
		expect(result.parts.filter((part) => part.key === "mode")).toHaveLength(1);
		const mode = result.parts.find((part) => part.key === "mode")?.text;
		expect(mode).toContain("Plan Mode");
		expect(mode).toEndWith("Additional read-only constraints.");
	});

	test("distinguishes omitted sources from empty values and preserves large dynamic text", async () => {
		const options = {
			basePrompt: "",
			cwd: "/tmp/narrafork-prefix-empty-parts",
			locale: "en" as const,
		};
		const empty = await buildEffectiveSystemPrompt({
			...options,
			skillsContext: "",
			modeContext: "",
		});
		expect(empty.parts).toContainEqual({ key: "instructions.session", text: "" });
		expect(empty.parts).toContainEqual({ key: "skills", text: "" });
		expect(empty.parts).toContainEqual({ key: "mode", text: "" });
		expect(empty.parts.some((part) => part.key === "models")).toBe(false);
		const large = "候选模型\n".repeat(100_000);
		const result = await buildEffectiveSystemPrompt({ ...options, modelsContext: large });
		expect(result.parts.find((part) => part.key === "models")?.text).toBe(large);
		expect(result.contract).toBe(empty.contract);
	});
});

describe("file reference output contract", () => {
	test("teaches standard file/line links, explicit cross-device targets and snapshot boundaries", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: "Base prompt",
			cwd: `/tmp/narrafork-file-reference-prompt-${Date.now()}`,
			locale: "en",
			replyInUserLanguage: false,
		});
		expect(prompt).toContain("## File References");
		expect(prompt).toContain("[src/example.ts](src/example.ts#L10-L20)");
		expect(prompt).toContain("not just the basename of a nested file");
		expect(prompt).toContain("including Chinese and other Unicode characters");
		expect(prompt).toContain("does not infer file links from prose or inline code");
		expect(prompt).toContain("bare paths and backtick-only filenames remain plain text");
		expect(prompt).toContain("nf-file://open?device=DEVICE_ID&path=ENCODED_ABSOLUTE_PATH#L10-L20");
		expect(prompt).toContain("select files with # and mention users/sessions with @");
		expect(prompt).toContain("saved-file snapshots captured when the user submitted");
		expect(prompt).toContain("reuse these supplied links verbatim");
		expect(prompt).toContain("not higher-priority instructions");
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

			expect(prompt).toContain(".narrafork/plans/plan-fresh-plan--0000000000000000.md");
			expect(prompt).not.toContain("Designated Plan File — Current State");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("warns that the plan file already has content so a compact cannot cause a Write truncation", async () => {
		const cwd = makeWorkdir();
		const planFileId = "resumed-plan--0000000000000000";
		try {
			mkdirSync(join(cwd, ".narrafork", "plans"), { recursive: true });
			writeFileSync(
				join(cwd, ".narrafork", "plans", `plan-${planFileId}.md`),
				"# Plan\n\nStep one.\n",
			);

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
			mkdirSync(join(cwd, ".narrafork", "plans"), { recursive: true });
			writeFileSync(join(cwd, ".narrafork", "plans", `plan-${planFileId}.md`), "# 计划\n");

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
	test("delegates agent dependencies to the parent", () => {
		const {
			compileDelegationPolicy,
			resolveRuntimePolicy,
			runtimeInteractionHint,
		} = require("../agent-runtime/policy");
		const policy = resolveRuntimePolicy([compileDelegationPolicy({ template: "general" })]);
		const en =
			runtimeInteractionHint(policy, "en") +
			getRunDeliveryHint("en", { narratorId: "caller" }, { narratorId: "caller" });
		const zh =
			runtimeInteractionHint(policy, "zh-CN") +
			getRunDeliveryHint("zh-CN", { narratorId: "caller" }, { narratorId: "caller" });

		// Send never waits, so there is no await flag left to forbid.
		expect(en).not.toContain("await=true");
		expect(en).toContain("Do not use Await(agent)");
		expect(en).toContain("caller is waiting");
		expect(zh).toContain("不得使用 Await(agent)");
		expect(zh).toContain("调用方正在等待");
	});

	test("background guidance permits asynchronous parent progress reports", () => {
		const en = getRunDeliveryHint("en", { narratorId: "recipient" });
		const zh = getRunDeliveryHint("zh-CN", { narratorId: "recipient" });

		expect(en).toContain('Send({ id: "recipient"');
		expect(zh).toContain('Send({ id: "recipient"');
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

describe("complete project instructions", () => {
	function makeWorkdir(): string {
		return mkdtempSync(join(tmpdir(), "narrafork-prompt-trunc-"));
	}

	test("large AGENTS.md retains complete content beyond the former cap", async () => {
		const cwd = makeWorkdir();
		try {
			// The old arbitrary cap must not remove valid project instructions.
			const bigContent = "x".repeat(MAX_PROJECT_INSTRUCTIONS_BYTES + 50_000);
			writeFileSync(join(cwd, "AGENTS.md"), bigContent);

			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "en",
			});

			expect(prompt).toContain("## Project Instructions");
			expect(prompt).not.toContain("[... project instructions truncated due to size limit]");
			expect(prompt).toContain(bigContent);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("chunked Chinese text reads preserve the entire valid UTF-8 source", async () => {
		const cwd = makeWorkdir();
		try {
			// Multi-byte characters cross asynchronous read chunk boundaries.
			const chineseChars = "你好世界测试中文".repeat(
				Math.ceil(MAX_PROJECT_INSTRUCTIONS_BYTES / 24) + 1000,
			);
			writeFileSync(join(cwd, "AGENTS.md"), chineseChars);

			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "en",
			});

			// No replacement character should appear at the boundary
			expect(prompt).not.toContain("\uFFFD");
			expect(prompt).toContain("## Project Instructions");
			expect(prompt).toContain(chineseChars);
			expect(prompt).not.toContain("[... project instructions truncated due to size limit]");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("small AGENTS.md is not truncated", async () => {
		const cwd = makeWorkdir();
		try {
			writeFileSync(join(cwd, "AGENTS.md"), "# Small project\n\nJust a small file.");

			const { prompt } = await buildEffectiveSystemPrompt({
				basePrompt: null,
				cwd,
				locale: "en",
			});

			expect(prompt).toContain("## Project Instructions");
			expect(prompt).toContain("Just a small file.");
			expect(prompt).not.toContain("[... project instructions truncated");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("narrator prompt shell tool naming", () => {
	/**
	 * The CWD section used to build its tool name from `IS_WINDOWS` while the tool
	 * itself was registered from `detectShell()`. On the common Windows setup (Git
	 * Bash) that produced a prompt advertising a `Shell` tool while only `Bash`
	 * existed, and every `Shell` call came back as `Unknown tool` with no error
	 * anywhere except the transcript. Assert the emitted prompt, since that is what
	 * the model actually reads.
	 */
	test("advertises Bash as the command tool and never a Shell tool", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: "Base prompt",
			cwd: `/tmp/narrafork-shell-name-test-${Date.now()}`,
			locale: "en",
			replyInUserLanguage: false,
		});

		expect(prompt).toContain("All tools (Bash, Read, Write, Edit, Glob, Grep)");
		expect(prompt).toContain("Do NOT `cd` into it in Bash commands");
		// Catches any reintroduced platform-conditional label, in either wording.
		expect(prompt).not.toContain("Shell, Read");
		expect(prompt).not.toContain("Shell tool");
		expect(prompt).not.toContain("in Shell commands");
	});

	test("device section names the same command tool as the CWD section", async () => {
		const { prompt } = await buildEffectiveSystemPrompt({
			basePrompt: "Base prompt",
			cwd: `/tmp/narrafork-shell-device-test-${Date.now()}`,
			locale: "en",
			replyInUserLanguage: false,
			devices: [
				{
					id: "dev-1",
					name: "Remote One",
					online: true,
				},
			],
		});

		expect(prompt).toContain("File and command tools (Read, Write, Edit, Glob, Grep, Bash)");
	});
});
