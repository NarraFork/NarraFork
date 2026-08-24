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
		title: { en: "Your first turn", "zh-CN": "第一次对话" },
		summary: {
			en: "Send a message and watch a narrator work: private reasoning, streamed answer, and the return to idle that means the turn is over.",
			"zh-CN":
				"发出一条消息，观察叙述者如何工作：私有推理、流式输出，以及回到空闲状态代表这一轮结束。",
		},
		needs: { narrator: "standalone" },
		steps: [
			{
				id: "send",
				instruction: {
					en: "Type anything into the composer and send it. The tutorial narrator answers from a script, so no AI API is called and nothing is billed.",
					"zh-CN":
						"在输入框里随便打点什么并发送。教程叙述者按剧本回复，不会调用任何 AI API，也不消耗额度。",
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
					en: "Watch the reasoning block appear before the answer. Reasoning is the model's private thinking — it is stored and replayable, but it is not the answer.",
					"zh-CN":
						"注意回答之前出现的推理块。推理是模型的私有思考过程，它会被保存下来可供回看，但它不是答案。",
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
					en: "Wait for the status to return to idle. A narrator is a session, not a request: it stays available with its full history for the next turn.",
					"zh-CN":
						"等待状态回到空闲。叙述者是一个会话而不是一次请求：它会带着完整历史一直在那里，等你的下一轮。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
	{
		id: "tool-calls",
		track: "conversation",
		order: 2,
		title: { en: "How tool calls read", "zh-CN": "读懂工具调用" },
		summary: {
			en: "A tool card has phases, and the confusing one is before execution: the model is still writing the arguments. Watch three real reads happen in the sandbox.",
			"zh-CN":
				"工具卡片是分阶段的，最容易看不懂的是执行之前那一段：模型还在写参数。在沙盒里观察三次真实的读取。",
		},
		recommendedAfter: ["first-turn"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send anything to start the turn. This lesson runs in the tutorial sandbox repository, so the files being read are real files on disk.",
					"zh-CN":
						"随便发一条消息开始这一轮。本课在教程沙盒仓库里进行，所以被读取的文件是磁盘上真实存在的文件。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "watch-arguments",
				instruction: {
					en: "Watch a card appear with its tool name before its arguments are complete. That phase means the model is still writing the call — it has not run yet, and nothing has touched your files.",
					"zh-CN":
						"注意卡片会先带着工具名出现，参数还没写完。这个阶段表示模型还在书写这次调用——它还没有执行，也还没有碰到任何文件。",
				},
				hint: {
					en: "The phase after it is 'executing', which is when the work actually happens.",
					"zh-CN": "紧随其后的阶段才是「执行中」，那时才真正开始干活。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "read-ran",
				instruction: {
					en: "Wait for the Read call to finish. Click the card to expand it: the output you see is what the model saw, which is how you check its reasoning against reality.",
					"zh-CN":
						"等待 Read 调用完成。点开卡片：你看到的输出就是模型看到的内容——这正是你用来核对它的判断是否符合事实的依据。",
				},
				completion: { kind: "toolCompleted", toolName: "Read" },
			},
			{
				id: "grep-ran",
				instruction: {
					en: "Wait for the Grep call. Search results are a list of real matches; a tool card is evidence, not a claim.",
					"zh-CN": "等待 Grep 调用完成。搜索结果是一份真实的命中列表；工具卡片是证据，不是断言。",
				},
				completion: { kind: "toolCompleted", toolName: "Grep" },
			},
			{
				id: "turn-done",
				instruction: {
					en: "Wait for the turn to finish. Multiple tools can run in one turn — the narrator only becomes idle once all of them have settled.",
					"zh-CN": "等待这一轮结束。一轮里可以跑多个工具——只有全部落定之后，叙述者才会回到空闲。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
	{
		id: "permissions",
		track: "conversation",
		order: 3,
		title: { en: "Approving and refusing", "zh-CN": "批准与拒绝" },
		summary: {
			en: "Anything that changes your machine stops and asks. Approve one write, refuse another, and see that refusing is a normal answer rather than an error.",
			"zh-CN":
				"任何会改动你机器的操作都会停下来征求同意。批准一次写入、拒绝另一次，并看到「拒绝」是一个正常答复而不是错误。",
		},
		recommendedAfter: ["tool-calls"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send anything to start the turn. The narrator is in the default permission mode — the one that asks before every change.",
					"zh-CN":
						"随便发一条消息开始这一轮。叙述者处于默认权限模式——也就是每次改动前都会询问的那种。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "decide",
				instruction: {
					en: "A Write call stops for approval. Read what it intends to write, then decide. Either answer moves the lesson on: refusing is a legitimate choice, not a mistake.",
					"zh-CN":
						"一次 Write 调用会停下来等你批准。先读清楚它打算写什么，再做决定。两种答复都会让本课继续：拒绝是正当选择，不是操作失误。",
				},
				hint: {
					en: "Refusing sends your reason back to the model, so it can propose something else instead of retrying blindly.",
					"zh-CN": "拒绝时你的理由会回传给模型，它就能换个做法，而不是盲目重试。",
				},
				completion: { kind: "permissionResolved" },
			},
			{
				id: "aftermath",
				instruction: {
					en: "Watch what the narrator does with your decision. An approval executes; a refusal is fed back as the tool's result and the turn continues from there.",
					"zh-CN":
						"看看叙述者如何处理你的决定。批准会执行；拒绝会作为该工具的结果回传，这一轮从那里继续。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "turn-done",
				instruction: {
					en: "Wait for the turn to finish. Permission modes exist for later: 'default' asks every time, and looser modes trade approvals for autonomy.",
					"zh-CN":
						"等待这一轮结束。权限模式是为之后准备的：default 每次都问，更宽松的模式用审批换自主性。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
	{
		id: "interrupt-and-queue",
		track: "conversation",
		order: 4,
		title: { en: "Interrupting a turn", "zh-CN": "打断一轮工作" },
		summary: {
			en: "You do not have to wait for a turn you no longer want. Interrupt a running command and see that the work done so far is kept, not discarded.",
			"zh-CN":
				"你不必等一轮已经不想要的工作跑完。中断一条正在运行的命令，并看到此前已完成的工作被保留而不是丢弃。",
		},
		recommendedAfter: ["tool-calls"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send anything to start the turn. It runs a deliberately slow command so there is something to interrupt.",
					"zh-CN": "随便发一条消息开始这一轮。它会执行一条故意放慢的命令，好让你有东西可以中断。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "interrupt",
				instruction: {
					en: "While the command is running, press the stop button in the header. Interrupting is not an error state — the narrator returns to idle and everything already produced stays in the transcript.",
					"zh-CN":
						"命令运行期间，按下头部的停止按钮。中断不是错误状态——叙述者会回到空闲，此前产出的一切都留在对话记录里。",
				},
				hint: {
					en: "You can also just type: sending while it works queues your message for the next safe boundary instead of throwing away the turn.",
					"zh-CN":
						"你也可以直接输入：在它工作时发送会把消息排到下一个安全边界，而不是把这一轮丢掉。",
				},
				completion: { kind: "narratorIdle" },
			},
			{
				id: "inspect",
				instruction: {
					en: "Scroll back through what survived. This is why a narrator is a session: the history is the record, and an interrupted turn is part of it.",
					"zh-CN":
						"往上翻看保留下来的内容。这正是「叙述者是会话」的意义：历史就是记录，被中断的那一轮也是其中一部分。",
				},
				completion: { kind: "manual" },
			},
		],
	},
	{
		id: "plan-mode",
		track: "conversation",
		order: 5,
		title: { en: "Plan before code", "zh-CN": "先计划再动手" },
		summary: {
			en: "For anything non-trivial, the narrator can investigate read-only first and hand you a plan to approve before it changes a single file.",
			"zh-CN":
				"对任何不那么简单的任务，叙述者可以先只读地调查，然后把一份计划交给你批准，之后才动第一个文件。",
		},
		recommendedAfter: ["permissions"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send anything to start the turn. The narrator enters plan mode, where it can read and search but not modify.",
					"zh-CN": "随便发一条消息开始这一轮。叙述者会进入计划模式：可以读取和搜索，但不能修改。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "investigating",
				instruction: {
					en: "Watch it investigate before proposing anything. Plan mode is what stops an agent from confidently editing code it has not read.",
					"zh-CN":
						"注意它在提出任何方案之前先去调查。计划模式的作用，就是阻止 agent 自信地去改它根本没读过的代码。",
				},
				completion: { kind: "toolCompleted", toolName: "Grep" },
			},
			{
				id: "review-plan",
				instruction: {
					en: "Read the plan it hands you and approve or send it back. This is the cheapest place to disagree — before any file changed.",
					"zh-CN":
						"读一读它交上来的计划，然后批准或者打回。这里是提出异议成本最低的地方——此时还没有任何文件被改动。",
				},
				hint: {
					en: "Sending it back with a reason is usually better than approving a plan you half agree with.",
					"zh-CN": "带上理由打回，通常比批准一份你只同意一半的计划更好。",
				},
				completion: { kind: "permissionResolved" },
			},
			{
				id: "turn-done",
				instruction: {
					en: "Wait for the turn to finish. Approving a plan leaves plan mode; the narrator can then make the changes it described.",
					"zh-CN": "等待这一轮结束。批准计划后就退出计划模式，叙述者随后可以执行它描述过的改动。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
	{
		id: "spec-tasks",
		track: "conversation",
		order: 6,
		title: { en: "The task queue", "zh-CN": "任务队列" },
		summary: {
			en: "Long work needs a memory that survives a compacted conversation. Dynamic Spec is a small task list the narrator keeps and is reminded of.",
			"zh-CN":
				"长线工作需要一份能在对话被压缩后依然存活的记忆。Dynamic Spec 就是叙述者自己维护、并会被反复提醒的小型任务清单。",
		},
		recommendedAfter: ["tool-calls"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send anything to start the turn.",
					"zh-CN": "随便发一条消息开始这一轮。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "tasks-written",
				instruction: {
					en: "Watch it write spec://tasks.json. That path is not a file in your repository — it is the narrator's own scratch space, and writing it needs no approval.",
					"zh-CN":
						"注意它写入 spec://tasks.json。那个路径不是你仓库里的文件——它是叙述者自己的暂存空间，写入不需要审批。",
				},
				completion: { kind: "specTaskWritten" },
			},
			{
				id: "board",
				instruction: {
					en: "Open the Spec panel from the header to see the same tasks as a board. Unfinished tasks are what a resumed or auto-continued session picks up from.",
					"zh-CN":
						"从头部打开 Spec 面板，用看板形式查看同一批任务。未完成的任务正是会话恢复或自动续跑时接着做的东西。",
				},
				hint: {
					en: "Only finite, checkable work belongs here. A standing rule with no end has no place in a queue.",
					"zh-CN": "只有有限、可核验的工作才该放这里。没有终点的长期规则不属于队列。",
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

	// --- Track B: NarraFlow and chapters ---

	{
		id: "project-and-chapter",
		track: "chapters",
		order: 1,
		title: { en: "Repositories and chapters", "zh-CN": "仓库与章节" },
		summary: {
			en: "The one idea that makes the rest make sense: a narraflow is a git repository, and a chapter is a worktree with its own session. Two chapters can hold different versions of the same file at the same time.",
			"zh-CN":
				"理解其余一切的关键：一条叙事线就是一个 git 仓库，一个章节就是一个带独立会话的 worktree。两个章节可以同时持有同一个文件的不同版本。",
		},
		recommendedAfter: ["first-turn"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send anything. This narrator is bound to a chapter, so its working directory is that chapter's worktree — not a shared checkout.",
					"zh-CN":
						"随便发一条消息。这个叙述者绑定在某个章节上，所以它的工作目录就是那个章节的 worktree——不是一份共享的检出。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "see-worktree",
				instruction: {
					en: "Look at what the Bash call reports: a branch and a directory that belong to this chapter alone. Nothing it does here can surprise another chapter.",
					"zh-CN":
						"看看 Bash 调用报告的内容：一个只属于这个章节的分支和目录。它在这里做的任何事都不会波及其他章节。",
				},
				hint: {
					en: "This is why parallel work does not need coordination: isolation is a directory, not a convention.",
					"zh-CN": "这就是并行工作不需要相互协调的原因：隔离靠的是目录，而不是约定。",
				},
				completion: { kind: "toolCompleted", toolName: "Bash" },
			},
			{
				id: "history",
				instruction: {
					en: "The repository already has a few commits. Chapters branch from that history, which is what the next lesson uses.",
					"zh-CN": "这个仓库里已经有若干提交。章节就是从这段历史上分叉出来的——下一课会用到它。",
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
		title: { en: "Forking a chapter", "zh-CN": "分叉一个章节" },
		summary: {
			en: "Try an approach without betting the current one on it. Forking creates a second worktree and a second session, and you choose how much of the conversation it inherits.",
			"zh-CN":
				"在不押上当前进展的前提下试另一条路。分叉会创建第二个 worktree 和第二个会话，而你可以选择它继承多少对话上下文。",
		},
		recommendedAfter: ["project-and-chapter"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "open-fork",
				instruction: {
					en: "Fork this chapter from the graph or the chapter menu. You do not need to send a message first — forking is a structural action, not something you ask the narrator to do.",
					"zh-CN":
						"从图上或章节菜单里分叉这个章节。你不需要先发消息——分叉是一个结构性操作，不是请叙述者去做的事。",
				},
				hint: {
					en: "Context inheritance: 'full' carries the whole conversation, 'compressed' carries a summary, 'fresh' starts clean. Pick 'fresh' when the old context would only mislead.",
					"zh-CN":
						"上下文继承：full 带走完整对话，compressed 带走摘要，fresh 从零开始。当旧上下文只会误导时，选 fresh。",
				},
				completion: { kind: "chapterForked" },
			},
			{
				id: "two-worktrees",
				instruction: {
					en: "You now have two chapters on two branches, each with its own directory and session. Editing a file in one leaves the other untouched.",
					"zh-CN":
						"现在你有两个章节，位于两个分支上，各自拥有独立目录和会话。在其中一个里改文件，另一个毫无影响。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "why",
				instruction: {
					en: "This is the alternative to committing to one approach and hoping. Two forks can explore incompatible designs at once, and you decide afterwards which one earned the merge.",
					"zh-CN":
						"这是「先选定一条路然后祈祷」之外的另一种做法。两个分叉可以同时探索互不兼容的设计，之后由你决定哪一个值得被合并。",
				},
				completion: { kind: "manual" },
			},
		],
	},
	{
		id: "graph",
		track: "chapters",
		order: 3,
		title: { en: "Reading the story network", "zh-CN": "读懂故事网络图" },
		summary: {
			en: "The graph is the project's main view, not a diagram of it. Nodes are chapters you can open; edges are the relationships that actually happened.",
			"zh-CN":
				"这张图是项目的主界面，而不是项目的示意图。节点是可以直接打开的章节；边是真实发生过的关系。",
		},
		recommendedAfter: ["fork"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "open-graph",
				instruction: {
					en: "Open the narraflow view for this project. The fork you just made is an edge between two nodes.",
					"zh-CN": "打开这个项目的叙事线视图。你刚才做的分叉，就是两个节点之间的一条边。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "roles",
				instruction: {
					en: "Node colour follows the chapter's role: trunk receives merges, branch is ordinary work, exploration is a candidate you may throw away, review is a code review. Roles are labels, not permissions — none of them restricts what you can do.",
					"zh-CN":
						"节点颜色对应章节角色：trunk 是接收合并的主线，branch 是普通工作分支，exploration 是可以丢弃的候选方案，review 是代码评审。角色只是标签而不是权限——它们都不限制你能做什么。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "edges",
				instruction: {
					en: "Edge types carry the history: fork, merge, dependency, cherry-pick, review. A dependency edge is the one you declare yourself — it tells the system to warn you when the upstream chapter moves.",
					"zh-CN":
						"边的类型承载了历史：fork、merge、dependency、cherry_pick、review。dependency 是需要你自己声明的那种——它让系统在上游章节发生变化时提醒你。",
				},
				hint: {
					en: "Click a node to open its session; the graph is a navigation surface, not a read-only picture.",
					"zh-CN": "点击节点即可打开它的会话；这张图是导航界面，而不是只能看的图片。",
				},
				completion: { kind: "manual" },
			},
		],
	},
	{
		id: "merge",
		track: "chapters",
		order: 4,
		title: { en: "Merging and letting go", "zh-CN": "合并与放手" },
		summary: {
			en: "Finish a branch by merging it back, and learn the two ways a chapter ends without merging: dormant keeps the branch and frees the disk, abandoned admits the approach lost.",
			"zh-CN":
				"通过合并回主线来结束一个分支；同时了解章节不经合并而结束的两种方式：休眠保留分支并释放磁盘，放弃则承认这条路没走通。",
		},
		recommendedAfter: ["fork"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "merge-back",
				instruction: {
					en: "Merge a chapter back into its parent. NarraFork checks for conflicts first and tells you before doing anything.",
					"zh-CN": "把一个章节合并回它的父章节。NarraFork 会先做冲突检查，并在动手之前告诉你结果。",
				},
				hint: {
					en: "On a conflict you can resolve it yourself or hand it to the narrator; either way the merge is not applied until it is resolved.",
					"zh-CN":
						"遇到冲突时，你可以自己解决，也可以交给叙述者；无论哪种，冲突解决之前合并都不会被应用。",
				},
				completion: { kind: "chapterMerged" },
			},
			{
				id: "merge-edge",
				instruction: {
					en: "A merge edge now records what happened. The merged chapter is not deleted — its history and conversation stay readable.",
					"zh-CN":
						"现在有一条 merge 边记录了这件事。被合并的章节不会被删除——它的历史和对话仍然可读。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "dormant",
				instruction: {
					en: "For a chapter you are done with but not finished with, dormant removes its worktree and keeps its branch. Waking it recreates the directory. This is the housekeeping that keeps a long-lived project from filling the disk.",
					"zh-CN":
						"对于「暂时不做但没有做完」的章节，休眠会移除它的 worktree 而保留分支。唤醒时目录会被重建。这正是让长期项目不至于占满磁盘的日常维护手段。",
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
		title: { en: "Delegating to subagents", "zh-CN": "委派给子代理" },
		summary: {
			en: "A subagent is a separate session with its own context, spawned to keep a large search out of the main conversation. The type decides what it may do — explore cannot write.",
			"zh-CN":
				"子代理是一个拥有独立上下文的单独会话，派生它的目的是把大范围搜索挡在主对话之外。类型决定它能做什么——explore 不能写入。",
		},
		recommendedAfter: ["tool-calls"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send anything. The narrator will delegate part of the work instead of doing it inline.",
					"zh-CN": "随便发一条消息。叙述者会把一部分工作委派出去，而不是自己在主线里做完。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "spawned",
				instruction: {
					en: "Watch an Agent card appear. That is a real second narrator with its own context window — which is the point: whatever it reads does not land in this conversation.",
					"zh-CN":
						"注意出现的 Agent 卡片。那是一个真实的第二个叙述者，拥有自己的上下文窗口——这正是意义所在：它读到的东西不会落进当前这段对话。",
				},
				hint: {
					en: "Click through to open the subagent's own session and read its full transcript.",
					"zh-CN": "点进去可以打开子代理自己的会话，读到它的完整记录。",
				},
				completion: { kind: "subagentSpawned" },
			},
			{
				id: "result",
				instruction: {
					en: "Notice what came back: a summary, not the raw reading. A subagent that returned everything it saw would defeat its own purpose — the context it saved would land here anyway.",
					"zh-CN":
						"注意回传的是什么：一份归纳，而不是原始阅读内容。如果子代理把看到的一切都带回来，它就自我否定了——它省下的上下文最终还是会落到这里。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "types",
				instruction: {
					en: "Four types, differing in authority: explore is read-only, plan designs but does not implement, review inspects a diff, general can write. Pick the narrowest one that can do the job.",
					"zh-CN":
						"四种类型，区别在权限：explore 只读，plan 只设计不实现，review 检查差异，general 可以写入。选择能完成任务的最小权限那一个。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
	{
		id: "background-tasks",
		track: "subagents",
		order: 2,
		title: { en: "Work that runs in the background", "zh-CN": "在后台运行的工作" },
		summary: {
			en: "A long task does not have to hold your session hostage. Start it in the background, keep talking, and collect the result when you need it.",
			"zh-CN": "长任务不必扣着你的会话不放。让它在后台启动，你继续对话，需要时再去取结果。",
		},
		recommendedAfter: ["subagent-types"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send anything. The narrator starts a subagent in the background rather than waiting for it.",
					"zh-CN": "随便发一条消息。叙述者会在后台启动一个子代理，而不是等着它跑完。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "backgrounded",
				instruction: {
					en: "The Agent card returns immediately with a task id instead of a result. The work is still running; the turn is not blocked on it.",
					"zh-CN":
						"Agent 卡片会立即返回一个任务 id 而不是结果。工作仍在进行，但这一轮没有被它阻塞。",
				},
				completion: { kind: "subagentSpawned" },
			},
			{
				id: "drawer",
				instruction: {
					en: "Open the background tasks drawer from the header to see it running. This is where work you started and moved on from stays visible.",
					"zh-CN":
						"从头部打开后台任务抽屉，可以看到它正在运行。你启动后就转身去做别的事的工作，都在这里保持可见。",
				},
				hint: {
					en: "The narrator collects a finished task with Await; you do not have to poll it yourself.",
					"zh-CN": "叙述者用 Await 收取已完成的任务；你不需要自己去轮询。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "turn-done",
				instruction: {
					en: "Wait for the turn to finish. A background task can outlive the turn that started it, which is the whole reason to background it.",
					"zh-CN":
						"等待这一轮结束。后台任务可以比启动它的那一轮活得更久——这正是把它放到后台的全部理由。",
				},
				completion: { kind: "narratorIdle" },
			},
		],
	},
	{
		id: "team-coordination",
		track: "subagents",
		order: 3,
		title: { en: "Several agents at once", "zh-CN": "多个代理同时工作" },
		summary: {
			en: "Independent work can run in parallel. The hard part is not starting agents — it is knowing when to wait and when leaving them alone is the right move.",
			"zh-CN":
				"相互独立的工作可以并行。难点不在于把代理启动起来，而在于判断什么时候该等，以及什么时候「不去打扰」才是正确的做法。",
		},
		recommendedAfter: ["background-tasks"],
		needs: { project: true, narrator: "chapter" },
		steps: [
			{
				id: "ask",
				instruction: {
					en: "Send anything. Two subagents are spawned in one turn because their work does not overlap.",
					"zh-CN": "随便发一条消息。因为两份工作互不重叠，这一轮会同时派生两个子代理。",
				},
				completion: { kind: "userSentMessage" },
			},
			{
				id: "parallel",
				instruction: {
					en: "Both cards appear together. Work is only safe to parallelise when neither half needs the other's answer — otherwise one of them is guessing.",
					"zh-CN":
						"两张卡片会一起出现。只有当两半工作都不需要对方的答案时，并行才是安全的——否则其中一个只是在猜。",
				},
				completion: { kind: "subagentSpawned" },
			},
			{
				id: "waiting",
				instruction: {
					en: "The narrator waits for both rather than chasing them. A timed-out wait means the wait ended, not that the agent is stuck — nudging a working agent mostly costs it context.",
					"zh-CN":
						"叙述者会等待两者，而不是去催。等待超时只表示这次等待结束了，并不表示代理卡住了——去催一个正在工作的代理，主要代价是浪费它的上下文。",
				},
				completion: { kind: "manual" },
			},
			{
				id: "turn-done",
				instruction: {
					en: "Wait for the turn to finish. Both results arrive as summaries, and the main conversation stays readable.",
					"zh-CN": "等待这一轮结束。两份结果都以归纳形式回来，主对话依然保持可读。",
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
					en: "The user is taking the tutorial, so this first turn should demonstrate the shape of a turn rather than solve a task. Keep it short: one reasoning block, one short answer, no tools — tools are the next lesson.",
					"zh-CN":
						"用户正在做教程，所以这第一轮应该展示「一轮对话长什么样」，而不是去解决某个任务。保持简短：一个推理块、一段简短回答、不用工具——工具是下一课的内容。",
				},
				text: {
					en: [
						"Got it. Three things just happened, and they are the whole shape of a turn:",
						"",
						"1. **Reasoning** streamed first. That block is my private thinking. It is persisted, so you can reopen this session tomorrow and read how I got here — but it is not the answer, and you should not treat it as a commitment.",
						"2. **This text** streamed second. It is the answer, rendered as Markdown.",
						"3. **The status** is about to go back to `idle`. That is the signal the turn finished. A narrator is a session, not a one-shot request: the next thing you send continues from here.",
						"",
						"One thing worth internalising early: I am a *scripted* narrator for this tutorial. No API was called, nothing was billed. Everything else you see — the message rows, the status transitions, the persistence — is the real product.",
					].join("\n"),
					"zh-CN": [
						"收到。刚刚发生了三件事，它们构成了「一轮对话」的全貌：",
						"",
						"1. **推理**先流出来。那个块是我的私有思考。它会被持久化，所以你明天重新打开这个会话还能读到我是怎么想的——但它不是答案，也不该被当成承诺。",
						"2. **这段正文**随后流出。它才是答案，按 Markdown 渲染。",
						"3. **状态**即将回到 `idle`。这是这一轮结束的信号。叙述者是一个会话而不是一次性请求：你接下来发的内容会从这里继续。",
						"",
						"有一点值得尽早记住：在这个教程里我是一个**按剧本走**的叙述者。没有调用任何 API，也没有产生费用。你看到的其余一切——消息行、状态变化、持久化——都是真实的产品行为。",
					].join("\n"),
				},
			},
		],
		fallbackTurn: {
			text: {
				en: "This lesson's script is finished, so I do not have a scripted answer for that. Move on to the next lesson, or reset this one from the step panel to replay it.",
				"zh-CN":
					"这一课的剧本已经走完了，所以我没有对应的预置回复。可以进入下一课，或者从步骤面板重置本课重新走一遍。",
			},
		},
		generateResponses: {
			title: { en: "Tutorial: your first turn", "zh-CN": "教程：第一次对话" },
			summary: {
				en: "Tutorial session — nothing to summarise.",
				"zh-CN": "教程会话 —— 没有需要总结的内容。",
			},
		},
	},

	"tool-calls": {
		lessonId: "tool-calls",
		turns: [
			{
				reasoning: {
					en: "Show the three read-only tools whose cards look different from each other: Glob (a path list), Read (a file with line numbers), Grep (a match list). All against the seeded sandbox files so the output is real.",
					"zh-CN":
						"演示三个卡片形态各不相同的只读工具：Glob（路径列表）、Read（带行号的文件）、Grep（命中列表）。全部针对沙盒里预置的文件，这样输出是真实的。",
				},
				text: {
					en: "Let me look at what is actually in this repository before saying anything about it.",
					"zh-CN": "在对这个仓库下任何判断之前，我先看看它里面到底有什么。",
				},
				toolUses: [
					{ name: "Glob", input: { pattern: "src/*.ts" } },
					{ name: "Read", input: { file_path: "src/greeting.ts" } },
					{ name: "Grep", input: { pattern: "Hello", output_mode: "content", "-n": true } },
				],
			},
			{
				reasoning: {
					en: "The reads confirmed the duplication. Report it as an observation backed by the cards above, not as a claim the user has to take on trust.",
					"zh-CN":
						"读取确认了重复。把它作为「有上面卡片作证的观察」来报告，而不是让用户只能选择相信的断言。",
				},
				text: {
					en: [
						"Three cards, three shapes — worth knowing which is which:",
						"",
						"- **Glob** listed paths. It answers *what exists*, never *what is inside*.",
						"- **Read** returned `src/greeting.ts` with line numbers. What you see in that card is exactly what I saw; if my conclusion below does not follow from it, trust the card.",
						"- **Grep** returned matching lines. Two of them: `greet` and `greetLoudly` build the same template independently.",
						"",
						"That duplication is the kind of thing worth fixing, and the next lesson is where changing a file gets interesting — because changing anything stops and asks you first.",
					].join("\n"),
					"zh-CN": [
						"三张卡片、三种形态——值得分清：",
						"",
						"- **Glob** 列出了路径。它回答的是*有哪些文件*，从不回答*文件里有什么*。",
						"- **Read** 返回了带行号的 `src/greeting.ts`。你在那张卡片里看到的，就是我看到的；如果我下面的结论推不出来，请以卡片为准。",
						"- **Grep** 返回了命中行。有两处：`greet` 和 `greetLoudly` 各自拼了同样的模板。",
						"",
						"这种重复是值得修的。而修改文件从下一课开始才真正有意思——因为任何改动都会先停下来问你。",
					].join("\n"),
				},
			},
		],
		fallbackTurn: {
			text: {
				en: "That is the end of this lesson's script. The next lesson covers what happens when a tool wants to CHANGE something instead of just reading it.",
				"zh-CN": "本课剧本到此结束。下一课讲的是：当工具想要**改动**而不只是读取时会发生什么。",
			},
		},
		generateResponses: {
			title: { en: "Tutorial: how tool calls read", "zh-CN": "教程：读懂工具调用" },
		},
	},

	permissions: {
		lessonId: "permissions",
		turns: [
			{
				reasoning: {
					en: "Write a NEW file rather than editing a seeded one: a create is easy to reason about when approving, and if the user refuses there is nothing half-changed to explain.",
					"zh-CN":
						"写一个**新**文件而不是改动预置文件：新建在审批时更容易判断，而且如果用户拒绝，也不会留下半改的状态需要解释。",
				},
				text: {
					en: "I would add a short note recording what I found. Creating a file changes your machine, so this needs your approval first.",
					"zh-CN":
						"我想加一份简短的记录，写下我发现的问题。创建文件会改动你的机器，所以这需要你先批准。",
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
					en: "Whatever the user decided, treat it as the answer. If they refused, the refusal is the tool result and the right move is to accept it, not to retry the same call with different wording.",
					"zh-CN":
						"无论用户怎么决定，都把它当作答复。如果被拒绝，那次拒绝就是工具结果，正确的做法是接受，而不是换个说法重试同一次调用。",
				},
				text: {
					en: [
						"Either way, that was the mechanism worth learning:",
						"",
						"- **Approved** — the call executed and the result came back in the card.",
						"- **Refused** — the refusal (and your reason, if you gave one) became the tool's result. I see it the way I would see any other outcome, so the right response is to change approach rather than ask again.",
						"",
						"Two things to carry forward. Read-only calls do not ask — `Read`, `Grep` and `Glob` in the previous lesson ran without stopping. And the mode you are in decides how often you are asked: `default` asks every time, and the looser modes trade that away for autonomy. Pick deliberately.",
					].join("\n"),
					"zh-CN": [
						"无论哪种，这套机制才是要学的东西：",
						"",
						"- **批准** —— 调用执行，结果回到卡片里。",
						"- **拒绝** —— 这次拒绝（以及你给出的理由，如果有）成为该工具的结果。我看到它和看到任何其他结果一样，所以正确的反应是换思路，而不是再问一遍。",
						"",
						"有两点要带走。只读调用不会询问——上一课的 `Read`、`Grep`、`Glob` 都是直接跑完的。而你所处的模式决定了被询问的频率：`default` 每次都问，更宽松的模式则用它换取自主性。请有意识地选择。",
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
					en: "Run something slow enough to interrupt, but harmless and bounded: a short sleep with progress output. It must finish on its own if the user does nothing, so a user who reads instead of clicking is not left stuck.",
					"zh-CN":
						"跑一个慢到足以被中断、但无害且有界的东西：短暂 sleep 加进度输出。如果用户什么都不做，它必须能自己结束——这样只顾读说明、没去点按钮的用户不会被卡住。",
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
					en: "Do not re-run the command. Whether it was interrupted or completed, re-running it would suggest interrupting achieved nothing — the opposite of the lesson.",
					"zh-CN":
						"不要重跑这条命令。无论它是被中断还是跑完了，重跑都会暗示「中断没有意义」——正好与本课的意图相反。",
				},
				text: {
					en: [
						"If you pressed stop, notice what did *not* happen: nothing was rolled back and nothing was lost. The output produced up to that point is still in the card above, the narrator went back to `idle`, and this session kept its whole history.",
						"",
						"That is why interrupting is cheap here. You are not cancelling a request and starting over — you are ending a turn early in a session that continues.",
						"",
						"You also did not have to interrupt at all: typing while I work queues your message, and it is delivered at the next safe boundary instead of cutting the turn short. Interrupt when the direction is wrong; queue when you just have more to add.",
					].join("\n"),
					"zh-CN": [
						"如果你按了停止，请注意**没有**发生的事：没有回滚，也没有丢东西。到那一刻为止产生的输出仍在上面的卡片里，叙述者回到了 `idle`，这个会话保留了全部历史。",
						"",
						"这就是为什么在这里中断的代价很低。你不是在取消一个请求然后从头再来——你只是在一个会继续下去的会话里提前结束了一轮。",
						"",
						"其实你也完全可以不中断：我工作时你直接输入，消息会被排队，在下一个安全边界送达，而不是把这一轮砍断。方向错了就中断；只是还有话要补充，就排队。",
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
			title: { en: "Tutorial: interrupting a turn", "zh-CN": "教程：打断一轮工作" },
		},
	},

	"plan-mode": {
		lessonId: "plan-mode",
		turns: [
			{
				reasoning: {
					en: "Enter plan mode first, then investigate. Proposing before reading is exactly the failure plan mode exists to prevent, so the script must not model it.",
					"zh-CN":
						"先进入计划模式，再去调查。「先提方案后读代码」正是计划模式要防止的失误，所以剧本本身绝不能示范它。",
				},
				text: {
					en: "This is worth planning before touching anything. Let me enter plan mode and look first.",
					"zh-CN": "这件事值得先规划再动手。我先进入计划模式，去看一看。",
				},
				toolUses: [{ name: "EnterPlanMode", input: {} }],
			},
			{
				reasoning: {
					en: "Read-only investigation: find the duplication and check whether anything depends on the loud variant before proposing to change it.",
					"zh-CN": "只读调查：找出重复，并在提出改动之前确认有没有别的地方依赖那个大写变体。",
				},
				text: {
					en: "Checking what exists and what depends on it.",
					"zh-CN": "先确认存在什么，以及有什么依赖它。",
				},
				toolUses: [
					{ name: "Grep", input: { pattern: "greetLoudly", output_mode: "content", "-n": true } },
					{ name: "Read", input: { file_path: "src/greeting.ts" } },
				],
			},
			{
				reasoning: {
					en: "Now there is enough to propose a concrete plan. Keep it small and reviewable: a plan the user cannot check is not a plan they can approve.",
					"zh-CN":
						"现在有足够依据提出具体计划了。保持小而可审：一份用户无法核对的计划，也就无法被真正批准。",
				},
				text: {
					en: "Here is what I would do.",
					"zh-CN": "下面是我打算做的事。",
				},
				toolUses: [
					{
						name: "ExitPlanMode",
						input: {
							mode: "inline",
							inline_plan: [
								"## Remove the duplicated greeting template",
								"",
								"**What I found**",
								"",
								`\`src/greeting.ts\` builds \`\` \`Hello, ${literalInterpolation("name")}!\` \`\` twice: once in \`greet\`, once in \`greetLoudly\`. Grep shows nothing outside this file depends on the second copy.`,
								"",
								"**Change**",
								"",
								"1. Rewrite `greetLoudly` as `return greet(name).toUpperCase();` — one template, one place to change it.",
								"2. Leave `greet` alone; it is already the single source of the wording.",
								"",
								"**Not doing**",
								"",
								"Renaming either function. Nothing asked for it, and a rename is a separate decision with its own callers to check.",
								"",
								"**Verification**",
								"",
								"Re-read the file after the edit. There is no test runner in this sandbox, so I will not claim tests passed.",
							].join("\n"),
						},
					},
				],
			},
			{
				reasoning: {
					en: "The plan was decided. Do not perform the edit: this lesson is about the planning gate, and a surprise write after the plan step would undercut the point that nothing changes until you approve.",
					"zh-CN":
						"计划已经有了结论。不要真的去改：本课讲的是「计划这道关卡」，在计划步骤之后突然写文件，会削弱「批准前什么都不会变」这个要点。",
				},
				text: {
					en: [
						"That is the whole shape of plan mode:",
						"",
						"1. **Enter** — tools narrow to read-only. Not a promise to behave; the write path is actually unavailable.",
						"2. **Investigate** — Grep and Read, so the plan rests on the file rather than on a guess.",
						"3. **Propose** — a plan small enough that you can disagree with a specific line of it.",
						"4. **Decide** — approving leaves plan mode; sending it back keeps the file untouched.",
						"",
						"Notice the ordering. The expensive mistake is not a bad plan — it is a confident edit to code nobody read. Plan mode makes disagreement cheap by putting it before the change instead of after.",
					].join("\n"),
					"zh-CN": [
						"这就是计划模式的全貌：",
						"",
						"1. **进入** —— 工具收窄为只读。这不是「保证守规矩」，而是写入路径确实不可用。",
						"2. **调查** —— Grep 与 Read，让计划立足于文件本身而不是猜测。",
						"3. **提出** —— 计划要小到你能针对其中某一条提出异议。",
						"4. **决定** —— 批准即退出计划模式；打回则文件毫发无损。",
						"",
						"注意这个次序。代价高的失误不是「计划不好」，而是「自信地改了没人读过的代码」。计划模式把异议放在改动之前而不是之后，从而让异议变得便宜。",
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
			title: { en: "Tutorial: plan before code", "zh-CN": "教程：先计划再动手" },
		},
	},

	"spec-tasks": {
		lessonId: "spec-tasks",
		turns: [
			{
				reasoning: {
					en: 'Write a queue whose entries are finite and checkable. A standing rule ("never break X") has no completion condition and would be re-run forever, so it must not appear in the example.',
					"zh-CN":
						"写一份条目有限、可核验的队列。长期规则（「不得破坏 X」）没有完成条件，会被无限续跑，所以不能出现在示例里。",
				},
				text: {
					en: "This is multi-step, so let me write it down where it survives a compacted conversation.",
					"zh-CN": "这件事是多步骤的，我把它记到一个能在对话被压缩后依然存活的地方。",
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
					en: "Explain why the queue exists rather than restating its contents, which the user can already see in the panel.",
					"zh-CN": "解释这份队列为什么存在，而不是复述内容——用户在面板里已经能看到了。",
				},
				text: {
					en: [
						"Notice what that write did *not* do: it did not ask for approval, and it did not appear in your repository. `spec://` is my own scratch space, not a path on disk.",
						"",
						'Why keep a queue at all? A long conversation eventually gets compacted — earlier turns are replaced by a summary to stay inside the context window. Anything that only existed as "something I said earlier" can be lost that way. Tasks survive it, and I get reminded of the unfinished ones.',
						"",
						'That is also why each entry above is **finite and checkable** — you could tell me whether it is done. A standing rule like "never break the build" has no completion condition, so it would sit in the queue forever being re-attempted. Rules belong somewhere else; the queue is for work that ends.',
					].join("\n"),
					"zh-CN": [
						"注意那次写入**没有**做的事：它没有请求批准，也没有出现在你的仓库里。`spec://` 是我自己的暂存空间，不是磁盘上的路径。",
						"",
						"为什么要有一份队列？长对话最终会被压缩——早期轮次会被摘要替换，以便留在上下文窗口内。任何只以「我早先说过」形式存在的东西，都可能就此丢失。任务能活下来，而且未完成的会被反复提醒。",
						"",
						"这也是为什么上面每一条都是**有限且可核验**的——你能判断它到底做完了没有。像「不得破坏构建」这样的长期规则没有完成条件，会永远待在队列里被反复尝试。规则应该放在别处；队列是给会结束的工作用的。",
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
			title: { en: "Tutorial: the task queue", "zh-CN": "教程：任务队列" },
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
					en: "Show, do not assert. `git rev-parse` and `pwd` prove the branch and directory belong to this chapter; a sentence claiming isolation would be exactly the kind of thing the user cannot check.",
					"zh-CN":
						"用证据而不是断言。`git rev-parse` 和 `pwd` 能证明分支和目录属于这个章节；只用一句话声称「已隔离」，恰恰是用户无法核对的那类说法。",
				},
				text: {
					en: "Let me show you where this session actually lives rather than just telling you.",
					"zh-CN": "我直接把这个会话所在的位置展示给你，而不是只用嘴说。",
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
					en: "Connect the output to the model: worktree = isolation, branch = its own line of history, session = its own conversation. Then point at what the next lesson needs.",
					"zh-CN":
						"把输出与心智模型对应起来：worktree = 隔离，branch = 独立的历史线，session = 独立的对话。然后指向下一课需要的东西。",
				},
				text: {
					en: [
						"Three facts, and together they are the whole model:",
						"",
						"- **The branch** is this chapter's own. Commits I make here do not appear on any other chapter's branch until someone merges them.",
						"- **The directory** is a git *worktree* — a second checkout of the same repository. This is why isolation needs no coordination: two chapters cannot fight over one file because they do not share one.",
						"- **The commit count** is the history this chapter branched from. It is not empty, which matters for the next lesson: forking is only interesting when there is something to fork.",
						"",
						"The thing worth unlearning from other tools: a chapter is not a task or a ticket. It is a place — a directory, a branch and a conversation that keep existing after you look away.",
					].join("\n"),
					"zh-CN": [
						"三个事实，合起来就是完整的心智模型：",
						"",
						"- **分支**是这个章节自己的。我在这里产生的提交，在有人合并之前不会出现在任何其他章节的分支上。",
						"- **目录**是一个 git *worktree*——同一个仓库的第二份检出。这就是为什么隔离不需要协调：两个章节不会争抢同一个文件，因为它们本来就不共用。",
						"- **提交数**是这个章节分叉自的那段历史。它不是空的，这对下一课很重要：只有当有东西可分叉时，分叉才有意义。",
						"",
						"从其他工具那里需要「反学习」的一点：章节不是任务，也不是工单。它是一个**场所**——一个目录、一个分支和一段对话，在你不看它的时候依然存在。",
					].join("\n"),
				},
			},
		],
		fallbackTurn: {
			text: {
				en: "That is the end of this lesson's script. The next lesson forks this chapter, which is where having two worktrees starts to pay off.",
				"zh-CN":
					"本课剧本到此结束。下一课会分叉这个章节——那时「拥有两个 worktree」才开始体现价值。",
			},
		},
		generateResponses: {
			title: { en: "Tutorial: repositories and chapters", "zh-CN": "教程：仓库与章节" },
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
				en: [
					"Forking is something you do to the chapter, not something you ask me to do — so there is nothing for me to run here.",
					"",
					"The choice worth thinking about is context inheritance. **Full** carries this whole conversation into the new chapter, which is right when the fork continues the same line of thought. **Compressed** carries a summary instead, which keeps the useful conclusions without re-paying for every intermediate step. **Fresh** starts with nothing, which is the right answer more often than it looks: if the previous approach was wrong, inheriting the reasoning that produced it mostly imports the mistake.",
				].join("\n"),
				"zh-CN": [
					"分叉是你对章节做的操作，而不是让我去做的事——所以这里没有我需要执行的东西。",
					"",
					"真正值得思考的是上下文继承。**full** 把当前整段对话带进新章节，适合分叉是同一思路的延续。**compressed** 改为带走摘要，保留有用结论而不必为每个中间步骤重复付费。**fresh** 从零开始——它是正确答案的频率比看上去更高：如果之前那条路本来就错了，继承产生它的推理，多半只是把错误一起搬过去。",
				].join("\n"),
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
				en: [
					"This lesson is about reading the graph, so there is nothing for me to run.",
					"",
					"One distinction that matters: **roles** (trunk / branch / exploration / review) are labels. They change how a node looks and what it means to you; they do not restrict what you can do with it. **Edges** are different — they are records of things that actually happened, except for `dependency`, which you declare yourself so the system can warn you when the upstream chapter moves.",
				].join("\n"),
				"zh-CN": [
					"本课讲的是如何读图，所以这里没有我需要执行的东西。",
					"",
					"有一个区别很重要：**角色**（trunk / branch / exploration / review）是标签。它们改变节点的外观和对你的语义，但不限制你能对它做什么。**边**则不同——它们是真实发生过的事情的记录，唯一的例外是 `dependency`：它由你自己声明，好让系统在上游章节变化时提醒你。",
				].join("\n"),
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
				en: [
					"Merging is a structural action too, so there is nothing for me to run here.",
					"",
					"Worth knowing about how a chapter ends. **Merged** means its work landed. **Dormant** removes the worktree and keeps the branch — it frees disk without deciding anything, and waking it recreates the directory. **Abandoned** records that the approach lost, and that is a real outcome rather than a failure: the whole point of forking cheaply is that some forks are supposed to be thrown away.",
					"",
					"None of these delete the conversation. A rejected approach is often the most useful thing to be able to re-read six months later.",
				].join("\n"),
				"zh-CN": [
					"合并同样是结构性操作，所以这里没有我需要执行的东西。",
					"",
					"关于章节如何结束，有几点值得知道。**merged** 表示它的工作落地了。**dormant** 移除 worktree、保留分支——它只释放磁盘而不做任何决定，唤醒时目录会被重建。**abandoned** 记录这条路没走通，而这是一个真实的结果而非失败：低成本分叉的意义，本来就包含「有些分叉就该被丢掉」。",
					"",
					"这些都不会删除对话。半年后最值得回看的，往往正是那条被否掉的路。",
				].join("\n"),
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
					en: "Delegate the search rather than running it inline. The point of the lesson is the context boundary: whatever the subagent reads should not land in this conversation.",
					"zh-CN":
						"把搜索委派出去，而不是自己在主线里跑。本课的要点是上下文边界：子代理读到的东西不应落进当前这段对话。",
				},
				text: {
					en: "This needs a look around the repository. I will delegate it to an explore agent so the reading stays out of our conversation.",
					"zh-CN":
						"这需要在仓库里四处看看。我把它委派给一个 explore 代理，让阅读过程留在我们的对话之外。",
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
					en: "Report the delegation model, not the findings again. Repeating what the subagent already returned is the mistake this whole mechanism exists to avoid.",
					"zh-CN":
						"讲清委派机制，而不是把结论再说一遍。重复子代理已经回传的内容，正是这套机制本身要避免的错误。",
				},
				text: {
					en: [
						'Worth being precise about what just happened, because it is easy to read that card as "a tool ran":',
						"",
						"- A **second narrator** was created, with its own context window. You can open it and read every step it took.",
						"- What came back here is its **summary**, not its reading. That is the whole economy of the thing: a subagent that returned everything it saw would have saved nothing, because the context would land here anyway.",
						"- It was an **explore** agent, so it could not have written anything even if it decided to. That is authority, not etiquette.",
						"",
						"The four types differ in exactly that authority: `explore` reads, `plan` designs without implementing, `review` inspects a diff, `general` writes. Choose the narrowest one that can do the job — not because a wider one misbehaves, but because a narrow one cannot.",
					].join("\n"),
					"zh-CN": [
						"有必要把刚才发生的事说准确，因为那张卡片很容易被读成「跑了一个工具」：",
						"",
						"- 一个**第二叙述者**被创建了，拥有自己的上下文窗口。你可以打开它，读到它走过的每一步。",
						"- 回到这里的是它的**归纳**，而不是它的阅读内容。这就是整件事的经济性所在：如果子代理把看到的一切都带回来，它什么也没省下，因为上下文最终还是会落在这里。",
						"- 它是一个 **explore** 代理，所以即便它想写，也写不了。这是权限，而不是礼节。",
						"",
						"四种类型的区别正在于这份权限：`explore` 只读，`plan` 只设计不实现，`review` 检查差异，`general` 可以写入。选择能完成任务的最小权限那一个——不是因为权限更大的会乱来，而是因为权限小的做不到。",
					].join("\n"),
				},
			},
		],
		subagentTurns: {
			explore: [
				{
					reasoning: {
						en: "Read-only survey. Answer in a few sentences and do not paste file contents back — returning everything would put the context right back into the parent conversation the delegation was meant to protect.",
						"zh-CN":
							"只读勘察。用几句话作答，不要把文件内容粘回去——全都带回去，会把上下文重新塞进这次委派本要保护的父对话里。",
					},
					text: {
						en: "Looking around before answering.",
						"zh-CN": "先四处看看再回答。",
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
							"Survey done. Four files: `README.md`, `notes.md`, `src/greeting.ts`, `src/tasks.ts`.",
							"",
							"One duplication worth reporting: `greet` and `greetLoudly` in `src/greeting.ts` build the same greeting template independently, so a change to the wording has to be made twice. `notes.md` already records it.",
							"",
							"`src/tasks.ts` has a single `countOpen` helper and no tests.",
						].join("\n"),
						"zh-CN": [
							"勘察完成。四个文件：`README.md`、`notes.md`、`src/greeting.ts`、`src/tasks.ts`。",
							"",
							"有一处重复值得报告：`src/greeting.ts` 里的 `greet` 和 `greetLoudly` 各自独立拼出同样的问候模板，所以改文案要改两遍。`notes.md` 里已经记下了这一点。",
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
			title: { en: "Tutorial: delegating to subagents", "zh-CN": "教程：委派给子代理" },
		},
	},

	"background-tasks": {
		lessonId: "background-tasks",
		turns: [
			{
				reasoning: {
					en: "Start it in the background so the turn is not held hostage. The whole point is that the card returns a handle rather than a result.",
					"zh-CN": "放到后台启动，这一轮就不会被扣住。要点在于卡片返回的是一个句柄而不是结果。",
				},
				text: {
					en: "This one takes a while, so I will start it in the background instead of making you wait.",
					"zh-CN": "这件事要花些时间，所以我把它放到后台启动，不让你干等。",
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
					en: "Do not Await it here. Waiting immediately after backgrounding it would make the background flag pointless and teach the opposite of the lesson.",
					"zh-CN":
						"这里不要 Await 它。刚放到后台就立刻等待，会让后台标记失去意义，教出与本课相反的东西。",
				},
				text: {
					en: [
						"Notice what the card returned: a task handle, not an answer. The agent is still working and this turn is already finishing.",
						"",
						"That is the trade being made. A foreground agent gives you its answer inside the turn, at the cost of the turn lasting as long as the work. A background agent frees the turn, at the cost of you (or I) having to come back for the result — which is what `Await` is for, and why the background tasks drawer exists.",
						"",
						"Background is the right choice when the answer is not needed to decide the next thing. When it is, waiting is not inefficiency — it is the dependency being honest.",
					].join("\n"),
					"zh-CN": [
						"注意卡片返回的东西：一个任务句柄，而不是答案。代理还在工作，而这一轮已经要结束了。",
						"",
						"这是一次权衡。前台代理在这一轮内就把答案给你，代价是这一轮要持续到工作做完。后台代理释放了这一轮，代价是你（或我）得回来取结果——这正是 `Await` 的用途，也是后台任务抽屉存在的原因。",
						"",
						"当「下一步怎么做」不依赖这个答案时，后台是对的选择。当它依赖时，等待并不是低效——那只是依赖关系本身如实呈现。",
					].join("\n"),
				},
			},
		],
		subagentTurns: {
			explore: [
				{
					text: {
						en: "Ran an audit. The one thing worth doing is removing the duplicated greeting template in `src/greeting.ts`; `src/tasks.ts` would benefit from a test for `countOpen` but is otherwise fine.",
						"zh-CN":
							"审查完成。真正值得做的是消除 `src/greeting.ts` 里重复的问候模板；`src/tasks.ts` 若能给 `countOpen` 补个测试会更好，但其余没有问题。",
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
					en: "Two agents in ONE turn, and they must be genuinely independent: one surveys the greeting code, the other the task code. If either needed the other's answer, parallelising would just make one of them guess.",
					"zh-CN":
						"在**同一轮**里派两个代理，而且它们必须真正独立：一个勘察问候代码，另一个勘察任务代码。如果其中任何一个需要对方的答案，并行只会让它去猜。",
				},
				text: {
					en: "These two halves do not depend on each other, so they can run at the same time.",
					"zh-CN": "这两半工作互不依赖，所以可以同时进行。",
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
					en: "Both came back. Say the thing that is easy to get wrong — that a slow agent is usually just working — rather than restating two short findings.",
					"zh-CN":
						"两边都回来了。说清最容易搞错的那一点——慢的代理通常只是在工作——而不是把两条简短结论再复述一遍。",
				},
				text: {
					en: [
						"Both agents ran at once and each reported on its own file.",
						"",
						"Parallelising was safe here for one reason only: neither half needed the other's answer. When work *is* dependent, running it in parallel does not make it faster — it makes one of the two proceed on a guess, and you find out later.",
						"",
						'The other half of coordination is knowing when to leave an agent alone. A wait that times out means *the wait ended*, not that the agent is stuck. Sending it a "status?" message costs it context and interrupts what it was doing; the honest signals are whether it is still making tool calls and what it eventually returns. Interrupt when the direction is wrong — not because you are impatient.',
					].join("\n"),
					"zh-CN": [
						"两个代理同时运行，各自汇报了自己那份文件。",
						"",
						"在这里并行是安全的，原因只有一个：两半工作都不需要对方的答案。当工作**确实**存在依赖时，并行并不会更快——它只会让其中一个基于猜测继续往下走，而你事后才发现。",
						"",
						"协作的另一半，是知道什么时候该别去打扰。等待超时意味着**这次等待结束了**，而不是代理卡住了。给它发一条「进展如何？」会浪费它的上下文并打断它正在做的事；真正可靠的信号是它是否还在调用工具，以及它最终返回了什么。方向错了才该中断——而不是因为你等得不耐烦。",
					].join("\n"),
				},
			},
		],
		subagentTurns: {
			explore: [
				{
					text: {
						en: "Read the file I was pointed at. The clearest improvement is removing the duplicated greeting template so the wording lives in one place; nothing else stands out in a file this small.",
						"zh-CN":
							"读了指定给我的文件。最明确的改进是消除重复的问候模板，让文案只存在于一处；在这么小的文件里，其余没有特别突出的问题。",
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
			title: { en: "Tutorial: several agents at once", "zh-CN": "教程：多个代理同时工作" },
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

export function resolveTutorialTurn(
	turn: TutorialScriptTurn,
	locale: Locale | string | null | undefined,
): ResolvedTutorialTurn {
	return {
		...(turn.reasoning ? { reasoning: pickLocalizedValue(turn.reasoning, locale) } : {}),
		...(turn.text ? { text: pickLocalizedValue(turn.text, locale) } : {}),
		toolUses: turn.toolUses ?? [],
	};
}
