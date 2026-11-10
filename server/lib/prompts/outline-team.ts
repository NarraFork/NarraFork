/**
 * What an outline session is told about the rest of its team (outline P2 PR 10b): the team activity
 * note written at the start of a run (`outline/team-activity.ts`, design §2.5) and the overlap hint
 * a Write or Edit result ends with (`outline/overlap.ts`, design §2.6).
 *
 * Both are deterministic: no relative times, no lease times, nothing that depends on when the text
 * is read. A row written once sends the same bytes on every rebuild and retry. Names come in
 * already decided by the caller (a session's title only where everyone who reads this session may
 * read that one; otherwise "another session").
 */
import type { Locale } from "../i18n";

/** Who did something, as the note names them. */
export type OutlineTeamActor =
	/** A session: its title, or null when this session may not name it. */
	| { kind: "session"; name: string | null }
	/** A person: their username. */
	| { kind: "person"; name: string }
	| { kind: "system" };

/** A task as a note links it: `key/sid` and its title (one line). No address: not named. */
export interface OutlineTeamTask {
	address: string;
	title: string;
}

/** What one person or session did, as one line of the team activity note. */
export type OutlineTeamEvent =
	| { kind: "done" | "cancelled" | "started" | "reopened"; task: OutlineTeamTask }
	| { kind: "assigned"; task: OutlineTeamTask; to: string }
	| { kind: "added"; task: OutlineTeamTask; claimable: boolean }
	| { kind: "claimable"; task: OutlineTeamTask }
	| { kind: "notes" | "reports" | "answers"; n: number };

/** One line of the note: under a related task tree, on the project task page, or about a file. */
export type OutlineTeamLine =
	| { where: "tree"; tree: OutlineTeamTask; by: OutlineTeamActor; event: OutlineTeamEvent }
	| { where: "page"; by: OutlineTeamActor; event: OutlineTeamEvent }
	| {
			where: "file";
			by: OutlineTeamActor;
			/** The other session's task in progress; null when this session may not name it. */
			task: OutlineTeamTask | null;
			/** Repository-relative path. */
			path: string;
	  };

/** `[[key/sid|title]]`, with what would end the link taken out of the title. */
export function outlineTeamLink(task: OutlineTeamTask): string {
	const title = task.title
		.replace(/[[\]|]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return title && title !== task.address ? `[[${task.address}|${title}]]` : `[[${task.address}]]`;
}

function actorText(actor: OutlineTeamActor, zh: boolean): string {
	switch (actor.kind) {
		case "session":
			return actor.name === null
				? zh
					? "另一个会话"
					: "another session"
				: zh
					? `会话「${actor.name}」`
					: `session "${actor.name}"`;
		case "person":
			return actor.name;
		case "system":
			return zh ? "系统" : "the system";
	}
}

/** `alice 加了` but `会话「B」把`: a space only after a name ending in a Latin letter or digit. */
function zhJoin(who: string, rest: string): string {
	return /[A-Za-z0-9_.-]$/.test(who) ? `${who} ${rest}` : `${who}${rest}`;
}

function eventText(event: OutlineTeamEvent, self: boolean, zh: boolean): string {
	const it = (task: OutlineTeamTask) => (self ? (zh ? "它" : "it") : outlineTeamLink(task));
	switch (event.kind) {
		case "done":
			return zh
				? `把${self ? "它" : ` ${it(event.task)} `}勾成完成`
				: `ticked ${it(event.task)} done`;
		case "cancelled":
			return zh ? `取消了${self ? "它" : ` ${it(event.task)}`}` : `cancelled ${it(event.task)}`;
		case "started":
			return zh ? `开始做${self ? "它" : ` ${it(event.task)}`}` : `started ${it(event.task)}`;
		case "reopened":
			return zh ? `重开了${self ? "它" : ` ${it(event.task)}`}` : `reopened ${it(event.task)}`;
		case "assigned":
			return zh
				? `把${self ? "它" : ` ${it(event.task)} `}转交给 ${event.to}`
				: `handed ${it(event.task)} to ${event.to}`;
		case "added": {
			const mark = event.claimable ? (zh ? "（可领取）" : " (claimable)") : "";
			return zh
				? `加了任务 ${outlineTeamLink(event.task)}${mark}`
				: `added the task ${outlineTeamLink(event.task)}${mark}`;
		}
		case "claimable":
			return zh
				? `把${self ? "它" : ` ${it(event.task)} `}放进了可领取池`
				: `put ${it(event.task)} in the claim pool`;
		case "notes":
			return zh ? `加了 ${event.n} 条笔记` : `added ${event.n} note${event.n === 1 ? "" : "s"}`;
		case "reports":
			return zh
				? `挂回了 ${event.n} 份报告`
				: `attached ${event.n} report${event.n === 1 ? "" : "s"}`;
		case "answers":
			return zh
				? `回答了 ${event.n} 个提问`
				: `answered ${event.n} question${event.n === 1 ? "" : "s"}`;
	}
}

function eventTask(event: OutlineTeamEvent): OutlineTeamTask | null {
	return "task" in event ? event.task : null;
}

/** One line of the note, as the model reads it. */
export function outlineTeamLineText(line: OutlineTeamLine, locale: Locale): string {
	const zh = locale === "zh-CN";
	const who = actorText(line.by, zh);
	if (line.where === "file") {
		const path = `\`${line.path.replace(/`/g, "'")}\``;
		if (zh)
			return line.task
				? `- 文件：${who}的 ${outlineTeamLink(line.task)} 也在改你改过的 ${path}`
				: `- 文件：${who}的一个进行中的任务也在改你改过的 ${path}`;
		return line.task
			? `- Files: ${outlineTeamLink(line.task)} of ${who} is also changing ${path}, which you changed`
			: `- Files: a task in progress of ${who} is also changing ${path}, which you changed`;
	}
	const task = eventTask(line.event);
	// Something that happened to the tree's own task: "it", the tree is already named.
	const self = line.where === "tree" && task !== null && task.address === line.tree.address;
	const what = eventText(line.event, self, zh);
	if (line.where === "tree") {
		const tree = outlineTeamLink(line.tree);
		return zh ? `- ${tree} 下：${zhJoin(who, what)}` : `- Under ${tree}: ${who} ${what}`;
	}
	return zh ? `- 项目任务页：${zhJoin(who, what)}` : `- Project task page: ${who} ${what}`;
}

/** The first line of the note. */
export function getOutlineTeamActivityHeading(locale: Locale): string {
	return locale === "zh-CN"
		? "团队动态（上一轮之后别人做的；系统整理，不是用户发言）"
		: "Team activity since your last turn (what others did; compiled by the system, not the user)";
}

/**
 * The line that counts what did not fit. `taskPage` is the project task page when there is one:
 * the place to read on.
 */
export function getOutlineTeamActivityMore(
	more: number,
	taskPage: OutlineTeamTask | null,
	locale: Locale,
): string {
	if (locale === "zh-CN")
		return taskPage
			? `（还有 ${more} 处变化没有列出，用 OutlineRead 读 ${outlineTeamLink(taskPage)}）`
			: `（还有 ${more} 处变化没有列出，用 OutlineRead 读相关的任务）`;
	return taskPage
		? `(${more} more change${more === 1 ? "" : "s"} not listed; read ${outlineTeamLink(taskPage)} with OutlineRead)`
		: `(${more} more change${more === 1 ? "" : "s"} not listed; read the related tasks with OutlineRead)`;
}

/**
 * The fixed line of a look that could not read its whole window (older commits of a busy window
 * passed over, or one commit larger than a read): no number, the same bytes every time.
 */
export function getOutlineTeamActivityClipped(locale: Locale): string {
	return locale === "zh-CN"
		? "（这段时间里更早的一些变化没有读。）"
		: "(Some earlier changes in this window were not read.)";
}

/** The overlap hint a Write or Edit result ends with: one line (design §2.6). */
export function getOutlineOverlapHint(
	input: {
		/** The other session's task in progress; null when this session may not name it. */
		task: OutlineTeamTask | null;
		/** The other session's title; null when this session may not name it. */
		session: string | null;
		/** Repository-relative path. */
		path: string;
		/** Further (file, task) pairs of other sessions, counted. */
		more: number;
	},
	locale: Locale,
): string {
	const zh = locale === "zh-CN";
	const path = `\`${input.path.replace(/`/g, "'")}\``;
	const who = actorText({ kind: "session", name: input.session }, zh);
	const more = input.more > 0 ? (zh ? `（另有 ${input.more} 处）` : ` (${input.more} more)`) : "";
	if (zh)
		return input.task
			? `重叠提示：${outlineTeamLink(input.task)}（${who}，进行中）也改过 ${path}${more}。动手前可以先读它的任务。`
			: `重叠提示：${who}的一个进行中的任务也改过 ${path}${more}。`;
	return input.task
		? `Overlap: ${outlineTeamLink(input.task)} (${who}, in progress) also changed ${path}${more}. You may want to read its task before going on.`
		: `Overlap: a task in progress of ${who} also changed ${path}${more}.`;
}
