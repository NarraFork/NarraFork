/**
 * Interactive tutorial: lesson catalog and scripted model behaviour.
 *
 * The tutorial teaches NarraFork by letting the user drive the REAL product —
 * real narrators, real tool execution, real permission cards, real worktrees,
 * real database rows. The single thing that is replaced is the model upstream:
 * `TutorialProvider` (server/lib/agent/tutorial-provider.ts) replays the scripts
 * defined here instead of calling any AI API.
 *
 * Two consequences shape everything in this file:
 *
 *  1. **Tools really run.** A script that asks to `Read` a file the sandbox does
 *     not contain produces a real error card, so the lesson would be teaching
 *     what a failure looks like. Every path referenced here must exist in the
 *     sandbox that `tutorial-service` provisions.
 *
 *  2. **Paths must stay inside the sandbox.** Tool paths are resolved against the
 *     narrator's cwd (`resolveBackendPath(backend, ctx.cwd, input)`), so a
 *     RELATIVE path lands in the sandbox worktree while an absolute one escapes
 *     it and would edit the user's real files. `lessons.guard.test.ts` enforces
 *     this mechanically rather than trusting review.
 *
 * Content lives here (not in `frontend/locales/`) because the SERVER also reads
 * it: the provider needs the script text in the user's locale. Same reasoning as
 * `shared/learning-content.ts`.
 */

import { type Locale, type LocalizedValue, pickLocalizedValue } from "../i18n-locales";

export type LocalizedText = LocalizedValue<string>;

/**
 * Reserved provider prefix for the tutorial.
 *
 * `createProviderByName` checks this FIRST, so no plugin or compatible-API
 * provider can claim it. Deliberately not registered as a model source: a
 * scripted model must never show up in the normal model pickers, where a user
 * could select it for real work and get a session that only recites lines.
 */
export const TUTORIAL_PROVIDER_PREFIX = "tutorial";
export const TUTORIAL_MODEL_ID = "guide";
export const TUTORIAL_MODEL = `${TUTORIAL_PROVIDER_PREFIX}:${TUTORIAL_MODEL_ID}`;

/** Marker written to `projects.traits` / `narrators.traits` for sandbox rows. */
export const TUTORIAL_TRAIT = "tutorial";

/**
 * Content-block type marking where a lesson begins inside a REUSED tutorial
 * narrator.
 *
 * The tutorial keeps one narrator per slot across every lesson, so the user's
 * learning session reads as one continuous conversation instead of thirteen
 * disconnected ones. That reuse breaks the provider's turn counter unless the
 * count restarts here: `scriptTurnIndex` counts assistant turns, and by lesson
 * five the history holds dozens — so every lesson after the first would open on
 * its `fallbackTurn` ("this lesson's script is finished") without a single error
 * to notice.
 *
 * A message row rather than a narrator column because the boundary must live in
 * the same ordered stream the provider already receives: `buildHistory` is handed
 * messages, not the narrator row, and the row also has to be visible to the
 * reader as "a new lesson starts here".
 */
export const TUTORIAL_LESSON_BOUNDARY_BLOCK = "tutorial_lesson_boundary";

/**
 * Model-facing text for a lesson boundary row.
 *
 * The scripted provider ignores this text — it plays `turns[index]` regardless —
 * but the row is a real `sys` message that a compact or an export would read, and
 * a blank one there would look like a bug. Localized because the reader sees the
 * same row.
 */
export function tutorialLessonBoundaryText(lessonTitle: string, locale?: Locale | string): string {
	const text: LocalizedText = {
		en: `A new tutorial lesson starts here: ${lessonTitle}. Everything above is the earlier part of this same learning session and stays available as context.`,
		"zh-CN": `新的教程课程从这里开始：${lessonTitle}。上面的内容是同一个学习会话中较早的部分，仍然作为上下文保留。`,
	};
	return pickLocalizedValue(text, locale);
}

// ---------------------------------------------------------------------------
// Lesson structure
// ---------------------------------------------------------------------------

/**
 * Which of the three first-version tracks a lesson belongs to.
 *
 * Tracks are the grouping the overview page renders, and they also decide what
 * the lesson needs provisioned: `chapters` lessons require the sandbox git
 * project, while `conversation` lessons can run on a standalone narrator.
 */
export type TutorialTrack = "conversation" | "chapters" | "subagents";

export const TUTORIAL_TRACKS: readonly TutorialTrack[] = ["conversation", "chapters", "subagents"];

/**
 * When a step counts as done.
 *
 * Every variant is derived from state the product ALREADY publishes (narrator
 * status, existing WS frames, chapter edges, spec files). Adding a
 * tutorial-specific event would mean the tutorial passes while the real feature
 * is broken — the completion signal has to be the same one the feature itself
 * produces.
 */
export type TutorialCompletion =
	/** The user submitted a message in the composer. */
	| { kind: "userSentMessage" }
	/** The narrator finished its turn and went back to idle. */
	| { kind: "narratorIdle" }
	/** A permission request was decided; optionally pinned to one decision. */
	| { kind: "permissionResolved"; decision?: "allow" | "deny" }
	/** A specific tool reached a terminal status. */
	| { kind: "toolCompleted"; toolName: string }
	/** The narrator spawned a subagent. */
	| { kind: "subagentSpawned" }
	/** A fork edge appeared for the sandbox chapter. */
	| { kind: "chapterForked" }
	/** A merge edge appeared for the sandbox chapter. */
	| { kind: "chapterMerged" }
	/** `spec://tasks.json` gained at least one task. */
	| { kind: "specTaskWritten" }
	/** Nothing to detect — the user reads and clicks through. */
	| { kind: "manual" };

export interface TutorialStepSource {
	id: string;
	instruction: LocalizedText;
	hint?: LocalizedText;
	completion: TutorialCompletion;
}

export interface TutorialLessonSource {
	id: string;
	track: TutorialTrack;
	/** Display order within the track. */
	order: number;
	title: LocalizedText;
	summary: LocalizedText;
	/**
	 * Lessons that make this one easier to follow. Surfaced as a hint, never a
	 * hard gate: the user explicitly asked to be able to practise a single
	 * feature without replaying the whole sequence.
	 */
	recommendedAfter?: string[];
	needs: TutorialNeeds;
	steps: TutorialStepSource[];
}

export interface TutorialNeeds {
	/**
	 * Requires the sandbox git project (and therefore a chapter + worktree).
	 * Implied by `narrator: "chapter"`, but stated separately because a lesson
	 * may want the project without binding its narrator to a chapter.
	 */
	project?: boolean;
	/** Whether the lesson's narrator is standalone or bound to the sandbox chapter. */
	narrator: "standalone" | "chapter";
}

// ---------------------------------------------------------------------------
// Script structure
// ---------------------------------------------------------------------------

/**
 * One tool call the scripted model performs.
 *
 * The provider streams the arguments in chunks so the phase BEFORE execution —
 * the model still writing its arguments — is visible, which is the part of a tool
 * card newcomers find most confusing.
 *
 * **Key order in `input` is meaningful.** The provider serialises the object with
 * `JSON.stringify`, which preserves insertion order, and the loop's field
 * extractor reports whichever field is currently being written. Declaring
 * `old_string` before `new_string` on an `Edit` is therefore what produces the
 * card's "matching → replacing" transition; swapping them changes what the user
 * sees, with nothing to warn you.
 */
export interface TutorialScriptToolUse {
	/** Must match a registered tool name (`lessons.guard.test.ts` asserts this). */
	name: string;
	input: Record<string, unknown>;
	/**
	 * Input fields whose value is copy the USER reads, keyed by field name.
	 *
	 * Needed because most tool arguments are machine-facing (a path, a pattern) and
	 * correctly stay untranslated, while a few are prose the lesson is teaching
	 * through: `ExitPlanMode`'s `inline_plan` is a document the user reads and
	 * approves. Leaving it in `input` would show a zh-CN learner an English plan
	 * inside an otherwise-Chinese lesson, with nothing to report the mismatch.
	 *
	 * Resolved into `input` by `resolveTutorialTurn`, so nothing downstream needs to
	 * know this field exists.
	 */
	localizedInput?: Record<string, LocalizedText>;
}

export interface TutorialScriptTurn {
	reasoning?: LocalizedText;
	text?: LocalizedText;
	toolUses?: TutorialScriptToolUse[];
}

export interface TutorialScript {
	lessonId: string;
	/**
	 * Consumed by index: the Nth `chat()` call of the session plays `turns[N]`.
	 * The index is derived from the history the loop hands the provider, never
	 * from provider state — a fresh adapter is constructed per resolution.
	 */
	turns: TutorialScriptTurn[];
	/** Played once the scripted turns run out, so the session never dead-ends. */
	fallbackTurn: TutorialScriptTurn;
	/**
	 * Per-subagent-type scripts, keyed by type (`explore`, `general`, …).
	 *
	 * A subagent runs its own full agent loop, so it needs its own turns. Keeping
	 * them under the parent lesson rather than as separate lessons matters because
	 * the type is what should differ: an `explore` agent is read-only and a
	 * `general` agent writes, and a lesson where both recite the same lines teaches
	 * that the distinction is cosmetic when it is not.
	 *
	 * A type with no entry falls back to this script's own `fallbackTurn`, so an
	 * unexpected subagent type answers something sensible instead of nothing.
	 */
	subagentTurns?: Record<string, TutorialScriptTurn[]>;
	/**
	 * Fixed answers for the non-streaming `generate*` paths.
	 *
	 * These should never be reached in a well-formed lesson (titles are written
	 * at creation time and compact is not part of the first version), but a
	 * scripted provider that throws there would take the whole tutorial down over
	 * an auxiliary call. Degrading to a canned line is the safer failure.
	 */
	generateResponses?: {
		summary?: LocalizedText;
		title?: LocalizedText;
	};
}

// ---------------------------------------------------------------------------
// Resolved (locale-picked) shapes returned to callers
// ---------------------------------------------------------------------------

export interface TutorialStep {
	id: string;
	instruction: string;
	hint?: string;
	completion: TutorialCompletion;
}

export interface TutorialLesson {
	id: string;
	track: TutorialTrack;
	order: number;
	title: string;
	summary: string;
	recommendedAfter: string[];
	needs: TutorialNeeds;
	steps: TutorialStep[];
}

export interface TutorialLessonSummary {
	id: string;
	track: TutorialTrack;
	order: number;
	title: string;
	summary: string;
	recommendedAfter: string[];
	needs: TutorialNeeds;
	stepCount: number;
}

// ---------------------------------------------------------------------------
// Lesson catalog
// ---------------------------------------------------------------------------

const lessons: TutorialLessonSource[] = [
	{
		id: "first-turn",
		track: "conversation",
		order: 1,
		title: {
			en: "Your first turn",
			"zh-CN": "第一次对话",
		},
		summary: {
			en: "Send a message and watch the narrator go through reasoning, answer, then idle. No API is called — the tutorial narrator runs from a script.",
			"zh-CN":
				"发一条消息，看叙述者依次完成推理、回答、回到空闲。不调用任何 API，教程叙述者按剧本运行。",
		},
		needs: { narrator: "standalone" },
		steps: [
			{
				id: "send",
				instruction: {
					en: "Type anything and send it. The tutorial narrator answers from a script — no AI API is called and nothing is billed.",
					"zh-CN":
						"在输入框里随便输点什么并发送。教程叙述者按剧本回复，不调用任何 AI API，也不消耗额度。",
				},
				hint: {
					en: "Enter sends; Shift+Enter adds a newline.",
					"zh-CN": "回车发送，Shift+回车换行。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "observe",
				instruction: {
					en: "A reasoning block appears before the answer. Reasoning is the model's private thinking — stored and replayable, but not the answer itself.",
					"zh-CN": "回答之前会出现推理块。推理是模型的私有思考过程，可保存回看，但它本身不是答案。",
				},
				hint: {
					en: "Reasoning blocks can be collapsed; there is a global preference for whether they start expanded.",
					"zh-CN": "推理块可以折叠；是否默认展开有一个全局偏好设置。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "idle",
				instruction: {
					en: "Wait for the status to return to idle. A narrator is a session, not a request — it keeps its full history ready for the next turn.",
					"zh-CN": "等状态回到空闲。叙述者是一个会话，不是一次请求，它带着完整历史等待下一轮。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
	{
		id: "tool-calls",
		track: "conversation",
		order: 2,
		title: {
			en: "How tool calls read",
			"zh-CN": "读懂工具调用",
		},
		summary: {
			en: "A tool card has phases. The earliest one means the model is still writing the arguments — nothing has run yet. Watch Glob, Read, and Grep produce three different card shapes.",
			"zh-CN":
				"工具卡片分阶段。最早出现的阶段表示模型还在写参数，还没执行。观察 Glob、Read、Grep 产生三种不同形态的卡片。",
		},
		recommendedAfter: ["first-turn"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send any message to start the turn. The sandbox files are real files on disk — the tool output you will see is not simulated.",
					"zh-CN":
						"发一条消息开始这一轮。沙盒里的文件是磁盘上真实存在的，你看到的工具输出不是模拟的。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "watch-arguments",
				instruction: {
					en: "Watch a card appear with only the tool name visible — the arguments are not filled in yet. The model is still writing the call and nothing has executed.",
					"zh-CN":
						"注意卡片会先只显示工具名，参数尚未填入。此时模型还在书写这次调用，还没有执行任何操作。",
				},
				hint: {
					en: "The next phase is 'executing', which is when the tool actually runs.",
					"zh-CN": "紧接着的阶段才是「执行中」，工具才真正开始运行。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "read-ran",
				instruction: {
					en: "Wait for the Read call to finish, then click the card to expand it. The output shown is exactly what the model saw.",
					"zh-CN": "等 Read 调用完成后，点开卡片。里面显示的输出就是模型看到的内容。",
				},
				completion: { kind: "toolCompleted", toolName: "Read" },
			},
			{
				id: "grep-ran",
				instruction: {
					en: "Wait for the Grep call to finish. The results are real matched lines from the file — a tool card is evidence, not a claim.",
					"zh-CN": "等 Grep 调用完成。结果是文件里真实命中的行，工具卡片是证据，不是模型的断言。",
				},
				completion: { kind: "toolCompleted", toolName: "Grep" },
			},
			{
				id: "turn-done",
				instruction: {
					en: "Wait for the turn to finish. Multiple tools can run in one turn — the narrator goes idle only after all of them complete.",
					"zh-CN": "等这一轮结束。一轮可以跑多个工具，所有工具都完成后叙述者才回到空闲。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
	{
		id: "permissions",
		track: "conversation",
		order: 3,
		title: {
			en: "Approving and refusing",
			"zh-CN": "批准与拒绝",
		},
		summary: {
			en: "Write operations stop and ask for approval; read-only calls run silently. Approve or refuse, and see that a refusal is fed back as the tool result.",
			"zh-CN": "写操作会停下来等你批准，只读操作直接运行。批准或拒绝后，看叙述者如何处理你的决定。",
		},
		recommendedAfter: ["tool-calls"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send any message to start the turn. The narrator is in `default` permission mode, which asks before every change.",
					"zh-CN": "随便发一条消息开始这一轮。叙述者处于 `default` 权限模式，每次改动前都会询问。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "decide",
				instruction: {
					en: "A Write call stops for your approval. Read what it plans to write, then approve or refuse.",
					"zh-CN": "一次 Write 调用会停下来等你决定。先看清它要写什么，再批准或拒绝。",
				},
				hint: {
					en: "If you refuse, your reason is sent back to the model as the tool result — it can then try a different approach.",
					"zh-CN": "拒绝时你给的理由会作为工具结果回传给模型，它可以据此换个做法。",
				},
				completion: { kind: "permissionResolved" },
			},
			{
				id: "aftermath",
				instruction: {
					en: "Watch what the narrator does next. Approve → the call executes. Refuse → your refusal becomes the tool result and the turn continues.",
					"zh-CN":
						"观察叙述者接下来的动作。批准则执行；拒绝则把你的理由作为工具结果，这一轮从那里继续。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "turn-done",
				instruction: {
					en: "Wait for the turn to finish. `default` mode asks every time; looser permission modes reduce interruptions but give the model more autonomy.",
					"zh-CN":
						"等待这一轮结束。`default` 模式每次都问；更宽松的权限模式减少询问，但模型会更自主。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
	{
		id: "interrupt-and-queue",
		track: "conversation",
		order: 4,
		title: {
			en: "Interrupting a turn",
			"zh-CN": "打断一轮工作",
		},
		summary: {
			en: "You can stop a running turn at any time. Output produced so far is kept, the narrator returns to idle, and the session history stays intact.",
			"zh-CN": "可以随时停掉正在运行的那一轮。已产生的输出保留在记录里，叙述者回到空闲状态。",
		},
		recommendedAfter: ["tool-calls"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send any message to start the turn. It runs a slow command on purpose so you have time to interrupt.",
					"zh-CN": "发一条消息开始这一轮。它会故意跑一条慢命令，给你时间去中断。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "interrupt",
				instruction: {
					en: "While the command is running, press the stop button in the header. The narrator returns to idle and everything already produced stays in the transcript.",
					"zh-CN": "命令运行期间，按下头部的停止按钮。叙述者会回到空闲，已产生的输出保留在记录里。",
				},
				hint: {
					en: "You can also just type: your message will be queued and delivered at the next safe boundary instead of cutting the turn short.",
					"zh-CN": "也可以直接输入：消息会排队，在下一个安全边界送达，不会砍断这一轮。",
				},
				completion: { kind: "narratorIdle" },
			},
			{
				id: "inspect",
				instruction: {
					en: "Scroll up to see what survived. An interrupted turn is part of the session history, not an error.",
					"zh-CN": "往上翻看保留下来的内容。被中断的那一轮是会话历史的一部分，不是错误。",
				},
				completion: { kind: "manual" },
			},
		],
	},
	{
		id: "plan-mode",
		track: "conversation",
		order: 5,
		title: {
			en: "Plan before code",
			"zh-CN": "先计划再动手",
		},
		summary: {
			en: "The narrator can investigate read-only first, then hand you a plan to approve before touching any file.",
			"zh-CN": "叙述者可以先只读地调查，再交出一份计划让你审批，之后才改第一个文件。",
		},
		recommendedAfter: ["permissions"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send any message to start the turn. The narrator enters plan mode — it can read and search, but write tools are unavailable.",
					"zh-CN": "发一条消息开始这一轮。叙述者会进入计划模式：可以读取和搜索，写入工具不可用。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "investigating",
				instruction: {
					en: "Watch it investigate before proposing anything. In plan mode, writing is blocked at the tool level, not by a promise.",
					"zh-CN": "注意它在提出方案之前先去调查。计划模式下写入被工具层拦截，不是靠约定。",
				},
				completion: { kind: "toolCompleted", toolName: "Grep" },
			},
			{
				id: "review-plan",
				instruction: {
					en: "Read the plan and approve or send it back. No file has changed yet — this is the lowest-cost point to disagree.",
					"zh-CN":
						"读一读这份计划，然后批准或打回。此时还没有任何文件被改动，是提出异议成本最低的地方。",
				},
				hint: {
					en: "Sending it back with a reason is better than approving a plan you only half agree with.",
					"zh-CN": "带上理由打回，比批准一份你只同意一半的计划更好。",
				},
				completion: { kind: "permissionResolved" },
			},
			{
				id: "turn-done",
				instruction: {
					en: "Wait for the turn to finish. Approving exits plan mode; the narrator can then make the changes it described.",
					"zh-CN": "等这一轮结束。批准计划后退出计划模式，叙述者随后可以执行它描述过的改动。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
	{
		id: "spec-tasks",
		track: "conversation",
		order: 6,
		title: {
			en: "The task queue",
			"zh-CN": "任务队列",
		},
		summary: {
			en: "Long conversations get compacted, and things only said earlier can be lost. spec://tasks.json survives compaction and keeps unfinished tasks in front of the narrator.",
			"zh-CN":
				"长对话会被压缩，只靠「之前说过」的内容可能丢失。spec://tasks.json 在压缩后仍然存在，未完成的任务会被反复提醒。",
		},
		recommendedAfter: ["tool-calls"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send any message to start the turn.",
					"zh-CN": "发一条消息，开始这一轮。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "tasks-written",
				instruction: {
					en: "Watch it write spec://tasks.json. That path is not in your repository — it is the narrator's own scratch space, and writing it needs no approval.",
					"zh-CN":
						"观察它写入 spec://tasks.json。那个路径不在你的仓库里，是叙述者自己的暂存空间，写入不需要审批。",
				},
				completion: { kind: "specTaskWritten" },
			},
			{
				id: "board",
				instruction: {
					en: "Open the Spec panel from the header to see the same tasks as a board. Unfinished tasks are what a resumed or auto-continued session picks up from.",
					"zh-CN":
						"从头部打开 Spec 面板，以看板形式查看同一批任务。未完成的任务是会话恢复或自动续跑时接着做的起点。",
				},
				hint: {
					en: "Only finite, checkable work belongs here. A rule with no end condition has no place in a queue.",
					"zh-CN": "队列里只放有限、可判断做完没做完的工作。没有终点的规则不属于这里。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "turn-done",
				instruction: {
					en: "Wait for the turn to finish.",
					"zh-CN": "等这一轮结束。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},

	// --- Track B: NarraFlow and chapters ---

	{
		id: "project-and-chapter",
		track: "chapters",
		order: 1,
		title: {
			en: "Repositories and chapters",
			"zh-CN": "仓库与章节",
		},
		summary: {
			en: "A narraflow is a git repository. A chapter is a worktree with its own branch and session. Two chapters can hold different versions of the same file at the same time.",
			"zh-CN":
				"一条叙事线就是一个 git 仓库。一个章节就是一个 worktree，有独立的分支和会话。两个章节可以同时持有同一个文件的不同版本。",
		},
		recommendedAfter: ["first-turn"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send any message. The narrator's working directory is this chapter's worktree, not a shared checkout.",
					"zh-CN": "随便发一条消息。叙述者的工作目录是这个章节的 worktree，不是共享检出。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "see-worktree",
				instruction: {
					en: "Check the Bash output: a branch name and a directory that belong to this chapter alone.",
					"zh-CN": "看 Bash 的输出：一个分支名和一个目录，都只属于这个章节。",
				},
				hint: {
					en: "Two chapters don't share a directory, so they can't conflict over the same file.",
					"zh-CN": "两个章节目录不同，不会争抢同一个文件。",
				},
				completion: { kind: "toolCompleted", toolName: "Bash" },
			},
			{
				id: "history",
				instruction: {
					en: "The sandbox repository already has 4 commits. The next lesson forks from this history.",
					"zh-CN": "沙盒仓库已有 4 个提交。下一课会从这段历史分叉。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "turn-done",
				instruction: {
					en: "Wait for the turn to finish.",
					"zh-CN": "等待这一轮结束。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
	{
		id: "fork",
		track: "chapters",
		order: 2,
		title: {
			en: "Forking a chapter",
			"zh-CN": "分叉一个章节",
		},
		summary: {
			en: "Fork creates a second branch, a second worktree, and a second session. You choose how much context the new chapter inherits.",
			"zh-CN": "分叉会创建第二个分支、第二个 worktree 和第二个会话。你决定新章节继承多少上下文。",
		},
		recommendedAfter: ["project-and-chapter"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "open-fork",
				instruction: {
					en: "Fork this chapter from the graph or the chapter menu. Forking is a structural action — you do not need to send a message first.",
					"zh-CN": "从图上或章节菜单里对本章节执行分叉。分叉是结构性操作，不需要先发消息。",
				},
				hint: {
					en: "full inherits the whole conversation, compressed inherits a summary, fresh starts clean. Pick fresh when the previous approach was wrong, so its reasoning is not inherited too.",
					"zh-CN":
						"full 继承完整对话，compressed 继承摘要，fresh 从零开始。上一条路走错了就选 fresh，否则错误的推理会一起被继承过去。",
				},
				completion: { kind: "chapterForked" },
			},
			{
				id: "two-worktrees",
				instruction: {
					en: "You now have two chapters on two branches, each with its own directory and session. Editing a file in one leaves the other untouched.",
					"zh-CN":
						"现在你有两个章节，各自在独立分支上，有独立目录和独立会话。在一个里改文件，另一个不受影响。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "why",
				instruction: {
					en: "Two forks can explore incompatible designs at the same time. Afterwards you decide which one to merge.",
					"zh-CN": "两个分叉可以同时探索互不兼容的方案。之后你再决定合并哪一个。",
				},
				completion: { kind: "manual" },
			},
		],
	},
	{
		id: "graph",
		track: "chapters",
		order: 3,
		title: {
			en: "Reading the story network",
			"zh-CN": "读懂故事网络图",
		},
		summary: {
			en: "The graph is the project's main view. Click a node to open that chapter's session. Edges record what actually happened; roles are visual labels only.",
			"zh-CN":
				"这张图是项目的主界面。点击节点直接打开该章节的会话。边记录已发生的关系，角色只是视觉标签。",
		},
		recommendedAfter: ["fork"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "open-graph",
				instruction: {
					en: "Open the narraflow view for this project. The fork you just made appears as an edge between two nodes.",
					"zh-CN": "打开这个项目的叙事线视图。你刚才做的分叉，会显示为两个节点之间的一条边。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "roles",
				instruction: {
					en: "Node colour shows the chapter's role: trunk receives merges, branch is ordinary work, exploration is a candidate you can discard, review is a code review. Roles are labels, not permissions.",
					"zh-CN":
						"节点颜色对应章节角色：trunk 接收合并，branch 是普通工作分支，exploration 是可丢弃的候选方案，review 是代码评审。角色只是标签，不限制你的操作。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "edges",
				instruction: {
					en: "Edge types: fork, merge, dependency, cherry_pick, review. All except dependency are records of past events. A dependency edge you declare yourself — it tells the system to warn you when the upstream chapter changes.",
					"zh-CN":
						"边的类型有五种：fork、merge、dependency、cherry_pick、review。除 dependency 外，其余都是已发生事件的记录。dependency 由你自己声明，上游章节变化时系统会提醒你。",
				},
				hint: {
					en: "Click a node to open its session — the graph is a navigation surface, not a read-only picture.",
					"zh-CN": "点击节点即可打开它的会话，这张图是导航界面，不是只读图片。",
				},
				completion: { kind: "manual" },
			},
		],
	},
	{
		id: "merge",
		track: "chapters",
		order: 4,
		title: {
			en: "Merging and letting go",
			"zh-CN": "合并与放手",
		},
		summary: {
			en: "Merge a branch back into its parent. Learn the three ways a chapter ends and why none of them delete your conversation.",
			"zh-CN": "把章节合并回父章节。了解章节结束的三种状态，以及为什么三种都不会删掉对话记录。",
		},
		recommendedAfter: ["fork"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "merge-back",
				instruction: {
					en: "Merge a chapter back into its parent. NarraFork runs a conflict check first and reports the result before touching anything.",
					"zh-CN": "把一个章节合并回它的父章节。NarraFork 会先做冲突检查，告知结果后再动手。",
				},
				hint: {
					en: "If there are conflicts, resolve them yourself or hand them to the narrator. The merge is not applied until all conflicts are resolved.",
					"zh-CN": "有冲突时，可以自己解决，也可以交给叙述者。冲突解决前合并不会被应用。",
				},
				completion: { kind: "chapterMerged" },
			},
			{
				id: "merge-edge",
				instruction: {
					en: "A merge edge now records the relationship. The merged chapter is not deleted — its history and conversation stay readable.",
					"zh-CN":
						"合并完成后会留一条 merge 边记录这件事。被合并的章节不会被删除，历史和对话仍然可读。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "dormant",
				instruction: {
					en: "Mark a chapter dormant to remove its worktree and free disk space. The branch stays. Waking it recreates the directory.",
					"zh-CN": "把章节标为休眠，会移除它的 worktree 并释放磁盘。分支保留，唤醒时目录会被重建。",
				},
				completion: { kind: "manual" },
			},
		],
	},

	// --- Track C: subagents and background work ---

	{
		id: "subagent-types",
		track: "subagents",
		order: 1,
		title: {
			en: "Delegating to subagents",
			"zh-CN": "委派给子代理",
		},
		summary: {
			en: "A subagent is a real second narrator with its own context window. What returns to the main conversation is only a summary. The type sets what it can do — explore cannot write.",
			"zh-CN":
				"子代理是一个真实的第二个叙述者，有自己的上下文窗口。回到主对话的只是归纳，不是它读过的内容。类型决定它能做什么——explore 不能写入。",
		},
		recommendedAfter: ["tool-calls"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send any message. The narrator will delegate part of the work to a subagent instead of doing it inline.",
					"zh-CN": "随便发一条消息。叙述者会把一部分工作委派给子代理，而不是自己在主线里做完。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "spawned",
				instruction: {
					en: "Watch the Agent card appear. That is a real second narrator with its own context window — what it reads does not come back here.",
					"zh-CN":
						"注意出现的 Agent 卡片。那是一个真实的第二个叙述者，有自己的上下文窗口。它读到的内容不会进入当前对话。",
				},
				hint: {
					en: "Click the card to open the subagent's session and read its full transcript.",
					"zh-CN": "点击卡片可以打开子代理的会话，看到它的完整记录。",
				},
				completion: { kind: "subagentSpawned" },
			},
			{
				id: "result",
				instruction: {
					en: "Look at what came back: a summary, not the raw content it read. If a subagent returned everything it saw, the context savings would be lost — it would all end up here anyway.",
					"zh-CN":
						"看回传的是什么：一份归纳，不是它读过的原始内容。子代理要是把看到的全部带回来，这些内容还是会落到主对话里，委派就白做了。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "types",
				instruction: {
					en: "Four types, each with different authority: `explore` is read-only, `plan` designs but does not implement, `review` inspects a diff, `general` can write. Pick the narrowest one that can do the job.",
					"zh-CN":
						"四种类型，权限各不相同：`explore` 只读，`plan` 只设计不实现，`review` 检查差异，`general` 可以写入。选能完成任务的最小权限那个。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
	{
		id: "background-tasks",
		track: "subagents",
		order: 2,
		title: {
			en: "Work that runs in the background",
			"zh-CN": "在后台运行的工作",
		},
		summary: {
			en: "An Agent card with run_in_background returns a task id immediately. The turn is not blocked. Use Await to collect the result when you actually need it.",
			"zh-CN":
				"带 run_in_background 的 Agent 卡片立刻返回任务 id，这一轮不会被卡住。需要结果时再用 Await 来取。",
		},
		recommendedAfter: ["subagent-types"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send any message. The narrator starts a subagent in the background instead of waiting for it to finish.",
					"zh-CN": "发一条消息。叙述者在后台启动子代理，不等它跑完。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "backgrounded",
				instruction: {
					en: "The Agent card returns a task id, not a result. The subagent is still running; this turn is already done.",
					"zh-CN": "Agent 卡片返回的是任务 id，不是结果。子代理还在跑，这一轮已经结束了。",
				},
				completion: { kind: "subagentSpawned" },
			},
			{
				id: "drawer",
				instruction: {
					en: "Open the background tasks drawer in the header to see the running task.",
					"zh-CN": "从头部打开后台任务抽屉，可以看到这个任务还在运行。",
				},
				hint: {
					en: "The narrator uses Await to collect a finished task. You do not need to poll it yourself.",
					"zh-CN": "叙述者用 Await 收取完成的任务，不需要你自己轮询。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "turn-done",
				instruction: {
					en: "Wait for the turn to finish. A background task can outlive the turn that started it.",
					"zh-CN": "等这一轮结束。后台任务可以比启动它的那一轮活得更久。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
	{
		id: "team-coordination",
		track: "subagents",
		order: 3,
		title: {
			en: "Several agents at once",
			"zh-CN": "多个代理同时工作",
		},
		summary: {
			en: "Independent tasks can run in parallel. Know when to wait quietly and when to interrupt.",
			"zh-CN": "互不依赖的任务可以并行。知道什么时候等待，什么时候才该中断。",
		},
		recommendedAfter: ["background-tasks"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send any message. Two subagents are spawned in the same turn because their files don't overlap.",
					"zh-CN": "随便发一条消息。两个子代理会在同一轮派生，因为它们各看各的文件，互不干扰。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "parallel",
				instruction: {
					en: "Both subagent cards appear at the same time. Parallel is only safe when neither side needs the other's answer — if it does, one of them proceeds on a guess.",
					"zh-CN":
						"两张子代理卡片同时出现。只有两边都不需要对方的答案，并行才安全。有依赖还硬要并行，其中一个只能靠猜。",
				},
				completion: { kind: "subagentSpawned" },
			},
			{
				id: "waiting",
				instruction: {
					en: "The narrator waits without nudging. A timed-out wait means the wait ended, not that the agent is stuck. Sending a status check costs the agent context and interrupts its work.",
					"zh-CN":
						"叙述者只等待，不去催。等待超时只表示这次等待结束了，不代表代理卡住了。发一句「进展如何」会浪费它的上下文，还会打断它。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "turn-done",
				instruction: {
					en: "Wait for the turn to finish. Both results come back as summaries and the main conversation stays readable.",
					"zh-CN": "等这一轮结束。两份结果以归纳形式返回，主对话保持可读。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
];

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

/**
 * A `${...}` sequence that belongs to the DISPLAYED text, not to this module.
 *
 * Scripts quote code, and code contains template placeholders. Writing one as a
 * plain `"${name}"` literal makes Biome suggest converting the quotes to a
 * template string, which would interpolate at build time and render
 * `Hello, undefined!` to the user. Same reasoning as `sandbox-files.ts`.
 */
function literalInterpolation(expression: string): string {
	return `\${${expression}}`;
}

const scripts: Record<string, TutorialScript> = {
	"first-turn": {
		lessonId: "first-turn",
		turns: [
			{
				reasoning: {
					en: "This is the first turn of the tutorial. I should show what a turn looks like, not solve a task. Short reasoning block, short answer, no tools.",
					"zh-CN":
						"这是教程的第一轮。我要展示一轮对话长什么样，而不是解决任务。推理块短，回答短，不用工具。",
				},
				text: {
					en: [
						"Three things just happened:",
						"",
						"1. **Reasoning** streamed first. That block is my private thinking — persisted and replayable, but not the answer.",
						"2. **This text** streamed second. It is the answer, rendered as Markdown.",
						"3. **The status** is returning to `idle`. That means the turn is finished. A narrator is a session: what you send next continues from here.",
						"",
						"One more thing: I am a **scripted** narrator for this tutorial. No API was called, nothing was billed. Everything else — the message rows, the status transitions, the persistence — is the real product.",
					].join("\n"),
					"zh-CN": [
						"刚刚发生了三件事：",
						"",
						"1. **推理块**先流出来。这是我的私有思考，会被保存可供回看，但它不是答案。",
						"2. **这段正文**随后流出。这才是答案，按 Markdown 渲染。",
						"3. **状态**正在回到 `idle`。这代表这一轮结束。叙述者是一个会话：你接下来发的内容会从这里继续。",
						"",
						"还有一点：在这个教程里我是**按剧本走**的叙述者。没有调用任何 API，也没有产生费用。你看到的其余一切——消息行、状态变化、持久化——都是真实的产品行为。",
					].join("\n"),
				},
			},
		],
		fallbackTurn: {
			text: {
				en: "This lesson's script is finished. Move on to the next lesson, or reset this one from the step panel to replay it.",
				"zh-CN": "这一课的剧本已经走完了。可以进入下一课，或从步骤面板重置本课重新走一遍。",
			},
		},
		generateResponses: {
			title: {
				en: "Tutorial: your first turn",
				"zh-CN": "教程：第一次对话",
			},
			summary: {
				en: "Tutorial session — nothing to summarise.",
				"zh-CN": "教程会话，没有需要总结的内容。",
			},
		},
	},

	"tool-calls": {
		lessonId: "tool-calls",
		turns: [
			{
				reasoning: {
					en: "Show three read-only tools with different card shapes: Glob (path list), Read (file with line numbers), Grep (match list). All against real sandbox files.",
					"zh-CN":
						"演示三个卡片形态不同的只读工具：Glob（路径列表）、Read（带行号的文件）、Grep（命中列表）。全部针对沙盒真实文件。",
				},
				text: {
					en: "Let me look at what is actually in this repository before saying anything about it.",
					"zh-CN": "先看看这个仓库里实际有什么，再做判断。",
				},
				toolUses: [
					{ name: "Glob", input: { pattern: "src/*.ts" } },
					{ name: "Read", input: { file_path: "src/greeting.ts" } },
					{ name: "Grep", input: { pattern: "Hello", output_mode: "content", "-n": true } },
				],
			},
			{
				reasoning: {
					en: "The reads confirmed the duplication. Report it as an observation backed by the cards, not a claim the user has to take on trust.",
					"zh-CN": "读取确认了重复。把它作为有卡片为证的观察来报告，不是让用户凭信任接受的断言。",
				},
				text: {
					en: [
						"Three cards, three shapes:",
						"",
						"- **Glob** listed paths. It answers *what files exist*, not *what is inside them*.",
						"- **Read** returned `src/greeting.ts` with line numbers. What you see in that card is exactly what I saw.",
						"- **Grep** returned matching lines. Two hits: `greet` and `greetLoudly` both build the same template independently.",
						"",
						"That duplication should be fixed. The next lesson covers what happens when a tool wants to change a file: it stops and asks you first.",
					].join("\n"),
					"zh-CN": [
						"三张卡片，三种形态：",
						"",
						"- **Glob** 列出了路径，回答的是*有哪些文件*，不涉及文件内容。",
						"- **Read** 返回了带行号的 `src/greeting.ts`，卡片里的内容就是我看到的原文。",
						"- **Grep** 返回了命中行。两处：`greet` 和 `greetLoudly` 各自拼了同一个模板。",
						"",
						"这个重复应该修掉。下一课讲改文件时会发生什么：任何改动都会先停下来问你。",
					].join("\n"),
				},
			},
		],
		fallbackTurn: {
			text: {
				en: "This lesson's script has ended. The next lesson covers what happens when a tool wants to change a file instead of just reading it.",
				"zh-CN": "本课剧本到此结束。下一课讲的是工具想要修改文件时会发生什么。",
			},
		},
		generateResponses: {
			title: {
				en: "Tutorial: how tool calls read",
				"zh-CN": "教程：读懂工具调用",
			},
		},
	},

	permissions: {
		lessonId: "permissions",
		turns: [
			{
				reasoning: {
					en: "I'll create a new file rather than edit an existing one — easier to evaluate when approving, and no half-changed state if refused.",
					"zh-CN": "新建文件比修改现有文件更容易审批，拒绝后也不会留下半改的状态。",
				},
				text: {
					en: "I want to add a short note recording what I found. Creating a file changes your machine, so I need your approval first.",
					"zh-CN": "我想新建一个文件，记录我发现的问题。创建文件会改动你的机器，需要你先批准。",
				},
				toolUses: [
					{
						name: "Write",
						input: {
							file_path: "notes-from-tutorial.md",
							content: [
								"# Tutorial note",
								"",
								"`greet` and `greetLoudly` in `src/greeting.ts` build the same template twice.",
								"",
								"Created by the NarraFork tutorial. Safe to delete.",
								"",
							].join("\n"),
						},
					},
				],
			},
			{
				reasoning: {
					en: "The user has decided. If refused, that refusal is the tool result — I should change approach, not retry the same call.",
					"zh-CN":
						"用户已经决定了。如果被拒绝，拒绝就是工具结果，我应该换思路，不该重试同一个调用。",
				},
				text: {
					en: [
						"Here is what just happened:",
						"",
						"- **Approved** — the call executed and the result is in the card.",
						"- **Refused** — your refusal (and reason, if given) became the tool result. I treat it like any other outcome and change approach instead of asking again.",
						"",
						"A few things to note: read-only calls (`Read`, `Grep`, `Glob`) never ask — you saw that in the previous lesson. The `default` mode asks before every change; looser modes trade that for more autonomy. Choose based on how much you want to stay in the loop.",
					].join("\n"),
					"zh-CN": [
						"刚才发生了什么：",
						"",
						"- **批准** — 调用已执行，结果在卡片里。",
						"- **拒绝** — 你的拒绝（以及理由，如果有）成为该工具的结果。我会换思路，不会再试同一个调用。",
						"",
						"几点说明：只读调用（`Read`、`Grep`、`Glob`）从不询问，上一课已经看到了。`default` 模式每次改动前都问；更宽松的权限模式减少询问，但模型更自主。根据自己想介入的程度来选。",
					].join("\n"),
				},
			},
		],
		fallbackTurn: {
			text: {
				en: "That is the end of this lesson's script.",
				"zh-CN": "本课剧本到此结束。",
			},
		},
		generateResponses: {
			title: { en: "Tutorial: approving and refusing", "zh-CN": "教程：批准与拒绝" },
		},
	},

	"interrupt-and-queue": {
		lessonId: "interrupt-and-queue",
		turns: [
			{
				reasoning: {
					en: "Run a slow but harmless command with visible progress. If the user does nothing, it finishes on its own — no one gets stuck.",
					"zh-CN":
						"跑一条慢但无害、有进度输出的命令。用户什么都不做，它会自己跑完，不会卡住任何人。",
				},
				text: {
					en: "I will run something slow on purpose. Press the stop button in the header while it is going.",
					"zh-CN": "我故意跑一个慢的东西。它运行期间，请按下头部的停止按钮。",
				},
				toolUses: [
					{
						name: "Bash",
						input: {
							command:
								'for i in 1 2 3 4 5 6 7 8 9 10; do echo "step $i of 10"; sleep 1; done; echo done',
							description: "Print ten steps, one per second, so there is time to interrupt",
						},
					},
				],
			},
			{
				reasoning: {
					en: "Don't re-run the command. Re-running would imply interrupting did nothing — the opposite of what this lesson demonstrates.",
					"zh-CN": "不要重跑命令。重跑会暗示中断没有意义，与本课目的相反。",
				},
				text: {
					en: [
						"Whether you pressed stop or let it finish, notice what was kept: the output in the card above, the full session history, the narrator back at `idle`.",
						"",
						"Interrupting ends a turn early — it does not roll anything back.",
						"",
						"You also had another option: typing while I work queues your message for the next safe boundary. Interrupt when the direction is wrong; queue when you just have more to add.",
					].join("\n"),
					"zh-CN": [
						"不管你有没有按停止，看看保留了什么：上面卡片里的输出、完整的会话历史、叙述者回到 `idle`。",
						"",
						"中断只是提前结束那一轮，不会回滚任何东西。",
						"",
						"还有另一个选择：我工作时直接输入，消息会排队，在下一个安全边界送达。方向错了就中断，只是还有话要补充就排队。",
					].join("\n"),
				},
			},
		],
		fallbackTurn: {
			text: {
				en: "That is the end of this lesson's script.",
				"zh-CN": "本课剧本到此结束。",
			},
		},
		generateResponses: {
			title: {
				en: "Tutorial: interrupting a turn",
				"zh-CN": "教程：打断一轮工作",
			},
		},
	},

	"plan-mode": {
		lessonId: "plan-mode",
		turns: [
			{
				reasoning: {
					en: "Enter plan mode first, then investigate. Plan mode exists to prevent proposing before reading, so the script must not do it either.",
					"zh-CN":
						"先进入计划模式，再去调查。计划模式就是为了防止「没读代码就提方案」，剧本自己不能这么做。",
				},
				text: {
					en: "Let me enter plan mode and look at the code before proposing anything.",
					"zh-CN": "我先进入计划模式，读过代码再说。",
				},
				toolUses: [{ name: "EnterPlanMode", input: {} }],
			},
			{
				reasoning: {
					en: "Read-only investigation: find the duplication and check whether anything outside the file depends on the second copy before proposing a change.",
					"zh-CN": "只读调查：找出重复，并确认文件外是否有代码依赖第二处，再提改动建议。",
				},
				text: {
					en: "Checking what exists and what depends on it.",
					"zh-CN": "先确认代码现状，以及有什么依赖它。",
				},
				toolUses: [
					{ name: "Grep", input: { pattern: "greetLoudly", output_mode: "content", "-n": true } },
					{ name: "Read", input: { file_path: "src/greeting.ts" } },
				],
			},
			{
				reasoning: {
					en: "Enough information to propose a concrete plan. Keep it small enough that the user can agree or disagree with a specific line.",
					"zh-CN": "已有足够依据提出具体计划。保持计划足够小，让用户能针对某一条表态。",
				},
				text: {
					en: "Here is what I would do.",
					"zh-CN": "下面是我打算做的事。",
				},
				toolUses: [
					{
						name: "ExitPlanMode",
						input: { mode: "inline" },
						// The plan is a document the user READS and approves, so it has to
						// follow the lesson's language. Every other field here (`mode`, paths,
						// patterns) is machine-facing and correctly stays as-is.
						localizedInput: {
							inline_plan: {
								en: [
									"## Remove the duplicated greeting template",
									"",
									"**What I found**",
									"",
									`\`src/greeting.ts\` builds \`\` \`Hello, ${literalInterpolation("name")}!\` \`\` twice: once in \`greet\`, once in \`greetLoudly\`. Grep shows nothing outside this file depends on the second copy.`,
									"",
									"**Change**",
									"",
									"1. Rewrite `greetLoudly` as `return greet(name).toUpperCase();` so the template exists in one place.",
									"2. Leave `greet` alone. It is already the only source of the wording.",
									"",
									"**Not doing**",
									"",
									"Renaming either function. Nobody asked for it, and a rename touches callers and needs its own review.",
									"",
									"**Verification**",
									"",
									"Re-read the file after the edit. This sandbox has no test runner, so I will not claim tests passed.",
								].join("\n"),
								"zh-CN": [
									"## 移除重复的问候模板",
									"",
									"**发现了什么**",
									"",
									`\`src/greeting.ts\` 里有两处拼出 \`\` \`Hello, ${literalInterpolation("name")}!\` \`\`：一处在 \`greet\`，一处在 \`greetLoudly\`。Grep 显示文件外没有代码依赖第二处。`,
									"",
									"**要改的**",
									"",
									"1. 把 `greetLoudly` 改成 `return greet(name).toUpperCase();`，模板只留一处。",
									"2. `greet` 不动，它已经是文案的唯一来源。",
									"",
									"**不改的**",
									"",
									"两个函数都不改名。没人要求改名，而改名会牵动调用方，要单独评审。",
									"",
									"**怎么验证**",
									"",
									"改完重新读一遍文件。这个沙盒里没有测试运行器，所以我不会声称测试通过。",
								].join("\n"),
							},
						},
					},
				],
			},
			{
				reasoning: {
					en: "The plan is decided. Do not perform the edit — this lesson is about the planning gate. Writing after the plan step would undercut the point that nothing changes until you approve.",
					"zh-CN":
						"计划已有结论，不要真的去改。本课讲的是「计划这道关卡」，计划步骤后突然写文件会削弱「批准前什么都不变」这个要点。",
				},
				text: {
					en: [
						"Plan mode works in four steps:",
						"",
						"1. **Enter** — write tools become unavailable. Not a promise; the write path is actually blocked.",
						"2. **Investigate** — Grep and Read, so the plan is based on the actual file, not a guess.",
						"3. **Propose** — a plan small enough to disagree with a specific line.",
						"4. **Decide** — approving exits plan mode; sending it back leaves every file untouched.",
						"",
						"The ordering matters. Edits to code nobody read are the expensive kind. Plan mode puts disagreement before the change, not after.",
					].join("\n"),
					"zh-CN": [
						"计划模式分四步：",
						"",
						"1. **进入** — 写入工具不可用。不是靠约定，是路径被实际拦截。",
						"2. **调查** — 用 Grep 和 Read，让计划立足于文件本身而不是猜测。",
						"3. **提出** — 计划要小，小到你能针对某一条提出异议。",
						"4. **决定** — 批准即退出计划模式；打回则文件一字未动。",
						"",
						"次序很重要。改了没人读过的代码，代价才高。计划模式把异议放在改动之前。",
					].join("\n"),
				},
			},
		],
		fallbackTurn: {
			text: {
				en: "That is the end of this lesson's script.",
				"zh-CN": "本课剧本到此结束。",
			},
		},
		generateResponses: {
			title: {
				en: "Tutorial: plan before code",
				"zh-CN": "教程：先计划再动手",
			},
		},
	},

	"spec-tasks": {
		lessonId: "spec-tasks",
		turns: [
			{
				reasoning: {
					en: "Write a queue with finite, checkable entries. Standing rules have no completion condition and must not appear in the example.",
					"zh-CN": "写一份条目有限、可核验的队列。长期规则没有完成条件，不能出现在示例里。",
				},
				text: {
					en: "This is multi-step, so I'll write it down where it survives a compacted conversation.",
					"zh-CN": "这件事是多步骤的，我把它记到对话被压缩后也不会丢的地方。",
				},
				toolUses: [
					{
						name: "Write",
						input: {
							file_path: "spec://tasks.json",
							content: `${JSON.stringify(
								{
									tasks: [
										{
											text: "Read src/greeting.ts and confirm the duplicated template",
											status: "doing",
										},
										{ text: "Rewrite greetLoudly to call greet", status: "todo" },
										{ text: "Re-read the file and confirm one template remains", status: "todo" },
									],
								},
								null,
								"\t",
							)}\n`,
						},
					},
				],
			},
			{
				reasoning: {
					en: "Explain why the queue exists, not what is in it — the user can already see that in the panel.",
					"zh-CN": "解释队列为什么存在，不复述内容——用户在面板里已经能看到了。",
				},
				text: {
					en: [
						"That write did not ask for approval, and it did not appear in your repository. `spec://` is my own scratch space, not a path on disk.",
						"",
						"Why keep a queue? Long conversations get compacted — earlier turns are replaced by a summary to stay inside the context window. Anything that only existed as something said earlier can be lost. Tasks survive compaction, and I get reminded of unfinished ones on every continuation.",
						"",
						'Each entry above is **finite and checkable** — you can tell whether it is done. A rule like "never break the build" has no completion condition. It would sit in the queue forever. Rules belong somewhere else; the queue is for work that ends.',
					].join("\n"),
					"zh-CN": [
						"那次写入没有请求审批，也没有出现在你的仓库里。`spec://` 是我自己的暂存空间，不是磁盘上的路径。",
						"",
						"为什么要有队列？长对话会被压缩——早期轮次被摘要替换以保持在上下文窗口内。只以「我之前说过」形式存在的东西可能就此丢失。任务能在压缩后存活，未完成的每次续跑都会被提醒。",
						"",
						"上面每一条都是**有限且可核验**的——你能判断它做完了没有。像「不得破坏构建」这样的规则没有完成条件，会永远待在队列里。规则应该放在别处；队列给会结束的工作用。",
					].join("\n"),
				},
			},
		],
		fallbackTurn: {
			text: {
				en: "That is the end of this lesson's script.",
				"zh-CN": "本课剧本到此结束。",
			},
		},
		generateResponses: {
			title: {
				en: "Tutorial: the task queue",
				"zh-CN": "教程：任务队列",
			},
		},
	},

	// --- Track B ---
	//
	// These lessons are mostly about STRUCTURAL actions the user performs (fork,
	// merge, open the graph), not about what the narrator says. Their scripts exist
	// to explain the surroundings and to give the one lesson that needs a tool call
	// something real to show; the rest of the teaching is in the step instructions.

	"project-and-chapter": {
		lessonId: "project-and-chapter",
		turns: [
			{
				reasoning: {
					en: "Run git and pwd to prove isolation — a claim without output is unverifiable.",
					"zh-CN": "跑 git 和 pwd 来证明隔离，光说「已隔离」用户没法核对。",
				},
				text: {
					en: "Let me show you where this session lives.",
					"zh-CN": "我把这个会话所在的位置直接展示给你。",
				},
				toolUses: [
					{
						name: "Bash",
						input: {
							command:
								'echo "branch: $(git rev-parse --abbrev-ref HEAD)"; echo "directory: $(pwd)"; echo "commits: $(git rev-list --count HEAD)"',
							description: "Report this chapter's branch, working directory and commit count",
						},
					},
				],
			},
			{
				reasoning: {
					en: "Map the three output lines to three concrete facts: branch, directory, commit count. Skip the abstraction.",
					"zh-CN": "把三行输出对应三个具体事实：分支、目录、提交数。不要抽象化。",
				},
				text: {
					en: [
						"- **Branch**: belongs to this chapter. My commits here won't appear on any other chapter's branch until someone merges them.",
						"- **Directory**: a git *worktree* — a second checkout of the same repository. Two chapters can't conflict over one file because they don't share one.",
						"- **Commit count**: the history this chapter branched from. The next lesson forks from it.",
					].join("\n"),
					"zh-CN": [
						"- **分支**：只属于这个章节。我在这里产生的提交，合并之前不会出现在其他章节的分支上。",
						"- **目录**：一个 git *worktree*，同一仓库的第二份检出。两个章节各有自己的目录，不会争抢同一个文件。",
						"- **提交数**：这个章节分叉自的那段历史。下一课会用到它。",
					].join("\n"),
				},
			},
		],
		fallbackTurn: {
			text: {
				en: "End of this lesson's script. The next lesson forks this chapter.",
				"zh-CN": "本课剧本结束。下一课会分叉这个章节。",
			},
		},
		generateResponses: {
			title: {
				en: "Tutorial: repositories and chapters",
				"zh-CN": "教程：仓库与章节",
			},
		},
	},

	// The remaining Track B lessons are driven entirely by the user's own structural
	// actions. Their narrator exists so the surface is not empty and so a question
	// gets an answer, but no scripted turn is required to complete a step — which is
	// why each has only a fallback.
	fork: {
		lessonId: "fork",
		turns: [],
		fallbackTurn: {
			text: {
				en: "Forking is something you do to the chapter — there is nothing for me to run here.\n\nThe main choice is context inheritance:\n\n- **full** — carries this whole conversation into the new chapter. Use it when the fork continues the same line of work.\n- **compressed** — carries a summary instead. Keeps the useful conclusions without re-running every step.\n- **fresh** — starts with nothing. Use it when the previous approach was wrong: inheriting the reasoning that produced a mistake mostly copies the mistake.",
				"zh-CN":
					"分叉是你对章节做的操作，这里没有我需要执行的东西。\n\n主要选择是上下文继承：\n\n- **full** — 把当前完整对话带进新章节。分叉是同一思路的延续时使用。\n- **compressed** — 只带摘要。保留有用结论，不重复每个中间步骤。\n- **fresh** — 从零开始。之前那条路走错了就用这个：继承产生错误的推理，多半只是把错误一起搬过去。",
			},
		},
		generateResponses: {
			title: { en: "Tutorial: forking a chapter", "zh-CN": "教程：分叉一个章节" },
		},
	},

	graph: {
		lessonId: "graph",
		turns: [],
		fallbackTurn: {
			text: {
				en: "This lesson is about reading the graph, so there's nothing for me to run.\n\n**Roles** (trunk / branch / exploration / review) are labels. They change how a node looks; they don't restrict what you can do with it.\n\n**Edges** record things that actually happened — except `dependency`, which you declare yourself so the system warns you when the upstream chapter changes.",
				"zh-CN":
					"本课讲的是如何读图，没有我需要执行的操作。\n\n**角色**（trunk / branch / exploration / review）是标签，改变节点外观，不限制你能做什么。\n\n**边**记录已发生的事，唯一例外是 `dependency`：由你自己声明，上游章节变化时系统会提醒你。",
			},
		},
		generateResponses: {
			title: { en: "Tutorial: reading the story network", "zh-CN": "教程：读懂故事网络图" },
		},
	},

	merge: {
		lessonId: "merge",
		turns: [],
		fallbackTurn: {
			text: {
				en: "Merging is a structural action, so there is nothing for me to run here.\n\nThree ways a chapter ends:\n\n- **merged** — its work landed in the parent.\n- **dormant** — worktree removed, branch kept. Waking it recreates the directory. Use this when you are pausing work, not closing it.\n- **abandoned** — records that the approach did not pan out. Not a failure; cheap forks exist so some can be thrown away.\n\nNone of these delete the conversation. A rejected approach is often useful to re-read later.",
				"zh-CN":
					"合并是结构性操作，这里没有我需要执行的东西。\n\n章节结束有三种状态：\n\n- **merged** — 工作已落地到父章节。\n- **dormant** — 移除 worktree，保留分支。唤醒时目录重建。用于暂停而非关闭。\n- **abandoned** — 记录这条路没走通。这是正常结果，低成本分叉本来就允许有些分叉被丢弃。\n\n三种状态都不会删掉对话记录。",
			},
		},
		generateResponses: {
			title: { en: "Tutorial: merging and letting go", "zh-CN": "教程：合并与放手" },
		},
	},

	// --- Track C ---
	//
	// These lessons spawn REAL subagents, each running its own agent loop against
	// this same scripted provider. Their turns live under `subagentTurns`, keyed by
	// type, because the type is what should differ: an `explore` agent is read-only
	// and a `general` agent writes. See `tutorialSubagentTraits`, which writes a
	// distinct model value per type so the provider can tell them apart.

	"subagent-types": {
		lessonId: "subagent-types",
		turns: [
			{
				reasoning: {
					en: "Delegate the search so the reading stays out of the main conversation — that is the point of the lesson.",
					"zh-CN": "把搜索委派出去，让阅读过程留在主对话之外——这就是本课的要点。",
				},
				text: {
					en: "I'll send an explore agent to look around the repository. Its reading won't land in our conversation.",
					"zh-CN": "我派一个 explore 代理去查看仓库。它的阅读过程不会进入我们的对话。",
				},
				toolUses: [
					{
						name: "Agent",
						input: {
							description: "Survey the repository",
							subagent_type: "explore",
							prompt:
								"Survey this small repository and report back what it contains and any duplication you notice. Keep the answer to a few sentences — do NOT paste file contents back, since the point is to keep them out of the parent conversation.",
						},
					},
				],
			},
			{
				reasoning: {
					en: "Explain the delegation mechanism. No need to repeat what the subagent already returned.",
					"zh-CN": "讲清委派机制。子代理已经汇报过的结论不用重复。",
				},
				text: {
					en: [
						"Here is what actually happened:",
						"",
						"- A **second narrator** was created with its own context window. You can open the card and read every step it took.",
						"- What came back is its **summary**, not its reading. A subagent that returned everything it saw would save nothing — the context would land here anyway.",
						"- It was an **explore** agent, so it had no write access at all.",
						"",
						"The four types differ in authority: `explore` reads, `plan` designs without implementing, `review` inspects a diff, `general` writes. Pick the narrowest one that fits the job.",
					].join("\n"),
					"zh-CN": [
						"刚才发生的事：",
						"",
						"- 一个**第二叙述者**被创建了，有自己的上下文窗口。点开卡片可以看到它走过的每一步。",
						"- 回到这里的是它的**归纳**，不是它的阅读内容。如果把看到的全部带回来，上下文一样会落在这里，什么也没省。",
						"- 它是 **explore** 代理，没有任何写入权限。",
						"",
						"四种类型的区别在于权限：`explore` 只读，`plan` 只设计不实现，`review` 检查差异，`general` 可以写入。选能完成任务的最小权限那个。",
					].join("\n"),
				},
			},
		],
		subagentTurns: {
			explore: [
				{
					reasoning: {
						en: "Read-only survey. Answer in a few sentences and do not return file contents — that would put the context back into the parent conversation.",
						"zh-CN": "只读勘察。用几句话作答，不要把文件内容带回去——那会把上下文重新塞进父对话。",
					},
					text: {
						en: "Looking around first.",
						"zh-CN": "先看看再说。",
					},
					toolUses: [
						{ name: "Glob", input: { pattern: "**/*.{ts,md}" } },
						{
							name: "Grep",
							input: { pattern: "export function", output_mode: "content", "-n": true },
						},
					],
				},
				{
					text: {
						en: [
							"Four files: `README.md`, `notes.md`, `src/greeting.ts`, `src/tasks.ts`.",
							"",
							"`greet` and `greetLoudly` in `src/greeting.ts` build the same greeting template independently — a wording change has to be made twice. `notes.md` already records this.",
							"",
							"`src/tasks.ts` has a single `countOpen` helper and no tests.",
						].join("\n"),
						"zh-CN": [
							"四个文件：`README.md`、`notes.md`、`src/greeting.ts`、`src/tasks.ts`。",
							"",
							"`src/greeting.ts` 里的 `greet` 和 `greetLoudly` 各自独立拼出同样的问候模板，改文案要改两遍。`notes.md` 已记录此事。",
							"",
							"`src/tasks.ts` 只有一个 `countOpen` 辅助函数，没有测试。",
						].join("\n"),
					},
				},
			],
		},
		fallbackTurn: {
			text: {
				en: "That is the end of this lesson's script.",
				"zh-CN": "本课剧本到此结束。",
			},
		},
		generateResponses: {
			title: {
				en: "Tutorial: delegating to subagents",
				"zh-CN": "教程：委派给子代理",
			},
		},
	},

	"background-tasks": {
		lessonId: "background-tasks",
		turns: [
			{
				reasoning: {
					en: "Start it in the background so this turn returns immediately. The card gives back a handle, not a result.",
					"zh-CN": "放后台启动，这一轮立刻结束。卡片返回的是句柄，不是结果。",
				},
				text: {
					en: "This will take a while, so I'm starting it in the background.",
					"zh-CN": "这个要跑一会儿，我把它放到后台。",
				},
				toolUses: [
					{
						name: "Agent",
						input: {
							description: "Audit the repository",
							subagent_type: "explore",
							run_in_background: true,
							prompt:
								"Take your time and report what could be tidied up in this small repository. A few sentences is enough.",
						},
					},
				],
			},
			{
				reasoning: {
					en: "Don't Await here. Waiting right after backgrounding defeats the point and teaches the wrong lesson.",
					"zh-CN": "不能在这里 Await。刚放后台就等，完全没有意义。",
				},
				text: {
					en: [
						"The card returned a task id, not an answer. The agent is still working.",
						"",
						"Two choices when running a subagent:",
						"",
						"- **Foreground**: answer arrives in this turn, turn lasts as long as the work.",
						"- **Background**: turn ends now, result collected later with `Await`.",
						"",
						"Use background when the next step does not depend on the answer. When it does, waiting is not inefficiency — it is the dependency.",
					].join("\n"),
					"zh-CN": [
						"卡片返回了任务 id，不是答案。子代理还在工作。",
						"",
						"启动子代理有两种方式：",
						"",
						"- **前台**：答案在这一轮里返回，这一轮持续到工作做完。",
						"- **后台**：这一轮现在结束，之后用 `Await` 取结果。",
						"",
						"下一步不依赖这个答案时，选后台。依赖时，等就是对的，不是低效。",
					].join("\n"),
				},
			},
		],
		subagentTurns: {
			explore: [
				{
					text: {
						en: "Done. One thing to fix: remove the duplicated greeting template in `src/greeting.ts`. `src/tasks.ts` is missing a test for `countOpen`; everything else is fine.",
						"zh-CN":
							"审查完成。要做的只有一件事：删掉 `src/greeting.ts` 里重复的问候模板。`src/tasks.ts` 的 `countOpen` 缺一个测试，其余没有问题。",
					},
				},
			],
		},
		fallbackTurn: {
			text: {
				en: "That is the end of this lesson's script.",
				"zh-CN": "本课剧本到此结束。",
			},
		},
		generateResponses: {
			title: {
				en: "Tutorial: work that runs in the background",
				"zh-CN": "教程：在后台运行的工作",
			},
		},
	},

	"team-coordination": {
		lessonId: "team-coordination",
		turns: [
			{
				reasoning: {
					en: "Spawn two agents in one turn. They must be genuinely independent — one reads the greeting code, the other reads the task code. If either needed the other's answer, parallelising would make one of them guess.",
					"zh-CN":
						"在同一轮派两个代理。它们必须真正独立：一个看问候代码，另一个看任务代码。如果其中一个需要对方的答案，并行就会让它去猜。",
				},
				text: {
					en: "These two tasks don't depend on each other, so they can run at the same time.",
					"zh-CN": "这两份工作互不依赖，所以可以同时进行。",
				},
				toolUses: [
					{
						name: "Agent",
						input: {
							description: "Review greeting helpers",
							subagent_type: "explore",
							prompt:
								"Look only at src/greeting.ts and report in one or two sentences what could be improved.",
							alias: "greeting",
						},
					},
					{
						name: "Agent",
						input: {
							description: "Review task helpers",
							subagent_type: "explore",
							prompt:
								"Look only at src/tasks.ts and report in one or two sentences what could be improved.",
							alias: "tasks",
						},
					},
				],
			},
			{
				reasoning: {
					en: "Both came back. Explain the one thing people get wrong: a slow agent is usually still working, not stuck.",
					"zh-CN": "两边都回来了。说清最容易搞错的那一点：慢的代理通常还在工作，不是卡住了。",
				},
				text: {
					en: [
						"Both agents ran at the same time and each reported on its own file.",
						"",
						"Parallel was safe here for one reason: neither side needed the other's answer. When tasks *are* dependent, running them in parallel makes one proceed on a guess.",
						"",
						'The other part of coordination: know when to leave an agent alone. A timed-out wait means the wait ended, not that the agent is stuck. Sending a "how\'s it going?" costs it context and breaks its flow. The real signals are whether it is still making tool calls and what it eventually returns. Interrupt when the direction is wrong — not because you are impatient.',
					].join("\n"),
					"zh-CN": [
						"两个代理同时运行，各自汇报了自己那份文件。",
						"",
						"并行安全只有一个原因：两半工作都不需要对方的答案。有依赖时并行，其中一个只能基于猜测继续，你事后才发现。",
						"",
						"协作的另一面：知道什么时候别去打扰。等待超时意味着这次等待结束了，不是代理卡住了。给它发「进展如何」会浪费它的上下文并打断它。真正可靠的信号是它是否还在调用工具，以及最终返回了什么。方向错了才该中断，不是因为等得不耐烦。",
					].join("\n"),
				},
			},
		],
		subagentTurns: {
			explore: [
				{
					text: {
						en: "Read the file I was assigned. The clearest improvement is removing the duplicated greeting template so the wording lives in one place. Nothing else stands out in a file this small.",
						"zh-CN":
							"读了分配给我的文件。最明确的改进是消掉重复的问候模板，让文案只在一处维护。文件很小，没有其他突出问题。",
					},
				},
			],
		},
		fallbackTurn: {
			text: {
				en: "That is the end of this lesson's script.",
				"zh-CN": "本课剧本到此结束。",
			},
		},
		generateResponses: {
			title: {
				en: "Tutorial: several agents at once",
				"zh-CN": "教程：多个代理同时工作",
			},
		},
	},
};

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

function resolveStep(source: TutorialStepSource, locale: string | null | undefined): TutorialStep {
	return {
		id: source.id,
		instruction: pickLocalizedValue(source.instruction, locale),
		...(source.hint ? { hint: pickLocalizedValue(source.hint, locale) } : {}),
		completion: source.completion,
	};
}

function byTrackThenOrder(a: TutorialLessonSource, b: TutorialLessonSource): number {
	const trackDelta = TUTORIAL_TRACKS.indexOf(a.track) - TUTORIAL_TRACKS.indexOf(b.track);
	if (trackDelta !== 0) return trackDelta;
	return a.order - b.order;
}

/** Every lesson id, in the canonical "complete run" order. */
export function getTutorialLessonIds(): string[] {
	return [...lessons].sort(byTrackThenOrder).map((lesson) => lesson.id);
}

export function getTutorialLessonSummaries(locale?: string | null): TutorialLessonSummary[] {
	return [...lessons].sort(byTrackThenOrder).map((lesson) => ({
		id: lesson.id,
		track: lesson.track,
		order: lesson.order,
		title: pickLocalizedValue(lesson.title, locale),
		summary: pickLocalizedValue(lesson.summary, locale),
		recommendedAfter: lesson.recommendedAfter ?? [],
		needs: lesson.needs,
		stepCount: lesson.steps.length,
	}));
}

export function getTutorialLesson(id: string, locale?: string | null): TutorialLesson | undefined {
	const lesson = lessons.find((entry) => entry.id === id);
	if (!lesson) return undefined;
	return {
		id: lesson.id,
		track: lesson.track,
		order: lesson.order,
		title: pickLocalizedValue(lesson.title, locale),
		summary: pickLocalizedValue(lesson.summary, locale),
		recommendedAfter: lesson.recommendedAfter ?? [],
		needs: lesson.needs,
		steps: lesson.steps.map((step) => resolveStep(step, locale)),
	};
}

/** Raw source rows — used by guard tests that must inspect every locale. */
export function getTutorialLessonSources(): readonly TutorialLessonSource[] {
	return lessons;
}

export function getTutorialScript(lessonId: string): TutorialScript | undefined {
	return scripts[lessonId];
}

export function getTutorialScripts(): Readonly<Record<string, TutorialScript>> {
	return scripts;
}

/**
 * Resolve a script turn's localized fields for one locale.
 *
 * Kept here rather than in the provider so the "which locale wins" rule is the
 * same one the frontend applies to lesson copy.
 */
export interface ResolvedTutorialTurn {
	reasoning?: string;
	text?: string;
	toolUses: TutorialScriptToolUse[];
}

/**
 * Fold `localizedInput` into `input` for one locale.
 *
 * Returns the same object when there is nothing to localize, so the common case
 * allocates nothing and the identity the guard test inspects is unchanged.
 */
function resolveToolUse(
	toolUse: TutorialScriptToolUse,
	locale: Locale | string | null | undefined,
): TutorialScriptToolUse {
	if (!toolUse.localizedInput) return toolUse;
	const input = { ...toolUse.input };
	for (const [field, value] of Object.entries(toolUse.localizedInput)) {
		input[field] = pickLocalizedValue(value, locale);
	}
	// `localizedInput` is dropped: what remains is a plain scripted call, and
	// leaving the source field on it would let a consumer localize twice.
	return { name: toolUse.name, input };
}

export function resolveTutorialTurn(
	turn: TutorialScriptTurn,
	locale: Locale | string | null | undefined,
): ResolvedTutorialTurn {
	return {
		...(turn.reasoning ? { reasoning: pickLocalizedValue(turn.reasoning, locale) } : {}),
		...(turn.text ? { text: pickLocalizedValue(turn.text, locale) } : {}),
		toolUses: (turn.toolUses ?? []).map((toolUse) => resolveToolUse(toolUse, locale)),
	};
}
