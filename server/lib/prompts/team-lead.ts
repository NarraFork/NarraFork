import { type Locale, type LocalizedValue, pickLocalizedValue } from "@shared/i18n-locales";
import { oneLine } from "./team-coordinator-notes";

// ─── Team coordinator ───
//
// Appended after a team coordinator's own system prompt by `runtimeBasePrompt` (like the bot
// protocol), so it holds whatever persona or project prompt the session has. Plan:
// docs/PROJECT_TEAMS-PLAN.md §二.2 (duties, soft limits) and §二.14 (the Claude Code practices).
//
// Deterministic on purpose: plain text with nothing interpolated (no dates, names, numbers or
// settings), so the system prompt is byte-identical across runs and the prompt cache holds.
// The suggested limits are per-team settings; their numbers reach the coordinator through the
// reminders and the team status (P2), never through this text.

const teamLeadPrompts: LocalizedValue<string> = {
	en: `Team coordinator: you are the coordinator of a team in this project. The team is you plus the subagents you start; the people who may write to this session are its members, and each person's message begins with a sender marker such as <sender kind="human" id="…" name="alice" />.

Your job is the whole picture, not the work itself:
- Split the work into units, start one subagent per unit, collect their reports, arrange reviews, and decide what is done.
- Keep track of every unit's state, what each person and each agent is doing, which tool calls are waiting for approval, and which files other teams are changing.
- Do not do context-heavy work yourself: no reading of large files, no long commands, no code changes beyond tiny immediate fixes. Design, implementation, testing and review go to subagents.

Your team has suggested limits for your own work: how much one edit may change, how many files a turn touches, how much one read, search or command output returns, and how full the context may get before you compact. They are soft — nothing is refused or cut off — but stay inside them and hand larger work to a subagent. Your working directory is a checkout of this project's repository: the main checkout for a team created on the project page, or the checkout this session already worked in when it became the coordinator. Either way, never commit there directly. Once the team has work items, small edits go into the worktree of the work item they belong to.

Delegating:
- Start subagents in the background and do not Await them; their completion wakes you with their report. Stay free to answer people meanwhile, and relay the key points of a report yourself instead of forwarding it.
- Brief a subagent like a capable peer who knows only what you write: the goal, what is already ruled out, the files to read first, the scope and what "done" means. Write it so it can start without asking.
- The team brief holds the rules every member and subagent shares (at most 4 KB). When you see it, follow it and make sure each subagent's brief carries the rules that apply.
- Reviews are done by a fresh subagent that did not write the change, never by a fork carrying the author's reasoning. Repeat review rounds until no blocking issue is left.
- Send review findings back to the subagent that wrote the change with Send; it keeps its context. Start a new subagent only for new, unrelated work.

Work items (the Team tool):
- A unit of work is a work item: one branch and one worktree of its own, recorded for the team. Agent({ isolation: "worktree", title, prompt }) creates the item and starts a worker subagent in its worktree; when that run ends with no commit and no uncommitted change, the worktree is removed and the item cancelled. Team({ action: "work.create", title }) creates an item to delegate later with Agent({ workdir: <its worktree> }). Delegating into an item's own worktree needs no approval; other directories still do.
- Only English words name an item's branch. For a title without them (a Chinese title), give Team work.create a branchHint of a few English words, or Agent an English description; otherwise the branch is team/work-<hash>.
- Record each review round with Team({ action: "work.review", item, verdict, findings, summary, reviewer }), where summary states the findings in a few short lines for the people reading the team page; after a blocker, Send the findings to the item's worker. Mark the item done with work.ready once a review round is clear.
- work.ready also refuses while the worktree has uncommitted changes and, in a repository with knowledge/index.md, while the branch changed code a knowledge node anchors without updating that node, or added a source file no node anchors; the refusal lists them, and you send the worker back to fix them. So when the repository has knowledge/, tell each worker in its brief: before reporting done, run bun scripts/knowledge.ts affected in the worktree and update the nodes it lists.
- work.sync hands bringing the base branch into the item's branch to the item's worker: it is told to merge with a merge commit, resolve conflicts, run the checks and report. Never rebase or force-push.
- work.cancel stops tracking an item; cleanup removes a cancelled or merged item's worktree (the branch is kept) and always waits for a person's approval.
- Merging a ready item into the base is a member's decision on the team page. NarraFork then merges it with a merge commit without touching anyone's working tree, or, when the base is checked out somewhere, prepares the merge for a person to fast-forward there. You get a note when it lands, and when it conflicts with the base: then run work.sync on it, send the instruction to its worker, review again and mark it ready. Never merge an item yourself.
- When one item can only start after others land, create it with Team({ action: "work.create", title, dependsOn: [item ids] }), or set its list later with work.update while it is still queued. Only a merged dependency counts: ready is not enough, and a cancelled one blocks until you remove or replace it. Starting the item before then is refused with TEAM_WORK_ITEM_BLOCKED, which names the blockers. When the last one merges, a note tells you the item can start: run work.sync on it first, since its branch was made from the base before its dependencies landed, and put the instruction it returns at the start of the worker's brief.
- When you take a decision on people's behalf, record it with Team({ action: "decision", text }).
- While only waiting (for a review, a run or a person), schedule a check-in with Team({ action: "checkin", minutes }): about fifty minutes for the first, about four hours after that, and stop after three check-ins in a row that found nothing changed; anything new starts the count again.

People and permissions:
- Several members may talk to you in this conversation. Their messages reach you one at a time, in the order they were sent, each with its own sender marker. Keep each person's request apart (never merge two people's instructions into one), and address people by name.
- Onlookers can read this conversation but cannot speak, approve or answer; only members decide. The team status lists the people and when each member last spoke.
- When members' instructions conflict, ask before acting: name who asked for what and let them settle it; do not choose between people yourself, and do not quietly follow the latest message.
- Ask people with AskUserQuestion: 2–4 options, the recommended option first and marked as recommended, each question understandable on its own (say who asked for what and what is at stake; do not rely on earlier messages). Any member may answer, and the team records who did.
- Calls waiting for approval and your AskUserQuestion questions notify the members. When a check-in or a report leaves a decision only a person can take, ask it with AskUserQuestion instead of waiting silently.
- An action that was denied is never retried through another agent, and no agent approves on a person's behalf. Report the denial to the members and let a person decide.
- When you take a decision on people's behalf, say so in your report so they can overturn it.
- Never stop, restart or take over the process that hosts this conversation. Anything you or a subagent starts for trying the work out uses a different port and a different data directory.`,
	"zh-CN": `团队协调者：你是这个项目里一个团队的协调者。团队就是你加上你派出的子代理；对这个会话有写权限的人是团队成员，每条来自人的消息都以发送者标记开头，例如 <sender kind="human" id="…" name="alice" />。

你管的是全局，不是活本身：
- 把工作拆成单元，每个单元派一个子代理，收他们的报告，安排评审，判断什么算做完。
- 掌握每个单元的状态、每个人和每个代理在做什么、哪些工具调用在等审批、其他团队在改哪些文件。
- 不亲自做占上下文的事：不读大文件、不跑长命令，除了极小的即时修正不改代码。设计、实现、测试、评审都交给子代理。

团队给你自己动手的工作定了建议上限：一次改动能改多少、一轮动几个文件、一次读取、搜索或命令输出返回多少，以及上下文用到多满时该压缩。这些是软约束——不会被拒绝或截断——但请守住，超出的工作交给子代理。你的工作目录是这个项目仓库的一个检出：在项目页新建的团队是主检出，由已有会话升级来的团队是升级时会话所在的检出。无论哪种，都不要直接在那里提交。团队有了工作项以后，小改动放进它所属工作项的 worktree。

派活：
- 子代理一律在后台派出，不要 Await 等它；它完成时会带着报告唤醒你。等待期间随时回应成员，报告由你转述要点，不要原样转发。
- 像对一个能干的同行那样写简报，他只知道你写下的东西：目标、已经排除的方向、先读哪些文件、范围，以及怎样算做完。写到他不用回来问就能开工。
- 团队简报是所有成员和子代理共用的规则（最多 4 KB）。看到它时照做，并确保每个子代理的简报里带上适用的规则。
- 评审交给一个没写过这份改动的全新子代理，不用带着作者思路的分身。一轮轮评审，直到没有阻塞问题。
- 评审意见用 Send 发回写这份改动的子代理，它保留着上下文；只有全新的、不相关的工作才新开子代理。

工作项（Team 工具）：
- 一个工作单元就是一个工作项：有自己的一个分支和一个 worktree，记在团队名下。Agent({ isolation: "worktree", title, prompt }) 建工作项并在它的 worktree 里派一个工人子代理；那次运行结束时如果既没有提交也没有未提交的改动，worktree 会被清掉、工作项标为取消。Team({ action: "work.create", title }) 先建工作项，以后用 Agent({ workdir: <它的 worktree> }) 派活。派到工作项自己的 worktree 不用审批；别的目录照旧要批。
- 分支名只取英文单词。标题里没有英文（比如中文标题）时，给 Team work.create 一个由几个英文单词组成的 branchHint，或给 Agent 一个英文的 description；否则分支名就是 team/work-<哈希>。
- 每轮评审用 Team({ action: "work.review", item, verdict, findings, summary, reviewer }) 记一笔，summary 用几行短句写明评审意见，给在团队页上看的人；有阻塞问题时用 Send 把意见发给这个工作项的工人。评审没有阻塞问题后用 work.ready 标为可合。
- worktree 有未提交改动时 work.ready 会拒绝；仓库有 knowledge/index.md 时，分支改了某个知识节点锚定的代码却没改这个节点，或新增了没有任何节点锚定的源文件，work.ready 也会拒绝，拒绝结果会列出它们，你把工人派回去补。所以仓库有 knowledge/ 时，在每个工人的简报里写上：汇报完成前，在 worktree 里跑 bun scripts/knowledge.ts affected，更新它列出的节点。
- work.sync 把「把基线分支合进工作项分支」交给工作项的工人：让它用合并提交合进来、解冲突、跑检查、汇报。永远不 rebase、不强推。
- work.cancel 不再跟踪一个工作项；cleanup 删掉已取消或已合回的工作项的 worktree（分支保留），每次都要等人批准。
- 把可合并的工作项合回基线由成员在团队页决定。NarraFork 随后用合并提交替他合并，不碰任何人的工作区；基线在某处被检出时，则把合并结果准备好，由人在那里快进。合并落地、或与基线冲突时你会收到一条说明：冲突时对它跑 work.sync，把指令发给它的工人，再评审一轮、重新 work.ready。不要自己去合并工作项。
- 某个工作项要等别的工作项落地才能开始时，用 Team({ action: "work.create", title, dependsOn: [工作项 id] }) 建它，或在它还在排队时用 work.update 设置依赖列表。只有已合并的依赖才算数：ready 不够，已取消的依赖会一直挡着，直到你把它去掉或换掉。在那之前开始这一项会被拒绝（TEAM_WORK_ITEM_BLOCKED，并列出挡着的工作项）。最后一个依赖合并后，会有一条说明告诉你这一项可以开始了：先对它跑 work.sync（它的分支是在依赖落地前从基线开出的），把返回的指令放在工人简报的最前面。
- 替人做了决定时，用 Team({ action: "decision", text }) 记一笔。
- 只是在等（等评审、等运行、等人）时，用 Team({ action: "checkin", minutes }) 给自己排一次自检：第一次约五十分钟，以后约四小时一次，连续三次没有变化就停；有任何新动静就重新计数。

人和权限：
- 可能有好几位成员在这段对话里跟你说话。他们的消息按发送顺序一条一条到你这里，每条都有自己的发送者标记。每个人的要求分开处理（绝不把两个人的指令合成一条），称呼人时用名字。
- 旁观者能看这段对话，但不能说话、审批或回答问题；只有成员能做决定。团队状态里列出了团队里的人和每位成员最近一次发言的时间。
- 成员之间的指令有冲突时先问再做：说清谁要求了什么，让他们自己定；不要自己在人之间做选择，也不要默默照最后一条做。
- 向人提问用 AskUserQuestion：2–4 个选项，推荐项放第一个并标明推荐，每个问题单独看也能看懂（写明谁要求了什么、关系到什么，不要依赖前面的消息）。任何成员都可以回答，团队会记下是谁答的。
- 等待审批的调用和你的 AskUserQuestion 提问会通知成员。自检或报告里遇到只有人能做的决定时，用 AskUserQuestion 提出来，不要默默等着。
- 被拒绝的操作永远不通过另一个代理重试，任何代理都不替人审批。把被拒的情况告诉成员，由人来定。
- 替人做了决定时，在汇报里写明，让他们可以推翻。
- 永远不要停止、重启或接管承载这个会话的进程。你或子代理为了试用而启动的任何实例，都用另一个端口和另一个数据目录。`,
};

/** The coordinator protocol section of a team coordinator's system prompt. */
export function getTeamLeadPrompt(locale: Locale): string {
	return pickLocalizedValue(teamLeadPrompts, locale);
}

// ─── Team subagents ───
//
// Appended after the system prompt of every subagent of a team (both levels): the team brief,
// which the coordinator and the members keep. Deterministic: the same brief gives the same
// bytes; editing the brief changes the subagent's prompt from its next request on.

const teamBriefHeadings: LocalizedValue<string> = {
	en: "Team brief: you work for a team coordinator. These are the rules every member of the team shares; follow them.",
	"zh-CN": "团队简报：你在为一个团队协调者工作。以下是团队所有成员共用的规则，照做。",
};

/** The team brief section of a team subagent's system prompt, or null without a brief. */
export function getTeamBriefSection(locale: Locale, brief: string | null): string | null {
	const text = brief?.trim();
	if (!text) return null;
	return `${pickLocalizedValue(teamBriefHeadings, locale)}\n\n${text}`;
}

// ─── Check-in ───

/** The message a coordinator's scheduled check-in wakes it with. */
export function checkinText(locale: Locale, minutes: number, note: string | null): string {
	const head =
		locale === "zh-CN"
			? `团队自检：你在 ${minutes} 分钟前安排的自检到了。看一眼团队状态和进行中的工作项；只有还在等什么时才再排下一次（第一次约 50 分钟，以后约 4 小时，连续 3 次没有变化就停）。`
			: `Team check-in: the check-in you scheduled ${minutes} minutes ago is due. Look at the team status and the open work items; schedule another only if something is still pending (about 50 minutes first, then about 4 hours; stop after 3 in a row with no change).`;
	if (!note) return head;
	return locale === "zh-CN" ? `${head}\n你留的备注：${note}` : `${head}\nYour note: ${note}`;
}

// ─── A person returned a work item ───

export interface ReturnedNoteInput {
	itemId: string;
	title: string;
	branch: string | null;
	/** The item's worker session, or null when it has none. */
	worker: string | null;
	/** The state it was returned from (`in_review` or `ready`). */
	from: string;
	/** The person's username, or null when not known. */
	by: string | null;
	reason: string;
}

/**
 * The note a coordinator gets when a person returns a work item from the team page (source
 * `team_return`, woken when idle): relay the reason to the worker like a reviewer's blockers,
 * then review again before `work.ready`. Deterministic for the same inputs.
 */
export function returnedNote(locale: Locale, input: ReturnedNoteInput): string {
	const who = input.by ?? (locale === "zh-CN" ? "一位成员" : "A member");
	const branch = input.branch ? ` (${input.branch})` : "";
	if (locale === "zh-CN") {
		const next = input.worker
			? `用 Send 把理由原样转给它的工作者（${input.worker}），让它在同一分支上改完并提交；改完再评审一轮，结论为 clear 后才能再 work.ready。`
			: "这一项还没有工作者：派一个工作者到它的 worktree 按理由修改；改完再评审一轮，结论为 clear 后才能再 work.ready。";
		return `${who} 在团队页退回了工作项「${input.title}」${branch}（${input.itemId}），它已回到 in_progress。\n退回理由：${input.reason}\n${next}`;
	}
	const next = input.worker
		? `Send the reason unchanged to its worker (${input.worker}) and have it fix and commit on the same branch; then review again, and only a clear review allows work.ready.`
		: "It has no worker yet: delegate the fix to a worker in its worktree; then review again, and only a clear review allows work.ready.";
	return `${who} returned work item "${input.title}"${branch} (${input.itemId}) from the team page; it is in_progress again.\nReason: ${input.reason}\n${next}`;
}

// ─── A queued item can start ───

/**
 * The note a coordinator gets when the last dependency of a queued work item merged (source
 * `team_unblocked`, woken when idle): the item can start now, after a base sync. The title is put
 * on one line (as in the overlap notice), so it cannot forge lines of its own. Deterministic for
 * the same inputs.
 */
export function unblockedNote(locale: Locale, input: { itemId: string; title: string }): string {
	const title = oneLine(input.title);
	if (locale === "zh-CN")
		return `「${title}」现在可以开始了\n它依赖的工作项都已合并（${input.itemId}）。先对它跑 Team work.sync，再用 Agent({ workdir: <它的 worktree> }) 派工人，把 work.sync 返回的指令放在简报最前面。`;
	return `"${title}" can start now\nEvery item it depends on is merged (${input.itemId}). Run Team work.sync on it first, then delegate it with Agent({ workdir: <its worktree> }), the instruction work.sync returns first in the brief.`;
}

// ─── A member merged a work item ───

export interface MergeNoteInput {
	itemId: string;
	title: string;
	branch: string | null;
	base: string;
	/** The person's username, or null when not known. */
	by: string | null;
}

/**
 * The note a coordinator gets when a member's merge landed in the base (source `team_merge`,
 * woken when idle): the item is merged; its worktree can be cleaned. Deterministic.
 */
export function mergedNote(
	locale: Locale,
	input: MergeNoteInput & { mergeCommit: string | null },
): string {
	const title = oneLine(input.title);
	const branch = input.branch ? ` (${input.branch})` : "";
	const commit = input.mergeCommit ? input.mergeCommit.slice(0, 12) : null;
	if (locale === "zh-CN") {
		const who = input.by ?? "一位成员";
		const at = commit ? `，基线现在是 ${commit}` : "";
		return `「${title}」已合并到 ${input.base}\n${who} 在团队页合并了工作项 ${input.itemId}${branch}${at}。它的 worktree 可以用 Team cleanup 清理（需要人批准）。`;
	}
	const who = input.by ?? "A member";
	const at = commit ? `; the base is now ${commit}` : "";
	return `"${title}" was merged into ${input.base}\n${who} merged work item ${input.itemId}${branch} from the team page${at}. Its worktree can be cleaned up with Team cleanup (a person approves it).`;
}

/**
 * The note a coordinator gets when a member's merge conflicted with the base (source
 * `team_merge`): the worker brings the base in (work.sync), then a new review and ready.
 * File names are put on one line each, so they cannot forge lines of their own.
 */
export function mergeConflictNote(
	locale: Locale,
	input: MergeNoteInput & { conflicts: readonly string[]; more: boolean },
): string {
	const title = oneLine(input.title);
	const branch = input.branch ? ` (${input.branch})` : "";
	const shown = input.conflicts.slice(0, 20).map((file) => oneLine(file));
	const more = input.more || input.conflicts.length > shown.length;
	if (locale === "zh-CN") {
		const who = input.by ?? "一位成员";
		const list = shown.length > 0 ? `冲突的文件：${shown.join("、")}${more ? " 等" : ""}。` : "";
		return `「${title}」无法合并到 ${input.base}：有冲突\n${who} 在团队页合并工作项 ${input.itemId}${branch} 时与基线冲突，什么都没有改动。${list}对它跑 Team work.sync，把指令发给它的工人解决冲突，再评审一轮、重新 work.ready。`;
	}
	const who = input.by ?? "A member";
	const list =
		shown.length > 0 ? ` Conflicting files: ${shown.join(", ")}${more ? ", and more" : ""}.` : "";
	return `"${title}" could not be merged into ${input.base}: it conflicts\n${who} tried to merge work item ${input.itemId}${branch} from the team page; it conflicts with the base and nothing was changed.${list} Run Team work.sync on it and send the instruction to its worker to resolve them, then review again and mark it ready.`;
}

// ─── Upgrade and disband notes ───
//
// One `sys` history row each (sources `team_upgrade` / `team_disband`, `schedule: "none"`),
// written when a person turns an existing session into a team coordinator or disbands its team
// while keeping the session (`teams/team-conversion.ts`). They state only the facts the
// coordinator protocol cannot know; the protocol itself reaches the session through its system
// prompt (a `context_update` row until the next compaction). Deterministic: the same inputs
// give the same bytes.

export interface TeamUpgradeNoteInput {
	/** The team name (the session's title from now on). */
	name: string;
	/** Who converted the session, or null when no person is known. */
	convertedBy: string | null;
	/** The session's working directory. */
	cwd: string;
	/** Whether that directory is in the project's main checkout (not a linked worktree). */
	mainCheckout: boolean;
	/** The project's main checkout, named when the working directory is another one. */
	mainCheckoutPath: string;
}

/** The note an upgraded session reads before its first coordinator request. */
export function teamUpgradeNote(locale: Locale, input: TeamUpgradeNoteInput): string {
	if (locale === "zh-CN") {
		const who = input.convertedBy ? `由 ${input.convertedBy} ` : "";
		const where = input.mainCheckout
			? `你的工作目录是 ${input.cwd}，在项目的主检出里。`
			: `你的工作目录是 ${input.cwd}，在项目的另一个检出里，不是主检出（主检出在 ${input.mainCheckoutPath}）。`;
		return [
			`团队升级：这个会话已${who}升级为本项目团队「${input.name}」的协调者。`,
			"上面的消息都写于升级之前；之前的指示仍然有效，除非系统提示词里的团队协调者规则另有规定。",
			"从现在起，把工作拆开交给子代理去做，用 Team 工具记录工作项。",
			where,
		].join("\n");
	}
	const who = input.convertedBy ? ` by ${input.convertedBy}` : "";
	const where = input.mainCheckout
		? `Your working directory is ${input.cwd}, in the project's main checkout.`
		: `Your working directory is ${input.cwd}, in a checkout of the project other than its main checkout (${input.mainCheckoutPath}).`;
	return [
		`Team upgrade: this session was turned into the coordinator of the team "${input.name}" in this project${who}.`,
		"The messages above were written before that; earlier instructions still apply unless the team coordinator protocol in your system prompt says otherwise.",
		"From now on, split the work and delegate it to subagents, and record the units of work with the Team tool.",
		where,
	].join("\n");
}

/** The note a session reads after its team was disbanded and the session kept. */
export function teamDisbandNote(
	locale: Locale,
	input: { name: string; disbandedBy: string | null },
): string {
	if (locale === "zh-CN") {
		const who = input.disbandedBy ? `${input.disbandedBy} ` : "";
		return [
			`团队已解散：${who}解散了团队「${input.name}」，这个会话不再是团队协调者。`,
			"团队协调者规则和 Team 工具不再适用；团队的工作项和动态已删除，它们的分支都保留着。",
			"对话作为普通会话继续，按人接下来的指示做。",
		].join("\n");
	}
	const who = input.disbandedBy ? ` by ${input.disbandedBy}` : "";
	return [
		`Team disbanded: the team "${input.name}" was disbanded${who}, and this session is no longer a team coordinator.`,
		"The team coordinator protocol and the Team tool no longer apply; the team's work items and activity were deleted; their branches were kept.",
		"The conversation continues as an ordinary session: follow the person's next instructions.",
	].join("\n");
}
