import { fileReferenceApi } from "@frontend/lib/api/file-references";
import { notifications } from "@mantine/notifications";
import type { FileTarget } from "@shared/file-reference";
import { useCallback, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useFileReferenceScope } from "../composer/FileReferenceScope";
import { useFilePanelNavigationReceiver } from "../file-panel/file-panel-navigation";

/** The receiving layout is not the file authorizer. Never use its cwd/default device. */
export function useToolFileNavigation(target?: FileTarget | null, fileNarratorId?: string) {
	const navigation = useFilePanelNavigationReceiver();
	const scope = useFileReferenceScope();
	const { t } = useTranslation("narrator");
	const pending = useRef<AbortController | null>(null);
	const receiver = navigation.openFilePanel ? navigation.receiver : scope.openFile;
	const receiverNarratorId = navigation.openFilePanel ? undefined : scope.narratorId;
	const ready = !!(
		target &&
		fileNarratorId &&
		(navigation.openFilePanel || (scope.narratorId === fileNarratorId && scope.openFile))
	);
	// Target object reconstruction is not a target change. Identity is the captured data.
	const targetKey = target ? JSON.stringify(target) : "";
	const lifetime = useRef<{ active: boolean } | null>(null);
	const latest = useRef({ target, fileNarratorId, navigation, scope, ready, t });
	useLayoutEffect(() => {
		latest.current = { target, fileNarratorId, navigation, scope, ready, t };
	});
	useLayoutEffect(() => {
		const current = {
			active: true,
			targetKey,
			fileNarratorId,
			receiver,
			receiverNarratorId,
			ready,
		};
		lifetime.current = current;
		return () => {
			current.active = false;
			pending.current?.abort();
		};
	}, [targetKey, fileNarratorId, receiver, receiverNarratorId, ready]);

	const open = useCallback(async () => {
		const source = latest.current;
		const current = lifetime.current;
		if (!source.ready || !source.target || !source.fileNarratorId || !current?.active) return;
		pending.current?.abort();
		const controller = new AbortController();
		pending.current = controller;
		const requestReceiver = source.navigation.getReceiver();
		const isCurrent = () => {
			if (
				!current.active ||
				lifetime.current !== current ||
				pending.current !== controller ||
				controller.signal.aborted ||
				!latest.current.ready
			)
				return false;
			// Dockview can replace apiRef.current without rebuilding this row first.
			if (
				source.navigation.openFilePanel &&
				latest.current.navigation.getReceiver() !== requestReceiver
			) {
				controller.abort();
				return false;
			}
			return true;
		};
		try {
			if (!source.navigation.openFilePanel) {
				// The real drawer opener owns authorization and checks this row's lifetime
				// at every async boundary before it mutates its own viewer state.
				await source.scope.openFile?.(source.target, { signal: controller.signal, isCurrent });
				return;
			}
			const { targets } = await fileReferenceApi.resolve(
				source.fileNarratorId,
				[source.target],
				controller.signal,
			);
			if (!isCurrent() || !targets[0]) return;
			const resolved = targets[0];
			// Same host, new callback: use the committed latest capability, never stale closures.
			latest.current.navigation.openFilePanel?.(resolved.path, undefined, {
				deviceId: resolved.deviceId,
				fileNarratorId: source.fileNarratorId,
				referenceOrigin: true,
				selection: resolved.selection,
			});
		} catch (error) {
			if (isCurrent())
				notifications.show({
					color: "red",
					title: latest.current.t("fileReferences.openFailed"),
					message: error instanceof Error ? error.message : String(error),
				});
		}
	}, []);
	return ready ? open : undefined;
}
