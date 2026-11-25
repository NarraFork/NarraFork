import { type QueryClient, type QueryFilters, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { getToken, onTokenChange } from "../lib/api/client";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { RUNTIME_SETTINGS_QUERY_KEY } from "./useRuntimeSettings";

/** One cancellation per burst, then dirty tail reads without restarting the in-flight refresh. */
export function createRuntimeProjectionInvalidator(qc: QueryClient, token: string | null) {
	let disposed = false;
	let queued = false;
	let running = false;
	let settingsPending = false;
	let modelsPending = false;
	let highestRevision = -1;
	let initialRevisionFloor: number | undefined;
	let epoch = 0;
	const active = () => !disposed && getToken() === token;
	const filters = (settings: boolean, models: boolean): QueryFilters[] => [
		...(settings ? [{ queryKey: [...RUNTIME_SETTINGS_QUERY_KEY, token], exact: true }] : []),
		...(models
			? [
					{ queryKey: ["model-catalog", "runtime", token] },
					{ queryKey: ["model-catalog", "options", token] },
				]
			: []),
	];
	const flush = () => {
		if (!active() || queued || running) return;
		queued = true;
		const readEpoch = epoch;
		queueMicrotask(() => {
			if (!active() || epoch !== readEpoch) return;
			queued = false;
			running = true;
			void (async () => {
				let first = true;
				while (active() && epoch === readEpoch && (settingsPending || modelsPending)) {
					const targets = filters(settingsPending, modelsPending);
					settingsPending = false;
					modelsPending = false;
					// An initial HTTP read may have no data yet: invalidate alone reuses that
					// stale promise and its late success would clear the marker's invalidation.
					if (first) await Promise.all(targets.map((target) => qc.cancelQueries(target)));
					if (!active() || epoch !== readEpoch) return;
					await Promise.all(
						targets.map((target) => qc.invalidateQueries(target, { cancelRefetch: false })),
					);
					first = false;
				}
			})().finally(() => {
				if (epoch !== readEpoch) return;
				running = false;
				if (active() && (settingsPending || modelsPending)) flush();
			});
		});
	};
	function reconcileInitialRevision() {
		if (!active() || initialRevisionFloor === undefined) return;
		const state = qc.getQueryState<{ revision: number }>([...RUNTIME_SETTINGS_QUERY_KEY, token]);
		if (!state?.data || state.fetchStatus === "fetching") return;
		const floor = initialRevisionFloor;
		initialRevisionFloor = undefined;
		if (state.data.revision >= floor) {
			highestRevision = Math.max(highestRevision, floor);
			return;
		}
		schedule(true, floor);
	}
	function schedule(settings: boolean, revision?: number, initial = false) {
		if (!active()) return;
		if (initial && settings && typeof revision === "number") {
			initialRevisionFloor = Math.max(initialRevisionFloor ?? -1, revision);
			reconcileInitialRevision();
			return;
		}
		if (settings && typeof revision === "number") {
			const current = qc.getQueryData<{ revision: number }>([...RUNTIME_SETTINGS_QUERY_KEY, token]);
			if (revision <= highestRevision || (current && current.revision >= revision)) return;
			highestRevision = revision;
		}
		settingsPending ||= settings;
		modelsPending = true;
		flush();
	}
	const offCache = qc.getQueryCache().subscribe(reconcileInitialRevision);
	return {
		schedule,
		resetEpoch() {
			epoch++;
			highestRevision = -1;
			initialRevisionFloor = undefined;
			settingsPending = false;
			modelsPending = false;
			queued = false;
			running = false;
		},
		dispose() {
			disposed = true;
			settingsPending = false;
			modelsPending = false;
			initialRevisionFloor = undefined;
			offCache();
		},
	};
}

/** Mounted once per authenticated layout. Hidden menus are invalidated without fetching. */
export function useRuntimeProjectionSync(enabled = true) {
	const qc = useQueryClient();
	const token = useSyncExternalStore(onTokenChange, getToken, getToken);
	useEffect(() => {
		if (!enabled || !token) return;
		const invalidator = createRuntimeProjectionInvalidator(qc, token);
		const listener = narratorWSManager.addListener(
			{ types: ["settings_runtime_changed", "model_catalog_changed"] },
			(message) =>
				invalidator.schedule(
					message.type === "settings_runtime_changed",
					typeof message.revision === "number" ? message.revision : undefined,
					message.initial === true,
				),
		);
		const offConnection = narratorWSManager.onConnectionChange((connected, isReconnect) => {
			if (connected && isReconnect) {
				invalidator.resetEpoch();
				invalidator.schedule(true);
			}
			// Initial connection sends its server revision as settings_runtime_changed;
			// a matching HTTP revision costs zero reads and closes the HTTP→WS gap.
		});
		const offToken = onTokenChange(() => {
			invalidator.dispose();
			for (const queryKey of [
				[...RUNTIME_SETTINGS_QUERY_KEY, token],
				["model-catalog", "runtime", token],
				["model-catalog", "options", token],
			]) {
				void qc.cancelQueries({ queryKey });
				qc.removeQueries({ queryKey });
			}
		});
		const onAvailability = () => invalidator.schedule(false);
		window.addEventListener("narrafork:nug-model-availability-changed", onAvailability);
		return () => {
			invalidator.dispose();
			narratorWSManager.removeListener(listener);
			offConnection();
			offToken();
			window.removeEventListener("narrafork:nug-model-availability-changed", onAvailability);
		};
	}, [enabled, qc, token]);
}
