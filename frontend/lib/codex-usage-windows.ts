import type { CodexUsageData, CodexUsageWindow, CodexUsageWindowType } from "./api/types";

export const CODEX_USAGE_WINDOW_ORDER = [
	"5h",
	"weekly",
	"monthly",
	"unknown",
] as const satisfies readonly CodexUsageWindowType[];

const WINDOW_ORDER_INDEX = new Map<CodexUsageWindowType, number>(
	CODEX_USAGE_WINDOW_ORDER.map((windowType, index) => [windowType, index]),
);

const WINDOW_LABEL_KEYS: Record<CodexUsageWindowType, string> = {
	"5h": "codexUsage5h",
	weekly: "codexUsageWeekly",
	monthly: "codexUsageMonthly",
	unknown: "codexUsageUnknown",
};

export function getCodexUsageWindowLabelKey(windowType: unknown): string {
	return WINDOW_LABEL_KEYS[windowType as CodexUsageWindowType] ?? WINDOW_LABEL_KEYS.unknown;
}

export function getCodexUsageWindows(usage?: CodexUsageData): CodexUsageWindow[] {
	if (!usage) return [];
	return [usage.primary_window, usage.secondary_window].filter(
		(window): window is CodexUsageWindow => !!window,
	);
}

export function sortCodexUsageWindows(windows: readonly CodexUsageWindow[]): CodexUsageWindow[] {
	return windows
		.map((window, index) => ({ window, index }))
		.sort((left, right) => {
			const orderDifference =
				(WINDOW_ORDER_INDEX.get(left.window.window_type) ?? Number.MAX_SAFE_INTEGER) -
				(WINDOW_ORDER_INDEX.get(right.window.window_type) ?? Number.MAX_SAFE_INTEGER);
			return orderDifference || left.index - right.index;
		})
		.map(({ window }) => window);
}
