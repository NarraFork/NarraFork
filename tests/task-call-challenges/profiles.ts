import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	CODE_DESCRIPTION,
	EVAL_DESCRIPTION,
	RUNTIME_CONTRACT,
	type RuntimeContract,
	renderApiGuide,
} from "./contract";

export interface BenchProfile {
	id: string;
	api: string;
	description: string;
	codeDescription: string;
	parameters: Record<string, unknown>;
	contract: RuntimeContract;
}

export const FROZEN_V4 = "2026-09-06T11-54-55-805Z";
export const DELIVERY_LIMITS = { maxBytes: 65_536, maxSummaryChars: 2000 } as const;
export const DELIVERY_GUIDE = `\n## 显式交付（实验）\n\n- return 用于让你观察中间信息；最终用 deliver(value, summary?) 交付，本轮随即结束，不再复核或调用 Eval。\n- value 严格采用用户要求的形状；可选补充说明放 summary，不要包进 value。\n- deliver 不验证答案、不完成或验收任务；先完成必要操作，再交付真实结果。交付须是最后一个 API 动作，之后不要继续调用。\n`;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function defaultProfile(parameters: Record<string, unknown>): BenchProfile {
	return {
		id: RUNTIME_CONTRACT.version,
		api: renderApiGuide(),
		description: EVAL_DESCRIPTION,
		codeDescription: CODE_DESCRIPTION,
		parameters,
		contract: RUNTIME_CONTRACT,
	};
}

export async function experimentProfiles(): Promise<{
	baseline: BenchProfile;
	delivery: BenchProfile;
}> {
	const directory = new URL("../../docs/task-call-challenges/results/", import.meta.url);
	const input = await Bun.file(new URL(`${FROZEN_V4}-inputs.json`, directory)).json();
	const manifest = await Bun.file(new URL(`${FROZEN_V4}-manifest.json`, directory)).json();
	assert.equal(sha256(input.api), manifest.apiHash);
	assert.equal(sha256(input.evalTool.description), manifest.descriptionHash);
	assert.equal(sha256(JSON.stringify(input.contract)), manifest.contractHash);
	assert.equal(renderApiGuide(), input.api, "Default V4 guide drifted");
	assert.equal(
		JSON.stringify(RUNTIME_CONTRACT),
		JSON.stringify(input.contract),
		"Default V4 contract drifted",
	);
	const baseline: BenchProfile = {
		id: "task-call-v4",
		api: input.api,
		description: input.evalTool.description,
		codeDescription: input.evalTool.parameters.properties.code.description,
		parameters: input.evalTool.parameters,
		contract: input.contract,
	};
	const delivery = structuredClone(baseline);
	delivery.id = "task-call-v5-delivery";
	delivery.api += DELIVERY_GUIDE;
	delivery.description +=
		" return 用于观察；最终以 deliver(value, summary?) 交付，成功后本轮结束。";
	delivery.codeDescription += "；完整交付用 deliver(value, summary?)，补充说明不要包进 value";
	const properties = delivery.parameters.properties as Record<string, Record<string, unknown>>;
	properties.code.description = delivery.codeDescription;
	delivery.contract.version = delivery.id;
	delivery.contract.delivery = DELIVERY_LIMITS;
	delivery.contract.help.deliver =
		"deliver(value, summary?)：封存并交付本轮结果；value 按用户要求，说明放可选 summary。只终结本轮，不修改任务状态，不校正答案。正文最多 64 KiB UTF-8，summary 最多 2000 字符；必须作为最后一个 API 动作。";
	return { baseline, delivery };
}

export const FROZEN_V5 = "2026-09-06T13-35-40-408Z-delivery";

const COHERENT_INTENTS = {
	observe: "还需要你看新信息再决定：用外层 return 观察结果，下一次 Eval 可继续。",
	answer:
		"本轮已可答复用户（完成、受阻、等待确认或只读查询）：用 deliver(value, summary?) 交付并结束。业务尚未 done 也能交付阶段结果。value 只放用户要求的值，说明另放 summary。",
	body: "写同步 TypeScript 函数体，可用 if/循环/try-catch，不用 async/await/Promise/import。内层函数的 return 不会穿透外层；观察 IIFE 结果也需外层 return。没有 return 时只显示最后一次 API 的结果。每次 Eval 重建变量，任务数据保留。",
} as const;

export async function coherentProfiles(): Promise<{
	baseline: BenchProfile;
	delivery: BenchProfile;
}> {
	const directory = new URL("../../docs/task-call-challenges/results/", import.meta.url);
	const input = await Bun.file(new URL(`${FROZEN_V5}-inputs.json`, directory)).json();
	const manifest = await Bun.file(new URL(`${FROZEN_V5}-manifest.json`, directory)).json();
	const baseline = input.conditions.B as BenchProfile;
	const expected = manifest.profileHashes.B;
	assert.equal(sha256(baseline.api), expected.api);
	assert.equal(sha256(baseline.description), expected.description);
	assert.equal(sha256(JSON.stringify(baseline.parameters)), expected.parameters);
	assert.equal(sha256(JSON.stringify(baseline.contract)), expected.contract);
	assert.deepEqual(baseline, (await experimentProfiles()).delivery, "Frozen V5 changed");

	const delivery = structuredClone(baseline);
	delivery.id = "task-call-v6-coherent";
	delivery.contract.version = delivery.id;
	delivery.contract.flows = {
		sequence:
			"已知步骤合在一次 Eval；需要理解新资料才 return 观察，本轮可答复时 deliver。不要用多个返回惯例收尾。",
		execute:
			"自己的工作：read 要求、执行并验证、finish 报告；自管 done，分派 submitted。准备答复就 deliver 用户要求的状态/结果，不等负责人验收后才交付本轮答复。",
		review:
			"负责人验收 submitted：在同一 Eval 对同一个对象 t.read()，核对最新要求与成果，满足后 t.accept()；随后 deliver 所需结果。不能用 finish；上次 Eval 或另一对象的 read 不算。",
		query:
			"只查询或列计划：分页至当前筛选的 hasMore=false，或 add 保持 todo，随后 deliver 所需值。不额外开始/完成/恢复任务，不为收尾再查一遍。",
		recover:
			"catch 按 code 分流：TEST_FAILURE 记录真实阻塞后交付所需状态/原因；CONTRACT_CHANGED 重读并交付用户所需的新信息，不自动改生命周期；READ_REQUIRED 在验收的同次 Eval 重读核对。等待确认也是本轮可交付的结果，不能 catch 一律 block。",
	};
	const help = delivery.contract.help;
	help.deliver = `deliver(value, summary?)：${COHERENT_INTENTS.answer}它不校验答案或修改任务；正文最多64 KiB UTF-8，summary最多2000 JS字符。交付后不能再调用 API，此前操作不回滚。`;
	help["task.read"] =
		"task.read()：刷新对象及已读凭据，详情含 description/acceptance/result/workflow；result 可为 null。workflow 是可选动作提示，不是执行要求或授权。需看资料再决定时 return 观察；本轮答复时 deliver 所需字段。";
	help["task.finish"] =
		"task.finish(summary)：报告自己已经验证的执行结果，返回更新后的 Task；自管 done，分派 submitted。不是验收别人。状态从对象.status取，本轮要答复的状态以 deliver 交付。";
	help["task.block"] =
		"task.block(reason)：记录真实执行阻塞，返回更新 Task；本轮停止时 deliver 用户所需状态/原因。提交冲突不等于执行阻塞，不因任意异常自动 block。";
	help["task.accept"] = `task.accept()：${delivery.contract.flows.review}`;
	help["tasks.list"] =
		"tasks.list(options?)：一页 {items:Task[],hasMore,next()}；完整结果需循环分页。scope:self|team 与 agent 互斥，relation:current|creator|participated，archived:exclude|include|only（默认exclude），search。主代理默认team，子代理默认自身。";
	help["task.children.list"] = `task.children.list(options?)：限定子集合。${help["tasks.list"]}`;
	delivery.contract.feedback = {
		contractChanged:
			"任务目标已改变，本次未提交，生命周期不变。这不是 TEST_FAILURE，不自动 block。用当前对象 read() 取得新要求；本轮等待确认时，以 deliver 交付用户要求的新信息（value 不包多余状态，说明放 summary）。不用旧结果重试，先前成功操作不回滚。",
	};
	delivery.description = `执行同步 TypeScript 函数体，只有实际 Eval 才算执行。${COHERENT_INTENTS.observe}${COHERENT_INTENTS.answer}finish/accept 改业务状态，deliver 只结束本轮答复。错误按 code 分流，先前操作不回滚。`;
	delivery.codeDescription =
		"同步函数体：需要观察用外层 return；本轮答复（含受阻/待确认）用 deliver(所需值,可选说明)。不要在 value 外加状态包装或丢掉内层函数结果。";
	const properties = delivery.parameters.properties as Record<string, Record<string, unknown>>;
	properties.code.description = delivery.codeDescription;
	delivery.api = [
		"# 同步任务对象：观察与本轮答复",
		'只调用原生 Eval，输入 {"code":"代码"}，不要只在正文贴代码。',
		"",
		"## 只区分两个意图",
		COHERENT_INTENTS.observe,
		COHERENT_INTENTS.answer,
		"交付是最后一个 API 动作；不自动完成任务或校正答案。要文本就交付文本，要 key 数组就交付数组，不包额外状态。",
		"",
		"## 同步对象与工具",
		COHERENT_INTENTS.body,
		"task 是宿主绑定的当前任务，其他目标用 tasks.get(key)。只读概要 key/text/status/paused/archived；task.children 是支持 list/get/add 的子集合。不要手传 ref 或赋值状态。",
		...(
			[
				"tasks.list",
				"tasks.get",
				"tasks.add",
				"task.read",
				"task.start",
				"task.finish",
				"task.block",
				"tools.Read",
				"tools.Bash",
			] as const
		).map((name) => `- ${help[name]}`),
		"",
		"## 结束各类流程",
		delivery.contract.flows.review,
		delivery.contract.flows.query,
		delivery.contract.flows.recover,
		'不会的动作查 help(完整方法名)，目录 help("task")。读取不扩写权；错误不回滚之前调用，交付也不撤销已成功工作。',
		"",
	].join("\n");
	assert(delivery.api.length <= baseline.api.length, "Coherent guide must not grow beyond V5");
	return { baseline, delivery };
}

export const FROZEN_V6 = "2026-09-06T15-41-09-954Z-coherent-delivery";
export async function qualificationProfile(): Promise<BenchProfile> {
	const directory = new URL("../../docs/task-call-challenges/results/", import.meta.url);
	const input = await Bun.file(new URL(`${FROZEN_V6}-inputs.json`, directory)).json();
	const manifest = await Bun.file(new URL(`${FROZEN_V6}-manifest.json`, directory)).json();
	const profile = input.conditions.B as BenchProfile;
	const expected = manifest.profileHashes.B;
	assert.equal(sha256(profile.api), expected.api);
	assert.equal(sha256(profile.description), expected.description);
	assert.equal(sha256(JSON.stringify(profile.parameters)), expected.parameters);
	assert.equal(sha256(JSON.stringify(profile.contract)), expected.contract);
	assert.deepEqual(
		profile,
		(await coherentProfiles()).delivery,
		"Qualification candidate must match frozen V6",
	);
	return profile;
}
