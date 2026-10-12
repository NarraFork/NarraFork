/**
 * 发送前上下文预检 —— 在请求真正发给 provider 之前做一次全量估算，注定装不下就不发。
 *
 * 背景：既有的错误恢复链（loop 产出 `context_length_exceeded` → narrator-executor →
 * agent-runtime/transition 的 `kind:"overflow"` → orchestrator 的 `handleContextOverflow`
 * → narrator-recovery 的紧急压缩 + `retry_compacted`）只在 provider 拒绝之后才动手。这意味着
 * 一次注定被拒的请求仍然要把整份历史传上去、等上游返回，用户白等一轮。参考 opencode v2：
 * 请求组装完成后、发出之前用本地估算与"窗口 − 输出预留"比较，超了先压缩、请求根本不发。
 * 它的估算比我们还粗（固定 length/4），但"预检时机 + 绝对预算 + 显式缓冲"才是起作用的部分。
 *
 * 与 opencode 的有意分歧：
 * 1. **窗口取不到时不 fail-open。** opencode 在拿不到 `limit.context` 时把上限置 0 并跳过
 *    检查；本项目的 `getModelContextWindow()` 六级回退后永远返回数值（兜底
 *    {@link DEFAULT_CONTEXT_WINDOW} = 272_000），所以这里用兜底值继续检查。跳过检查等于在
 *    元数据最不完整的会话上取消保护，而那恰恰是最容易踩到窗口的时候。
 * 2. **估算口径不同：** opencode 全用固定的 length/4；这里复用项目已校准的
 *    `estimateTokens()`（ASCII 0.5 / CJK 0.85 token/字符），与 UI 的上下文占用、切模型告警
 *    保持同一把尺子。已知代价见 estimate-tokens.ts 文件头：对 JSON / 代码 / 工具输出密集的
 *    内容仍会低估，所以本模块的结论口径是"估算确定超预算就不发"，而**不是**"估算没超就一定
 *    发得出去"——后者仍由既有的错误分类 + 恢复链兜底。
 * 3. **遍历提前结束本身不构成拦截理由。** 见 {@link ContextPreflightEstimate.partial}：只有
 *    "估值 > 可用预算"才拦。超深/超宽的**结构**（例如尚未转成 JSON 的 schema 对象）会让遍历
 *    提前结束却几乎不占窗口，把它当成超预算会拦掉正常请求。
 * 4. **字符 → token 的换算优先用目标模型自己实测的比值**（见 `context-calibration.ts`）。全局
 *    系数给不出跨模型一致的绝对值：同一份内容在 hy4-preview 上记 638,848 token，在
 *    deepseek-v4.1-flash 上记 1,080,519（1.69 倍），而把全局系数抬到能拦住稠密模型的水平，代价
 *    是纯英文长会话在真实只占 25%–50% 窗口时就被拦下。所以调用方把 `effectiveModel` 传进来
 *    （{@link ContextPreflightEstimateOptions}）时，改用该模型的实测比"字符数 × 比值"；没有样本、
 *    采样被关掉、或调用方没传模型时，完全走原来的分类口径（`estimateTokens`），行为与校准上线前
 *    逐字节一致。这条只改"如何把字符换算成 token"，不改本模块的判定语义与常量。
 *
 * 判据是**绝对预算**（窗口 − 输出预留），不是 `compactStart` 那类百分比日常压缩阈值：这里问的
 * 是"装不装得下"，不是"该不该压缩"。因此本模块不读 contextThresholds。
 *
 * 性能：绝不对整个 payload 做 `JSON.stringify`（3MB 请求体的同步序列化 + 随之而来的整串
 * 分类会长时间占用主线程，本项目明令禁止）。这里用有上限的轻量遍历：字符串值直接取 length 并
 * 交给 `estimateTokens` 逐字符分类，对象键另折算固定结构 token，全程不产生请求量级的中间字符串。
 *
 * 性能量级（用真实模块构造合成载荷、在单台开发机上以 Bun 计时，重复测得的量级）：
 * - 2.32M 字符 / 约 800 节点（content + history + tools）：约 4 ms
 * - 5.08M 字符：约 12 ms（仅用于对照，实际会被 {@link MAX_PREFLIGHT_CHARS} 提前收口）
 * - 15 万节点（短字符串为主）：约 14 ms —— 这是节点上限存在的理由，节点开销来自
 *   `Object.entries` 的分配，比逐字符分类贵一个量级
 * - 同样本 `JSON.stringify` 全长：约 4 / 8 ms，但要额外产生 2.3–5.1MB 垃圾，随后还得
 *   再分类一遍整串
 * 由上界推得最坏情况约 10–15 ms，且只在远超任何窗口的输入上才发生。
 */

import { logger } from "../logger";
import { DEFAULT_CONTEXT_WINDOW, settings } from "../settings";
import { contextCalibrationRatioFor } from "./context-calibration";
import { estimateTokens } from "./estimate-tokens";

/**
 * 输出预留下限（token）。
 *
 * 取 opencode 的 `DEFAULT_BUFFER = 20_000`：在常见的 200k 窗口上留出 10% 余量，避免请求压在
 * 窗口边缘，也让"模型明明还能吐 20k 输出"这种情况不至于因为输入顶着上限而失败。
 *
 * 注意它**不是**估算误差的补偿：`estimateTokens` 对结构化内容可能低估一倍以上（见其文件头），
 * 20k 在 1M 窗口上只占 2%，补不了那个缺口。窗口未知时的兜底与偏差口径见文件头。
 * 模型元数据能给出 `maxOutputTokens` 时由它接管（见 {@link preflightReserveTokens}）。
 */
export const PREFLIGHT_BUFFER = 20_000;

/**
 * 遍历字符上限：越过它就停止逐字符分类（主线程安全的硬约束）。
 *
 * 4M 选在"连最大的真实窗口也放不下"的保守位置：按最低的 ASCII 0.5 token/字符，4M 字符已是
 * 约 2M token。收口后已数到的字符数会经 {@link MIN_TOKENS_PER_CHAR} 折成下界再参与比较，
 * 因此这个上限不会把"其实装得下"的请求误判成超预算（详见 {@link estimatePayloadTokens}）。
 */
export const MAX_PREFLIGHT_CHARS = 4 * 1024 * 1024;

/** 遍历节点上限：防止异常深/宽的 payload 把主线程拖住（15 万节点实测已 13.6 ms）。 */
export const MAX_PREFLIGHT_NODES = 40_000;

/** 遍历深度上限：同时兜住自引用结构。 */
export const MAX_PREFLIGHT_DEPTH = 16;

/** 单次预检估算结果。 */
export interface ContextPreflightEstimate {
	/** 估算输入 token 数；`partial` 为 true 时只是下界。 */
	tokens: number;
	/**
	 * 遍历未覆盖全部内容（深度截断或触及体量/节点上限）。此时 `tokens` 是下界，
	 * 已按 {@link MIN_TOKENS_PER_CHAR} 补过下界换算——但仍然只是下界，
	 * 调用方不得仅凭它判断"超预算"。
	 */
	partial: boolean;
	/** 遍历数到的字符数（校准口径的分母；仅用于诊断与日志）。 */
	chars?: number;
	/** 实际生效的字符→token 换算来源。 */
	source?: ContextPreflightEstimateSource;
	/** 命中模型实测比时的细节；回退全局系数时为 null。 */
	calibration?: ContextPreflightCalibration | null;
}

/** 字符→token 的换算来源。 */
export type ContextPreflightEstimateSource = "model-calibration" | "global-heuristic";

/** 模型实测比的估算依据（用于日志与"这次为什么拦/没拦"的事后核对）。 */
export interface ContextPreflightCalibration {
	/** 采样键（`effectiveModel`）。 */
	model: string;
	/** 最近一次贡献样本的 provider，仅诊断用。 */
	provider: string | null;
	/** 实测比：token/字符。 */
	ratio: number;
	/** 参与分位数的样本数。 */
	samples: number;
}

/** 估算选项。不传（或 `model` 为空）时完全走全局分类口径。 */
export interface ContextPreflightEstimateOptions {
	/**
	 * 目标模型（`effectiveModel`）。该模型有达标样本时用它的实测比换算；
	 * 否则（无样本/样本不足/校准开关关闭）回退全局系数。
	 */
	model?: string | null;
}

/** 预检判定结果。 */
export interface ContextPreflightVerdict {
	exceeded: boolean;
	/** 实际参与比较的窗口（元数据缺失时为 DEFAULT_CONTEXT_WINDOW）。 */
	contextWindow: number;
	/** 为输出预留的 token 数。 */
	reservedTokens: number;
	/** 可用输入预算 = 窗口 − 预留。 */
	usableTokens: number;
	estimatedTokens: number;
	/** 估算是否只是下界（见 {@link ContextPreflightEstimate.partial}）。 */
	partial: boolean;
	/** 遍历数到的字符数（仅诊断用，回落到旧调用方构造的判定对象时为 undefined）。 */
	chars?: number;
	/** 字符→token 的换算来源（仅诊断用）。 */
	source?: ContextPreflightEstimateSource;
	/** 命中模型实测比时的细节；回退全局系数时为 null。 */
	calibration?: ContextPreflightCalibration | null;
}

/** 每个对象键（连同冒号、引号、逗号）折算的结构 token 下限。 */
const STRUCTURAL_TOKENS_PER_KEY = 1;

/**
 * 字符→token 的下界系数。只在遍历提前结束时用来把"已数到的字符"折成一个诚实的下界。
 *
 * 取 0.25（英文散文实测约 0.25 token/字符），因为下界必须对最"稀疏"的内容也成立；
 * 用它换算出的值只用于判断"是不是连下界都超预算了"，不会抬高正常估算。
 */
const MIN_TOKENS_PER_CHAR = 0.25;

interface WalkState {
	tokens: number;
	chars: number;
	nodes: number;
	/** 遍历未覆盖全部内容（深度截断/上限中止）：tokens 只是下界。 */
	partial: boolean;
	/** 遍历被上限中止，主线程安全优先，立即停止。 */
	aborted: boolean;
}

/**
 * 累加一个值的内容规模。字符串值是估算的主项：逐字符分类后交给 `estimateTokens`。
 * 对象键另按 {@link STRUCTURAL_TOKENS_PER_KEY} 折算——工具 schema 这类"键多值短"的内容
 * 若只算字符串值会明显少算。
 */
function addValueTokens(value: unknown, state: WalkState, depth: number): void {
	if (state.aborted) return;
	if (typeof value === "string") {
		state.chars += value.length;
		if (state.chars > MAX_PREFLIGHT_CHARS) {
			// 已经越过体量上限：不再逐字符分类（这是主线程安全的硬约束）。已数到的字符数
			// 仍会在收尾时经 MIN_TOKENS_PER_CHAR 换算成一个可比的下界。
			state.aborted = true;
			state.partial = true;
			return;
		}
		state.tokens += estimateTokens(value);
		return;
	}
	if (value === null || value === undefined) return;
	if (typeof value !== "object") {
		// 数字 / 布尔 / 函数 / symbol：只承担 JSON 里那一个结构字符。
		state.chars += 1;
		return;
	}
	state.nodes++;
	if (state.nodes > MAX_PREFLIGHT_NODES) {
		state.aborted = true;
		state.partial = true;
		return;
	}
	if (depth >= MAX_PREFLIGHT_DEPTH) {
		// 只跳过这棵子树，不放弃整次遍历：兄弟节点里的内容仍然是有效样本。
		// 超深结构（例如未经 JSON 化的 schema 对象）在这里被记成"部分覆盖"，
		// 而不是被判成"体量很大"。
		state.partial = true;
		state.chars += 1;
		return;
	}
	if (Array.isArray(value)) {
		// 方括号 + 逗号：按每个元素 1 个结构字符计。
		state.chars += value.length + 1;
		for (const entry of value) addValueTokens(entry, state, depth + 1);
		return;
	}
	const entries = Object.entries(value as Record<string, unknown>);
	// 花括号 + 冒号 + 逗号 + 引号：按每个键约 4 个结构字符计（只用于体积上限）。
	state.chars += entries.length * 4;
	for (const [key, entry] of entries) {
		state.chars += key.length;
		state.tokens += STRUCTURAL_TOKENS_PER_KEY;
		addValueTokens(entry, state, depth + 1);
	}
}

/**
 * 估算一批请求分片的输入规模（token）。
 *
 * 分片应当覆盖真正会发给 provider 的全部内容：当前消息（`content`）、历史
 * （`history`，含注入其中的 system prompt）、待回填的工具结果、以及 provider 已格式化
 * 的 `tools`。漏掉的部分只是少算，不会算重——重复计数只可能来自把同一份内容传两次，
 * 调用方需自行避免。
 *
 * **图片附件不在此列，也不能简单地算进来。** 图片是 `provider.chat` 的独立参数
 * （`images`），既不在 `content` 也不在 `history` 里；而它的 token 数按分辨率折算，
 * 与 base64 长度不成比例——把 base64 当字符走本模块的换算会高估一两个数量级
 * （1MiB 图的 base64 约 1.4M 字符，真实约一千多 token），不折算又会低估。因此调用方
 * （见 `loop.ts` 的预检调用点）在**首轮带图时整段跳过预检**，把那一轮交给既有的错误
 * 分类与恢复链：宁可少拦一次，也不要凭一个必然失准的数字拦掉用户刚发的图。
 *
 * `options.model` 给出目标模型且该模型有达标实测比时，字符数直接乘实测比；否则走全局分类口径。
 */
export function estimatePayloadTokens(
	parts: readonly unknown[],
	options?: ContextPreflightEstimateOptions,
): ContextPreflightEstimate {
	// 校准命中只改"字符 → token"这一步：样本不足、开关关闭、未给模型都返回 null → 原样回退。
	const calibration = options?.model ? contextCalibrationRatioFor(options.model) : null;
	const state: WalkState = { tokens: 0, chars: 0, nodes: 0, partial: false, aborted: false };
	for (const part of parts) addValueTokens(part, state, 0);
	const tokens = calibration
		? calibratedTokens(state, calibration.ratio)
		: // 遍历没覆盖完时，已数到的字符数本身是个可靠下界：用最稀疏内容的下界系数换算，
			// 免得"结构极深但内容很少"的对象（例如还没转成 JSON 的 schema）被当成超长输入。
			state.partial
			? Math.max(state.tokens, state.chars * MIN_TOKENS_PER_CHAR)
			: state.tokens;
	return {
		tokens: Math.ceil(tokens),
		partial: state.partial,
		chars: state.chars,
		source: calibration ? "model-calibration" : "global-heuristic",
		calibration: calibration
			? {
					model: calibration.model,
					provider: calibration.provider,
					ratio: calibration.ratio,
					samples: calibration.samples,
				}
			: null,
	};
}

/**
 * 校准口径的换算：该模型的实测比已经把分词密度量出来了，字符数相乘即可。
 *
 * `partial`（遍历提前结束）时至少保留 {@link MIN_TOKENS_PER_CHAR} 这个全局下界系数：下界语义
 * 不因校准而放松——实测比低于它时，宁可沿用那个更保守的换算。
 */
function calibratedTokens(state: WalkState, ratio: number): number {
	if (!state.partial) return state.chars * ratio;
	return state.chars * Math.max(ratio, MIN_TOKENS_PER_CHAR);
}

/** 输出预留：模型元数据的 maxOutputTokens 与 {@link PREFLIGHT_BUFFER} 取大者。 */
export function preflightReserveTokens(maxOutputTokens: number | null | undefined): number {
	return Math.max(
		typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
			? maxOutputTokens
			: 0,
		PREFLIGHT_BUFFER,
	);
}

/**
 * 把"窗口 / 输出预留 / 估算规模"折成一条判定。
 *
 * 窗口缺失或不是正数时用 {@link DEFAULT_CONTEXT_WINDOW} 继续检查（与 opencode 的
 * fail-open 相反，见文件头）。
 */
export function evaluateContextPreflight(input: {
	contextWindow: number | null | undefined;
	maxOutputTokens?: number | null;
	estimate: ContextPreflightEstimate;
}): ContextPreflightVerdict {
	const resolvedWindow =
		typeof input.contextWindow === "number" &&
		Number.isFinite(input.contextWindow) &&
		input.contextWindow > 0
			? input.contextWindow
			: DEFAULT_CONTEXT_WINDOW;
	const reservedTokens = preflightReserveTokens(input.maxOutputTokens);
	const usableTokens = Math.max(0, resolvedWindow - reservedTokens);
	// 只用 token 比较，不把 `partial` 当成"超预算"：遍历提前结束只说明估算是个下界，
	// 而超深/超宽结构完全可能来自"内容很少"的对象（例如未被 JSON 化的 schema 对象）。
	// 宁可放行、让既有的错误分类与恢复链兜底，也不要凭一个下界拦掉正常请求。
	const verdict: ContextPreflightVerdict = {
		exceeded: input.estimate.tokens > usableTokens,
		contextWindow: resolvedWindow,
		reservedTokens,
		usableTokens,
		estimatedTokens: input.estimate.tokens,
		partial: input.estimate.partial,
		chars: input.estimate.chars,
		source: input.estimate.source ?? "global-heuristic",
		calibration: input.estimate.calibration ?? null,
	};
	if (verdict.calibration) {
		// 事后核对"这次为什么拦/没拦"：模型、字符数、用的比值、算出的 token、窗口、结论。
		// 只在真的用实测比换算时记一条，回退全局系数的路径保持零日志。
		logger.debug("Context preflight converted characters with the model's measured ratio", {
			model: verdict.calibration.model,
			modelProvider: verdict.calibration.provider,
			chars: verdict.chars,
			ratio: verdict.calibration.ratio,
			samples: verdict.calibration.samples,
			estimatedTokens: verdict.estimatedTokens,
			contextWindow: verdict.contextWindow,
			reservedTokens: verdict.reservedTokens,
			usableTokens: verdict.usableTokens,
			exceeded: verdict.exceeded,
			partial: verdict.partial,
		});
	}
	return verdict;
}

/** 预检开关；默认开启，只有显式写成 false 才关闭（`settings.json` 缺键时保持开启）。 */
export function isContextPreflightEnabled(): boolean {
	return settings.agent.contextPreflightEnabled !== false;
}

/**
 * 非本地化诊断文案：随 `context_length_exceeded` 事件进日志与请求 dump，不直接面向用户
 * （用户可见的失败文案仍由 narrator-recovery 的 `getContextOverflowFailureError` 产出）。
 */
export function formatContextPreflightMessage(
	verdict: ContextPreflightVerdict,
	meta: { provider: string; model: string },
): string {
	const estimated = verdict.partial
		? `at least ${verdict.estimatedTokens}`
		: `${verdict.estimatedTokens}`;
	// 用了实测比时把依据一并写进诊断串：日志与请求 dump 里能直接看到"这次为什么拦"。
	const calibrated = verdict.calibration
		? ` [calibrated: ${verdict.chars ?? 0} chars × ${verdict.calibration.ratio} token/char ` +
			`from ${verdict.calibration.samples} samples of ${verdict.calibration.model}]`
		: "";
	return (
		`Preflight estimate: input is ${estimated} tokens, over the usable budget of ` +
		`${verdict.usableTokens} (context window ${verdict.contextWindow} minus ` +
		`${verdict.reservedTokens} reserved for output) for ${meta.provider}:${meta.model}${calibrated}`
	);
}
