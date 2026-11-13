import type { UsePluginContributionsResult } from "@frontend/hooks/usePluginContributions";
import type { UsePromptOptimizeResult } from "@frontend/hooks/usePromptOptimize";

const noop = () => {};
const snapshot = Object.freeze({
	contributions: {},
	revision: 0,
	synced: false,
	isFetching: false,
});
export function usePluginContributions(): UsePluginContributionsResult {
	return { ...snapshot, invalidate: noop, resolve: () => undefined };
}
export function usePluginContributionStoreSnapshot() {
	return snapshot;
}
export function toPluginContributionRecords() {
	return [];
}
export function usePromptOptimize(): UsePromptOptimizeResult {
	return {
		loading: false,
		withContext: false,
		contextMessageCount: 0,
		toggleContext: noop,
		setContextMessageCount: noop,
		cancelOptimize: noop,
		releaseSurface: noop,
		handleOptimize: async () => {
			throw new Error("REMOTE_OPTIMIZE_UNSUPPORTED");
		},
	};
}
