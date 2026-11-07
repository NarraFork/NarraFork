/**
 * The plans of the outline plan card's browser test (`outline-plan-tree.browser.test.ts`, plan
 * readability): a realistic plan in the owner's format, in Chinese and in English (a title, the
 * background, three big points with their small points and implementation details, the notable
 * points), and the plan of the owner's first screenshot, written before the format (the goal and
 * the acceptance in one root paragraph, long bullets four levels deep). Pure data: the fixture
 * draws them in Chromium, the test checks that the formatted ones pass the submission check.
 */
import type { OutlineItem } from "@shared/outline";

const item = (content: string, children: OutlineItem[] = [], task = false): OutlineItem => ({
	content,
	task: task ? { status: "todo", assignee: null } : null,
	props: {},
	children,
});
const step = (content: string, children: OutlineItem[] = []) => item(content, children, true);

/** The owner's format, in Chinese. */
export const FORMAT_ZH: OutlineItem = step("历史读取超过 10 秒改为告警", [
	item(
		"模型历史链路、工具结果回放和会话恢复读历史时都带着 10 秒的固定超时，超过就直接拒绝并报 HISTORY_READ_TIMEOUT；慢磁盘或大会话上，用户只看到会话莫名失败，看不到原因。这次把三处固定时间拒绝都改成告警：读取照常完成，慢的时候在日志里记一条带耗时的 warn，并在会话头部提示正在读取历史。分页、游标和每页上限都不变。",
	),
	step("阶段 1：去掉固定时间拒绝", [
		step("清除模型历史链路的固定时间拒绝", [
			item(
				"删除 deadline 传播和超时 reject：history-build.ts 的 readHistoryPage 不再 Promise.race，读完后比较耗时，超过阈值调用 logSlowOperation 并把耗时带进返回值",
			),
			item("loop.ts 删掉捕获 HISTORY_READ_TIMEOUT 的分支，这个错误码不再产生"),
			item("错误码定义保留一个版本，避免旧日志解析报错"),
			item("buildModelHistory 不改签名：耗时是可选字段，旧调用方忽略即可", [
				item("新调用方用它决定要不要发界面提示"),
			]),
			item("阈值 10 秒做成常量，放在 history-limits.ts"),
		]),
		step("工具结果回放改为告警", [
			item("回放超过 10 秒只记 warn，不再拒绝，结果照常回放给模型和界面"),
			item("告警带工具调用 id，方便在日志里对上是哪一次调用读得慢"),
			item("replayToolResults 的单测改成断言告警，不再断言抛错"),
		]),
		step("会话恢复路径改为告警", [item("restoreSession 读历史的超时拒绝改成告警，恢复流程不中断")]),
	]),
	step("阶段 2：界面提示", [
		step("读取慢时在会话头部显示提示", [
			item("复用现有的会话状态事件，加一个 slowHistory 字段，读取完成后清掉"),
			item("不新增 WebSocket 消息类型，旧客户端收不到提示也不会出错"),
		]),
		step("提示文案进 en / zh-CN 两套语言文件"),
	]),
	step("阶段 3：验收与回归", [
		step("三条链路各加一个注入延迟的测试", [
			item("注入 15 秒延迟：读取照常返回，日志里有 warn，带会话 id、链路名和耗时"),
			item("用注入的延迟模拟慢读取，不依赖真实的慢磁盘，CI 上结果稳定"),
		]),
		step("跑受影响目录的现有测试，确认没有回归"),
	]),
	item("特别值得注意的点", [
		item("HISTORY_READ_TIMEOUT 错误码保留一个版本：旧客户端和日志解析器还在用它"),
		item("压缩恢复链路这次不动：它的超时保护的是磁盘，不是用户体验"),
		item("告警不限频：慢读取本身很少，线上告警过多再单独加限频"),
	]),
]);

/** The owner's format, in English. */
export const FORMAT_EN: OutlineItem = step("Warn instead of failing on history reads over 10 s", [
	item(
		"Reading history for the model, replaying tool results and restoring a session all carry a fixed 10-second timeout and fail with HISTORY_READ_TIMEOUT past it. On a slow disk or a large session the user just sees the session fail, with no reason. This turns all three into warnings: the read completes, a slow one logs a warning with its duration, and the session header says history is loading.",
	),
	step("Phase 1: remove the fixed-time refusal", [
		step("Remove the fixed-time refusal from the model history path", [
			item(
				"Drop the deadline and the timeout reject: readHistoryPage in history-build.ts no longer races a timer; after the read it compares the elapsed time and calls logSlowOperation past the threshold",
			),
			item(
				"loop.ts: delete the branch catching HISTORY_READ_TIMEOUT; the code is no longer raised",
			),
			item("Keep the error code's definition for one release so old log parsers do not fail"),
			item("buildModelHistory keeps its signature: the duration is an optional field", [
				item("New callers use it to decide whether to show the notice"),
			]),
			item("The 10-second threshold becomes a constant in history-limits.ts"),
		]),
		step("Tool-result replay warns instead", [
			item("A replay over 10 seconds logs a warning and still replays the results"),
			item("The warning carries the tool call id, to match the slow read in the log"),
			item("replayToolResults' unit tests assert the warning instead of the throw"),
		]),
		step("Session restore warns instead", [
			item("restoreSession's timeout becomes a warning; the restore goes on"),
		]),
	]),
	step("Phase 2: the notice", [
		step("Show a notice in the session header while a read is slow", [
			item("Reuse the session state event with a slowHistory field, cleared when the read ends"),
			item("No new WebSocket message type: old clients just do not show the notice"),
		]),
		step("Notice strings in both en and zh-CN"),
	]),
	step("Phase 3: acceptance and regressions", [
		step("A delayed-read test for each of the three paths", [
			item(
				"A read delayed 15 s still answers; the log has the warning with session, path and time",
			),
			item("The delay is injected, not a real slow disk, so CI stays stable"),
		]),
		step("Run the existing tests of the affected directories"),
	]),
	item("Notable points", [
		item("HISTORY_READ_TIMEOUT stays defined for one release: old clients and log parsers use it"),
		item("The compaction restore path is not touched: its timeout protects the disk"),
		item("Warnings are not rate-limited: slow reads are rare; add a limit if they flood"),
	]),
]);

/** The plan of the owner's first screenshot: the goal and the acceptance in the root, long bullets. */
export const LEGACY: OutlineItem = step(
	[
		"历史读取10秒改告警",
		"目标：把模型历史链路、工具结果回放和会话恢复里“读取历史超过 10 秒就拒绝”的固定时间限制全部改成告警，读取照常完成；慢的时候在日志和界面上提示，用户能看到原因，不再看到莫名其妙的失败。",
		"验收：1）人为注入 15 秒延迟的慢读取照常返回，不再报 HISTORY_READ_TIMEOUT；2）日志里有一条 warn，带会话 id、链路名和耗时；3）界面提示在读取完成后消失；4）现有历史读取测试全部通过，新增的告警测试覆盖三条链路。",
	].join("\n"),
	[
		item("已确定的边界与取舍", [
			item(
				"只改“超时即拒绝”的行为，不改读取本身：分页、游标和每页上限都保持不变，避免同时改两件事时无法判断回归来自哪里。",
			),
			item(
				"告警阈值沿用 10 秒，但做成常量放在 history-limits.ts 里，后面要调只改一处；不做成用户设置，因为没有人需要按会话调它。",
			),
			item(
				"不在主线程上做任何新的同步等待：告警通过已有的慢操作日志通道发出，界面提示走现有的会话状态事件，不新增 WebSocket 消息类型。",
			),
			item(
				"压缩恢复链路这次不动：它的超时是保护磁盘的，不是保护用户体验的，和这次的问题无关，单独评估后再决定要不要放宽。",
			),
			item(
				"旧客户端看不到新提示也没关系：它们收到的仍然是照常完成的读取结果，只是少一条提示，不会出错。",
			),
			item(
				"测试只在受影响的三个目录里跑，不跑全量；慢读取用注入延迟模拟，不依赖真实的慢磁盘，保证 CI 上结果稳定。",
			),
		]),
		step("阶段1：历史读取10秒改告警——先去掉模型历史链路里的固定时间拒绝，再处理工具结果回放", [
			step("清除模型历史链路的固定时间拒绝", [
				item(
					"history-build.ts 里 readHistoryPage 的 10 秒 Promise.race 去掉，改成读取完成后比较耗时，超过阈值时调用 logSlowOperation，并把耗时带进返回值。",
				),
				item(
					"loop.ts 里捕获 HISTORY_READ_TIMEOUT 的分支一起删掉，这个错误码不再产生；保留错误码定义一个版本，避免旧日志解析报错。",
				),
				item(
					"调用方 buildModelHistory 不需要改签名：耗时是可选字段，旧调用方忽略即可，新调用方用它决定要不要发界面提示。",
				),
			]),
			step("工具结果回放改为告警", [
				item("replayToolResults 同样去掉 race，耗时超过阈值时只告警，结果照常回放。"),
				item("回放的告警带工具调用 id，方便在日志里对上是哪一次调用读得慢。"),
			]),
			step("会话恢复路径同样改成告警", [
				item("restoreSession 读历史的超时拒绝改成告警，恢复流程不中断。"),
			]),
		]),
		step("阶段2：界面提示", [
			step("读取慢时在会话头部显示提示", [
				item("复用现有的会话状态事件，加一个 slowHistory 字段，读取完成后清掉。"),
			]),
			step("提示文案进 en / zh-CN 两套语言文件"),
		]),
		step("阶段3：测试与回归", [
			step("三条链路各加一个注入延迟的测试"),
			step("跑受影响目录的现有测试，确认没有回归"),
		]),
		item("开放问题", [item("告警是否需要按会话限频？目前倾向不限，因为慢读取本身就很少。")]),
	],
);
