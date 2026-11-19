import { type Locale, type LocalizedValue, pickLocalizedValue } from "@shared/i18n-locales";
import type { CoordinatorOverrunKind, TeamWorkItemState } from "@shared/project-teams";

// ─── Team coordinator: reminders and team status (Project Teams P2) ───
//
// Model-facing text only. Everything here is a pure function of its arguments: no dates
// computed here, no relative times, so the same state always gives the same bytes (the rows
// stay in the history and a rebuilt request sends what the first one sent).

interface ReminderFacts {
	kind: CoordinatorOverrunKind;
	tool: string;
	size: number;
	limit: number;
}

const reminderLead: LocalizedValue<string> = {
	en: "[Coordinator limit]",
	"zh-CN": "[协调者建议上限]",
};

const reminderBody: LocalizedValue<(facts: ReminderFacts) => string> = {
	en: ({ kind, tool, size, limit }) => {
		switch (kind) {
			case "editLines":
				return `This ${tool} changed ${size} lines; the team's suggested limit for the coordinator is ${limit} lines per edit.`;
			case "newFileLines":
				return `This ${tool} wrote a new file of ${size} lines; the team's suggested limit for a new file is ${limit} lines.`;
			case "filesPerTurn":
				return `This turn has now changed ${size} files; the team's suggested limit is ${limit} files per turn.`;
			case "readLines":
				return `This ${tool} returned ${size} lines; the team's suggested limit for one read is ${limit} lines.`;
			case "searchLines":
				return `This ${tool} returned ${size} lines; the team's suggested limit for one search is ${limit} lines.`;
			case "bashOutputBytes":
				return `This ${tool} output is ${size} bytes; the team's suggested limit for one command's output is ${limit} bytes.`;
		}
	},
	"zh-CN": ({ kind, tool, size, limit }) => {
		switch (kind) {
			case "editLines":
				return `这次 ${tool} 改了 ${size} 行，团队给协调者的建议是每次改动不超过 ${limit} 行。`;
			case "newFileLines":
				return `这次 ${tool} 新建的文件有 ${size} 行，团队对新文件的建议是不超过 ${limit} 行。`;
			case "filesPerTurn":
				return `这一轮已经改了 ${size} 个文件，团队的建议是每轮不超过 ${limit} 个。`;
			case "readLines":
				return `这次 ${tool} 返回了 ${size} 行，团队对一次读取的建议是不超过 ${limit} 行。`;
			case "searchLines":
				return `这次 ${tool} 返回了 ${size} 行，团队对一次搜索的建议是不超过 ${limit} 行。`;
			case "bashOutputBytes":
				return `这次 ${tool} 输出了 ${size} 字节，团队对一条命令输出的建议是不超过 ${limit} 字节。`;
		}
	},
};

const reminderAdvice: LocalizedValue<Record<"change" | "output", string>> = {
	en: {
		change: "It ran as usual; hand work like this to a subagent.",
		output: "Hand reading large files and long commands to a subagent.",
	},
	"zh-CN": {
		change: "已照常执行；这类工作请交给子代理。",
		output: "读大文件、跑长命令请交给子代理。",
	},
};

/** Where the complete result of a shortened output is. */
export type SavedOutputNote =
	| { kind: "saved"; paths: string[]; keptMegabytes: number }
	| { kind: "existing"; path: string };

const savedNote: LocalizedValue<(note: SavedOutputNote) => string> = {
	en: (note) => {
		const lead = "Only the beginning and the end are shown above.";
		if (note.kind === "existing")
			return `${lead} The complete output was saved at ${note.path}; page through it with Read (offset and limit) or search it with Grep.`;
		const kept = `(kept while available: each session keeps its latest ${note.keptMegabytes} MB of saved results)`;
		if (note.paths.length === 1)
			return `${lead} The complete result is saved at ${note.paths[0]}; Read that file with limit: -1 to get all of it ${kept}.`;
		return `${lead} The complete result is saved in ${note.paths.length} consecutive parts (joined without separators): ${note.paths.join(", ")}; Read each with limit: -1 to get all of it ${kept}.`;
	},
	"zh-CN": (note) => {
		const lead = "上面只显示了开头和结尾。";
		if (note.kind === "existing")
			return `${lead}完整输出已存到 ${note.path}；用 Read（offset 和 limit）分段读，或用 Grep 搜索。`;
		const kept = `（在可用期间保留：每个会话保留最近 ${note.keptMegabytes} MB 的已存结果）`;
		if (note.paths.length === 1)
			return `${lead}完整结果已存到 ${note.paths[0]}；用 Read 读这个文件、limit 设为 -1 就能拿到全文${kept}。`;
		return `${lead}完整结果分 ${note.paths.length} 段依次存放（直接首尾相接）：${note.paths.join("、")}；每段用 Read、limit 设为 -1 读全${kept}。`;
	},
};

const omittedMarker: LocalizedValue<(lines: number, bytes: number) => string> = {
	en: (lines, bytes) => `[… ${lines} lines (${bytes} bytes) not shown here …]`,
	"zh-CN": (lines, bytes) => `[… 这里省略了 ${lines} 行（${bytes} 字节）…]`,
};

const OUTPUT_KINDS: ReadonlySet<CoordinatorOverrunKind> = new Set([
	"readLines",
	"searchLines",
	"bashOutputBytes",
]);

/** One reminder line for one overrun kind. `saved` only for an output shown head + tail. */
export function getCoordinatorReminder(
	facts: ReminderFacts & { saved?: SavedOutputNote },
	locale: Locale,
): string {
	const advice = pickLocalizedValue(reminderAdvice, locale)[
		OUTPUT_KINDS.has(facts.kind) ? "output" : "change"
	];
	const saved = facts.saved ? ` ${pickLocalizedValue(savedNote, locale)(facts.saved)}` : "";
	return `${pickLocalizedValue(reminderLead, locale)} ${pickLocalizedValue(reminderBody, locale)(facts)}${saved} ${advice}`;
}

/** The line standing between the head and the tail of a saved output. */
export function getCoordinatorOmittedMarker(lines: number, bytes: number, locale: Locale): string {
	return pickLocalizedValue(omittedMarker, locale)(lines, bytes);
}

// ─── Team status ───

export interface TeamStatusLabels {
	heading: (name: string, baseBranch: string) => string;
	briefHeading: string;
	noBrief: string;
	briefCut: (bytes: number) => string;
	briefShown: (bytes: number) => string;
	workItems: (counts: string) => string;
	noWorkItems: string;
	state: Record<TeamWorkItemState, string>;
	finished: (count: string) => string;
	item: (state: string, title: string, branch: string | null, worker: string | null) => string;
	moreItems: (count: number) => string;
	approvals: (count: string) => string;
	noApprovals: string;
	approval: (tool: string, who: string, summary: string) => string;
	coordinatorSelf: string;
	unnamedAgent: string;
	moreApprovals: (count: number) => string;
	overruns: (weekStart: string, total: string, byKind: string) => string;
	noOverruns: (weekStart: string) => string;
	overrunKind: Record<CoordinatorOverrunKind, string>;
	decisions: string;
	decision: (date: string, summary: string) => string;
	moreDecisions: (count: number) => string;
	context: (limit: number) => string;
	listCut: string;
	separator: string;
	/** M1: the team's people (members and onlookers) and when each last spoke. */
	people: (members: string, onlookers: string) => string;
	member: (
		name: string,
		role: "member" | "onlooker",
		owner: boolean,
		spoke: string | null,
	) => string;
	morePeople: (count: string) => string;
	peopleMore: string;
	peopleHidden: (count: string) => string;
	/** Broad audiences: everyone in the project, or anyone signed in. */
	audienceProjectWrite: string;
	audienceProjectRead: string;
	audiencePublicWrite: string;
	audiencePublicRead: string;
}

const statusLabels: LocalizedValue<TeamStatusLabels> = {
	en: {
		heading: (name, base) =>
			`[Team status] Team "${name}", base branch ${base}. Written by the system, not by a person.`,
		briefHeading: "Team brief (shared rules for you and every subagent):",
		noBrief: "Team brief: none yet.",
		briefCut: (bytes) => `[… brief cut here to fit the status; it has ${bytes} bytes in all …]`,
		briefShown: (bytes) =>
			`Team brief: unchanged since an earlier team status in this conversation showed it (${bytes} bytes).`,
		workItems: (counts) => `Work items: ${counts}.`,
		noWorkItems: "Work items: none yet.",
		state: {
			queued: "queued",
			in_progress: "in progress",
			in_review: "in review",
			ready: "ready",
			merged: "merged",
			cancelled: "cancelled",
		},
		finished: (count) => `${count} finished`,
		item: (state, title, branch, worker) =>
			`- [${state}] ${title}${branch ? ` — branch ${branch}` : ""}${worker ? ` — ${worker}` : ""}`,
		moreItems: (count) => `- … and ${count} more open work items`,
		approvals: (count) => `Waiting for a person's approval: ${count}.`,
		noApprovals: "Waiting for a person's approval: nothing.",
		approval: (tool, who, summary) => `- ${tool} by ${who}${summary ? `: ${summary}` : ""}`,
		coordinatorSelf: "you",
		unnamedAgent: "a subagent",
		moreApprovals: (count) => `- … and ${count} more`,
		overruns: (week, total, byKind) =>
			`Your suggested limits were exceeded ${total} times this week (since ${week}, UTC): ${byKind}.`,
		noOverruns: (week) => `Your suggested limits were not exceeded this week (since ${week}, UTC).`,
		overrunKind: {
			editLines: "edit size",
			newFileLines: "new file size",
			filesPerTurn: "files per turn",
			readLines: "Read size",
			searchLines: "search size",
			bashOutputBytes: "command output",
		},
		decisions: "Recent decisions you took on people's behalf (they can overturn them):",
		decision: (date, summary) => `- ${date}: ${summary}`,
		moreDecisions: (count) => `- … and ${count} more`,
		context: (limit) =>
			`Context use is above the team's suggested ${limit}%: compact when the work allows.`,
		listCut: "[… list cut here to fit the status …]",
		separator: ", ",
		people: (members, onlookers) =>
			`People: members ${members}, onlookers ${onlookers} (members speak to you, approve and answer; onlookers only read). "Last spoke" is a member's latest message here, in UTC.`,
		member: (name, role, owner, spoke) =>
			`- ${name} — ${role === "member" ? "member" : "onlooker"}${owner ? " (owner)" : ""}${
				role === "member" ? (spoke ? `, last spoke ${spoke}` : ", no recent message") : ""
			}`,
		morePeople: (count) => `- … and ${count} more not listed here`,
		peopleMore:
			"These counts are of the people found; more may have access (only the first of each kind were looked at).",
		peopleHidden: (count) =>
			`${count} of them reach the team only through the project and are not named here.`,
		audienceProjectWrite: "Everyone with write access to the project is a member too.",
		audienceProjectRead: "Everyone in the project may look on.",
		audiencePublicWrite: "Anyone signed in may speak here too.",
		audiencePublicRead: "Anyone signed in may look on.",
	},
	"zh-CN": {
		heading: (name, base) =>
			`[团队状态] 团队「${name}」，基线分支 ${base}。由系统写入，不是人发的消息。`,
		briefHeading: "团队简报（你和每个子代理共用的规则）：",
		noBrief: "团队简报：还没有。",
		briefCut: (bytes) => `[… 为了放进状态，简报在这里截断；全文共 ${bytes} 字节 …]`,
		briefShown: (bytes) =>
			`团队简报：和这段对话里前面的团队状态显示的一样，没有变（${bytes} 字节）。`,
		workItems: (counts) => `工作项：${counts}。`,
		noWorkItems: "工作项：还没有。",
		state: {
			queued: "排队",
			in_progress: "进行中",
			in_review: "评审中",
			ready: "就绪",
			merged: "已合回",
			cancelled: "已取消",
		},
		finished: (count) => `已结束 ${count}`,
		item: (state, title, branch, worker) =>
			`- [${state}] ${title}${branch ? ` — 分支 ${branch}` : ""}${worker ? ` — ${worker}` : ""}`,
		moreItems: (count) => `- … 另有 ${count} 个未结束的工作项`,
		approvals: (count) => `等人审批：${count} 个。`,
		noApprovals: "等人审批：没有。",
		approval: (tool, who, summary) => `- ${who} 的 ${tool}${summary ? `：${summary}` : ""}`,
		coordinatorSelf: "你",
		unnamedAgent: "某个子代理",
		moreApprovals: (count) => `- … 另有 ${count} 个`,
		overruns: (week, total, byKind) =>
			`本周（自 ${week} 起，UTC）超出建议上限 ${total} 次：${byKind}。`,
		noOverruns: (week) => `本周（自 ${week} 起，UTC）没有超出建议上限。`,
		overrunKind: {
			editLines: "单次改动",
			newFileLines: "新文件",
			filesPerTurn: "每轮文件数",
			readLines: "Read 行数",
			searchLines: "搜索行数",
			bashOutputBytes: "命令输出",
		},
		decisions: "最近替人做的决定（他们可以推翻）：",
		decision: (date, summary) => `- ${date}：${summary}`,
		moreDecisions: (count) => `- … 另有 ${count} 条`,
		context: (limit) => `上下文用量已超过团队建议的 ${limit}%：方便时请压缩。`,
		listCut: "[… 为了放进状态，列表在这里截断 …]",
		separator: "，",
		people: (members, onlookers) =>
			`团队里的人：成员 ${members} 人，旁观者 ${onlookers} 人（成员对你说话、审批和回答问题；旁观者只读）。「最近发言」是成员在这里的最后一条消息，UTC 时间。`,
		member: (name, role, owner, spoke) =>
			`- ${name} — ${role === "member" ? "成员" : "旁观者"}${owner ? "（所有者）" : ""}${
				role === "member" ? (spoke ? `，最近发言 ${spoke}` : "，最近没有发言") : ""
			}`,
		morePeople: (count) => `- … 另有 ${count} 人没有列出`,
		peopleMore: "以上人数是找到的人；有权限的人可能更多（每类只查看了前面一部分）。",
		peopleHidden: (count) => `其中 ${count} 人只是通过项目进入团队，这里不列名字。`,
		audienceProjectWrite: "对项目有写权限的人也都是成员。",
		audienceProjectRead: "项目里的人都可以旁观。",
		audiencePublicWrite: "任何登录的人也都可以在这里说话。",
		audiencePublicRead: "任何登录的人都可以旁观。",
	},
};

export function getTeamStatusLabels(locale: Locale): TeamStatusLabels {
	return pickLocalizedValue(statusLabels, locale);
}

// ─── Team overlaps and the exclusive lock (Project Teams X) ───

export interface TeamOverlapLabels {
	/** Status section heading: overlaps of this team's open items with other open items. */
	heading: (total: string) => string;
	none: string;
	/** One overlap: the path (a top-level directory ends in `/`), this team's items, the others. */
	line: (path: string, dir: boolean, mine: string, others: string) => string;
	/** Another team's item: its team and title, or `null`s when this conversation may not name it. */
	other: (team: string | null, title: string | null) => string;
	more: (count: number) => string;
	lockMine: (title: string) => string;
	lockOther: (team: string | null, title: string | null) => string;
	unlocked: (titles: string) => string;
	/** Ready items whose branch no longer contains the head recorded at ready (reset). */
	rewound: (titles: string) => string;
	noticeHeading: string;
	noticeLine: (mine: string, team: string | null, title: string | null, paths: string) => string;
	noticeAdvice: string;
	/** A person released the exclusive paths lock one of this team's items held. */
	releasedNotice: (title: string, reason: string | null) => string;
	separator: string;
}

const overlapLabels: LocalizedValue<TeamOverlapLabels> = {
	en: {
		heading: (total) => `Files your open work items share with other open work items: ${total}.`,
		none: "Files your open work items share with other open work items: none.",
		line: (path, dir, mine, others) =>
			`- ${path}${dir ? " (compared by top-level directory)" : ""}: ${mine}${mine && others ? "; " : ""}${others}`,
		other: (team, title) =>
			team === null ? "another team's work item" : `team "${team}": "${title ?? ""}"`,
		more: (count) => `- … and ${count} more`,
		lockMine: (title) =>
			`Exclusive paths lock: held by your work item "${title}" until it is merged or cancelled.`,
		lockOther: (team, title) =>
			team === null
				? "Exclusive paths lock: held by another team's work item; an item of yours that changes the exclusive paths cannot be marked ready until it is released."
				: `Exclusive paths lock: held by team "${team}"'s work item "${title ?? ""}"; an item of yours that changes the exclusive paths cannot be marked ready until it is released.`,
		unlocked: (titles) =>
			`Your work items changing the project's exclusive paths without the lock: ${titles}. work.ready takes it, or refuses while another item holds it.`,
		rewound: (titles) =>
			`Ready work items whose branch no longer contains the commit recorded when they were marked ready (reset or rewritten): ${titles}. They keep that recorded commit and any lock until cancelled or a person releases the lock; have the worker restore the branch, or cancel the item.`,
		noticeHeading:
			"[Team overlap] New overlaps with another team's work (written by the system, not by a person):",
		noticeLine: (mine, team, title, paths) =>
			`- your work item "${mine}" and ${team === null ? "another team's work item" : `team "${team}"'s work item "${title ?? ""}"`} both change: ${paths}`,
		noticeAdvice:
			'Decide whether this matters (e.g. who merges first, or split the change) and record what you decide with Team({ action: "decision" }). The team status lists every overlap.',
		releasedNotice: (title, reason) =>
			`[Team lock] A person released the exclusive paths lock your work item "${title}" held${reason ? ` (${reason})` : ""}. Another item may take it now; if this item still has to change the exclusive paths, mark it ready again later. Written by the system, not by a person.`,
		separator: ", ",
	},
	"zh-CN": {
		heading: (total) => `你的未结束工作项和其他未结束工作项同时改动的文件：${total} 处。`,
		none: "你的未结束工作项和其他未结束工作项同时改动的文件：没有。",
		line: (path, dir, mine, others) =>
			`- ${path}${dir ? "（按顶层目录比较）" : ""}：${mine}${mine && others ? "；" : ""}${others}`,
		other: (team, title) =>
			team === null ? "另一个 team 的工作项" : `team「${team}」的「${title ?? ""}」`,
		more: (count) => `- … 另有 ${count} 处`,
		lockMine: (title) => `独占路径锁：由你的工作项「${title}」持有，合回或取消时释放。`,
		lockOther: (team, title) =>
			team === null
				? "独占路径锁：由另一个 team 的工作项持有；在它释放前，你改到独占路径的工作项不能标记就绪。"
				: `独占路径锁：由 team「${team}」的工作项「${title ?? ""}」持有；在它释放前，你改到独占路径的工作项不能标记就绪。`,
		unlocked: (titles) =>
			`你的这些工作项改到了项目的独占路径但还没拿锁：${titles}。work.ready 时会拿锁，别人持有时会被拒绝。`,
		rewound: (titles) =>
			`这些已就绪的工作项，分支里已经没有标记就绪时记下的提交（被重置或改写过）：${titles}。它们仍按那个提交记账、锁也还在，直到取消或有人放行；请让 worker 把分支恢复，或者取消它。`,
		noticeHeading: "[团队重叠] 和另一个 team 的工作出现了新的重叠（由系统写入，不是人发的消息）：",
		noticeLine: (mine, team, title, paths) =>
			`- 你的工作项「${mine}」和${team === null ? "另一个 team 的工作项" : ` team「${team}」的「${title ?? ""}」`}都改了：${paths}`,
		noticeAdvice:
			'判断这是否要紧（比如谁先合、要不要拆开改），决定后用 Team({ action: "decision" }) 记下来。团队状态里列着全部重叠。',
		releasedNotice: (title, reason) =>
			`[团队锁] 有人放行了你的工作项「${title}」持有的独占路径锁${reason ? `（${reason}）` : ""}。别的工作项现在可以拿锁；这个工作项如果还要改独占路径，之后再标记一次就绪。由系统写入，不是人发的消息。`,
		separator: "，",
	},
};

export function getTeamOverlapLabels(locale: Locale): TeamOverlapLabels {
	return pickLocalizedValue(overlapLabels, locale);
}
