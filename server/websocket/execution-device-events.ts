import { EXECUTION_DEVICES_CHANGED_WS_TYPE } from "@shared/execution-devices";
import { eventBus } from "../lib/event-bus";

/** Device metadata and grant changes share one data-free, burst-coalesced invalidation. */
export function registerExecutionDeviceChangeBroadcast(
	broadcast: (message: { type: typeof EXECUTION_DEVICES_CHANGED_WS_TYPE }) => void,
): () => void {
	const types = [
		"device:changed",
		"device:status",
		"device:revoked",
		"oauth:grant_changed",
		"oauth:client_changed",
		"project:access_changed",
		"narrator:access_changed",
		"narrator:execution_principal_changed",
	] as const;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const changed = () => {
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			// Never send the event payload: it may identify a private device or grant.
			broadcast({ type: EXECUTION_DEVICES_CHANGED_WS_TYPE });
		}, 100);
		timer.unref();
	};
	for (const type of types) eventBus.on(type, changed);
	return () => {
		if (timer !== undefined) clearTimeout(timer);
		for (const type of types) eventBus.off(type, changed);
	};
}
