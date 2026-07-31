import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { detectShell } from "../lib/agent/shell";
import { IS_WINDOWS, isWslAllowed } from "../lib/platform";
import {
	getDynamicSpecSystemReminder,
	getPlanModeSystemReminder,
	getReplyLanguageInstruction,
	type Locale,
} from "../lib/prompt-i18n";

export interface BuildPromptOptions {
	/** Base system prompt (narrator's custom prompt or subagent type prompt) */
	basePrompt: string | null;
	/** Working directory for CWD injection and AGENT.md lookup */
	cwd: string;
	/** Locale for language instruction */
	locale: Locale;
	/** Compact summary to inject (main narrator only) */
	contextSummary?: string | null;
	/** Whether plan mode is active */
	planMode?: boolean;
	/** Plan file ID for plan mode (locks Write/Edit to .narrafork/plan-{id}.md) */
	planFileId?: string;
	/** Whether plan mode accepts inline plans. When false, only the file-based flow is shown. */
	planAllowInlinePlan?: boolean;
	/** Whether to force language instruction even for English locale */
	replyInUserLanguage?: boolean;
	/** Global default system prompt (used when basePrompt is null) */
	defaultSystemPrompt?: string | null;
	/** Known remote execution devices and their current online status. */
	devices?: Array<{
		id: string;
		name: string;
		description?: string | null;
		online: boolean;
		platform?: { os: string; arch: string };
		defaultCwd?: string | null;
	}>;
	/** Current session default device id (null/undefined → local server). */
	defaultDeviceId?: string | null;
	/** Whether the NarraFork server may be selected as an execution target. */
	allowLocalExecution?: boolean;
}

export interface BuildPromptResult {
	prompt: string | null;
	usedCompactSummary: boolean;
}

/**
 * Size of the designated plan file, or undefined when there is nothing to warn
 * about (no plan identity, missing file, empty file, unreadable path).
 *
 * This runs on the system-prompt rebuild path, which happens once per loop
 * iteration, so it stays a single bounded `stat` — never a read. The plan file
 * content itself is only read when ExitPlanMode resolves it.
 */
async function statPlanFileBytes(cwd: string, planFileId?: string): Promise<number | undefined> {
	if (!planFileId) return undefined;
	// planFileId is generated/validated server-side, but this path is also used
	// for restored narrators, so refuse anything that could escape the worktree.
	if (planFileId.includes("/") || planFileId.includes("\\") || planFileId.includes("..")) {
		return undefined;
	}
	if (!isAbsolute(cwd)) return undefined;
	try {
		const stats = await stat(join(cwd, ".narrafork", `plan-${planFileId}.md`));
		if (!stats.isFile() || stats.size <= 0) return undefined;
		return stats.size;
	} catch {
		// Missing file is the normal case at the start of a plan cycle.
		return undefined;
	}
}

/**
 * Build the effective system prompt by appending standard sections:
 * context summary → CWD → Dynamic Spec → AGENT.md/CLAUDE.md →
 * ~/.agents/AGENT.md|~/.claude/CLAUDE.md → language → plan mode.
 *
 * Used by both main narrators and subagents. Subagents simply omit the
 * optional fields (contextSummary, planMode) to get a minimal prompt.
 */
export async function buildEffectiveSystemPrompt(
	options: BuildPromptOptions,
): Promise<BuildPromptResult> {
	const {
		basePrompt,
		cwd,
		locale,
		contextSummary,
		planMode,
		planFileId,
		planAllowInlinePlan,
		replyInUserLanguage,
		defaultSystemPrompt,
		devices,
		defaultDeviceId,
		allowLocalExecution = true,
	} = options;

	// Fall back to global default system prompt when basePrompt is null
	let prompt = basePrompt ?? defaultSystemPrompt ?? null;
	let usedCompactSummary = false;

	// 1. Inject compact summary if available
	if (contextSummary) {
		usedCompactSummary = true;
		const base = prompt ?? "";
		const sep = base ? "\n\n" : "";
		prompt = `${base}${sep}## Conversation Context\n\n${contextSummary}`;
	}

	// 2. Inject current working directory + shell type info
	{
		const base = prompt ?? "";
		const sep = base ? "\n\n" : "";
		const shellInfo = detectShell();
		const shellLabel = IS_WINDOWS ? "Shell" : "Bash";
		const toolList = IS_WINDOWS
			? `All tools (Shell, Read, Write, Edit, Glob, Grep)`
			: `All tools (Bash, Read, Write, Edit, Glob, Grep)`;
		let cwdSection = `## Current Working Directory\n\n\`${cwd}\`\n\n${toolList} already use this as their default working directory. Do NOT \`cd\` into it in ${shellLabel} commands — it is redundant.`;

		// Windows Git Bash: warn about MSYS2 path mangling and forbid cmd builtins
		if (IS_WINDOWS && shellInfo.loginWrap) {
			cwdSection += `\n\nCRITICAL — Windows Git Bash Shell Rules:
- The Shell tool runs commands through Git Bash (MSYS2). MSYS2 automatically converts arguments that look like Unix paths: \`/S\` → \`S:/\`, \`/I\` → \`I:/\`, etc. This BREAKS any Windows cmd command that uses \`/flag\` syntax.
- NEVER use Windows cmd builtins or utilities in the Shell tool: \`findstr\`, \`dir\`, \`type\`, \`copy\`, \`move\`, \`del\`, \`ren\`, \`cls\`, \`more\`, \`sort\`, \`fc\`, \`comp\`, \`xcopy\`, \`robocopy\`, \`attrib\`, \`icacls\`.
- Use the dedicated tools instead: Grep (uses ripgrep), Glob, Read, Write, Edit. These work correctly on all platforms.
- For shell commands, use Unix-style equivalents available in Git Bash: \`ls\`, \`cat\`, \`cp\`, \`mv\`, \`rm\`, \`find\`, \`grep\`, \`mkdir\`, \`touch\`, \`head\`, \`tail\`, \`wc\`.
- Use \`git\`, \`node\`, \`npm\`, \`bun\`, \`python\` etc. directly — they work fine in Git Bash.`;
		}

		// Windows PowerShell guidance
		if (IS_WINDOWS && shellInfo.type === "powershell") {
			cwdSection += `\n\nCRITICAL — Windows PowerShell Shell Rules:
- The Shell tool uses PowerShell on this system. Use PowerShell cmdlets (e.g. Get-ChildItem, Select-String) or common cross-platform commands (e.g. git, node, npm, bun, python).
- NEVER use Windows cmd builtins: \`findstr\`, \`dir\`, \`type\`, \`copy\`, \`move\`, \`del\`. They may behave unexpectedly in PowerShell.
- Prefer the dedicated tools (Read, Write, Edit, Glob, Grep) over shell commands whenever possible.`;
		}

		// On Windows, forbid WSL suggestions unless --wsl=true
		if (IS_WINDOWS && !isWslAllowed()) {
			cwdSection += `\n\nIMPORTANT: This is a native Windows environment. Do NOT suggest switching to WSL (Windows Subsystem for Linux), installing WSL, or running commands through WSL. All tools and commands must work natively on Windows.`;
		}
		prompt = `${base}${sep}${cwdSection}`;
	}

	// 2a. Inject the Execution Devices section when remote execution is available,
	// or when a stale remote default needs an explicit recovery warning.
	{
		const allDevices = devices ?? [];
		const onlineDevices = allDevices.filter((d) => d.online);
		const hasRemoteDefault = defaultDeviceId != null && defaultDeviceId !== "local";
		if (onlineDevices.length > 0 || hasRemoteDefault) {
			const base = prompt ?? "";
			const sep = base ? "\n\n" : "";
			const defaultDevice = hasRemoteDefault
				? allDevices.find((d) => d.id === defaultDeviceId)
				: undefined;
			const defaultUnavailable = hasRemoteDefault && !defaultDevice?.online;
			const currentTarget = hasRemoteDefault
				? `${defaultDevice?.name ?? defaultDeviceId} (remote${defaultUnavailable ? ", unavailable" : ""})`
				: "local (the NarraFork server)";
			const deviceLines = onlineDevices.map((d) => {
				const platform = d.platform ? ` [${d.platform.os}/${d.platform.arch}]` : "";
				const purpose = d.description ? ` — ${d.description}` : "";
				const cwd = d.defaultCwd ? ` (default cwd: ${d.defaultCwd})` : "";
				return `- \`${d.id}\` — ${d.name}${platform}${purpose}${cwd}`;
			});
			const availabilityText =
				onlineDevices.length > 0
					? `Available remote devices:\n${deviceLines.join("\n")}`
					: "Available remote devices: none currently online.";
			const unavailableWarning = defaultUnavailable
				? `\n\nWARNING: The configured default remote device \`${defaultDeviceId}\` is unknown or offline. ` +
					`Tool calls that omit \`device\` will fail and will NOT fall back to local execution. ` +
					(allowLocalExecution
						? `Use SwitchDevice with \`device: "local"\` before running local file or command tools.`
						: `Select another listed online remote device; local execution is forbidden by runtime policy.`)
				: "";
			// Prefer an online device for the example; fall back to the (possibly
			// offline) remote default, and only then to "local". When local execution
			// is forbidden and no concrete device id is available, omit the id example
			// entirely rather than interpolate a null/undefined placeholder.
			const exampleDeviceId = onlineDevices[0]?.id ?? (hasRemoteDefault ? defaultDeviceId : null);
			let perCallExample: string;
			if (allowLocalExecution) {
				perCallExample = exampleDeviceId
					? `(e.g. \`device: "${exampleDeviceId}"\`, or \`"local"\` for the server).`
					: `(e.g. \`device: "local"\` for the server).`;
			} else {
				perCallExample = exampleDeviceId
					? `(e.g. \`device: "${exampleDeviceId}"\`). Only listed remote device ids are allowed; ` +
						"the local server is forbidden by runtime policy."
					: "using a listed remote device id. Only listed remote device ids are allowed; " +
						"the local server is forbidden by runtime policy.";
			}
			const deviceSection =
				`## Execution Devices\n\n` +
				`File and command tools (Read, Write, Edit, Glob, Grep, ${IS_WINDOWS ? "Shell" : "Bash"}) ` +
				`run only on their selected execution target.\n\n` +
				`Current default execution target: **${currentTarget}**.${unavailableWarning}\n\n` +
				`${availabilityText}\n\n` +
				`- By default, tools run on the current default target.\n` +
				`- To run a single operation on a specific machine, pass the \`device\` parameter ${perCallExample}\n` +
				`- To change the default target for subsequent tools, use the SwitchDevice tool.\n` +
				`- Remote routing failures never fall back to the server's local filesystem.\n` +
				`- Paths and commands are interpreted on the selected target's filesystem.`;
			prompt = `${base}${sep}${deviceSection}`;
		}
	}

	// 2b. Inject Dynamic Spec usage so models know spec:// exists even before tasks do.
	{
		const base = prompt ?? "";
		const sep = base ? "\n\n" : "";
		prompt = `${base}${sep}${getDynamicSpecSystemReminder(locale)}`;
	}

	// 3. Inject AGENT.md (fallback to CLAUDE.md) if present
	{
		let agentMdContent: string | null = null;
		for (const filename of ["AGENT.md", "CLAUDE.md"]) {
			try {
				agentMdContent = await readFile(join(cwd, filename), "utf-8");
				break;
			} catch {
				// file not found, try next
			}
		}
		if (agentMdContent) {
			const base = prompt ?? "";
			const sep = base ? "\n\n" : "";
			prompt = `${base}${sep}## Project Instructions\n\n${agentMdContent}`;
		}
	}
	// 3b. Inject global AGENT.md (fallback to CLAUDE.md): ~/.agents/AGENT.md > ~/.claude/CLAUDE.md
	{
		let globalMd: string | null = null;
		const globalCandidates = [
			join(homedir(), ".agents", "AGENT.md"),
			join(homedir(), ".claude", "CLAUDE.md"),
		];
		for (const candidate of globalCandidates) {
			try {
				globalMd = await readFile(candidate, "utf-8");
				break;
			} catch {
				// file not found, try next
			}
		}
		if (globalMd) {
			const MAX_GLOBAL_MD = 50_000;
			if (globalMd.length > MAX_GLOBAL_MD) {
				globalMd = globalMd.slice(0, MAX_GLOBAL_MD);
			}
			const base = prompt ?? "";
			const sep = base ? "\n\n" : "";
			prompt = `${base}${sep}## Global Instructions\n\n${globalMd}`;
		}
	}

	// 4. Append language instruction
	if (replyInUserLanguage || locale !== "en") {
		const instruction = getReplyLanguageInstruction(locale);
		const base = prompt ?? "";
		const sep = base ? "\n\n" : "";
		prompt = `${base}${sep}## Language\n\n${instruction}`;
	}

	// 5. Inject plan mode system reminder
	if (planMode) {
		const base = prompt ?? "";
		const sep = base ? "\n\n" : "";
		// The plan file's path always survives a compact (it is rebuilt from
		// planFileId every turn), but the record of having written to it does not.
		// Stat the file so the reminder can tell the model to Read + Edit instead
		// of Write-truncating a half-finished plan it no longer remembers.
		const planFileBytes = await statPlanFileBytes(cwd, planFileId);
		prompt = `${base}${sep}${getPlanModeSystemReminder(
			locale,
			planFileId,
			planAllowInlinePlan !== false,
			planFileBytes,
		)}`;
	}

	return { prompt, usedCompactSummary };
}
