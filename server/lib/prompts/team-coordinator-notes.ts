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

const savedNote: LocalizedValue<(path: string) => string> = {
	en: (path) =>
		`Only the beginning and the end are shown above. The complete result is saved at ${path}; Read that file (limit -1 for all of it) to see everything.`,
	"zh-CN": (path) =>
		`上面只显示了开头和结尾。完整结果已存到 ${path}；用 Read 读这个文件（limit 设为 -1 读全部）就能看到全文。`,
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

/** One reminder line for one overrun kind. `savedPath` only for an output shown head + tail. */
export function getCoordinatorReminder(
	facts: ReminderFacts & { savedPath?: string },
	locale: Locale,
): string {
	const advice = pickLocalizedValue(reminderAdvice, locale)[
		OUTPUT_KINDS.has(facts.kind) ? "output" : "change"
	];
	const saved = facts.savedPath ? ` ${pickLocalizedValue(savedNote, locale)(facts.savedPath)}` : "";
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
}

const statusLabels: LocalizedValue<TeamStatusLabels> = {
	en: {
		heading: (name, base) =>
			`[Team status] Team "${name}", base branch ${base}. Written by the system, not by a person.`,
		briefHeading: "Team brief (shared rules for you and every subagent):",
		noBrief: "Team brief: none yet.",
		briefCut: (bytes) => `[… brief cut here to fit the status; it has ${bytes} bytes in all …]`,
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
	},
	"zh-CN": {
		heading: (name, base) =>
			`[团队状态] 团队「${name}」，基线分支 ${base}。由系统写入，不是人发的消息。`,
		briefHeading: "团队简报（你和每个子代理共用的规则）：",
		noBrief: "团队简报：还没有。",
		briefCut: (bytes) => `[… 为了放进状态，简报在这里截断；全文共 ${bytes} 字节 …]`,
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
	},
};

export function getTeamStatusLabels(locale: Locale): TeamStatusLabels {
	return pickLocalizedValue(statusLabels, locale);
}
