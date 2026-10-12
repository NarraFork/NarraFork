/**
 * 按模型校准"字符 → token"的换算比。
 *
 * 为什么需要：同一份内容在不同模型上的 token 数可以差一倍以上（真实事故：3,077,644 字节的请求
 * 在 hy4-preview 上 638,848 token，在 deepseek-v4.1-flash 上 1,080,519 token，1.69 倍）。
 * `estimate-tokens.ts` 的全局系数（ASCII 0.5 / CJK 0.85）给不出跨模型一致的绝对值，而把全局系数
 * 调到能拦住最稠密模型的水平，代价是纯英文长会话在真实只占 25%–50% 窗口时就被发送前预检拦下——
 * 预检走的是 compact+retry 硬路径，不是温和的日常压缩。所以每个模型量自己的密度。
 *
 * 数据同源：`input-characters.ts` 在发送前统计 wire 的字符数（`countInputCharacters`，与预检的
 * 轻量累加同属"遍历"口径，不是 `JSON.stringify`），同一次请求的响应又带回 provider 上报的
 * `promptTokens`（各 provider 都已把它归一成"整份输入足迹"）。两者相除就是该模型在这份内容上的
 * 实测密度（token/字符），而字符数与 token 数**同属一次请求**，不需要额外探测。
 *
 * 配对时机：字符数在请求发出之前到达（`onInputCharacters`），token 数在响应事件里到达。因此按
 * "一次 loop 调用一个探针"隔离——并发叙述者各有各的探针（哪怕跑同一个模型也不会串台），同一调用
 * 内的重试则依赖 attempt 串行这一事实（上一轮的 usage 不可能在下一轮 `begin` 之后才到）。
 * 没有 usage 的失败/中断请求不产生样本：`observe` 从未被调用，`flush` 直接丢弃。
 *
 * 聚合：每模型保留一个滑动窗口（{@link MAX_CALIBRATION_SAMPLES_PER_MODEL} 条），取
 * {@link CALIBRATION_RATIO_QUANTILE} 分位数而**不是**平均值——超大工具输出、几乎全 JSON 的极端
 * 样本会把均值带偏，分位数对它们不敏感（取上分位是往"宁可高估"的方向靠，与 estimate-tokens.ts
 * 的取向一致）。样本不足 {@link MIN_CALIBRATION_SAMPLES} 条时视为无数据，预检回退全局系数。
 *
 * 持久化：内存为主、节流异步落盘到 `~/.narrafork/context-calibration.json`。绝不在请求路径上做
 * 同步写：写入统一走 `node:fs/promises`，失败只记日志。文件不存在/损坏时静默从零开始，不影响任何
 * 请求。模型数与每模型样本数都有硬上限，文件不会无限增长。
 *
 * 已知局限（预检侧都有兜底，且不改动"估算确定超预算就不发"的既有语义）：
 * 1. 比值是**内容构成的平均**：一个模型的历史样本里既有纯 ASCII 会话也有 CJK 会话，分位数取的是
 *    两者之间的保守位置，不是对当下这一份内容的最优估计。这是选分位数而非均值的原因之一。
 * 2. 分母是 wire 字符数（含 JSON 转义），预检侧乘的是它自己的轻量字符计数（不含转义），两者相差
 *    几个百分点（转义只影响引号/反斜杠/控制字符），方向上偏乐观一点点。
 * 3. 上游网关若自行裁剪历史，provider 报的 token 数对应的输入就比我们发出的少，比值会偏小。
 *    {@link MIN_CALIBRATION_RATIO} / {@link MAX_CALIBRATION_RATIO} 是这类污染的兜底闸门。
 * 4. 带图片附件的请求会让比值偏大：分母（wire 字符数）不含图片字节，分子（`promptTokens`）
 *    却含图片按分辨率折算的 token。图片每张约一千多 token，混进窗口会往上拉分位数。代价是
 *    预检偏保守（宁可高估），方向安全；分位数与样本闸门也能吸收少量离群样本，因此不做"带图
 *    则跳过采样"的额外检测——那需要额外扫描每个请求的附件，而预检侧本来就对带图请求跳过。
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { logger } from "../logger";
import { getNarraforkHome, getNarraforkPath } from "../narrafork-home";
import { settings } from "../settings";

/** 每个模型保留的样本数上限（滑动窗口；超出时丢弃最旧的样本）。 */
export const MAX_CALIBRATION_SAMPLES_PER_MODEL = 40;

/** 保留的模型数上限；超出时淘汰最久未更新的模型。 */
export const MAX_CALIBRATION_MODELS = 32;

/**
 * 样本量低于此值时视为"无数据"，预检回退全局系数。
 *
 * 5 是"一个离群样本当不了中位数/上分位数"的最小窗口：更少的话，两三个样本就能把比值定下来，
 * 而那几个样本可能恰好来自类型很偏的一次请求。
 */
export const MIN_CALIBRATION_SAMPLES = 5;

/**
 * 单个样本的最小字符数。
 *
 * 小请求的 promptTokens 里含有固定的每消息开销与取整误差，比值会偏离大请求的真实密度；预检关心的
 * 恰恰是大请求（几个字节到几兆），所以只收这个区间里的样本。
 */
export const MIN_CALIBRATION_SAMPLE_CHARS = 1000;

/** 取值分位：认可"大多数样本"的密度，同时向更高密度一侧留出余量。 */
export const CALIBRATION_RATIO_QUANTILE = 0.75;

/** 比值下界：低于它的样本几乎只能是"上游只收到一部分输入"这类污染。 */
export const MIN_CALIBRATION_RATIO = 0.05;

/** 比值上界：再稠密的分词器也不会到 4 token/字符（最激进的分词也是按字符片段切的）。 */
export const MAX_CALIBRATION_RATIO = 4;

/** 样本落盘的节流间隔：这段时间内的新样本合并成一次异步写入。 */
export const CALIBRATION_SAVE_DEBOUNCE_MS = 5000;

/** 未落盘样本达到这个数量就不等节流，立刻写一次（连续快速请求时避免长窗口丢样本）。 */
export const MAX_UNSAVED_CALIBRATION_SAMPLES = 20;

/** 落盘文件的字节上限；超出时淘汰最旧的模型直到装得下。 */
export const MAX_CALIBRATION_FILE_BYTES = 256 * 1024;

/** 落盘格式版本，便于以后迁移。 */
const CALIBRATION_FILE_VERSION = 1;

/** 落盘文件位置（`~/.narrafork/` 下，与 settings.json / kimi-usages.json 同级）。 */
export const CONTEXT_CALIBRATION_FILE_PATH = getNarraforkPath("context-calibration.json");

/** 一次请求的配对样本：wire 字符数 + provider 上报的输入 token 数。 */
export interface ContextCalibrationSample {
	chars: number;
	tokens: number;
}

/** 某个模型当前生效的换算比（token/字符）。 */
export interface ContextCalibrationRatio {
	model: string;
	/** 最近一次贡献样本的 provider，仅用于诊断。 */
	provider: string | null;
	/** 实测比 = 样本比值窗口的 {@link CALIBRATION_RATIO_QUANTILE} 分位数。 */
	ratio: number;
	/** 参与计算的样本数（必然 ≥ {@link MIN_CALIBRATION_SAMPLES}）。 */
	samples: number;
	updatedAt: number;
}

/** 只读统计（排障/测试用）：样本不足的模型也会列出，此时 `ratio` 为 null。 */
export interface ContextCalibrationStats {
	model: string;
	provider: string | null;
	samples: number;
	ratio: number | null;
	updatedAt: number;
}

/**
 * 一次 loop 调用的采样探针。
 *
 * 探针即隔离单位：并发叙述者互不影响；同一调用内 attempt 串行，`begin` 覆盖上一轮的悬空槽位。
 */
export interface ContextCalibrationProbe {
	/** 请求发出前：记录这一轮的 wire 字符数（拿不到就传 null，本轮不采样）。 */
	begin(
		provider: string | null | undefined,
		model: string | null | undefined,
		chars: number | null | undefined,
	): void;
	/** 响应到达后：记录 provider 上报的输入 token 数（同一轮可能上报多次，取最大值）。 */
	observe(promptTokens: number | null | undefined): void;
	/** 本轮结束（成功、失败、中断都算）：把可信的配对写入样本，不可信的丢弃。 */
	flush(): void;
}

interface CalibrationEntry {
	provider: string | null;
	/** 只存可用样本（写入与加载时都过 {@link isUsableSample}），因此 `length` 就是可用样本数。 */
	samples: ContextCalibrationSample[];
	updatedAt: number;
}

const calibrationEntries = new Map<string, CalibrationEntry>();

let stateLoaded = false;
let unsavedSamples = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight: Promise<void> | null = null;
let saveRequested = false;

// ---------------------------------------------------------------------------
// 开关
// ---------------------------------------------------------------------------

/** 采集/使用校准的开关；默认开启，只有显式写成 false 才关闭（`settings.json` 缺键时保持开启）。 */
export function isContextCalibrationEnabled(): boolean {
	return settings.agent.contextCalibrationEnabled !== false;
}

// ---------------------------------------------------------------------------
// 纯逻辑（无状态，供单测直接钉住口径）
// ---------------------------------------------------------------------------

/** 样本是否可信：字符量够大、token 为正、比值在合理区间内。 */
export function isUsableSample(sample: ContextCalibrationSample): boolean {
	const { chars, tokens } = sample;
	if (!Number.isFinite(chars) || !Number.isFinite(tokens)) return false;
	if (chars < MIN_CALIBRATION_SAMPLE_CHARS) return false;
	if (tokens <= 0) return false;
	const ratio = tokens / chars;
	return Number.isFinite(ratio) && ratio >= MIN_CALIBRATION_RATIO && ratio <= MAX_CALIBRATION_RATIO;
}

/**
 * 从样本窗口算出该模型的换算比（token/字符）。
 *
 * 取分位数而非均值：极端样本（超大工具输出、几乎全 JSON 的请求）会把均值带偏，分位数不会。
 * 推力方向是"宁可高估"——见 {@link CALIBRATION_RATIO_QUANTILE}。
 */
export function calibrationRatioFromSamples(
	samples: readonly ContextCalibrationSample[],
	quantile: number = CALIBRATION_RATIO_QUANTILE,
): number | null {
	const ratios: number[] = [];
	for (const sample of samples) {
		if (!isUsableSample(sample)) continue;
		ratios.push(sample.tokens / sample.chars);
	}
	if (ratios.length === 0) return null;
	ratios.sort((a, b) => a - b);
	const position = Math.ceil(Math.min(Math.max(quantile, 0), 1) * ratios.length) - 1;
	return ratios[Math.min(Math.max(position, 0), ratios.length - 1)] ?? null;
}

// ---------------------------------------------------------------------------
// 采样
// ---------------------------------------------------------------------------

/** 创建一个 loop 调用级别的采样探针。 */
export function createContextCalibrationProbe(): ContextCalibrationProbe {
	let pending: { provider: string | null; model: string; chars: number; tokens: number } | null =
		null;

	const flushPending = () => {
		const entry = pending;
		pending = null;
		// 没有 usage 的一轮（失败、中断、上游没报用量）不产生样本：宁可少一条，也不能污染比值。
		if (!entry || entry.tokens <= 0) return;
		recordContextCalibrationSample(entry.model, entry.provider, entry.chars, entry.tokens);
	};

	return {
		begin(provider, model, chars) {
			// 上一轮的悬空槽位先结账：它要么已经拿到 usage（可信），要么被丢弃。
			flushPending();
			if (!isContextCalibrationEnabled()) return;
			if (!model) return;
			if (typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) return;
			pending = { provider: provider ?? null, model, chars, tokens: 0 };
		},
		observe(promptTokens) {
			if (!pending) return;
			if (typeof promptTokens !== "number" || !Number.isFinite(promptTokens)) return;
			const tokens = Math.floor(promptTokens);
			if (tokens <= 0) return;
			// usage 可能分多条事件到达（部分计数器先出现）：取本轮最大值，避免把中间值当最终值。
			pending.tokens = Math.max(pending.tokens, tokens);
		},
		flush() {
			flushPending();
		},
	};
}

/**
 * 写入一条样本（探针内部使用，也供测试与排障直接喂数据）。
 *
 * 返回是否被采纳：被拒的样本不进入窗口，也不触发落盘。
 */
export function recordContextCalibrationSample(
	model: string,
	provider: string | null,
	chars: number,
	tokens: number,
): boolean {
	if (!isContextCalibrationEnabled()) return false;
	if (!model) return false;
	const sample: ContextCalibrationSample = { chars, tokens };
	if (!isUsableSample(sample)) return false;
	ensureCalibrationLoaded();
	const entry = calibrationEntries.get(model) ?? { provider: null, samples: [], updatedAt: 0 };
	entry.provider = provider ?? entry.provider;
	entry.samples.push(sample);
	if (entry.samples.length > MAX_CALIBRATION_SAMPLES_PER_MODEL) {
		// 滑动窗口：只留最近的样本，模型/上游的分词行为变化时能自然跟上。
		entry.samples.splice(0, entry.samples.length - MAX_CALIBRATION_SAMPLES_PER_MODEL);
	}
	entry.updatedAt = Date.now();
	calibrationEntries.set(model, entry);
	evictExcessModels();
	unsavedSamples++;
	schedulePersistence();
	return true;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/**
 * 取某模型的实测比；没有数据（样本不足、从未采到、开关关闭）时返回 null，调用方回退全局系数。
 */
export function contextCalibrationRatioFor(
	model: string | null | undefined,
): ContextCalibrationRatio | null {
	if (!isContextCalibrationEnabled()) return null;
	if (!model) return null;
	ensureCalibrationLoaded();
	const entry = calibrationEntries.get(model);
	if (!entry || entry.samples.length < MIN_CALIBRATION_SAMPLES) return null;
	const ratio = calibrationRatioFromSamples(entry.samples);
	if (ratio == null) return null;
	return {
		model,
		provider: entry.provider,
		ratio,
		samples: entry.samples.length,
		updatedAt: entry.updatedAt,
	};
}

/**
 * 只读统计：各模型当前样本数与生效比值，供排障与测试。
 *
 * 刻意**不**看开关：关闭采集后仍应能查到已经学到的比值，否则"为什么关掉之后还是拦了"没法解释。
 */
export function getContextCalibrationStats(): ContextCalibrationStats[] {
	ensureCalibrationLoaded();
	const stats: ContextCalibrationStats[] = [];
	for (const [model, entry] of calibrationEntries) {
		stats.push({
			model,
			provider: entry.provider,
			samples: entry.samples.length,
			ratio:
				entry.samples.length >= MIN_CALIBRATION_SAMPLES
					? calibrationRatioFromSamples(entry.samples)
					: null,
			updatedAt: entry.updatedAt,
		});
	}
	return stats.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------------------------------------------------------------------------
// 持久化（内存为主 + 节流异步落盘）
// ---------------------------------------------------------------------------

function evictExcessModels(): void {
	while (calibrationEntries.size > MAX_CALIBRATION_MODELS) {
		let oldestKey: string | null = null;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [model, entry] of calibrationEntries) {
			if (entry.updatedAt < oldestAt) {
				oldestAt = entry.updatedAt;
				oldestKey = model;
			}
		}
		if (!oldestKey) return;
		calibrationEntries.delete(oldestKey);
	}
}

function parseSample(value: unknown): ContextCalibrationSample | null {
	if (!Array.isArray(value) || value.length !== 2) return null;
	const [chars, tokens] = value as [unknown, unknown];
	if (typeof chars !== "number" || typeof tokens !== "number") return null;
	return { chars, tokens };
}

/**
 * 从磁盘装载一次（幂等）。
 *
 * 装载点固定在模块导入处（见文件末尾），所以这次同步读发生在宿主启动时，而不是第一条请求上——
 * 发送路径只读内存。文件缺失、损坏、字段非法都只是"从零开始"，绝不抛错：校准是优化项，
 * 不能因为它挡住宿主启动或任何请求。测试重置状态后会再走一次装载。
 */
function ensureCalibrationLoaded(): void {
	if (stateLoaded) return;
	stateLoaded = true;
	try {
		if (!existsSync(CONTEXT_CALIBRATION_FILE_PATH)) return;
		const parsed = JSON.parse(readFileSync(CONTEXT_CALIBRATION_FILE_PATH, "utf-8")) as {
			models?: Record<string, { provider?: unknown; updatedAt?: unknown; samples?: unknown }>;
		};
		const models = parsed?.models;
		if (!models || typeof models !== "object") return;
		for (const [model, raw] of Object.entries(models)) {
			if (!model || !raw || typeof raw !== "object") continue;
			const samples: ContextCalibrationSample[] = [];
			if (Array.isArray(raw.samples)) {
				for (const value of raw.samples) {
					const sample = parseSample(value);
					if (sample && isUsableSample(sample)) samples.push(sample);
				}
			}
			if (samples.length === 0) continue;
			if (samples.length > MAX_CALIBRATION_SAMPLES_PER_MODEL) {
				samples.splice(0, samples.length - MAX_CALIBRATION_SAMPLES_PER_MODEL);
			}
			calibrationEntries.set(model, {
				provider: typeof raw.provider === "string" ? raw.provider : null,
				samples,
				updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
			});
		}
		evictExcessModels();
	} catch {
		// 损坏或不可读：静默从零开始。
		calibrationEntries.clear();
	}
}

function serializeCalibration(): string {
	const models: Record<
		string,
		{ provider: string | null; updatedAt: number; samples: Array<[number, number]> }
	> = {};
	for (const [model, entry] of calibrationEntries) {
		models[model] = {
			provider: entry.provider,
			updatedAt: entry.updatedAt,
			samples: entry.samples.map((sample) => [sample.chars, sample.tokens]),
		};
	}
	return JSON.stringify({ version: CALIBRATION_FILE_VERSION, models });
}

/** 序列化并保证不越过字节上限：必要时淘汰最旧的模型。 */
function serializeCalibrationWithinLimit(): string {
	let text = serializeCalibration();
	while (Buffer.byteLength(text) > MAX_CALIBRATION_FILE_BYTES && calibrationEntries.size > 1) {
		let oldestKey: string | null = null;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [model, entry] of calibrationEntries) {
			if (entry.updatedAt < oldestAt) {
				oldestAt = entry.updatedAt;
				oldestKey = model;
			}
		}
		if (!oldestKey) break;
		calibrationEntries.delete(oldestKey);
		text = serializeCalibration();
	}
	return text;
}

async function runCalibrationPersist(): Promise<void> {
	// 一轮写入期间到达的新样本会重新置位 saveRequested：循环到没有新请求为止，
	// 保证"写最后一次"这个语义，不会丢掉收尾窗口里的样本。
	while (saveRequested) {
		saveRequested = false;
		unsavedSamples = 0;
		try {
			await mkdir(getNarraforkHome(), { recursive: true });
			await writeFile(CONTEXT_CALIBRATION_FILE_PATH, serializeCalibrationWithinLimit());
		} catch (error) {
			// 落盘失败不影响请求，也不清空内存样本：下次节流窗口再试。
			logger.debug("Context calibration persist failed", { error: String(error) });
		}
	}
}

/**
 * 请求一次落盘。
 *
 * 并发调用合并到同一个在途 promise 上（写入是异步的，请求路径只负责"请求"），调用方 await 它
 * 就能拿到"这一轮写完"的确定时点。
 */
function persistCalibration(): Promise<void> {
	if (persistInFlight) return persistInFlight;
	const chained = runCalibrationPersist().finally(() => {
		if (persistInFlight === chained) persistInFlight = null;
	});
	persistInFlight = chained;
	return chained;
}

function schedulePersistence(): void {
	// 关闭时不落盘：否则"关掉开关"还会继续改磁盘上的文件，与用户预期不符。
	if (!isContextCalibrationEnabled()) return;
	saveRequested = true;
	if (persistInFlight) return;
	if (unsavedSamples >= MAX_UNSAVED_CALIBRATION_SAMPLES) {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		void persistCalibration();
		return;
	}
	if (saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		if (!isContextCalibrationEnabled()) return;
		void persistCalibration();
	}, CALIBRATION_SAVE_DEBOUNCE_MS);
	saveTimer.unref?.();
}

// ---------------------------------------------------------------------------
// 测试钩子
// ---------------------------------------------------------------------------

/** 清空内存样本并取消挂起的写入；下一次访问会重新从磁盘装载。 */
export function resetContextCalibrationForTests(): void {
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	saveRequested = false;
	unsavedSamples = 0;
	calibrationEntries.clear();
	stateLoaded = false;
}

/** 立即落盘一次（测试用；生产路径只走节流）。 */
export async function persistContextCalibrationForTests(): Promise<void> {
	saveRequested = true;
	await persistCalibration();
}

// 启动时装载一次（与 settings.json / kimi-usages.json 同一模式）：把唯一的一次同步读移出请求路径。
// 文件不存在时这里什么都不做，一切从零开始。
ensureCalibrationLoaded();
