import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { getModelContextWindow } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { estimateNarratorBuildHistoryTokens } from "./narrator-history-token-estimate";

/**
 * 切模型后"预估占用 / 新模型窗口"达到这个比例就告警。
 *
 * 判据是"还装不装得下"，不是各模型的压缩阈值（`compactStart`）：用户是主动切模型
 * 的，需要被告知"下一条请求可能被拒"，而不是"该压缩了"。留出的 10% 余量用来吸收
 * `estimateTokens` 的已知低估（见 server/lib/agent/estimate-tokens.ts 文件头：对
 * JSON / 代码 / 工具输出密集的内容实测仍会低估）。
 */
export const MODEL_SWITCH_CONTEXT_WARN_RATIO = 0.9;

export interface ModelSwitchContextWarning {
	narratorId: string;
	model: string;
	provider: string;
	/** 按新模型重建历史后的估算占用。 */
	promptTokens: number;
	contextWindow: number;
	/** 估算占用率（百分比，可能大于 100）。 */
	percent: number;
	/** 非本地化回退文案；客户端按自己的语言重排同一些数字。 */
	message: string;
}

/**
 * 判定并组装告警；不到阈值（或窗口未知）时返回 null。
 *
 * 抽成纯函数是为了让"多少算超"这条线可以被单测直接钉住，而不必从一次真实切换里
 * 间接观察。
 */
export function buildModelSwitchContextWarning(input: {
	narratorId: string;
	model: string;
	provider: string;
	promptTokens: number;
	contextWindow: number;
}): ModelSwitchContextWarning | null {
	const { narratorId, model, provider, promptTokens, contextWindow } = input;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
	if (!Number.isFinite(promptTokens) || promptTokens <= 0) return null;

	const ratio = promptTokens / contextWindow;
	if (ratio < MODEL_SWITCH_CONTEXT_WARN_RATIO) return null;

	const percent = Math.round(ratio * 1000) / 10;
	return {
		narratorId,
		model,
		provider,
		promptTokens,
		contextWindow,
		percent,
		message:
			`Switched to ${model}: the rebuilt history is estimated at ${promptTokens} tokens, ` +
			`${Math.round(ratio * 100)}% of that model's ${contextWindow} token context window. ` +
			"The next request may be rejected as too long; compact the context first.",
	};
}

/**
 * 切模型之后按**新模型**重估当前历史占用，逼近或超过新窗口就广播一条告警。
 *
 * 只告警：不自动压缩，也不阻止切换——切换是用户的主动操作，这里负责告知后果。
 * 返回是否真的广播了告警（供调用方记录，也让测试能直接断言"没误报"）。
 *
 * 注意它是一次完整的历史重建（与下一轮请求同路径），因此调用方必须异步触发，
 * 不要放进切换本身的同步/响应路径里阻塞用户操作。
 */
export async function warnIfModelSwitchExceedsContextWindow(input: {
	narratorId: string;
	model: string;
	provider: string;
	locale: Locale;
}): Promise<boolean> {
	const { narratorId, model, provider, locale } = input;
	const estimate = await estimateNarratorBuildHistoryTokens(narratorId, locale, model);
	// 与 UI 显示的窗口同源：优先按调用方给的 provider 解析，退回估算内部解析出的窗口。
	const contextWindow = getModelContextWindow(model, provider) ?? estimate.contextWindow;
	if (contextWindow == null) {
		// 按当前契约这里不会发生：`resolveModelContextWindow` 的每一条分支都返回正数
		// （用户设置仅在其 > 0 时采用，其余全部落到 DEFAULT_CONTEXT_WINDOW）。保留这段
		// 是为了防御解析层将来不再保证返回数值——那种情况下宁可不猜，也不要凭一条
		// 数字缺失的告警制造噪音。
		logger.debug("Model switch context check skipped: context window unknown", {
			narratorId,
			model,
			provider,
		});
		return false;
	}

	const warning = buildModelSwitchContextWarning({
		narratorId,
		model,
		provider,
		promptTokens: estimate.promptTokens,
		contextWindow,
	});
	if (!warning) return false;

	logger.warn("Model switch may exceed the new model's context window", {
		narratorId,
		model,
		provider,
		promptTokens: warning.promptTokens,
		contextWindow: warning.contextWindow,
		percent: warning.percent,
	});
	broadcastToNarrator(narratorId, { type: "context_window_warning", ...warning });
	return true;
}
