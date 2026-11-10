/**
 * 应用自己写下的草稿。
 *
 * iframe 一旦重建（展开视图、切会话回来、卡片被列表回收后重绘），应用里任意 React
 * 组件的状态就归零了——宿主拿不到也注不进去。所以由应用通过 `genUI.persist` 主动
 * 交出来，宿主按 tool call 存进会话存储，下次挂载时经 `genUI.restored` 回灌。
 */
const PREFIX = "narrafork:genUiApp:";
/** 一份草稿的上限；超过就放弃保存，而不是把会话存储塞满。 */
const MAX_BYTES = 64 * 1024;

export function readAppState(key: string): Record<string, unknown> | null {
	try {
		const raw = sessionStorage.getItem(PREFIX + key);
		if (!raw) return null;
		const value: unknown = JSON.parse(raw);
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export function writeAppState(key: string, values: Record<string, unknown>): void {
	try {
		const raw = JSON.stringify(values);
		if (raw.length > MAX_BYTES) return;
		sessionStorage.setItem(PREFIX + key, raw);
	} catch {
		// 会话存储不可用或已满：草稿保不住，但不该影响应用本身。
	}
}
