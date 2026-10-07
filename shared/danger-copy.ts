/**
 * danger-copy.ts — Map server-written English danger assessment copy to i18n keys.
 *
 * `classifyDanger` / `danger()` in narrator-permission.ts write canonical English
 * into `DangerInfo` (summary / consequences / saferAlternatives / details). Those
 * strings are system chrome, not model content, but they were shown raw — so a
 * Chinese UI still read "Git reset may rewrite…".
 *
 * Same display-time strategy as reflection-reason.ts: keep the stored English
 * stable (historical rows, multi-user views, tests) and re-label it at paint time.
 * Pure lookup — the shell supplies `t`.
 */

export interface DangerCopyRef {
	/** i18n key in the `narrator` namespace. */
	key: string;
	/** Interpolation params for templated copy. */
	params?: Record<string, string>;
}

/**
 * Exact-match English → key for every static summary / consequence / alternative
 * written by the danger classifiers.
 */
const EXACT: Map<string, string> = new Map([
	// ── shell analysis failure ──────────────────────────────────────────────
	["Shell command safety analysis failed.", "dangerCopy_shellAnalysisFailedSummary"],
	["NarraFork could not inspect the command before execution.", "dangerCopy_shellAnalysisFailedC1"],
	[
		"In Bypass All mode, executing an unanalyzed shell command may modify files, run code, or access external paths without an effective safety gate.",
		"dangerCopy_shellAnalysisFailedC2",
	],
	["Retry after fixing the command analysis failure.", "dangerCopy_shellAnalysisFailedA1"],
	[
		"Break the task into dedicated read/write tools or smaller explicit commands.",
		"dangerCopy_shellAnalysisFailedA2",
	],
	[
		"Run only after the visible command has been manually verified as intentional and bounded.",
		"dangerCopy_shellAnalysisFailedA3",
	],
	// ── plan mode soft deny ─────────────────────────────────────────────────
	["Plan mode is about to be relaxed for a non-planning tool call.", "dangerCopy_planRelaxSummary"],
	[
		"The narrator is still in plan mode, but this approval will enable relaxed plan mode so edit-capable tools can run.",
		"dangerCopy_planRelaxC1",
	],
	[
		"Implementation changes may begin before the plan has gone through the normal plan-mode approval path.",
		"dangerCopy_planRelaxC2",
	],
	[
		"Continue read-only investigation and write only to the designated plan file.",
		"dangerCopy_planRelaxA1",
	],
	[
		"Submit the complete plan first, then run implementation tools after approval.",
		"dangerCopy_planRelaxA2",
	],
	// ── git ─────────────────────────────────────────────────────────────────
	["Git reset may rewrite the current worktree/index state.", "dangerCopy_gitResetSummary"],
	["Uncommitted work can be discarded or unstaged.", "dangerCopy_gitResetC1"],
	[
		"HEAD/index changes can be hard to reconstruct without reflog or backups.",
		"dangerCopy_gitResetC2",
	],
	["Run git status and git diff first.", "dangerCopy_gitResetA1"],
	["Create a backup branch or stash before resetting.", "dangerCopy_gitResetA2"],
	["Git clean removes untracked files from the worktree.", "dangerCopy_gitCleanSummary"],
	["Untracked files are often not recoverable from git.", "dangerCopy_gitCleanC1"],
	[
		"Generated artifacts, local notes, or new source files may be deleted.",
		"dangerCopy_gitCleanC2",
	],
	["Run git clean -nd first to preview.", "dangerCopy_gitCleanA1"],
	["Delete only specific paths if possible.", "dangerCopy_gitCleanA2"],
	[
		"Git checkout is being used to restore paths and may discard local changes.",
		"dangerCopy_gitCheckoutSummary",
	],
	[
		"Modified files can be reverted without preserving the previous content.",
		"dangerCopy_gitCheckoutC1",
	],
	["Inspect git diff first.", "dangerCopy_gitInspectDiff"],
	["Restore only the specific files that must be reverted.", "dangerCopy_gitCheckoutA2"],
	["Git restore may discard local file changes.", "dangerCopy_gitRestoreSummary"],
	[
		"Affected files can be reverted without preserving the previous content.",
		"dangerCopy_gitRestoreC1",
	],
	["Restore only specific files rather than the whole tree.", "dangerCopy_gitRestoreA2"],
	["Git push may rewrite or delete remote history.", "dangerCopy_gitPushSummary"],
	[
		"Remote commits or branches can be overwritten or removed for collaborators.",
		"dangerCopy_gitPushC1",
	],
	["Recovery may require remote reflogs or manual intervention.", "dangerCopy_gitPushC2"],
	["Prefer a normal push.", "dangerCopy_gitPushA1"],
	[
		"If force is necessary, verify the remote branch and use --force-with-lease.",
		"dangerCopy_gitPushA2",
	],
	["Git branch deletion removes a local branch reference.", "dangerCopy_gitBranchDeleteSummary"],
	[
		"Commits reachable only from that branch can become difficult to find.",
		"dangerCopy_gitBranchDeleteC1",
	],
	[
		"Check git branch --merged and note the commit hash before deleting.",
		"dangerCopy_gitBranchDeleteA1",
	],
	["Git worktree remove deletes a worktree checkout.", "dangerCopy_gitWorktreeSummary"],
	["Uncommitted files in that worktree may be lost.", "dangerCopy_gitWorktreeC1"],
	["Run git -C <worktree> status first.", "dangerCopy_gitWorktreeA1"],
	["Commit, stash, or copy important files before removal.", "dangerCopy_gitWorktreeA2"],
	["Git rm deletes tracked files from the worktree and index.", "dangerCopy_gitRmSummary"],
	["Files will be removed and staged for deletion.", "dangerCopy_gitRmC1"],
	["Use git status first.", "dangerCopy_gitRmA1"],
	["Remove only specific intended files.", "dangerCopy_gitRmA2"],
	["Git reflog expire can destroy recovery points.", "dangerCopy_gitReflogSummary"],
	[
		"Future recovery from accidental resets or rebases may become impossible.",
		"dangerCopy_gitReflogC1",
	],
	[
		"Avoid expiring reflogs during agent work unless explicitly required.",
		"dangerCopy_gitReflogA1",
	],
	["Git stash drop permanently removes a stash entry.", "dangerCopy_gitStashDropSummary"],
	["The stashed changes cannot be recovered after dropping.", "dangerCopy_gitStashDropC1"],
	[
		"If the stash contains important uncommitted work, it will be lost.",
		"dangerCopy_gitStashDropC2",
	],
	["Run git stash list first to inspect.", "dangerCopy_gitStashListFirst"],
	["Apply the stash before dropping it.", "dangerCopy_gitStashDropA2"],
	["Git stash clear removes all stash entries.", "dangerCopy_gitStashClearSummary"],
	["All stashed changes will be permanently lost.", "dangerCopy_gitStashClearC1"],
	["Recovery is not possible after clearing the stash.", "dangerCopy_gitStashClearC2"],
	["Apply or pop important stashes before clearing.", "dangerCopy_gitStashClearA2"],
	["Git gc --prune can permanently remove unreachable objects.", "dangerCopy_gitGcSummary"],
	["Commits/files recoverable only via dangling objects may be deleted.", "dangerCopy_gitGcC1"],
	["Avoid aggressive pruning during agent work.", "dangerCopy_gitGcA1"],
	["Create a backup ref first if pruning is required.", "dangerCopy_gitGcA2"],
	["Create a backup branch first.", "dangerCopy_gitHistoryRewriteA1"],
	["Prefer a new commit if history rewriting is not required.", "dangerCopy_gitHistoryRewriteA2"],
	[
		"Commit hashes change and collaborators may need manual recovery steps.",
		"dangerCopy_gitHistoryRewriteC1",
	],
	// ── shell / find / rm ───────────────────────────────────────────────────
	[
		"Deleted files may not be recoverable from git if they are untracked or ignored.",
		"dangerCopy_deleteFilesC1",
	],
	["The operation can remove user work that the agent did not create.", "dangerCopy_deleteFilesC2"],
	["List the target paths first.", "dangerCopy_deleteFilesA1"],
	["Prefer moving files to a temporary trash directory.", "dangerCopy_deleteFilesA2"],
	["Find runs a command NarraFork could not classify.", "dangerCopy_findUnknownSummary"],
	[
		"The executed command's side effects are unknown, and find applies it to every match.",
		"dangerCopy_findUnknownC1",
	],
	["In Bypass All mode this would otherwise execute without user approval.", "dangerCopy_bypassC"],
	[
		"Run the same find command without -exec first to see what it would match.",
		"dangerCopy_findUnknownA1",
	],
	["Invoke the command directly on explicit paths instead.", "dangerCopy_findUnknownA2"],
	[
		"Find is being used to delete files or run a destructive command.",
		"dangerCopy_findDestructiveSummary",
	],
	["Find applies a state-changing command to every match.", "dangerCopy_findMutatingSummary"],
	[
		"It can affect many matching files at once, including files the agent did not inspect.",
		"dangerCopy_findMutatingC1",
	],
	[
		"Paths written through the find expression are not covered by the worktree boundary check.",
		"dangerCopy_findMutatingC2",
	],
	["Run the same find command without -delete/-exec first.", "dangerCopy_findMutatingA1"],
	["Apply changes to explicit paths.", "dangerCopy_findMutatingA2"],
	// ── chapter git / env / patterns ────────────────────────────────────────
	["Git command changes chapter branch/worktree state.", "dangerCopy_chapterGitSummary"],
	[
		"The command can switch, create, delete, rewrite, or otherwise move branch/worktree state outside the normal chapter workflow.",
		"dangerCopy_chapterGitC1",
	],
	[
		"NarraFork may lose track of which chapter owns the resulting git state.",
		"dangerCopy_chapterGitC2",
	],
	[
		"Prefer NarraFork chapter/fork/merge operations for branch and worktree changes.",
		"dangerCopy_chapterGitA1",
	],
	[
		"If this git operation is intentional, confirm the exact target branch or worktree first.",
		"dangerCopy_chapterGitA2",
	],
	["Shell command contains dangerous execution patterns.", "dangerCopy_dangerousPatternsSummary"],
	[
		"Shell command includes unclassified execution patterns.",
		"dangerCopy_unclassifiedPatternsSummary",
	],
	[
		"The command may execute downloaded, nested, or environment-injected code.",
		"dangerCopy_dangerousPatternsC1",
	],
	[
		"Side effects may be broader than the visible command line suggests.",
		"dangerCopy_dangerousPatternsC2",
	],
	[
		"The command may execute a local script, unknown subcommand, or unallowlisted argument whose side effects are not classified.",
		"dangerCopy_unclassifiedPatternsC1",
	],
	["Inspect the command source first.", "dangerCopy_inspectSource"],
	[
		"Break the command into read-only inspection and explicit execution steps.",
		"dangerCopy_splitReadExecute",
	],
	[
		"Use a dedicated NarraFork tool for read/write operations when possible.",
		"dangerCopy_preferDedicatedTool",
	],
	[
		"Break the command into smaller inspected steps or add a narrow command whitelist rule if this exact command is trusted.",
		"dangerCopy_breakOrWhitelist",
	],
	// ── allowlist / external paths ──────────────────────────────────────────
	[
		"Shell command includes commands outside the safety allowlist.",
		"dangerCopy_nonAllowlistedSummary",
	],
	[
		"The command may run code, invoke a package/script, change system state, or perform side effects that NarraFork cannot classify as read-only.",
		"dangerCopy_nonAllowlistedC1",
	],
	[
		"Shell command accesses paths outside the current working directory.",
		"dangerCopy_shellExternalPathsSummary",
	],
	[
		"The command may read or modify files outside this chapter/worktree boundary.",
		"dangerCopy_shellExternalPathsC1",
	],
	[
		"Those files may not be covered by NarraFork snapshots or git recovery.",
		"dangerCopy_shellExternalPathsC2",
	],
	["Copy needed data into the worktree first.", "dangerCopy_shellExternalPathsA1"],
	["Use a narrower command scoped to explicit paths.", "dangerCopy_shellExternalPathsA2"],
	// ── tool-level external paths ───────────────────────────────────────────
	["The operation crosses the chapter/worktree boundary.", "dangerCopy_toolExternalPathsC1"],
	[
		"External files may not be covered by project git history or NarraFork snapshots.",
		"dangerCopy_toolExternalPathsC2",
	],
	["Operate inside the worktree when possible.", "dangerCopy_toolExternalPathsA1"],
	["Use explicit user approval for external files.", "dangerCopy_toolExternalPathsA2"],
	// ── SwitchWorkingDirectory / Agent ──────────────────────────────────────
	[
		"SwitchWorkingDirectory changes the narrator's execution workspace.",
		"dangerCopy_switchCwdSummary",
	],
	[
		"Subsequent tools use a different working directory, skills and permission context.",
		"dangerCopy_switchCwdC1",
	],
	[
		"Existing background tools, subagents and terminals remain on their original targets.",
		"dangerCopy_switchCwdC2",
	],
	[
		"Verify the target device and directory match the user's requested workspace.",
		"dangerCopy_switchCwdA1",
	],
	[
		"Keep the current workspace if switching is not necessary for this task.",
		"dangerCopy_switchCwdA2",
	],
	[
		"Write-capable subagent requests a custom working directory.",
		"dangerCopy_subagentWorkdirSummary",
	],
	[
		"The subagent may operate outside the parent narrator's current workspace.",
		"dangerCopy_subagentWorkdirC1",
	],
	[
		"A write-capable subagent can modify files the parent did not inspect.",
		"dangerCopy_subagentWorkdirC2",
	],
	["Use the inherited working directory when possible.", "dangerCopy_subagentWorkdirA1"],
	[
		"Use an explore/plan subagent for read-only investigation first.",
		"dangerCopy_subagentWorkdirA2",
	],
	// ── knowledge ───────────────────────────────────────────────────────────
	[
		"This changes shared project knowledge or its access-control configuration.",
		"dangerCopy_knowledgeWriteC1",
	],
	[
		"Approving a publish updates the globally-served knowledge version.",
		"dangerCopy_knowledgeMergeC",
	],
	[
		"Reviewing affects whether a contributor's proposal is published.",
		"dangerCopy_knowledgeReviewC",
	],
	["ACL changes affect who can read or modify knowledge entries.", "dangerCopy_knowledgeAclC"],
	[
		"Confirm the action and target ids are correct before proceeding.",
		"dangerCopy_knowledgeConfirm",
	],
	[
		"Prefer the personal-entry → publish → review flow for content changes when unsure.",
		"dangerCopy_knowledgePreferFlow",
	],
	[
		"KnowledgeCreate creates an entry directly in the global knowledge base.",
		"dangerCopy_knowledgeCreateDirectSummary",
	],
	[
		"KnowledgeCreate creates an entry in your personal knowledge library.",
		"dangerCopy_knowledgeCreatePersonalSummary",
	],
	[
		"A direct create publishes to the globally-served base without review.",
		"dangerCopy_knowledgeCreateDirectC",
	],
	["Personal entries are private to you until published.", "dangerCopy_knowledgeCreatePersonalC"],
	[
		"Confirm the title and target collection are correct before proceeding.",
		"dangerCopy_knowledgeCreateConfirm",
	],
	[
		"Publishing or a direct save changes the globally-served knowledge version.",
		"dangerCopy_knowledgeEditGlobalC",
	],
	[
		"This changes your personal entry, an entry's metadata, or ownership.",
		"dangerCopy_knowledgeEditPersonalC",
	],
	["A non-direct save only updates your private personal entry.", "dangerCopy_knowledgeEditSaveA"],
	["Use 'publish' to propose the change for review.", "dangerCopy_knowledgeEditPublishA"],
	// ── static details ──────────────────────────────────────────────────────
	["Environment variable injection detected", "dangerCopy_envInjectionDetail"],
	// ── static action/alternative fragments already listed above ────────────
	[
		"Find is being used to delete files or run a destructive command.",
		"dangerCopy_findDestructiveSummary",
	],
]);

/** Templated summaries (dynamic tool / subcommand / action names). */
const TEMPLATES: Array<{
	re: RegExp;
	key: string;
	build: (m: RegExpExecArray) => Record<string, string>;
}> = [
	{
		re: /^(rm|rmdir|shred) deletes files recursively\.$/,
		key: "dangerCopy_deleteFilesRecursiveSummary",
		build: (m) => ({ name: m[1] ?? "" }),
	},
	{
		re: /^(rm|rmdir|shred) deletes files\.$/,
		key: "dangerCopy_deleteFilesSummary",
		build: (m) => ({ name: m[1] ?? "" }),
	},
	{
		re: /^Git (filter-branch|filter-repo|rebase) rewrites commit history\.$/,
		key: "dangerCopy_gitHistoryRewriteSummary",
		build: (m) => ({ sub: m[1] ?? "" }),
	},
	{
		re: /^Knowledge(Admin|Review) performs a knowledge-base write action: (.+)\.$/,
		key: "dangerCopy_knowledgeWriteSummary",
		build: (m) => ({ tool: `Knowledge${m[1] ?? ""}`, action: m[2] ?? "" }),
	},
	{
		re: /^KnowledgeEdit performs a knowledge action: (.+)\.$/,
		key: "dangerCopy_knowledgeEditSummary",
		build: (m) => ({ action: m[1] ?? "" }),
	},
	{
		re: /^(.+) targets paths outside the current working directory\.$/,
		key: "dangerCopy_toolExternalPathsSummary",
		build: (m) => ({ tool: m[1] ?? "" }),
	},
];

/** Assessment-detail chrome: `Label: value` pairs. Value stays verbatim. */
const DETAIL_PATTERNS: Array<{ re: RegExp; key: string; param: string }> = [
	{ re: /^Tool: (.+)$/s, key: "dangerDetail_tool", param: "value" },
	{ re: /^Command: (.+)$/s, key: "dangerDetail_command", param: "value" },
	{ re: /^Analysis error: (.+)$/s, key: "dangerDetail_analysisError", param: "value" },
	{ re: /^Target path: (.+)$/s, key: "dangerDetail_targetPath", param: "value" },
	{ re: /^Pattern: (.+)$/s, key: "dangerDetail_pattern", param: "value" },
	{ re: /^Chapter git issue: (.+)$/s, key: "dangerDetail_chapterGitIssue", param: "value" },
	{ re: /^External paths: (.+)$/s, key: "dangerDetail_externalPaths", param: "value" },
	{
		re: /^Commands outside allowlist: (.+)$/s,
		key: "dangerDetail_commandsOutsideAllowlist",
		param: "value",
	},
	{
		re: /^Current working directory: (.+)$/s,
		key: "dangerDetail_currentCwd",
		param: "value",
	},
	{ re: /^Requested device: (.+)$/s, key: "dangerDetail_requestedDevice", param: "value" },
	{
		re: /^Requested working directory: (.+)$/s,
		key: "dangerDetail_requestedCwd",
		param: "value",
	},
	{ re: /^Requested workdir: (.+)$/s, key: "dangerDetail_requestedWorkdir", param: "value" },
	{ re: /^Action: (.+)$/s, key: "dangerDetail_action", param: "value" },
	{ re: /^Direct: (.+)$/s, key: "dangerDetail_direct", param: "value" },
];

function fromExactOrTemplate(text: string): DangerCopyRef | null {
	const exactKey = EXACT.get(text);
	if (exactKey) return { key: exactKey };
	for (const template of TEMPLATES) {
		const match = template.re.exec(text);
		if (match) return { key: template.key, params: template.build(match) };
	}
	return null;
}

/** Every i18n key this catalog can emit (summaries + detail chrome). */
export const DANGER_COPY_KEYS: readonly string[] = (() => {
	const keys = new Set<string>();
	for (const key of EXACT.values()) keys.add(key);
	for (const template of TEMPLATES) keys.add(template.key);
	for (const pattern of DETAIL_PATTERNS) keys.add(pattern.key);
	return [...keys].sort();
})();

/**
 * English fallbacks for every catalog key (`{param}` templates included).
 * Used by the adapter's SYSTEM_LABEL_FALLBACKS so measure stays self-contained.
 */
export function dangerCopyEnglishFallbacks(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [en, key] of EXACT) {
		if (!(key in out)) out[key] = en;
	}
	out.dangerCopy_deleteFilesSummary = "{name} deletes files.";
	out.dangerCopy_deleteFilesRecursiveSummary = "{name} deletes files recursively.";
	out.dangerCopy_gitHistoryRewriteSummary = "Git {sub} rewrites commit history.";
	out.dangerCopy_knowledgeWriteSummary = "{tool} performs a knowledge-base write action: {action}.";
	out.dangerCopy_knowledgeEditSummary = "KnowledgeEdit performs a knowledge action: {action}.";
	out.dangerCopy_toolExternalPathsSummary =
		"{tool} targets paths outside the current working directory.";
	out.dangerDetail_tool = "Tool: {value}";
	out.dangerDetail_command = "Command: {value}";
	out.dangerDetail_analysisError = "Analysis error: {value}";
	out.dangerDetail_targetPath = "Target path: {value}";
	out.dangerDetail_pattern = "Pattern: {value}";
	out.dangerDetail_chapterGitIssue = "Chapter git issue: {value}";
	out.dangerDetail_externalPaths = "External paths: {value}";
	out.dangerDetail_commandsOutsideAllowlist = "Commands outside allowlist: {value}";
	out.dangerDetail_currentCwd = "Current working directory: {value}";
	out.dangerDetail_requestedDevice = "Requested device: {value}";
	out.dangerDetail_requestedCwd = "Requested working directory: {value}";
	out.dangerDetail_requestedWorkdir = "Requested workdir: {value}";
	out.dangerDetail_action = "Action: {value}";
	out.dangerDetail_direct = "Direct: {value}";
	return out;
}

/**
 * Placeholder params for templated keys when building adapter labels.
 *
 * Matches the `reflectionNextSteps` contract: `t(key, { name: "{name}" })` leaves
 * a literal `{name}` marker the adapter substitutes with live values at layout
 * time. Without this, `t(key)` would interpolate `{{name}}` away to empty.
 */
const LABEL_PLACEHOLDERS: Record<string, Record<string, string>> = {
	dangerCopy_deleteFilesSummary: { name: "{name}" },
	dangerCopy_deleteFilesRecursiveSummary: { name: "{name}" },
	dangerCopy_gitHistoryRewriteSummary: { sub: "{sub}" },
	dangerCopy_knowledgeWriteSummary: { tool: "{tool}", action: "{action}" },
	dangerCopy_knowledgeEditSummary: { action: "{action}" },
	dangerCopy_toolExternalPathsSummary: { tool: "{tool}" },
	dangerDetail_tool: { value: "{value}" },
	dangerDetail_command: { value: "{value}" },
	dangerDetail_analysisError: { value: "{value}" },
	dangerDetail_targetPath: { value: "{value}" },
	dangerDetail_pattern: { value: "{value}" },
	dangerDetail_chapterGitIssue: { value: "{value}" },
	dangerDetail_externalPaths: { value: "{value}" },
	dangerDetail_commandsOutsideAllowlist: { value: "{value}" },
	dangerDetail_currentCwd: { value: "{value}" },
	dangerDetail_requestedDevice: { value: "{value}" },
	dangerDetail_requestedCwd: { value: "{value}" },
	dangerDetail_requestedWorkdir: { value: "{value}" },
	dangerDetail_action: { value: "{value}" },
	dangerDetail_direct: { value: "{value}" },
};

/**
 * Build the adapter-label bundle for every danger copy key. The shell injects
 * these so the measure pass and the paint pass see the same localized text.
 */
export function dangerCopyLabels(
	t: (key: string, options?: Record<string, unknown>) => string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of DANGER_COPY_KEYS) {
		const placeholders = LABEL_PLACEHOLDERS[key];
		out[key] = placeholders ? t(key, placeholders) : t(key);
	}
	return out;
}

/**
 * Look up a summary / consequence / safer-alternative string.
 * Returns null for custom content that must be shown verbatim.
 */
export function lookupDangerCopy(text: string): DangerCopyRef | null {
	const trimmed = typeof text === "string" ? text.trim() : "";
	if (!trimmed) return null;
	return fromExactOrTemplate(trimmed);
}

/**
 * Look up an assessment-detail line. Handles `Label: value` chrome and exact
 * static details; falls back to the summary table (shared phrases).
 */
export function lookupDangerDetail(text: string): DangerCopyRef | null {
	const trimmed = typeof text === "string" ? text.trim() : "";
	if (!trimmed) return null;
	for (const pattern of DETAIL_PATTERNS) {
		const match = pattern.re.exec(trimmed);
		if (match) {
			return { key: pattern.key, params: { [pattern.param]: match[1] ?? "" } };
		}
	}
	return fromExactOrTemplate(trimmed);
}
