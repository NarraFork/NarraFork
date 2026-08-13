import {
	DEFAULT_LOCALE,
	type Locale,
	type LocalizedValue,
	pickLocalizedValue,
} from "@shared/i18n-locales";

// ─── Setup Assistant narrator ───
//
// A specialized standalone narrator whose only job is installing the system
// dependencies NarraFork needs (git / ripgrep / dtach) on THIS machine. It
// exists because a hard-coded install-command matrix cannot cover every distro,
// package manager and permission model, while an agent with Bash can probe the
// environment and adapt.
//
// Deliberate constraints baked into the prompt:
//   - Scope is limited to the declared dependencies. No unrelated software, no
//     system reconfiguration, no touching the running NarraFork process.
//   - The briefing is a hint, not ground truth: the agent must verify.
//   - Non-interactive installer flags only, and never block on a sudo password
//     prompt — hand that back to the user instead.

const setupAssistantPrompts: LocalizedValue<string> = {
	en: `You are the Setup Assistant — a specialized assistant whose ONLY job is to install the missing system dependencies that NarraFork needs on this machine. You are not here to write application code or work on the user's project.

## Scope (do not exceed it)
- You may install ONLY these dependencies: git (required), ripgrep/rg (optional, powers fast search), dtach (optional, powers detachable terminals).
- Do NOT install unrelated software, do NOT change system configuration beyond what the package installation itself does, and do NOT modify, stop or restart the running NarraFork process.
- When every dependency in scope is installed and verified, report the result and stop. Do not look for more work.

## Method
1. Probe the environment first. The briefing below is a hint from NarraFork's own detection, not ground truth — verify it yourself (e.g. \`uname -a\`, \`cat /etc/os-release\`, \`command -v git\`, \`id -u\`, and check for Termux/proot signals like \`$PREFIX\` / \`$TERMUX_VERSION\`).
2. Pick the install path that actually fits this machine: the native package manager (apt/dnf/pacman/zypper/apk/pkg/brew/winget/scoop/choco), or a static binary download when no package manager is usable.
3. Install one dependency at a time so a failure is easy to attribute.
4. Verify each install by running the tool itself (\`git --version\`, \`rg --version\`, \`dtach -h\`). An install is not done until the binary answers.
5. Report clearly at the end: what got installed, what did not, and exactly what the user must do by hand for anything you could not finish.

## Privileged commands (sudo) — use the Terminal tool
The Bash tool has no interactive terminal, so a \`sudo\` password prompt there simply hangs until it times out. When a command needs \`sudo\`:
1. Run it through the **Terminal** tool instead of Bash (\`action: "create"\` once, then \`action: "write"\` to send the command).
2. Tell the user in plain words to open the terminal panel and type their password: it is the terminal button in the narrator's status bar (on mobile, the terminal entry in the overflow menu opens a full-screen terminal drawer). Say explicitly that you cannot see or type the password yourself.
3. Then poll with \`action: "read"\` until the command finishes, and continue from its output. If the password prompt is still waiting after a couple of reads, do not spam it — ask the user once more and wait.
4. Never type a password yourself, never ask the user to paste a password into the chat, and never write a password into a command line or a file.

## Rules
- Always use non-interactive installer flags (\`-y\`, \`--noconfirm\`, \`--accept-package-agreements\`). An installer that waits for keyboard input will hang and time out.
- If you lack the privileges to install system-wide and cannot obtain them, say so and offer a user-local alternative (e.g. a static binary in \`~/.local/bin\`) instead of retrying the same failing command.
- On Windows, a freshly installed tool often is not on the current process PATH. Verify what you can, then tell the user NarraFork may need a restart (or a PATH recheck) to see it.
- If the same approach fails twice, stop tweaking it — diagnose why, then switch approach.
- Git is the only required dependency. If an optional one cannot be installed on this platform, that is an acceptable outcome; say so and move on.`,
	"zh-CN": `你是装机助手（Setup Assistant）—— 一个专职助手，唯一职责是在这台机器上装好 NarraFork 所需但缺失的系统依赖。你不负责编写应用代码，也不参与用户的项目工作。

## 职责范围（不得越界）
- 你只能安装这些依赖：git（必需）、ripgrep/rg（可选，用于高速搜索）、dtach（可选，用于可分离终端）。
- 不要安装无关软件，不要在软件包安装本身之外改动系统配置，不要修改、停止或重启正在运行的 NarraFork 进程。
- 范围内的依赖全部装好并验证通过后，汇报结果并结束。不要自行寻找更多工作。

## 方法
1. 先自己探测环境。下面的环境简报只是 NarraFork 自身检测给出的提示，不是事实来源 —— 你必须自行核实（例如 \`uname -a\`、\`cat /etc/os-release\`、\`command -v git\`、\`id -u\`，以及 \`$PREFIX\` / \`$TERMUX_VERSION\` 这类 Termux/proot 信号）。
2. 选择真正适合这台机器的安装路径：原生包管理器（apt/dnf/pacman/zypper/apk/pkg/brew/winget/scoop/choco），或在没有可用包管理器时下载静态二进制。
3. 一次只装一个依赖，这样失败时容易定位。
4. 每装完一项都要运行该工具本身来验证（\`git --version\`、\`rg --version\`、\`dtach -h\`）。二进制没有响应就不算装完。
5. 最后清晰汇报：哪些装好了、哪些没装上、你没能完成的部分用户需要手动做什么。

## 特权命令（sudo）—— 改用 Terminal 工具
Bash 工具没有交互式终端，在那里遇到 \`sudo\` 密码提示只会一直挂住直到超时。当命令需要 \`sudo\` 时：
1. 改用 **Terminal** 工具执行（先 \`action: "create"\` 建一个，再用 \`action: "write"\` 发送命令），不要用 Bash。
2. 用清楚的话告诉用户打开终端面板输入密码：入口是叙述者状态栏上的终端按钮（移动端在溢出菜单里的终端项，会打开全屏终端抽屉）。明确说明你自己看不到也无法输入密码。
3. 然后用 \`action: "read"\` 轮询直到命令结束，再根据输出继续。如果读了两次密码提示仍在等待，不要反复刷屏 —— 再提醒用户一次并等待。
4. 绝不自己输入密码，绝不要求用户把密码贴到对话里，也绝不把密码写进命令行或文件。

## 规则
- 始终使用非交互安装参数（\`-y\`、\`--noconfirm\`、\`--accept-package-agreements\`）。等待键盘输入的安装器会挂住并超时。
- 如果你没有全局安装的权限且无法取得，直接说明，并给出用户级替代方案（例如把静态二进制放到 \`~/.local/bin\`），而不是反复重试同一条失败命令。
- 在 Windows 上，刚装好的工具常常不在当前进程的 PATH 里。先做能做的验证，然后告知用户 NarraFork 可能需要重启（或重新检测 PATH）才能识别。
- 同一个思路失败两次就不要再微调 —— 先诊断原因，再换方法。
- git 是唯一必需依赖。某个可选依赖在本平台装不上是可以接受的结果，说明情况后继续即可。`,
};

const briefingHeadings: LocalizedValue<string> = {
	en: "## Environment briefing (from NarraFork's own detection — verify it)",
	"zh-CN": "## 环境简报（来自 NarraFork 自身检测 —— 请自行核实）",
};

const startMessages: LocalizedValue<string> = {
	en: "Please install the missing dependencies listed in your environment briefing on this machine, verify each one, and report the result.",
	"zh-CN": "请在这台机器上安装环境简报中列出的缺失依赖，逐项验证，并汇报结果。",
};

const startMessagesWithNames: LocalizedValue<(names: string) => string> = {
	en: (names) =>
		`Please install these missing dependencies on this machine: ${names}. Verify each one after installing and report the result.`,
	"zh-CN": (names) => `请在这台机器上安装这些缺失依赖：${names}。安装后逐项验证，并汇报结果。`,
};

/** First user message that kicks the Setup Assistant into action. */
export function getSetupAssistantStartMessage(
	locale: Locale = DEFAULT_LOCALE,
	missingNames: readonly string[] = [],
): string {
	if (missingNames.length === 0) return pickLocalizedValue(startMessages, locale);
	return pickLocalizedValue(startMessagesWithNames, locale)(missingNames.join(", "));
}

const titles: LocalizedValue<(names: string) => string> = {
	en: (names) => `Install dependencies: ${names}`,
	"zh-CN": (names) => `安装依赖：${names}`,
};

/**
 * Explicit title for a Setup Assistant narrator.
 *
 * Set at creation instead of letting the usual title generator run: the job is
 * known up front, so spending a model call on it is waste — and on a machine
 * that has not finished setup, that call may not even be possible yet.
 */
export function getSetupAssistantTitle(
	locale: Locale = DEFAULT_LOCALE,
	missingNames: readonly string[] = [],
): string {
	const names = missingNames.length > 0 ? missingNames.join(", ") : "system";
	return pickLocalizedValue(titles, locale)(names);
}

/** One dependency as reported by `dependencyService.checkAll()`. */
export interface SetupBriefingDependency {
	name: string;
	required: boolean;
	installed: boolean;
	version?: string;
	platformSupported: boolean;
	installCommands: Record<string, string>;
}

export interface SetupBriefingInput {
	platform: string;
	packageManager?: string;
	/**
	 * Runtime flags (android / proot / termux / …). Typed as a plain object rather
	 * than `Record<string, unknown>` so `dependencyService.checkAll()`'s concrete
	 * interface — which has no index signature — can be passed straight through.
	 */
	runtimeEnvironment?: object;
	dependencies: readonly SetupBriefingDependency[];
}

/**
 * How much authority the user grants a Setup Assistant.
 *
 * "full" — bypassPermissions: no approval card is raised, so setup can run
 *   unattended. Danger reflection is pinned to "strict", which under
 *   bypassPermissions diverts a call into the reflection loop when the risk
 *   classifier flags it at low severity or above (narrator-permission.ts:3783).
 *   Be clear about what that loop is: the same model re-examining its own pending
 *   call in a separate turn and answering with DangerConfirm/DangerCancel. It
 *   catches stale, accidental or task-mismatched commands; it is NOT human review
 *   and NOT a sandbox. Calls the classifier does not flag proceed unreviewed, and
 *   a confirmed fingerprint is cached for a TTL so an identical repeat does not
 *   reflect again.
 * "default" — normal permission mode: sudo and package-manager commands surface a
 *   permission card the user approves one by one.
 *
 * Declining entirely is not a mode here: the caller simply does not create a
 * narrator, which is why there is no "none" value.
 */
export const SETUP_AUTHORIZATION_VALUES = ["full", "default"] as const;
export type SetupAuthorization = (typeof SETUP_AUTHORIZATION_VALUES)[number];

export interface SetupAuthorizationResolution {
	permissionMode: "bypassPermissions" | "default";
	/**
	 * Pinned for "full" rather than left to "inherit": with an instance default of
	 * `off`, bypassPermissions would run every classified-risky command with no
	 * review pass at all. "default" authorization keeps "inherit" because the
	 * approval cards already put a human in the loop.
	 */
	dangerReflectionOverride: "strict" | "inherit";
}

/** Map a user's authorization choice onto concrete narrator settings. */
export function resolveSetupAuthorization(
	authorization: SetupAuthorization,
): SetupAuthorizationResolution {
	if (authorization === "full") {
		return { permissionMode: "bypassPermissions", dangerReflectionOverride: "strict" };
	}
	return { permissionMode: "default", dangerReflectionOverride: "inherit" };
}

/** Dependencies the Setup Assistant should act on: missing and supported here. */
export function selectActionableDependencies(
	dependencies: readonly SetupBriefingDependency[],
): SetupBriefingDependency[] {
	return dependencies.filter((dep) => !dep.installed && dep.platformSupported);
}

/**
 * Render the dependency check into plain text for the agent.
 *
 * Only actionable (missing + platform-supported) dependencies get a full entry
 * with its suggested command; already-installed ones are listed as a one-line
 * "leave these alone" note so the agent does not reinstall them, and
 * platform-unsupported ones are named as out of scope.
 */
export function formatDependencyBriefing(input: SetupBriefingInput): string {
	const lines: string[] = [];
	lines.push(`- Platform: ${input.platform}`);
	lines.push(`- Detected package manager: ${input.packageManager ?? "none detected"}`);

	const runtimeFlags = Object.entries(input.runtimeEnvironment ?? {})
		.filter(([, value]) => value === true)
		.map(([key]) => key);
	if (runtimeFlags.length > 0) {
		lines.push(`- Runtime flags: ${runtimeFlags.join(", ")}`);
	}

	const missing = selectActionableDependencies(input.dependencies);
	const installed = input.dependencies.filter((dep) => dep.installed);
	const unsupported = input.dependencies.filter((dep) => !dep.installed && !dep.platformSupported);

	if (installed.length > 0) {
		lines.push(
			`- Already installed (do not reinstall): ${installed
				.map((dep) => (dep.version ? `${dep.name} ${dep.version}` : dep.name))
				.join(", ")}`,
		);
	}
	if (unsupported.length > 0) {
		lines.push(
			`- Not supported on this platform (out of scope): ${unsupported
				.map((dep) => dep.name)
				.join(", ")}`,
		);
	}

	if (missing.length === 0) {
		lines.push("- Missing dependencies: none");
		return lines.join("\n");
	}

	lines.push("- Missing dependencies:");
	for (const dep of missing) {
		const suggested = input.packageManager ? dep.installCommands[input.packageManager] : undefined;
		lines.push(`  - ${dep.name} (${dep.required ? "required" : "optional"})`);
		if (suggested) {
			lines.push(`    suggested command: ${suggested}`);
		} else {
			lines.push(
				"    no suggested command for the detected package manager — work it out yourself",
			);
		}
	}
	return lines.join("\n");
}

/**
 * Extra instructions per authorization level.
 *
 * Under full authority no approval card is raised, so the agent must not sit
 * waiting for one, and it must not treat the risk classifier as its safety net —
 * commands it does not flag simply execute. Under default authority the opposite
 * risk applies: approval cards are expected, and rewriting a command to slip past
 * one is the failure mode to forbid.
 */
const authorizationNotes: Record<SetupAuthorization, LocalizedValue<string>> = {
	full: {
		en: `## Authorization: full
Your commands run without a per-command approval card, so nobody is clicking "allow" — do not wait for one. Some risky-looking calls will be diverted into a reflection turn where you re-examine them, but do not rely on that: anything the risk classifier does not flag executes immediately, exactly as written. So state briefly, before each state-changing command, what it changes and why it is the minimal way to install the dependency. Stay strictly inside the dependency scope above; broader authority is not broader scope. A sudo password is still something you cannot supply — use the Terminal tool and ask the user, as described above.`,
		"zh-CN": `## 授权级别：全权
你的命令不会再逐条弹出授权卡，没有人会去点"允许"，所以不要等待授权。部分看起来有风险的调用会被转入一次反思回合让你重新检查，但不要依赖它：风险分类器没有标记的调用会立即按原样执行。因此每执行一条会改变系统状态的命令前，先简短说明它改变了什么、以及为什么这是装好依赖的最小做法。严格待在上面的依赖范围内；权限变大不等于范围变大。sudo 密码仍然是你无法自行提供的 —— 按上面的说明改用 Terminal 工具并请用户输入。`,
	},
	default: {
		en: `## Authorization: standard
Commands that change the system will pause for the user's approval. That is expected, not an obstacle: never try to route around a pending or denied approval by rewriting the command to look harmless. Keep each command small and self-explanatory so the user can approve it confidently, and say what you are about to run before you run it. If the user denies something, accept it and offer an alternative or hand that step back to them.`,
		"zh-CN": `## 授权级别：标准
会改变系统的命令会暂停并等待用户授权。这是预期行为，不是障碍：绝不要通过把命令改写得看起来无害来绕过待批或被拒的授权。让每条命令都尽量小、含义自明，便于用户放心批准，并在执行前说明你要跑什么。如果用户拒绝了某一步，就接受它，给出替代方案或把这一步交还给用户。`,
	},
};

/**
 * Build the full system prompt for a Setup Assistant narrator: base
 * instructions, the authorization-specific note, then the dependency briefing.
 */
export function buildSetupAssistantSystemPrompt(
	locale: Locale = DEFAULT_LOCALE,
	briefing?: string,
	authorization: SetupAuthorization = "default",
): string {
	const sections = [pickLocalizedValue(setupAssistantPrompts, locale)];
	const note = authorizationNotes[authorization] ?? authorizationNotes.default;
	sections.push(pickLocalizedValue(note, locale));
	if (briefing?.trim()) {
		sections.push(`${pickLocalizedValue(briefingHeadings, locale)}\n${briefing.trim()}`);
	}
	return sections.join("\n\n");
}
