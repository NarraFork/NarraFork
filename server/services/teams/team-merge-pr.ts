/**
 * The pull request flow of a ready work item (G), when origin is on GitHub (`team-hosting.ts`).
 *
 * 「发起 PR」 / 「更新 PR」 / 「重新发起 PR」 (`POST …/work/:itemId/merge`, job `pull_request`):
 *  1. the item is ready, its worker not running, its branch tip still the head pinned at ready,
 *     gh usable (installed, logged in, may write), the history real (`assertTrueHistory`,
 *     `assertNoReplacedHistory`);
 *  2. origin's push URL is read again and must name exactly the repository gh works on
 *     (`TEAM_PR_REMOTE_CHANGED` otherwise);
 *  3. `git push --porcelain <url> <head>:refs/heads/<branch>` through the hardened runner
 *     (`team-git-write.ts:pushBranch`: no `+`, no lease, no hook, the receive-pack pinned, the
 *     host's credentials only): a remote branch with commits the head lacks is
 *     `TEAM_PR_PUSH_REJECTED` (退回 is offered); a moved branch records `work.pr_pushed`;
 *  4. `gh pr list --head <branch> --state all`: an open pull request is reused (`work.pr_opened`
 *     when it is not the one recorded), one merged at this very head marks the item merged, and
 *     otherwise `gh pr create --head --base --title --body-file -` opens one (never a draft). Its
 *     body ({@link pullRequestBody}) names the person who asked, the size and the review rounds;
 *     every text an agent or a person wrote is quoted inside a code block with `@`, `#`, `GH-`
 *     and `://` neutralised, so it mentions nobody and closes nothing; at most 16 KB.
 *
 * 「合并 PR」 (`POST …/work/:itemId/pr/merge`, job `pr_merge`): the pull request is read again —
 * merged already: recorded; closed, carrying another head (「更新 PR」), a draft, BLOCKED, BEHIND
 * or UNKNOWN: refused with the reason; DIRTY: the conflicting files from a hardened local
 * `merge-tree` against `origin/<base>`, recorded as a conflict with 退回 offered — then `gh pr
 * merge N --<method> --match-head-commit <head>` (never `--delete-branch`, never `--admin`). A
 * merge queue (or auto-merge) may queue it instead: the pull request is read once more and
 * `work.pr_queued` recorded (已加入合并队列).
 *
 * Merged (by NarraFork or by hand on GitHub, found by a read): `markMergedByPullRequest` records
 * `work.merged {detectedBy: "pull_request", pr, url, mergeCommit, method, headMatches}` (any
 * method: squash and rebase too), then `origin/<base>` is fetched into its remote-tracking ref
 * only (never the local branch or a working tree), queued dependents are reconciled, and the
 * coordinator is told. The worktree goes through the usual, person-approved cleanup.
 *
 * Reads: `gh pr view` (64 KB) and `gh pr checks` (256 KB) per item, kept 20 s; at most two reads
 * run at once. A background pass every 60 s reads 20 ready items with a pull request at a time;
 * the drawer asks for a read when it opens (`POST …/pr/refresh`). Events are written only on
 * transitions: checks turning failing or passing or a review asking for changes
 * (`work.pr_checks`, the coordinator told when it needs the worker), GitHub reporting a
 * conflict (`work.merge_failed {code: "conflict"}`, told once per head), the pull request closed
 * (`work.pr_closed`), or merged. No git or gh runs inside a SQLite transaction.
 */
import {
	TEAM_MERGE_CONFLICTS_MAX,
	type TeamPrMergeMethod,
	type TeamWorkDiffStat,
	type TeamWorkPrRefreshResponse,
} from "@shared/project-teams";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { narrators, projectTeams, teamWorkEvents, teamWorkItems } from "../../db/schema";
import { AppError, NotFoundError } from "../../lib/errors";
import { eventBus } from "../../lib/event-bus";
import { hotSafe } from "../../lib/hot-safe";
import type { Locale } from "../../lib/i18n";
import { logger } from "../../lib/logger";
import { oneLine } from "../../lib/prompts/team-coordinator-notes";
import {
	GhError,
	type GhRepo,
	ghPrChecks,
	ghPrCreate,
	ghPrList,
	ghPrMerge,
	ghPrView,
	isGhRepo,
} from "./team-gh";
import { assertNoReplacedHistory } from "./team-git";
import {
	gitVersion,
	supportsMergeTree,
	type TeamRepoGit,
	teamRepoGit,
	UnsafeRemoteConfigError,
} from "./team-git-write";
import {
	githubHostOf,
	hostingOf,
	type ProjectHosting,
	parseRemoteUrl,
	readOriginPushUrl,
} from "./team-hosting";
import {
	assertTipStill,
	type GithubJobFacts,
	type JobContext,
	jobFacts,
	MergeFailure,
	notify,
	outcomeAt,
	personOf,
	repositoryOf,
	setPhase,
} from "./team-merge";
import { isMerging } from "./team-merge-guard";
import {
	endPrRefreshing,
	forgetPrStatus,
	latestPrEvent,
	latestPullRequest,
	markPrRefreshing,
	type PrStatus,
	type PullRequestRecord,
	peekPrStatus,
	prStatusFresh,
	prStatusOf,
	storePrStatus,
	summarizeChecks,
} from "./team-pr-state";
import { baseBranchOf, fetchOnce, remoteTrackingRef } from "./team-work-start";
import { markMergedByPullRequest, recordWorkEvent } from "./work-items";

type GithubHosting = Extract<ProjectHosting, { kind: "github" }>;
type WorkItemRow = typeof teamWorkItems.$inferSelect;

/** The pull request body's budget (UTF-8 bytes). */
export const PR_BODY_MAX_BYTES = 16 * 1024;
const PR_TITLE_MAX = 200;
/** One quoted text (a review summary, a return reason) in the body. */
const PR_BODY_TEXT_MAX = 2_000;
/** Review and return events one body reads. */
const PR_BODY_ROUNDS_SCAN = 60;
/** Background reads: every minute, 20 items a pass, two gh processes at once. */
const POLL_INTERVAL_MS = 60_000;
const POLL_BATCH = 20;
const POLL_PROJECTS_MAX = 200;
const POLL_ITEMS_PER_PROJECT = 100;
const READS_AT_ONCE = 2;

const githubTarget = (hosting: GithubHosting): GhRepo => ({
	host: hosting.host,
	owner: hosting.owner,
	repo: hosting.repo,
});
const repositoryName = (target: GhRepo) => `${target.host}/${target.owner}/${target.repo}`;
const sameRepository = (a: GhRepo, b: GhRepo) =>
	a.host === b.host &&
	a.owner.toLowerCase() === b.owner.toLowerCase() &&
	a.repo.toLowerCase() === b.repo.toLowerCase();

// ── The body ────────────────────────────────────────────────────────────────

/**
 * Text that cannot mention anyone, reference or close an issue, or link anywhere on GitHub: `@`
 * and `#` become their full-width forms, `GH-<n>` loses its hyphen, `://` is broken by a word
 * joiner. Shown inside code blocks, which GitHub renders literally anyway.
 */
export function neutralizeForGithub(text: string): string {
	return text
		.replaceAll("@", "＠")
		.replaceAll("#", "＃")
		.replace(/\bGH-(?=\d)/gi, (match) => `${match.slice(0, 2)}‑`)
		.replaceAll("://", ":/⁠/");
}

/** A code fence longer than any backtick run in `text` (at least three). */
function fenceFor(text: string): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return "`".repeat(Math.max(3, longest + 1));
}

/** Untrusted text as a fenced code block, neutralised and cut. */
function quoted(text: string, max = PR_BODY_TEXT_MAX): string {
	const cut = text.length > max ? `${text.slice(0, max - 1)}…` : text;
	const body = neutralizeForGithub(cut.replace(/\r\n?/g, "\n")).trimEnd();
	const fence = fenceFor(body);
	return `${fence}text\n${body}\n${fence}`;
}

/** Untrusted text on one line as a code span, neutralised. */
function inline(text: string, max = 200): string {
	const body = neutralizeForGithub(oneLine(text, max));
	if (!body) return "``";
	const fence = fenceFor(body).slice(0, -2) || "`";
	const ticks = fence.length >= 1 && /`/.test(body) ? `${fence}\`` : "`";
	const pad = body.startsWith("`") || body.endsWith("`") ? " " : "";
	return `${ticks}${pad}${body}${pad}${ticks}`;
}

/** The pull request's title: the item's, on one line, neutralised. */
export function pullRequestTitle(title: string): string {
	return neutralizeForGithub(oneLine(title, PR_TITLE_MAX)) || "NarraFork work item";
}

export interface PullRequestRound {
	kind: "review" | "returned";
	round: number | null;
	verdict: string | null;
	findings: number | null;
	reviewer: string | null;
	text: string | null;
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * The pull request's body: who asked (「由 NarraFork 用户 X 发起」), the item and its branch, the
 * size, and the review rounds with their findings text and the reasons it was returned — newest
 * kept when they do not all fit — at most {@link PR_BODY_MAX_BYTES}. Every text someone wrote is
 * {@link quoted}.
 */
export function pullRequestBody(input: {
	locale: Locale;
	itemId: string;
	title: string;
	branch: string;
	base: string;
	by: string | null;
	diffStat: TeamWorkDiffStat | null;
	rounds: readonly PullRequestRound[];
}): string {
	const zh = input.locale === "zh-CN";
	const head: string[] = [];
	head.push(
		zh
			? `NarraFork 团队工作项 ${inline(input.title)}（\`${input.itemId}\`）：${inline(input.branch)} → ${inline(input.base)}`
			: `NarraFork team work item ${inline(input.title)} (\`${input.itemId}\`): ${inline(input.branch)} → ${inline(input.base)}`,
	);
	head.push(
		input.by
			? zh
				? `由 NarraFork 用户 ${inline(input.by, 80)} 发起。`
				: `Opened by NarraFork user ${inline(input.by, 80)}.`
			: zh
				? "由 NarraFork 发起。"
				: "Opened by NarraFork.",
	);
	const stat = input.diffStat;
	if (stat)
		head.push(
			zh
				? `**改动**：+${stat.added} −${stat.removed}，${stat.files} 个文件${stat.binaryFiles ? `（${stat.binaryFiles} 个二进制）` : ""}${stat.truncated ? "（统计不完整）" : ""}`
				: `**Size:** +${stat.added} −${stat.removed} in ${stat.files} file(s)${stat.binaryFiles ? ` (${stat.binaryFiles} binary)` : ""}${stat.truncated ? " (partial count)" : ""}`,
		);
	const footer = zh
		? "_这个 PR 由 NarraFork 推送并创建；评审与合并请在 NarraFork 团队页继续。_"
		: "_Pushed and opened by NarraFork; review and merge continue on the NarraFork team page._";
	const blocks = input.rounds.map((round) => {
		const label =
			round.kind === "returned"
				? zh
					? `- 第 ${round.round ?? "?"} 轮：成员退回`
					: `- Round ${round.round ?? "?"}: returned by a member`
				: zh
					? `- 第 ${round.round ?? "?"} 轮评审：${inline(round.verdict ?? "?", 40)}${round.reviewer ? `，评审者 ${inline(round.reviewer, 80)}` : ""}${round.findings !== null ? `，${round.findings} 条发现` : ""}`
					: `- Review round ${round.round ?? "?"}: ${inline(round.verdict ?? "?", 40)}${round.reviewer ? `, reviewer ${inline(round.reviewer, 80)}` : ""}${round.findings !== null ? `, ${round.findings} finding(s)` : ""}`;
		return round.text ? `${label}\n\n${quoted(round.text)}` : label;
	});
	const heading = zh ? "**评审轮次**" : "**Review rounds**";
	const omitted = zh ? "_更早的轮次没有列出。_" : "_Earlier rounds are left out._";
	const fixed = [...head, footer].join("\n\n");
	let budget = PR_BODY_MAX_BYTES - bytes(fixed) - bytes(heading) - bytes(omitted) - 16;
	const kept: string[] = [];
	for (let index = blocks.length - 1; index >= 0; index--) {
		const block = blocks[index] ?? "";
		const size = bytes(block) + 2;
		if (size > budget) break;
		budget -= size;
		kept.unshift(block);
	}
	const parts = [...head];
	if (kept.length > 0 || blocks.length > 0) {
		parts.push(heading);
		if (kept.length < blocks.length) parts.push(omitted);
		parts.push(...kept);
	}
	parts.push(footer);
	const body = parts.join("\n\n");
	// Built to fit; a last guard all the same (never cuts inside a fence: the rounds are whole).
	return bytes(body) <= PR_BODY_MAX_BYTES ? body : [...head, footer].join("\n\n");
}

const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The review rounds and returns of an item, oldest first (bounded). */
function roundsOf(itemId: string): PullRequestRound[] {
	const rows = db
		.select({ kind: teamWorkEvents.kind, detail: teamWorkEvents.detailJson })
		.from(teamWorkEvents)
		.where(
			and(
				eq(teamWorkEvents.workItemId, itemId),
				inArray(teamWorkEvents.kind, ["work.review", "work.returned"]),
			),
		)
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(PR_BODY_ROUNDS_SCAN)
		.all()
		.reverse();
	return rows.map((row) => {
		const detail = row.detail ?? {};
		return row.kind === "work.returned"
			? {
					kind: "returned" as const,
					round: num(detail.round),
					verdict: "blocker",
					findings: null,
					reviewer: null,
					text: str(detail.reason),
				}
			: {
					kind: "review" as const,
					round: num(detail.round),
					verdict: str(detail.verdict),
					findings: num(detail.findings),
					reviewer: str(detail.reviewer),
					text: str(detail.summary),
				};
	});
}

/** The size the newest `work.ready` recorded. */
function readyDiffStat(itemId: string): TeamWorkDiffStat | null {
	const detail = db
		.select({ detail: teamWorkEvents.detailJson })
		.from(teamWorkEvents)
		.where(and(eq(teamWorkEvents.workItemId, itemId), eq(teamWorkEvents.kind, "work.ready")))
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(1)
		.get()?.detail;
	const stat = detail?.diffStat as Partial<TeamWorkDiffStat> | null | undefined;
	if (!stat || typeof stat !== "object") return null;
	const added = num(stat.added);
	const removed = num(stat.removed);
	const files = num(stat.files);
	if (added === null || removed === null || files === null) return null;
	return {
		added,
		removed,
		files,
		binaryFiles: num(stat.binaryFiles) ?? 0,
		truncated: stat.truncated === true,
	};
}

// ── Pushing and opening ─────────────────────────────────────────────────────

/**
 * Origin's push URL now, which must name exactly the repository gh works on (the pull request
 * is opened there, so the branch must be pushed there).
 */
async function pushUrlFor(repo: string, target: GhRepo): Promise<string> {
	const url = await readOriginPushUrl(repo).catch(() => null);
	const location = url ? parseRemoteUrl(url) : null;
	const host = location ? (githubHostOf(location.host) ?? location.host) : null;
	if (!url || !location || !host || !sameRepository({ ...location, host }, target))
		throw new MergeFailure(
			"TEAM_PR_REMOTE_CHANGED",
			`origin no longer pushes to ${repositoryName(target)}; nothing was pushed. Try again once its hosting is read again`,
		);
	return url;
}

const ghFailure = (code: string, error: unknown) =>
	new MergeFailure(
		code,
		error instanceof GhError || error instanceof Error ? error.message : String(error),
	);

/**
 * 「发起 PR」 / 「更新 PR」: push the pinned head, then reuse the open pull request or open one.
 * `facts` when the merge job already read them (origin turned out to be on GitHub).
 */
export async function runPullRequest(
	context: JobContext,
	signal: AbortSignal,
	given?: GithubJobFacts,
): Promise<void> {
	setPhase(context.itemId, "checking");
	const facts = given ?? (await githubFacts(context, signal));
	const { item, head, branch, base, git, repo, hosting } = facts;
	const target = githubTarget(hosting);
	const prBase = baseBranchOf(base).branch;
	// Only the real, full history is pushed (nothing grafted, shallow or replaced).
	await git.assertTrueHistory();
	await assertNoReplacedHistory(repo, [head]);
	const url = await pushUrlFor(repo, target);
	signal.throwIfAborted();
	setPhase(context.itemId, "pushing");
	await assertTipStill(git, branch, head);
	const pushed = await git.pushBranch({ url, head, branch }).catch((error: unknown) => {
		if (error instanceof UnsafeRemoteConfigError)
			throw new MergeFailure("TEAM_REMOTE_CONFIG_UNSAFE", error.message);
		throw error;
	});
	if (pushed.outcome === "rejected")
		throw new MergeFailure(
			"TEAM_PR_PUSH_REJECTED",
			`GitHub refused ${branch}: it has commits the ready head does not (${pushed.message}); nothing was forced. Return the item so its worker brings them in`,
			{ branch },
		);
	if (pushed.outcome === "failed")
		throw new MergeFailure(
			"TEAM_PR_PUSH_FAILED",
			`The push of ${branch} failed: ${pushed.message}`,
		);
	if (pushed.outcome === "pushed")
		recordWorkEvent(db, {
			teamId: context.teamId,
			workItemId: item.id,
			kind: "work.pr_pushed",
			actor: { kind: "person", id: context.userId },
			detail: { head, branch, repository: repositoryName(target) },
			at: outcomeAt(context),
		});
	signal.throwIfAborted();
	setPhase(context.itemId, "opening");
	const found = await ghPrList(target, branch, signal).catch((error: unknown) => {
		throw ghFailure("TEAM_PR_OPEN_FAILED", error);
	});
	const open = found.find((entry) => entry.state === "OPEN");
	const recorded = latestPullRequest(item.id);
	if (!open) {
		// Merged on GitHub at this very head already: nothing to open.
		const merged = found.find((entry) => entry.state === "MERGED" && entry.headRefOid === head);
		if (merged) {
			recordOpened(context, item.id, target, merged, prBase, head, recorded, false);
			const view = await ghPrView(target, merged.number, signal).catch(() => null);
			await landed({
				item,
				teamId: context.teamId,
				projectId: context.projectId,
				repo,
				base,
				record: { ...target, number: merged.number, url: merged.url, base: prBase, head },
				mergeCommit: view?.mergeCommit?.oid ?? null,
				headMatches: true,
				method: null,
				// Found merged (by someone on GitHub), not merged by this person: the system's.
				userId: null,
			});
			return;
		}
	}
	if (open && open.baseRefName !== prBase)
		throw new MergeFailure(
			"TEAM_PR_BASE_MISMATCH",
			`Pull request #${open.number} for ${branch} targets ${open.baseRefName}, not ${prBase}; retarget or close it on GitHub (${open.url})`,
		);
	let opened: { number: number; url: string };
	if (open) opened = { number: open.number, url: open.url };
	else {
		const person = await personOf(context.userId);
		opened = await ghPrCreate(
			target,
			{
				head: branch,
				base: prBase,
				title: pullRequestTitle(item.title),
				body: pullRequestBody({
					locale: person.locale,
					itemId: item.id,
					title: item.title,
					branch,
					base: prBase,
					by: person.name,
					diffStat: readyDiffStat(item.id),
					rounds: roundsOf(item.id),
				}),
			},
			signal,
		).catch((error: unknown) => {
			throw ghFailure("TEAM_PR_OPEN_FAILED", error);
		});
	}
	recordOpened(context, item.id, target, opened, prBase, head, recorded, !open);
	forgetPrStatus(item.id);
	// Its state right away (best effort; the drawer and the background pass read it again).
	const record = latestPullRequest(item.id);
	if (record) await readPullRequest(target, record, item.id, signal).catch(() => null);
}

/** `work.pr_opened`, unless that pull request is the one recorded already. */
function recordOpened(
	context: JobContext,
	itemId: string,
	target: GhRepo,
	pr: { number: number; url: string },
	base: string,
	head: string,
	recorded: PullRequestRecord | null,
	created: boolean,
): void {
	if (
		!created &&
		recorded?.number === pr.number &&
		sameRepository(recorded, target) &&
		recorded.url === pr.url
	)
		return;
	recordWorkEvent(db, {
		teamId: context.teamId,
		workItemId: itemId,
		kind: "work.pr_opened",
		actor: { kind: "person", id: context.userId },
		detail: {
			pr: pr.number,
			url: pr.url,
			repository: repositoryName(target),
			base,
			head,
			created,
		},
		at: outcomeAt(context),
	});
}

async function githubFacts(context: JobContext, signal: AbortSignal): Promise<GithubJobFacts> {
	const facts = await jobFacts(context, signal);
	if (facts.hosting.kind !== "github")
		throw new MergeFailure(
			"TEAM_PR_NOT_GITHUB",
			"Origin is not on GitHub (any more): there is no pull request flow",
		);
	return facts as GithubJobFacts;
}

// ── Merging ─────────────────────────────────────────────────────────────────

const MERGEABLE = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/** 「合并 PR」: read it again, refuse with the reason, or merge it at the ready head. */
export async function runPrMerge(context: JobContext, signal: AbortSignal): Promise<void> {
	setPhase(context.itemId, "checking");
	const facts = await githubFacts(context, signal);
	const { item, head, branch, base, git, repo, hosting } = facts;
	const target = githubTarget(hosting);
	const record = latestPullRequest(item.id);
	if (!record)
		throw new MergeFailure("TEAM_PR_NONE", "The item has no pull request yet: open one first");
	if (!sameRepository(record, target))
		throw new MergeFailure(
			"TEAM_PR_REMOTE_CHANGED",
			`The pull request is on ${repositoryName(record)}, but origin is ${repositoryName(target)} now; open it again`,
		);
	const methods = hosting.gh?.ok ? hosting.gh.methods : [];
	const method = context.method ?? methods[0];
	if (!method || !methods.includes(method))
		throw new MergeFailure(
			"TEAM_PR_METHOD_NOT_ALLOWED",
			`The repository does not allow ${method ?? "any"} merges`,
		);
	const status = await readPullRequest(target, record, item.id, signal).catch((error: unknown) => {
		throw ghFailure("TEAM_PR_GH_UNAVAILABLE", error);
	});
	const landedInput = {
		item,
		teamId: context.teamId,
		projectId: context.projectId,
		repo,
		base,
		record,
		userId: context.userId,
	};
	if (status.state === "MERGED") {
		await landed({
			...landedInput,
			mergeCommit: status.mergeCommit,
			headMatches: status.headSha === head,
			method: null,
		});
		return;
	}
	const link = ` (${record.url})`;
	if (status.state === "CLOSED")
		throw new MergeFailure(
			"TEAM_PR_CLOSED",
			`Pull request #${record.number} was closed${link}; open it again`,
		);
	if (status.headSha !== head)
		throw new MergeFailure(
			"TEAM_PR_HEAD_STALE",
			`Pull request #${record.number} carries ${status.headSha?.slice(0, 12) ?? "another head"}, not the ready head ${head.slice(0, 12)}; update it first${link}`,
		);
	if (status.isDraft || status.mergeState === "DRAFT")
		throw new MergeFailure("TEAM_PR_DRAFT", `Pull request #${record.number} is a draft${link}`);
	if (status.mergeState === "DIRTY") {
		await recordConflict({
			teamId: context.teamId,
			item,
			record,
			repo,
			git,
			base,
			head,
			branch,
			actor: { kind: "person", id: context.userId },
			at: outcomeAt(context),
			userId: context.userId,
			always: true,
		});
		return;
	}
	if (status.mergeState === "BLOCKED")
		throw new MergeFailure(
			"TEAM_PR_BLOCKED",
			`GitHub blocks pull request #${record.number}: a review, required checks or branch protection${link}`,
		);
	if (status.mergeState === "BEHIND")
		throw new MergeFailure(
			"TEAM_PR_BEHIND",
			`Pull request #${record.number} is behind ${baseBranchOf(base).branch}: bring the base in first${link}`,
		);
	if (!status.mergeState || !MERGEABLE.has(status.mergeState))
		throw new MergeFailure(
			"TEAM_PR_STATE_UNKNOWN",
			`GitHub has not worked out whether pull request #${record.number} can merge; try again shortly${link}`,
		);
	setPhase(context.itemId, "merging");
	await assertTipStill(git, branch, head);
	signal.throwIfAborted();
	try {
		await ghPrMerge(target, { pr: record.number, method, head }, signal);
	} catch (error) {
		if (signal.aborted) throw error;
		const message = error instanceof Error ? error.message : String(error);
		if (/head branch was modified|head commit|match-head-commit|expected head/i.test(message))
			throw new MergeFailure(
				"TEAM_PR_HEAD_STALE",
				`Pull request #${record.number} moved on GitHub; nothing was merged: ${message}`,
			);
		throw new MergeFailure(
			"TEAM_PR_MERGE_FAILED",
			`gh could not merge #${record.number}: ${message}`,
		);
	}
	const after = await readPullRequest(target, record, item.id, signal).catch(() => null);
	if (after?.state === "MERGED") {
		await landed({
			...landedInput,
			mergeCommit: after.mergeCommit,
			headMatches: after.headSha === head,
			method,
		});
		return;
	}
	// Accepted, not merged: a merge queue (or auto-merge) holds it. The background pass sees it land.
	recordWorkEvent(db, {
		teamId: context.teamId,
		workItemId: item.id,
		kind: "work.pr_queued",
		actor: { kind: "person", id: context.userId },
		detail: { pr: record.number, url: record.url, method, head },
		at: outcomeAt(context),
	});
}

/**
 * GitHub says the pull request conflicts with its base: list the files from a local merge of the
 * head into `origin/<base>` (fetched first, best effort; hardened like every team merge), record
 * `work.merge_failed {code: "conflict"}` once per pull request and head, and tell the coordinator.
 */
async function recordConflict(input: {
	teamId: string;
	item: WorkItemRow;
	record: PullRequestRecord;
	repo: string;
	git: TeamRepoGit;
	base: string;
	head: string;
	branch: string;
	actor: { kind: "person" | "system"; id: string | null };
	at: string;
	userId: string | null;
	/** A member's 「合并 PR」: recorded even when this conflict was already (it answers the click). */
	always?: boolean;
}): Promise<void> {
	const latest = db
		.select({ detail: teamWorkEvents.detailJson })
		.from(teamWorkEvents)
		.where(
			and(
				eq(teamWorkEvents.workItemId, input.item.id),
				eq(teamWorkEvents.kind, "work.merge_failed"),
			),
		)
		.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
		.limit(1)
		.get()?.detail;
	const already =
		latest?.code === "conflict" && latest.pr === input.record.number && latest.head === input.head;
	const branchName = baseBranchOf(input.base).branch;
	const listed = await conflictingFiles(input.repo, input.git, branchName, input.head);
	if (!already || input.always)
		recordWorkEvent(db, {
			teamId: input.teamId,
			workItemId: input.item.id,
			kind: "work.merge_failed",
			actor: input.actor,
			detail: {
				code: "conflict",
				message: `Pull request #${input.record.number} conflicts with ${branchName} (${input.record.url})`,
				job: "pr_merge",
				pr: input.record.number,
				url: input.record.url,
				conflicts: listed?.conflicts ?? [],
				more: listed ? listed.more : true,
				base: branchName,
				head: input.head,
			},
			at: input.at,
		});
	eventBus.emit({ type: "team:communication_changed", teamId: input.teamId });
	if (already) return;
	const { pullRequestConflictNote } = await import("../../lib/prompts/team-lead");
	await notify(
		{ itemId: input.item.id, teamId: input.teamId, projectId: "", userId: input.userId },
		(locale, by) =>
			pullRequestConflictNote(locale, {
				itemId: input.item.id,
				title: input.item.title,
				branch: input.branch,
				base: branchName,
				by,
				pr: input.record.number,
				url: input.record.url,
				conflicts: listed?.conflicts ?? [],
				more: listed ? listed.more : true,
			}),
	);
}

/** The files the head conflicts with in `origin/<base>` (a hardened `merge-tree`); null unknown. */
async function conflictingFiles(
	repo: string,
	git: TeamRepoGit,
	branch: string,
	head: string,
): Promise<{ conflicts: string[]; more: boolean } | null> {
	try {
		await fetchOnce(repo, branch, () =>
			git.fetchBaseFromOrigin(branch).catch((error: unknown) => ({
				ok: false as const,
				message: error instanceof Error ? error.message : String(error),
			})),
		);
		if (!supportsMergeTree(await gitVersion())) return null;
		const base = await git.resolve(remoteTrackingRef(branch));
		if (!base) return null;
		await assertNoReplacedHistory(repo, [base, head]);
		const merged = await git.mergeTree(base, head);
		return merged.clean
			? { conflicts: [], more: true }
			: { conflicts: merged.conflicts.slice(0, TEAM_MERGE_CONFLICTS_MAX), more: merged.more };
	} catch (error) {
		logger.debug("Conflicting files of a pull request could not be listed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

// ── Merged ──────────────────────────────────────────────────────────────────

/**
 * The pull request is merged: record it (the one writer, in a transaction), fetch
 * `origin/<base>` into its remote-tracking ref (best effort; never the local branch or a working
 * tree), reconcile queued dependents, and tell the coordinator — only when this call recorded it.
 */
async function landed(input: {
	item: WorkItemRow;
	teamId: string;
	projectId: string;
	repo: string;
	base: string;
	record: PullRequestRecord;
	mergeCommit: string | null;
	headMatches: boolean;
	method: TeamPrMergeMethod | null;
	/** The member who merged it from the team page; null when found merged by a read. */
	userId: string | null;
}): Promise<boolean> {
	const { item } = input;
	if (!item.headSha) return false;
	const branch = baseBranchOf(input.base).branch;
	const merged = markMergedByPullRequest({
		itemId: item.id,
		head: item.headSha,
		expectedUpdatedAt: item.updatedAt,
		actor: input.userId ? { kind: "person", id: input.userId } : { kind: "system", id: null },
		pr: input.record.number,
		url: input.record.url,
		mergeCommit: input.mergeCommit,
		method: input.method,
		headMatches: input.headMatches,
		baseBranch: branch,
	});
	if (!merged) return false;
	forgetPrStatus(item.id);
	afterMerge(input.projectId, input.repo, branch);
	const { pullRequestMergedNote } = await import("../../lib/prompts/team-lead");
	const requester = input.userId ?? lastRequester(item.id);
	await notify(
		{ itemId: item.id, teamId: input.teamId, projectId: input.projectId, userId: requester },
		(locale, by) =>
			pullRequestMergedNote(locale, {
				itemId: item.id,
				title: item.title,
				branch: item.branchName,
				base: branch,
				by: input.userId ? by : null,
				pr: input.record.number,
				url: input.record.url,
				method: input.method,
			}),
	);
	return true;
}

/** Fetch origin's base (remote-tracking ref only), then look at queued dependents again. */
function afterMerge(projectId: string, repo: string, branch: string): void {
	const git = teamRepoGit(repo);
	const work = fetchOnce(repo, branch, () =>
		git.fetchBaseFromOrigin(branch).catch((error: unknown) => ({
			ok: false as const,
			message: error instanceof Error ? error.message : String(error),
		})),
	)
		.then(async (fetched) => {
			if (!fetched.ok)
				logger.debug("origin's base was not fetched after a pull request merged", {
					projectId,
					error: fetched.message,
				});
			const { reconcileUnblocks } = await import("./work-item-dependencies");
			await reconcileUnblocks({ projectId });
		})
		.catch((error: unknown) =>
			logger.warn("After a pull request merged, dependents were not reconciled", {
				projectId,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	state.afterMerge.add(work);
	void work.finally(() => state.afterMerge.delete(work));
}

/** Who asked for the newest merge job of an item (for a note when GitHub merged it later). */
function lastRequester(itemId: string): string | null {
	return (
		db
			.select({ actorId: teamWorkEvents.actorId })
			.from(teamWorkEvents)
			.where(
				and(eq(teamWorkEvents.workItemId, itemId), eq(teamWorkEvents.kind, "work.merge_requested")),
			)
			.orderBy(desc(teamWorkEvents.createdAt), desc(teamWorkEvents.id))
			.limit(1)
			.get()?.actorId ?? null
	);
}

// ── Reading a pull request ──────────────────────────────────────────────────

const state = hotSafe("narrafork.teams.prReads", () => ({
	active: 0,
	waiting: [] as Array<() => void>,
	pending: new Map<string, Promise<PrStatus | null>>(),
	afterMerge: new Set<Promise<void>>(),
	cursor: "",
}));

/** Run `read` when one of the {@link READS_AT_ONCE} read slots is free. */
async function withReadSlot<T>(read: () => Promise<T>): Promise<T> {
	if (state.active >= READS_AT_ONCE)
		await new Promise<void>((resolve) => state.waiting.push(resolve));
	state.active++;
	try {
		return await read();
	} finally {
		state.active--;
		state.waiting.shift()?.();
	}
}

/** `gh pr view` and, while open, `gh pr checks` (one read slot), stored in the cache. */
async function readPullRequest(
	target: GhRepo,
	record: PullRequestRecord,
	itemId: string,
	signal?: AbortSignal,
): Promise<PrStatus> {
	return withReadSlot(async () => {
		const view = await ghPrView(target, record.number, signal);
		const checks =
			view.state === "OPEN"
				? await ghPrChecks(target, record.number, signal)
						.then(summarizeChecks)
						.catch(() => null)
				: null;
		const status = prStatusOf(view, record.number, checks);
		storePrStatus(itemId, record.number, { status });
		return status;
	});
}

/**
 * Read an item's pull request (not when read in the last 20 s unless `force`), store it, and act
 * on what changed: merged → recorded; closed → `work.pr_closed`; checks or review → `work.pr_checks`
 * (the coordinator told when it needs the worker); conflicts → recorded with the files. One read
 * per item at a time; nothing while a merge job holds the item. Never throws.
 */
export function refreshPullRequest(
	itemId: string,
	options: { force?: boolean } = {},
): Promise<PrStatus | null> {
	const running = state.pending.get(itemId);
	if (running) return running;
	const work = refreshNow(itemId, options).catch((error: unknown) => {
		logger.debug("A pull request could not be read", {
			workItemId: itemId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	});
	state.pending.set(itemId, work);
	void work.finally(() => {
		state.pending.delete(itemId);
		// Whatever the read found, or when it read nothing at all, it is not running any more.
		endPrRefreshing(itemId);
	});
	return work;
}

async function refreshNow(itemId: string, options: { force?: boolean }): Promise<PrStatus | null> {
	if (isMerging(itemId)) return null;
	const facts = itemFacts(itemId);
	if (!facts) return null;
	const record = latestPullRequest(itemId);
	if (!record) return null;
	if (!options.force && prStatusFresh(itemId, record.number))
		return peekPrStatus(itemId, record.number)?.status ?? null;
	const repo = repositoryOf(facts.item.projectId);
	if (!repo) return null;
	const hosting = await hostingOf(repo);
	if (hosting.kind !== "github" || !hosting.gh?.ok) return null;
	const target = githubTarget(hosting);
	if (!isGhRepo(record) || !sameRepository(record, target)) {
		storePrStatus(itemId, record.number, {
			error: `origin is ${repositoryName(target)} now, not ${repositoryName(record)}`,
		});
		return null;
	}
	markPrRefreshing(itemId, record.number, true);
	eventBus.emit({ type: "team:communication_changed", teamId: facts.item.teamId });
	let status: PrStatus;
	try {
		status = await readPullRequest(target, record, itemId);
	} catch (error) {
		storePrStatus(itemId, record.number, {
			error: error instanceof Error ? error.message : String(error),
		});
		eventBus.emit({ type: "team:communication_changed", teamId: facts.item.teamId });
		return null;
	}
	// A job took the item meanwhile: it acts on what it reads itself.
	if (!isMerging(itemId)) await applyTransitions(facts, record, status, repo);
	eventBus.emit({ type: "team:communication_changed", teamId: facts.item.teamId });
	return status;
}

/** A ready item of an active team, or null. */
function itemFacts(itemId: string) {
	const row = db
		.select({ item: teamWorkItems, baseBranch: projectTeams.baseBranch, team: projectTeams.status })
		.from(teamWorkItems)
		.innerJoin(projectTeams, eq(projectTeams.narratorId, teamWorkItems.teamId))
		.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
		.where(eq(teamWorkItems.id, itemId))
		.limit(1)
		.get();
	if (!row || row.item.state !== "ready" || row.team !== "active" || !row.item.headSha) return null;
	return { item: row.item, base: row.item.baseRef ?? row.baseBranch };
}

async function applyTransitions(
	facts: { item: WorkItemRow; base: string },
	record: PullRequestRecord,
	status: PrStatus,
	repo: string,
): Promise<void> {
	const { item } = facts;
	const head = item.headSha;
	if (!head) return;
	if (status.state === "MERGED") {
		await landed({
			item,
			teamId: item.teamId,
			projectId: item.projectId,
			repo,
			base: facts.base,
			record,
			mergeCommit: status.mergeCommit,
			headMatches: status.headSha === head,
			method: null,
			userId: null,
		});
		return;
	}
	const now = new Date().toISOString();
	if (status.state === "CLOSED") {
		if (!latestPrEvent(item.id, "work.pr_closed", record.number))
			recordWorkEvent(db, {
				teamId: item.teamId,
				workItemId: item.id,
				kind: "work.pr_closed",
				actor: { kind: "system", id: null },
				detail: { pr: record.number, url: record.url },
				at: now,
			});
		return;
	}
	// Open, and carrying the ready head: only its own checks and review matter.
	if (status.headSha !== head) return;
	if (status.mergeState === "DIRTY") {
		await recordConflict({
			teamId: item.teamId,
			item,
			record,
			repo,
			git: teamRepoGit(repo),
			base: facts.base,
			head,
			branch: item.branchName ?? "",
			actor: { kind: "system", id: null },
			at: now,
			userId: lastRequester(item.id),
		});
		return;
	}
	const checks = status.checks?.state;
	const last = latestPrEvent(item.id, "work.pr_checks", record.number);
	const sameHead = last?.head === head;
	const lastChecks = sameHead ? str(last?.checks) : null;
	const lastReview = sameHead ? str(last?.review) : null;
	const checksTurned = (checks === "failing" || checks === "passing") && checks !== lastChecks;
	const reviewTurned =
		(status.review === "CHANGES_REQUESTED" || status.review === "APPROVED") &&
		status.review !== lastReview;
	if (!checksTurned && !reviewTurned) return;
	recordWorkEvent(db, {
		teamId: item.teamId,
		workItemId: item.id,
		kind: "work.pr_checks",
		actor: { kind: "system", id: null },
		detail: {
			pr: record.number,
			url: record.url,
			head,
			checks: checksTurned ? checks : lastChecks,
			review: status.review,
			failed: status.checks?.fail ?? 0,
			failures: (status.checks?.failures ?? []).map((failure) => failure.name),
		},
		at: now,
	});
	const failing = checksTurned && checks === "failing";
	const changesRequested = reviewTurned && status.review === "CHANGES_REQUESTED";
	if (!failing && !changesRequested) return;
	const { pullRequestBlockedNote } = await import("../../lib/prompts/team-lead");
	await notify(
		{
			itemId: item.id,
			teamId: item.teamId,
			projectId: item.projectId,
			userId: lastRequester(item.id),
		},
		(locale) =>
			pullRequestBlockedNote(locale, {
				itemId: item.id,
				title: item.title,
				branch: item.branchName,
				base: baseBranchOf(facts.base).branch,
				by: null,
				pr: record.number,
				url: record.url,
				failures: failing ? (status.checks?.failures ?? []).map((failure) => failure.name) : [],
				changesRequested,
			}),
	);
}

/**
 * The drawer opened (`POST …/work/:itemId/pr/refresh`, members): read the pull request unless it
 * was read in the last 20 s. Answers at once; the drawer polls while `refreshing`.
 */
export function requestPrRefresh(input: {
	teamId: string;
	itemId: string;
}): TeamWorkPrRefreshResponse {
	// Only a read: allowed while the worker runs, refused for anything not ready.
	const item = db
		.select({ id: teamWorkItems.id, state: teamWorkItems.state })
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.id, input.itemId), eq(teamWorkItems.teamId, input.teamId)))
		.limit(1)
		.get();
	if (!item) throw new NotFoundError("Work item", input.itemId);
	if (item.state !== "ready")
		throw new AppError(
			`Work item ${item.id} is ${item.state}; only a ready item's pull request is read`,
			409,
			"TEAM_WORK_ITEM_NOT_READY",
		);
	const record = latestPullRequest(item.id);
	if (!record)
		throw new AppError(`Work item ${item.id} has no pull request to read`, 409, "TEAM_PR_NONE");
	if (prStatusFresh(item.id, record.number)) return { itemId: item.id, refreshing: false };
	// Marked before the answer, so the drawer's next read already polls.
	markPrRefreshing(item.id, record.number, true);
	void refreshPullRequest(item.id);
	return { itemId: item.id, refreshing: true };
}

// ── The background pass ─────────────────────────────────────────────────────

/** The ready items of active teams that have a pull request, in id order (bounded). */
function itemsWithPullRequests(): string[] {
	const projects = db
		.selectDistinct({ projectId: projectTeams.projectId })
		.from(projectTeams)
		.where(eq(projectTeams.status, "active"))
		.limit(POLL_PROJECTS_MAX)
		.all();
	const ids: string[] = [];
	for (const project of projects) {
		const ready = db
			.select({ id: teamWorkItems.id })
			.from(teamWorkItems)
			.where(and(eq(teamWorkItems.projectId, project.projectId), eq(teamWorkItems.state, "ready")))
			.orderBy(asc(teamWorkItems.id))
			.limit(POLL_ITEMS_PER_PROJECT)
			.all()
			.map((row) => row.id);
		if (ready.length === 0) continue;
		for (const row of db
			.selectDistinct({ id: teamWorkEvents.workItemId })
			.from(teamWorkEvents)
			.where(
				and(inArray(teamWorkEvents.workItemId, ready), eq(teamWorkEvents.kind, "work.pr_opened")),
			)
			.limit(ready.length)
			.all())
			if (row.id) ids.push(row.id);
	}
	return ids.sort();
}

/**
 * One background pass: read the next {@link POLL_BATCH} ready items with a pull request (after the
 * last one read, wrapping round), at most two at once. Returns how many were read.
 */
export async function runPrPollPass(): Promise<number> {
	const all = itemsWithPullRequests();
	if (all.length === 0) {
		state.cursor = "";
		return 0;
	}
	let batch = all.filter((id) => id > state.cursor).slice(0, POLL_BATCH);
	if (batch.length < POLL_BATCH)
		batch = [
			...batch,
			...all.filter((id) => !batch.includes(id)).slice(0, POLL_BATCH - batch.length),
		];
	state.cursor = batch.at(-1) ?? "";
	await Promise.all(batch.map((id) => refreshPullRequest(id)));
	return batch.length;
}

/** Wait for every read and post-merge fetch (tests and shutdown). */
export async function settlePullRequestWork(): Promise<void> {
	while (state.pending.size > 0 || state.afterMerge.size > 0)
		await Promise.allSettled([...state.pending.values(), ...state.afterMerge]);
}

export function resetPullRequestWorkForTests(): void {
	state.cursor = "";
	state.pending.clear();
	state.afterMerge.clear();
}

/** Startup: the background pass every minute. Returns the stop function. */
export function startTeamPrPoller(): () => Promise<void> {
	let stopped = false;
	let current: Promise<unknown> = Promise.resolve();
	let timer: ReturnType<typeof setTimeout> | null = null;
	const tick = () => {
		if (stopped) return;
		current = runPrPollPass()
			.catch((error) =>
				logger.warn("Team pull requests were not read", {
					error: error instanceof Error ? error.message : String(error),
				}),
			)
			.finally(() => {
				if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
			});
	};
	timer = setTimeout(tick, POLL_INTERVAL_MS);
	return async () => {
		stopped = true;
		if (timer) clearTimeout(timer);
		await current;
		await settlePullRequestWork();
	};
}
