// One description source for the model guide, native tool, and in-sandbox help.
// No fixture IDs, grading conditions, or reference solutions belong here.
export const CONTRACT_VERSION = "task-call-v4";

export const FLOWS = {
	sequence:
		"已确定的顺序操作放在同一次 Eval；需要理解新信息时才先返回。数据未变且目标已达成就结束，不重复测试、查询或提交。",
	execute:
		"执行自己的工作：按要求操作并验证后 finish(summary)；自管任务 done，分派任务 submitted、等待负责人验收。实际测试失败（TEST_FAILURE）才 block，不把提交/验收异常当测试失败。",
	review:
		"验收他人的 submitted：在实际验收的同一次 Eval 中取得对象 t，t.read()，核对最新 acceptance/result 及所需证明材料，满足后 t.accept()。finish 不是验收；另一对象或上一 Eval 的 read 不算。",
	query:
		"只查询或列计划：读取/分页或 add 即可，计划保持 todo；不额外开始、完成或恢复任务。完整分页取得所需结果后直接 return 并结束，不改筛选条件再查一遍。",
	recover:
		"catch 按失败调用和 code 分流：TEST_FAILURE 才 block 实际错误；CONTRACT_CHANGED 重读新要求并返回，不自动改变生命周期；READ_REQUIRED 在验收的同次 Eval 重读。不能把整段脚本的所有异常一律转成 block。",
} as const;

interface MethodDescription {
	signature: string;
	description: string;
}

const listDescription =
	"返回一页 {items: Task[], hasMore, next()}，不是完整数组；需要全量命中时循环至 hasMore=false。options：scope: self|team 或 agent（互斥），relation: current|creator|participated，archived: exclude|include|only（默认 exclude），search。主代理默认 team，子代理默认自己的工作。";
const getDescription =
	'返回 Task；查看归档时 options 传 {archived: "include"}，无需 restore。读取他人任务不授予写权限。';
const addDescription =
	"创建并返回 todo Task；可带 {children: string[]} 一并创建子任务，不自动开始。";

export const METHODS = {
	"task.read": {
		signature: "task.read()",
		description:
			"刷新本对象，返回 {key,text,status,paused,archived,description,acceptance,result,workflow}。result 可为 null；workflow 仅提示当前角色/状态的可选动作，不是执行要求或授权。",
	},
	"task.start": {
		signature: "task.start()",
		description: "开始自己有权执行的 todo 任务；已 doing 不必重复开始。",
	},
	"task.finish": {
		signature: "task.finish(summary)",
		description:
			"仅报告自己的执行结果，不用于验收别人。返回更新后的 Task（自管 done、分派 submitted）；最终状态取对象.status，不自造 finished。",
	},
	"task.block": {
		signature: "task.block(reason)",
		description:
			"记录真实执行阻塞；实际测试失败可用其 message。提交冲突不等于执行阻塞，不因任意异常自动 block。",
	},
	"task.accept": {
		signature: "task.accept()",
		description: FLOWS.review,
	},
	"task.archive": {
		signature: "task.archive()",
		description: "负责人归档 done/cancelled；归档不删除，不结束未完成工作。",
	},
	"task.restore": {
		signature: "task.restore()",
		description:
			'负责人先 get(key,{archived:"include"}) 再 restore；仅恢复可见性，仍暂停。查询历史无需恢复。',
	},
	"tasks.list": { signature: "tasks.list(options?)", description: listDescription },
	"tasks.get": { signature: "tasks.get(key, options?)", description: getDescription },
	"tasks.add": {
		signature: "tasks.add(text, options?)",
		description: `${addDescription}主代理默认建根项，子代理默认在分派根下创建。`,
	},
	"task.children.list": {
		signature: "task.children.list(options?)",
		description: `查询子任务集合。${listDescription}`,
	},
	"task.children.get": {
		signature: "task.children.get(key, options?)",
		description: getDescription,
	},
	"task.children.add": {
		signature: "task.children.add(text, options?)",
		description: `在当前任务下拆分工作。${addDescription}`,
	},
	"page.next": {
		signature: "page.next()",
		description: "保留筛选和归档读取范围，取得下一 TaskPage；先检查 page.hasMore。",
	},
	"tools.Read": {
		signature: "tools.Read({file_path})",
		description: "读取模拟文件，返回 {output: string}；不是原始字符串或真实宿主文件。",
	},
	"tools.Bash": {
		signature: "tools.Bash({command})",
		description:
			"执行模拟命令，成功返回 {output: string}；失败抛出带 code/message 的 Error，可 try/catch。",
	},
} satisfies Record<string, MethodDescription>;

export type MethodName = keyof typeof METHODS;
export interface RuntimeContract {
	version: string;
	flows: { [Key in keyof typeof FLOWS]: string };
	help: Record<string, string>;
	// Profile-specific wording only; error codes and mutation rules are unchanged.
	feedback?: { contractChanged: string };
	// Opt-in experiment only; omitted from the default V4 contract and guide.
	delivery?: { maxBytes: number; maxSummaryChars: number };
}

function methodHelp(name: MethodName): string {
	const method = METHODS[name];
	return `${method.signature}：${method.description}`;
}

export const RUNTIME_CONTRACT: RuntimeContract = {
	version: CONTRACT_VERSION,
	flows: FLOWS,
	help: Object.fromEntries(
		Object.keys(METHODS).map((name) => [name, methodHelp(name as MethodName)]),
	),
};

export const EVAL_DESCRIPTION = `执行同步 TypeScript 操作 task/tasks/tools；仅实际调用 Eval 才算执行，不支持 await/async/import。${FLOWS.sequence}finish 报告自己的工作，accept 验收他人（同一 Eval 先 read 核对）。catch 必须按错误码分流，不能一律 block。return 所需真实结果；失败不回滚此前成功调用。`;
export const CODE_DESCRIPTION =
	"同步 TypeScript；已知步骤串联调用，catch 按失败调用/code 分流；return 要求的最小结果";

export function renderApiGuide(): string {
	const daily: MethodName[] = [
		"tasks.list",
		"tasks.get",
		"tasks.add",
		"task.read",
		"task.start",
		"task.finish",
		"task.block",
	];
	return [
		"# 同步任务对象：实验接口",
		"",
		'你只有原生工具 Eval，输入 {"code":"TypeScript 代码"}；请实际调用，不要只在正文贴代码。',
		"",
		"## 先选流程，再写代码",
		"",
		...(["execute", "review", "query"] as const).map((flow) => `- ${FLOWS[flow]}`),
		"",
		FLOWS.sequence,
		"",
		"## 同步对象",
		"",
		"代码从上到下执行；可用变量、if、循环、map/forEach、try/catch，不使用 await/async/Promise/import 或宿主 API。每次 Eval 变量和对象重新创建，任务数据保留。",
		"",
		"task 是宿主绑定的当前任务；只读属性 key/text/status/paused/archived。task.children 是支持 list/get/add 的子集合。不要手传 ref、直接赋值或编造方法。",
		"",
		...daily.map((name) => `- ${methodHelp(name)}`),
		"",
		"## 工具、返回与帮助",
		"",
		`- ${methodHelp("tools.Read")}`,
		`- ${methodHelp("tools.Bash")}`,
		'- help("task") 查看目录，help("task.方法名") 查用法；已给出用法无需再次查询。',
		"- 用 return 返回所需值，保留要求的形状（状态、数组或文本）；不返回无关详情。无 return 时显示最后一次调用的结果。",
		`- ${FLOWS.recover}`,
		"- 错误不回滚此前成功的调用；不重复已有失败测试或用旧结果重试 finish，权限拒绝不强行覆盖。",
		"",
	].join("\n");
}
