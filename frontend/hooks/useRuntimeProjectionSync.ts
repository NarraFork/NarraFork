import { type QueryClient, type QueryFilters, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { getAuthSnapshot, subscribeAuth } from "../lib/api/client";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { runtimeSettingsQueryKey } from "./useRuntimeSettings";

/** One cancellation per burst, then dirty tail reads without restarting the in-flight refresh. */
export function createRuntimeProjectionInvalidator(qc: QueryClient, generation: number) {
	let disposed = false;
	let queued = false;
	let running = false;
	let settingsPending = false;
	let modelsPending = false;
	let highestRevision = -1;
	let initialRevisionFloor: number | undefined;
	let epoch = 0;
	const active = () => !disposed && getAuthSnapshot().generation === generation;
	const settingsKey = runtimeSettingsQueryKey(generation);
	const filters = (settings: boolean, models: boolean): QueryFilters[] => [
		...(settings ? [{ queryKey: settingsKey, exact: true }] : []),
		...(models
			? [
					{ queryKey: ["model-catalog", "runtime", generation] },
					{ queryKey: ["model-catalog", "options", generation] },
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
		const state = qc.getQueryState<{ revision: number }>(settingsKey);
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
			const current = qc.getQueryData<{ revision: number }>(settingsKey);
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
	const { generation, hasToken } = useSyncExternalStore(
		subscribeAuth,
		getAuthSnapshot,
		getAuthSnapshot,
	);
	useEffect(() => {
		if (!enabled || !hasToken) return;
		const invalidator = createRuntimeProjectionInvalidator(qc, generation);
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
		const offAuth = subscribeAuth(() => {
			if (getAuthSnapshot().generation === generation) return;
			invalidator.dispose();
			for (const queryKey of [
				runtimeSettingsQueryKey(generation),
				["model-catalog", "runtime", generation],
				["model-catalog", "options", generation],
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
			offAuth();
			window.removeEventListener("narrafork:nug-model-availability-changed", onAvailability);
		};
	}, [enabled, generation, hasToken, qc]);
}
