import { ApiError, api } from "@frontend/lib/api";
import {
	Alert,
	Badge,
	Button,
	Checkbox,
	Divider,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
} from "@mantine/core";
import type {
	WorktreeDependent,
	WorktreeRemovalPlan,
	WorktreeRemovalResult,
} from "@shared/narrator-worktrees";
import { IconAlertTriangle, IconTrash } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { worktreeDirectoryLabel } from "./worktree-list-view";
import {
	requiredConfirmations,
	WorktreeRemovalFlow,
	type WorktreeRemovalFlowState,
	type WorktreeRemovalStep,
} from "./worktree-removal-flow";

const EMPTY_STATE: WorktreeRemovalFlowState = { step: "idle", busy: false, confirmed: [] };

/**
 * Confirmation surface for removing one worktree.
 *
 * Every judgement is the server's: the plan lists what depends on the directory, what
 * would be closed, and what refuses right now. This dialog only shows that plan, offers
 * the one repair a person can perform here (archiving a blocking conversation), and keeps
 * the destructive button disabled until the server's own conditions are met.
 */
export function WorktreeRemovalDialog({
	opened,
	narratorId,
	worktreePath,
	workspaceKey,
	onClose,
	onRemoved,
}: {
	opened: boolean;
	narratorId: string;
	worktreePath: string | null;
	workspaceKey: string;
	onClose: () => void;
	onRemoved: (result: WorktreeRemovalResult, plan: WorktreeRemovalPlan | undefined) => void;
}) {
	const { t } = useTranslation("narrator");
	const [state, setState] = useState<WorktreeRemovalFlowState>(EMPTY_STATE);
	const alive = useRef(true);
	const flow = useMemo(
		() =>
			new WorktreeRemovalFlow(
				{
					plan: (input) => api.planNarratorWorktreeRemoval(narratorId, input),
					remove: (input) => api.removeNarratorWorktree(narratorId, input),
					archive: async (id) => {
						await api.archiveNarrator(id);
					},
					// A refused removal carries the plan the server just computed; adopt it
					// instead of leaving the user staring at a stale one.
					planFromError: (error) => {
						if (!(error instanceof ApiError)) return undefined;
						const details = error.data?.details as { plan?: WorktreeRemovalPlan } | undefined;
						return details?.plan;
					},
				},
				(next) => {
					if (alive.current) setState(next);
				},
				() => (worktreePath ? { workspaceKey, path: worktreePath } : null),
			),
		[narratorId, worktreePath, workspaceKey],
	);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	// A fresh target or a re-opened dialog always re-reads reality; a plan is never cached.
	useEffect(() => {
		if (!opened || !worktreePath) return;
		setState(EMPTY_STATE);
		void flow.load();
	}, [opened, worktreePath, flow]);
	const plan = state.plan;
	const busy = state.busy;
	/** Translated sentence for a stable server code, or undefined when we have none. */
	const translated = (code: string | undefined) => {
		if (!code) return undefined;
		const key = `worktree.removeBlocker_${code}`;
		const text = t(key);
		return text === key ? undefined : text;
	};
	const label = (code: string) => translated(code) ?? code;
	// A refusal the catalogue knows is shown in the user's language; anything else keeps
	// the server's own sentence rather than a bare code.
	const failure = translated(state.errorCode) ?? state.error;
	const dependentLabel = (dependent: WorktreeDependent) =>
		dependent.title?.trim() || t("worktree.removeUntitled");
	const stepLabel = (step: WorktreeRemovalStep) =>
		step === "remove" ? t("worktree.removeRunning") : t("worktree.removeChecking");
	return (
		<Modal
			opened={opened}
			onClose={() => !busy && onClose()}
			title={t("worktree.removeTitle")}
			closeOnClickOutside={!busy}
			closeOnEscape={!busy}
			size="lg"
		>
			<Stack gap="sm">
				{!plan && !state.error && (
					<Group gap="xs" role="status">
						<Loader size="xs" />
						<Text size="sm">{stepLabel(state.step)}</Text>
					</Group>
				)}
				{state.error && <Alert color="red">{failure}</Alert>}
				{plan && (
					<>
						<Stack gap={2}>
							<Text size="sm" fw={500} truncate title={plan.worktree.path}>
								{plan.worktree.branch ?? worktreeDirectoryLabel(plan.worktree.path)}
							</Text>
							<Text size="xs" c="dimmed" truncate title={plan.worktree.path}>
								{plan.worktree.path}
							</Text>
							<Group gap={4} mt={4}>
								<Badge size="xs" color={plan.worktree.present ? "gray" : "red"}>
									{t(plan.worktree.present ? "worktree.removePresent" : "worktree.removeMissing")}
								</Badge>
								<Badge size="xs" color={plan.worktree.registered ? "indigo" : "yellow"}>
									{t(
										plan.worktree.registered
											? "worktree.removeRegistered"
											: "worktree.removeUnregistered",
									)}
								</Badge>
								{plan.worktree.dirty && (
									<Badge size="xs" color="orange">
										{t(
											plan.worktree.dirtyExact === false
												? "worktree.removeDirtyAtLeast"
												: "worktree.removeDirty",
											{ count: plan.worktree.dirtyFileCount },
										)}
									</Badge>
								)}
								{(plan.worktree.unreachableCommits ?? 0) > 0 && (
									<Badge size="xs" color="red">
										{t("worktree.removeUnreachable", {
											count: plan.worktree.unreachableCommits,
										})}
									</Badge>
								)}
								{plan.worktree.locked && (
									<Badge size="xs" color="yellow">
										{t("worktree.locked")}
									</Badge>
								)}
							</Group>
						</Stack>
						{plan.worktree.mode === "prune" && (
							<Text size="xs" c="dimmed">
								{t("worktree.removePruneOnly")}
							</Text>
						)}
						{plan.worktree.mode === "rows" && (
							<Text size="xs" c="dimmed">
								{t("worktree.removeRowsOnly")}
							</Text>
						)}
						{plan.worktree.mode === "remove" && (
							<Text size="xs" c="dimmed">
								{t("worktree.removeIgnoredNote")}
							</Text>
						)}
						<Divider />
						<Text size="sm" fw={500}>
							{t("worktree.removeDependents")}
						</Text>
						{plan.dependents.length === 0 ? (
							<Text size="xs" c="dimmed">
								{t("worktree.removeNoDependents")}
							</Text>
						) : (
							<Stack gap={4}>
								{plan.dependents.map((dependent) => (
									<Group key={dependent.id} gap="xs" wrap="nowrap">
										<Text size="xs" truncate style={{ flex: 1 }} title={dependentLabel(dependent)}>
											{dependentLabel(dependent)}
										</Text>
										{dependent.kind === "self" && (
											<Badge size="xs">{t("worktree.removeDependentSelf")}</Badge>
										)}
										{dependent.kind === "subagent" && (
											<Badge size="xs" color="grape">
												{t("worktree.removeDependentSubagent")}
											</Badge>
										)}
										{dependent.running && (
											<Badge size="xs" color="orange">
												{t("worktree.removeDependentRunning")}
											</Badge>
										)}
										{dependent.status === "archived" && (
											<Badge size="xs" color="gray">
												{t("worktree.removeDependentArchived")}
											</Badge>
										)}
										{dependent.kind === "primary" && dependent.status !== "archived" && (
											<Button
												size="compact-xs"
												variant="light"
												disabled={busy}
												onClick={() => void flow.archiveDependent(dependent.id)}
											>
												{t("worktree.removeArchive")}
											</Button>
										)}
									</Group>
								))}
							</Stack>
						)}
						<Text size="xs" c="dimmed">
							{t("worktree.removeEffects", {
								tasks: plan.inventory.backgroundTasks,
								browsers: plan.inventory.browserSessions,
								terminals: plan.inventory.terminals,
								trees: plan.inventory.treeSnapshots,
							})}
						</Text>
						{plan.blockers.length > 0 && (
							<Alert color="red" icon={<IconAlertTriangle size={16} />}>
								<Stack gap={4}>
									{plan.blockers.map((blocker) => (
										<Text key={blocker.code} size="xs">
											{label(blocker.code)}
										</Text>
									))}
								</Stack>
							</Alert>
						)}
						{requiredConfirmations(plan).map((confirmation) => (
							<Checkbox
								key={confirmation}
								size="xs"
								disabled={busy}
								checked={state.confirmed.includes(confirmation)}
								onChange={(event) => flow.toggle(confirmation, event.currentTarget.checked)}
								label={t(
									confirmation === "force"
										? "worktree.removeForce"
										: "worktree.removeUnregisteredConfirm",
								)}
							/>
						))}
						{plan.blockers.some(
							(blocker) => blocker.code === "WORKTREE_REMOVAL_DEPENDENT_NOT_ARCHIVED",
						) && (
							<Text size="xs" c="dimmed">
								{t("worktree.removeArchiveHint")}
							</Text>
						)}
						<Group justify="space-between" wrap="nowrap">
							<Button variant="default" disabled={busy} onClick={() => void flow.load()}>
								{t("worktree.removeReload")}
							</Button>
							<Button
								color="red"
								leftSection={<IconTrash size={16} />}
								loading={state.step === "remove"}
								disabled={!flow.canSubmit}
								onClick={() =>
									void flow.submit().then((result) => {
										if (result) onRemoved(result, plan);
									})
								}
							>
								{t("worktree.removeConfirm")}
							</Button>
						</Group>
					</>
				)}
			</Stack>
		</Modal>
	);
}
