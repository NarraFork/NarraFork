import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectShell } from "../lib/agent/shell";
import { IS_WINDOWS, isWslAllowed } from "../lib/platform";
import {
	getPlanModeSystemReminder,
	getReplyLanguageInstruction,
	getTodoSystemReminder,
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
	/** Todos JSON for reminder injection */
	todosJson?: unknown;
	/** Whether plan mode is active */
	planMode?: boolean;
	/** Plan file ID for plan mode (locks Write/Edit to .narrafork/plan-{id}.md) */
	planFileId?: string;
	/** Whether to force language instruction even for English locale */
	replyInUserLanguage?: boolean;
}

export interface BuildPromptResult {
	prompt: string | null;
	usedCompactSummary: boolean;
}

/**
 * Build the effective system prompt by appending standard sections:
 * context summary → CWD → AGENT.md/CLAUDE.md → language → todos → plan mode.
 *
 * Used by both main narrators and subagents. Subagents simply omit the
 * optional fields (contextSummary, todosJson, planMode) to get a minimal prompt.
 */
export async function buildEffectiveSystemPrompt(
	options: BuildPromptOptions,
): Promise<BuildPromptResult> {
	const {
		basePrompt,
		cwd,
		locale,
		contextSummary,
		todosJson,
		planMode,
		planFileId,
		replyInUserLanguage,
	} = options;

	let prompt = basePrompt;
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

	// 4. Append language instruction
	if (replyInUserLanguage || locale !== "en") {
		const instruction = getReplyLanguageInstruction(locale);
		const base = prompt ?? "";
		const sep = base ? "\n\n" : "";
		prompt = `${base}${sep}## Language\n\n${instruction}`;
	}

	// 5. Inject todo management reminder when narrator has active todos
	if (
		Array.isArray(todosJson) &&
		todosJson.some((t: { status?: string }) => t.status !== "completed")
	) {
		const base = prompt ?? "";
		const sep = base ? "\n\n" : "";
		prompt = `${base}${sep}${getTodoSystemReminder(locale)}`;
	}

	// 6. Inject plan mode system reminder
	if (planMode) {
		const base = prompt ?? "";
		const sep = base ? "\n\n" : "";
		prompt = `${base}${sep}${getPlanModeSystemReminder(locale, planFileId)}`;
	}

	return { prompt, usedCompactSummary };
}
