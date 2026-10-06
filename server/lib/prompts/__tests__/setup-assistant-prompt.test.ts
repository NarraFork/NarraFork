/**
 * Setup Assistant prompt + authorization mapping.
 *
 * Deliberately imports ONLY the prompt leaf module: no DB, no narrator-service.
 * The sibling suite in server/services/__tests__ covers persistence and route
 * behaviour, but it pulls in the whole narrator service graph, so these pure
 * assertions live here where they can run on their own.
 *
 * What matters here is that the copy does not oversell danger reflection. Under
 * bypassPermissions, reflection only diverts calls the risk classifier flags
 * (narrator-permission.ts:3783 + shouldTriggerDangerReflection), and the
 * reflection turn is the same model answering DangerConfirm/DangerCancel — not
 * human review and not a sandbox. The prompt must say so, or an agent granted
 * full authority will treat it as a safety net.
 */
import { describe, expect, test } from "bun:test";
import {
	buildSetupAssistantSystemPrompt,
	formatDependencyBriefing,
	getSetupAssistantStartMessage,
	getSetupAssistantTitle,
	resolveSetupAuthorization,
	SETUP_AUTHORIZATION_VALUES,
	type SetupBriefingDependency,
	selectActionableDependencies,
} from "../setup-assistant";

function dep(overrides: Partial<SetupBriefingDependency> = {}): SetupBriefingDependency {
	return {
		name: "git",
		required: true,
		installed: false,
		platformSupported: true,
		installCommands: { apt: "sudo apt-get install -y git" },
		...overrides,
	};
}

describe("authorization values", () => {
	test("only the two grantable levels exist; declining is not a level", () => {
		// Declining is "create no narrator at all", so a third enum value would be a
		// state the server has to interpret and could get wrong.
		expect([...SETUP_AUTHORIZATION_VALUES]).toEqual(["full", "default"]);
	});
});

describe("resolveSetupAuthorization", () => {
	test("full authority pins strict reflection instead of inheriting it", () => {
		// With an instance default of "off", bypassPermissions would run every
		// classifier-flagged command with no review turn at all.
		expect(resolveSetupAuthorization("full")).toEqual({
			permissionMode: "bypassPermissions",
			dangerReflectionOverride: "strict",
		});
	});

	test("standard authority keeps the default mode and inherits reflection", () => {
		// Approval cards already put a human in the loop, so the instance default stands.
		expect(resolveSetupAuthorization("default")).toEqual({
			permissionMode: "default",
			dangerReflectionOverride: "inherit",
		});
	});
});

describe("system prompt", () => {
	test("is bilingual, scoped, and falls back to en for an unknown locale", () => {
		const en = buildSetupAssistantSystemPrompt("en");
		const zh = buildSetupAssistantSystemPrompt("zh-CN");
		expect(en).toContain("Setup Assistant");
		expect(en).toContain("Scope (do not exceed it)");
		expect(zh).toContain("装机助手");
		expect(zh).toContain("职责范围（不得越界）");
		expect(buildSetupAssistantSystemPrompt("xx" as never)).toContain("Setup Assistant");
	});

	test("routes sudo through the Terminal tool and never through a typed password", () => {
		// Bash has no tty, so a sudo prompt there hangs until timeout. The prompt must
		// name the Terminal tool AND where the user types the password.
		const en = buildSetupAssistantSystemPrompt("en");
		expect(en).toContain("Terminal");
		expect(en).toContain("status bar");
		expect(en).toContain("Never type a password yourself");
		const zh = buildSetupAssistantSystemPrompt("zh-CN");
		expect(zh).toContain("Terminal");
		expect(zh).toContain("状态栏");
		expect(zh).toContain("绝不自己输入密码");
	});

	test("full authority is told not to treat reflection as a safety net", () => {
		// The honest framing: unflagged calls execute immediately, as written.
		const full = buildSetupAssistantSystemPrompt("en", undefined, "full");
		expect(full).toContain("Authorization: full");
		expect(full).toContain("do not wait for one");
		expect(full).toContain("do not rely on that");
		expect(full).toContain("executes immediately");
		const zhFull = buildSetupAssistantSystemPrompt("zh-CN", undefined, "full");
		expect(zhFull).toContain("授权级别：全权");
		expect(zhFull).toContain("不要依赖它");
	});

	test("standard authority is told not to route around an approval", () => {
		const standard = buildSetupAssistantSystemPrompt("en", undefined, "default");
		expect(standard).toContain("Authorization: standard");
		expect(standard).toContain("never try to route around");
		const zhStandard = buildSetupAssistantSystemPrompt("zh-CN", undefined, "default");
		expect(zhStandard).toContain("授权级别：标准");
	});

	test("omitting the level yields standard, never full authority", () => {
		// A missing argument must fail toward less authority, not more.
		expect(buildSetupAssistantSystemPrompt("en")).toContain("Authorization: standard");
		expect(buildSetupAssistantSystemPrompt("en", "- Platform: linux")).toContain(
			"Authorization: standard",
		);
	});

	test("appends the briefing under a heading, and nothing when it is blank", () => {
		const withBriefing = buildSetupAssistantSystemPrompt("en", "- Platform: linux");
		expect(withBriefing).toContain("Environment briefing");
		expect(withBriefing).toContain("- Platform: linux");
		expect(buildSetupAssistantSystemPrompt("en", "   ")).not.toContain("Environment briefing");
	});
});

describe("selectActionableDependencies", () => {
	test("keeps only missing dependencies this platform supports", () => {
		const actionable = selectActionableDependencies([
			dep({ name: "git", installed: false, platformSupported: true }),
			dep({ name: "rg", installed: true, platformSupported: true }),
			dep({ name: "dtach", installed: false, platformSupported: false }),
		]);
		expect(actionable.map((d) => d.name)).toEqual(["git"]);
	});
});

describe("formatDependencyBriefing", () => {
	test("lists missing deps with commands and marks installed ones off-limits", () => {
		const briefing = formatDependencyBriefing({
			platform: "linux",
			packageManager: "apt",
			runtimeEnvironment: { android: false, proot: true, termux: false },
			dependencies: [
				dep({ name: "git", required: true, installed: false }),
				dep({ name: "rg", required: false, installed: true, version: "14.1.0" }),
				dep({ name: "dtach", required: false, installed: false, platformSupported: false }),
			],
		});

		expect(briefing).toContain("Platform: linux");
		expect(briefing).toContain("Detected package manager: apt");
		// Only truthy runtime flags are surfaced.
		expect(briefing).toContain("Runtime flags: proot");
		expect(briefing).not.toContain("android");
		expect(briefing).toContain("git (required)");
		expect(briefing).toContain("sudo apt-get install -y git");
		expect(briefing).toContain("Already installed (do not reinstall): rg 14.1.0");
		expect(briefing).toContain("Not supported on this platform (out of scope): dtach");
	});

	test("says so plainly when there is no package manager and nothing to install", () => {
		const briefing = formatDependencyBriefing({
			platform: "linux",
			dependencies: [dep({ name: "git", installed: true })],
		});
		expect(briefing).toContain("Detected package manager: none detected");
		expect(briefing).toContain("Missing dependencies: none");
	});

	test("admits when the detected package manager has no suggested command", () => {
		const briefing = formatDependencyBriefing({
			platform: "linux",
			packageManager: "pacman",
			dependencies: [dep({ name: "git", installCommands: { apt: "apt install git" } })],
		});
		expect(briefing).toContain("no suggested command for the detected package manager");
	});
});

describe("start message and title", () => {
	test("start message names the missing dependencies when known", () => {
		expect(getSetupAssistantStartMessage("en", ["git", "rg"])).toContain("git, rg");
		expect(getSetupAssistantStartMessage("zh-CN", ["git"])).toContain("git");
		expect(getSetupAssistantStartMessage("en")).toContain("environment briefing");
	});

	test("title names the missing dependencies and falls back when none are known", () => {
		expect(getSetupAssistantTitle("en", ["git"])).toBe("Install dependencies: git");
		expect(getSetupAssistantTitle("zh-CN", ["git", "rg"])).toBe("安装依赖：git, rg");
		expect(getSetupAssistantTitle("en")).toContain("system");
	});
});
