import { ApiError, api } from "@frontend/lib/api";
import { Alert, Button, Checkbox, Group, List, Loader, Stack, Text } from "@mantine/core";
import type {
	WorktreeEntry,
	WorktreeRemovalReport,
	WorktreeRemoveResult,
} from "@shared/narrator-worktrees";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { worktreeDirectoryLabel, worktreeLabel } from "./worktree-list-view";

/** Server refusals a person can act on; anything else shows the server's own text. */
const REMOVAL_ERRORS: Record<string, string> = {
	WORKTREE_IN_USE: "worktree.removeInUse",
	WORKTREE_NOT_RECORDED: "worktree.removeNotRecorded",
	WORKTREE_LOCKED: "worktree.removeLocked",
	WORKTREE_REMOVAL_WOULD_LOSE_WORK: "worktree.removeChanged",
	WORKTREE_REMOVAL_CHANGED: "worktree.removeChanged",
	GIT_WORKSPACE_BUSY: "worktree.removeBusy",
};

export function removalLoses(report: WorktreeRemovalReport): boolean {
	return report.uncommittedFiles > 0 || !report.uncommittedExact || report.unmergedCommits > 0;
}

function shortRef(ref: string): string {
	return ref.replace(/^refs\/(?:heads|remotes)\//, "");
}

/**
 * Confirmation for removing one recorded worktree.
 *
 * The report is measured by the server when the panel opens. When it shows a loss the
 * person must tick the acknowledgement, and the request then carries that exact report
 * as `discard`: if anything grew in between, the server refuses and the panel shows the
 * new report instead of removing more than the person saw.
 */
export function WorktreeRemovalPanel({
	narratorId,
	workspaceKey,
	entry,
	onClose,
	onRemoved,
}: {
	narratorId: string;
	workspaceKey: string;
	entry: WorktreeEntry;
	onClose: () => void;
	onRemoved: (result: WorktreeRemoveResult) => void;
}) {
	const { t } = useTranslation("narrator");
	const [deleteBranch, setDeleteBranch] = useState(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [error, setError] = useState<string>();
	const [refreshed, setRefreshed] = useState<WorktreeRemovalReport>();
	const measured = useQuery({
		queryKey: ["narratorWorktreeRemovalReport", narratorId, workspaceKey, entry.path],
		queryFn: ({ signal }) =>
			api.getNarratorWorktreeRemovalReport(narratorId, { workspaceKey, path: entry.path }, signal),
		gcTime: 0,
		staleTime: 0,
		retry: false,
		refetchOnWindowFocus: false,
	});
	const report = refreshed ?? measured.data;
	const loses = report ? removalLoses(report) : false;
	const describeError = (cause: unknown) => {
		const code = cause instanceof ApiError ? cause.data?.code : undefined;
		const key = typeof code === "string" ? REMOVAL_ERRORS[code] : undefined;
		return key ? t(key) : cause instanceof Error ? cause.message : String(cause);
	};
	const remove = async () => {
		if (!report || removing) return;
		setRemoving(true);
		setError(undefined);
		try {
			const result = await api.removeNarratorWorktree(narratorId, {
				workspaceKey,
				path: entry.path,
				deleteBranch,
				...(loses
					? {
							discard: {
								head: report.head,
								uncommittedFiles: report.uncommittedFiles,
								unmergedCommits: report.unmergedCommits,
							},
						}
					: {}),
			});
			onRemoved(result);
		} catch (cause) {
			// A grown loss arrives with the new report: show it and ask again.
			const details = cause instanceof ApiError ? cause.data?.details : undefined;
			const next =
				details && typeof details === "object" && "report" in details
					? (details as { report: WorktreeRemovalReport }).report
					: undefined;
			if (next) {
				setRefreshed(next);
				setAcknowledged(false);
			}
			setError(describeError(cause));
		} finally {
			setRemoving(false);
		}
	};
	return (
		<Stack gap="sm" data-worktree-removal={entry.path}>
			<Text fw={500}>{t("worktree.removeTitle")}</Text>
			<Text size="xs" c="dimmed" truncate title={entry.path}>
				{worktreeLabel(entry)} · {worktreeDirectoryLabel(entry.path)}
			</Text>
			{measured.isPending && !refreshed && (
				<Group gap="xs" role="status">
					<Loader size="xs" />
					<Text size="sm">{t("worktree.removeMeasuring")}</Text>
				</Group>
			)}
			{measured.error && !refreshed && <Alert color="red">{describeError(measured.error)}</Alert>}
			{report && !loses && <Text size="sm">{t("worktree.removeNothingLost")}</Text>}
			{report && loses && (
				<Alert color="red" title={t("worktree.removeLossTitle")}>
					<List size="sm" spacing={4}>
						{(report.uncommittedFiles > 0 || !report.uncommittedExact) && (
							<List.Item>
								{t(
									report.uncommittedExact
										? "worktree.removeUncommitted"
										: "worktree.removeUncommittedAtLeast",
									{ count: report.uncommittedFiles },
								)}
							</List.Item>
						)}
						{report.unmergedCommits > 0 && (
							<List.Item>
								{report.upstream
									? t("worktree.removeUnmergedWithUpstream", {
											count: report.unmergedCommits,
											base: report.base.ref,
											upstream: shortRef(report.upstream.ref),
										})
									: t("worktree.removeUnmerged", {
											count: report.unmergedCommits,
											base: report.base.ref,
										})}
							</List.Item>
						)}
					</List>
					<Checkbox
						mt="sm"
						checked={acknowledged}
						disabled={removing}
						onChange={(event) => setAcknowledged(event.currentTarget.checked)}
						label={t("worktree.removeAcknowledge")}
					/>
				</Alert>
			)}
			{report?.missing && (
				<Text size="xs" c="dimmed">
					{t("worktree.removeMissing")}
				</Text>
			)}
			{report?.branch && (
				<Checkbox
					checked={deleteBranch}
					disabled={removing}
					onChange={(event) => setDeleteBranch(event.currentTarget.checked)}
					label={t("worktree.removeDeleteBranch", { branch: report.branch })}
					description={t(
						loses && report.unmergedCommits > 0
							? "worktree.removeDeleteBranchDiscards"
							: "worktree.removeDeleteBranchHint",
					)}
				/>
			)}
			{error && <Alert color="red">{error}</Alert>}
			<Group justify="flex-end" gap="xs">
				<Button variant="default" disabled={removing} onClick={onClose}>
					{t("worktree.removeCancel")}
				</Button>
				<Button
					color="red"
					loading={removing}
					disabled={!report || (loses && !acknowledged)}
					onClick={() => void remove()}
				>
					{t("worktree.removeConfirm")}
				</Button>
			</Group>
		</Stack>
	);
}
