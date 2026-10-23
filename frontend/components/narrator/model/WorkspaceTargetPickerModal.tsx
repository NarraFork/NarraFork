import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	applyWorkspaceContext,
	DeviceWorkspaceOperationError,
	type DeviceWorkspaceTransition,
	isDeviceWorkspaceTransition,
	transitionKey,
	useDeviceWorkspaceMutation,
	useNarratorDeviceWorkspaces,
	useRecoverDeviceWorkspaceMutation,
	useWorkspaceContext,
	workspaceContextKey,
} from "../../../hooks/useWorkspaceContext";
import { api } from "../../../lib/api";
import { DirectoryPicker } from "../../common/DirectoryPicker";

export type WorkspaceTargetPickerMode = "configure" | "configureAndSelect";

/** The recovery source is global QueryClient state, not the lifetime of a menu/modal. */
export function WorkspaceTransitionNotice({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation("narrator");
	const { transition } = useWorkspaceContext(narratorId);
	const recovery = useRecoverDeviceWorkspaceMutation();
	if (!transition) return null;
	return (
		<Alert color={transition.phase === "superseded" ? "orange" : "yellow"}>
			<Stack gap="xs">
				<Text size="sm">
					{t(
						transition.phase === "committed_pending" && !transition.result?.selection
							? "deviceWorkspace.bindingPending"
							: `deviceWorkspace.${transition.phase}`,
					)}
				</Text>
				{transition.phase === "committed_pending" && transition.result?.selection && (
					<Text size="xs">{transition.result.selection.current.cwd}</Text>
				)}
				<Button
					size="xs"
					loading={recovery.isPending}
					onClick={() => void recovery.mutateAsync(transition.intent).catch(() => {})}
				>
					{t(
						transition.phase === "not_committed" || transition.phase === "superseded"
							? "deviceWorkspace.refreshCurrent"
							: "deviceWorkspace.recover",
					)}
				</Button>
			</Stack>
		</Alert>
	);
}

interface PickerProps {
	narratorId: string;
	deviceId: string;
	deviceLabel: string;
	deviceOnline?: boolean;
	mode?: WorkspaceTargetPickerMode;
	opened: boolean;
	onClose: () => void;
}

/** Inner sessions unmount on close and key on narrator/device: late completions cannot close a new session. */
export function WorkspaceTargetPickerModal(props: PickerProps) {
	const { t } = useTranslation("narrator");
	return (
		<Modal
			opened={props.opened}
			onClose={props.onClose}
			title={t(
				props.mode === "configure"
					? "deviceWorkspace.configure"
					: "deviceWorkspace.configureAndSelect",
			)}
		>
			{props.opened && (
				<WorkspaceTargetPickerSession
					key={`${props.narratorId}:${props.deviceId}:${props.mode ?? "configureAndSelect"}`}
					{...props}
				/>
			)}
		</Modal>
	);
}

function WorkspaceTargetPickerSession({
	narratorId,
	deviceId,
	deviceLabel,
	deviceOnline = true,
	mode = "configureAndSelect",
	onClose,
}: PickerProps) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const workspace = useWorkspaceContext(narratorId);
	const bindings = useNarratorDeviceWorkspaces(narratorId);
	const mutation = useDeviceWorkspaceMutation();
	const recovery = useRecoverDeviceWorkspaceMutation();
	const qc = useQueryClient();
	const [cwd, setCwd] = useState("");
	const [error, setError] = useState<string>();
	const [needsRebase, setNeedsRebase] = useState(false);
	const [rebasing, setRebasing] = useState(false);
	const [baselineReady, setBaselineReady] = useState(false);
	const touched = useRef(false);
	const observed = useRef<{ bindingRevision: number; cwd: string } | undefined>(undefined);
	const selection = useRef<{ revision: number; deviceId: string } | undefined>(undefined);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	// Capture the first actually observed selection, not a later revision after an async set.
	if (!selection.current && workspace.data)
		selection.current = { revision: workspace.data.revision, deviceId: workspace.data.deviceId };
	const binding = bindings.items.find((item) => item.deviceId === deviceId);
	const known = !!binding || (bindings.isSuccess && !bindings.hasNextPage);
	useEffect(() => {
		if (!known || observed.current || bindings.isError) return;
		observed.current = { bindingRevision: binding?.bindingRevision ?? 0, cwd: binding?.cwd ?? "" };
		if (!touched.current) setCwd(binding?.cwd ?? "");
	}, [known, binding, bindings.isError]);
	useEffect(() => {
		if (bindings.isError && !touched.current) setCwd("");
	}, [bindings.isError]);
	const refreshBaseline = async () => {
		if (!needsRebase || rebasing || mutation.isPending) return;
		const actorId = qc.getQueryData<{ id: string }>(["auth", "me"])?.id;
		const originalTransition = qc.getQueryData<boolean | DeviceWorkspaceTransition>(
			transitionKey(narratorId),
		);
		if (
			originalTransition &&
			(!isDeviceWorkspaceTransition(originalTransition) ||
				originalTransition.phase !== "not_committed")
		)
			return;
		setRebasing(true);
		setBaselineReady(false);
		try {
			if (isDeviceWorkspaceTransition(originalTransition)) {
				// This only verifies the original rejection/current installation; never replays a proposal.
				await recovery.mutateAsync(originalTransition.intent).catch(() => {});
				if (qc.getQueryData(transitionKey(narratorId)))
					throw new Error(t("deviceWorkspace.baselineNotReady"));
			}
			const [current, refreshed] = await Promise.all([
				api.getWorkspaceContext(narratorId),
				bindings.refetch(),
			]);
			const status = await api.getWorkspaceSelectionStatus(narratorId);
			if (!alive.current) return;
			if (
				qc.getQueryData<{ id: string }>(["auth", "me"])?.id !== actorId ||
				qc.getQueryData(transitionKey(narratorId))
			)
				throw new Error(t("deviceWorkspace.baselineNotReady"));
			if (
				!status.installed ||
				status.revision !== current.revision ||
				(qc.getQueryData<{ revision: number }>(workspaceContextKey(narratorId))?.revision ?? -1) >
					current.revision ||
				refreshed.isError ||
				!refreshed.data
			)
				throw new Error(t("deviceWorkspace.baselineNotReady"));
			const freshBinding = refreshed.data.pages
				.flatMap((page) => page.items)
				.find((item) => item.deviceId === deviceId);
			if (!freshBinding && refreshed.data.pages.at(-1)?.nextCursor !== null)
				throw new Error(t("deviceWorkspace.notLoaded"));
			observed.current = {
				bindingRevision: freshBinding?.bindingRevision ?? 0,
				cwd: freshBinding?.cwd ?? "",
			};
			selection.current = { revision: current.revision, deviceId: current.deviceId };
			applyWorkspaceContext(qc, narratorId, current);
			setError(undefined);
			setNeedsRebase(false);
			setBaselineReady(true);
		} catch (failure) {
			if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			if (alive.current) setRebasing(false);
		}
	};
	const submit = async () => {
		if (
			needsRebase ||
			rebasing ||
			mutation.isPending ||
			!known ||
			!observed.current ||
			!selection.current ||
			!cwd.trim() ||
			workspace.transition ||
			workspace.transitioning
		)
			return;
		const originalSelection = selection.current;
		let saved = false;
		setError(undefined);
		setBaselineReady(false);
		try {
			const result = await mutation.mutateAsync({
				narratorId,
				kind: "set",
				request: {
					requestId: nanoid(),
					deviceId,
					cwd: cwd.trim(),
					expectedBindingRevision: observed.current.bindingRevision,
					...(originalSelection.deviceId === deviceId
						? { expectedSelectionRevision: originalSelection.revision }
						: {}),
				},
			});
			saved = true;
			if (!alive.current) return;
			// Editing the selected binding already installed its new projection; do not select it again.
			if (mode === "configureAndSelect" && !result.selection)
				await mutation.mutateAsync({
					narratorId,
					kind: "select",
					request: {
						requestId: nanoid(),
						deviceId,
						expectedBindingRevision: result.binding.bindingRevision,
						expectedSelectionRevision: originalSelection.revision,
					},
				});
			if (alive.current) onClose();
		} catch (failure) {
			if (!alive.current) return;
			if (failure instanceof DeviceWorkspaceOperationError) {
				if (failure.phase === "not_committed") setNeedsRebase(true);
				setError(
					t(
						saved && failure.phase === "not_committed"
							? "deviceWorkspace.savedNotSelected"
							: `deviceWorkspace.${failure.phase}`,
					),
				);
			} else setError(failure instanceof Error ? failure.message : String(failure));
			// An explicit new action requires refreshed authoritative bindings, not silent CAS replay.
			void bindings.refetch();
		}
	};
	return (
		<Stack gap="sm">
			<Text size="xs" c="dimmed">
				{deviceLabel}
			</Text>
			<WorkspaceTransitionNotice narratorId={narratorId} />
			{!workspace.transition && workspace.data && (
				<Text size="xs" c="dimmed">
					{t("executionTargetCwd", { cwd: workspace.data.cwd })}
				</Text>
			)}
			{!known && <Alert color="blue">{t("deviceWorkspace.notLoaded")}</Alert>}
			{!binding && bindings.hasNextPage && (
				<Button
					variant="default"
					loading={bindings.isFetchingNextPage}
					onClick={() => void bindings.fetchNextPage()}
				>
					{t("deviceWorkspace.loadMore")}
				</Button>
			)}
			{bindings.error && <Alert color="red">{bindings.error.message}</Alert>}
			<DirectoryPicker
				narratorId={narratorId}
				deviceId={deviceId}
				deviceLabel={deviceLabel}
				value={cwd}
				onChange={(value) => {
					touched.current = true;
					setCwd(value);
				}}
				label={t("workspaceDirectory")}
				description={t("workspaceDirectoryConfirm")}
				disabled={
					mutation.isPending || !!workspace.transition || workspace.transitioning || !deviceOnline
				}
			/>
			{error && (!workspace.transition || workspace.transition.phase === "not_committed") && (
				<Alert color="red">{error}</Alert>
			)}
			{needsRebase && (!workspace.transition || workspace.transition.phase === "not_committed") && (
				<Button variant="default" loading={rebasing} onClick={() => void refreshBaseline()}>
					{t("deviceWorkspace.refreshBaseline")}
				</Button>
			)}
			{baselineReady && <Alert color="blue">{t("deviceWorkspace.baselineReady")}</Alert>}
			<Group justify="flex-end">
				<Button variant="default" onClick={onClose}>
					{tc("cancel")}
				</Button>
				<Button
					onClick={() => void submit()}
					loading={mutation.isPending}
					disabled={
						needsRebase ||
						rebasing ||
						!known ||
						bindings.isError ||
						!workspace.data ||
						!selection.current ||
						!cwd.trim() ||
						!deviceOnline ||
						!!workspace.transition ||
						workspace.transitioning
					}
				>
					{t(
						mode === "configure"
							? "deviceWorkspace.saveOnly"
							: "deviceWorkspace.configureAndSelect",
					)}
				</Button>
			</Group>
		</Stack>
	);
}
