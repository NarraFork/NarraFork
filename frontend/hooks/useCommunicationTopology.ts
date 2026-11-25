import { type CommunicationScope, communicationScopeKey } from "@shared/narrator-communication";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
	CommunicationTopologySubscriptions,
	type CommunicationView,
} from "../lib/communication-subscription";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const subscriptions = new CommunicationTopologySubscriptions(narratorWSManager);
const DISABLED: CommunicationView = { topology: null, status: "disconnected" };
export function useCommunicationTopology(scope: CommunicationScope, enabled = true) {
	const key = communicationScopeKey(scope);
	const stableScope = useMemo<CommunicationScope>(() => {
		const parts = JSON.parse(key) as string[];
		return parts[0] === "narrator"
			? { kind: "narrator", narratorId: parts[1] }
			: { kind: "team", projectId: parts[1], teamId: parts[2] };
	}, [key]);
	const subscribe = useCallback(
		(callback: () => void) => (enabled ? subscriptions.watch(stableScope, callback) : () => {}),
		[stableScope, enabled],
	);
	const getSnapshot = useCallback(
		() => (enabled ? subscriptions.getSnapshot(stableScope) : DISABLED),
		[stableScope, enabled],
	);
	const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	const retry = useCallback(() => {
		if (enabled) subscriptions.retry(stableScope);
	}, [enabled, stableScope]);
	return { ...view, retry };
}
