import {
	gitWorkspaceTarget,
	useGitLineStats,
	useGitStatus,
	useGitWorkspace,
} from "@frontend/hooks/useGit";
import { useWorkspaceContext } from "@frontend/hooks/useWorkspaceContext";
import { Badge, Group, Skeleton, Text, Tooltip } from "@mantine/core";
import { IconFolder, IconGitBranch } from "@tabler/icons-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { GitLineStatsSummary } from "../../git/GitLineStatsSummary";
import { isActivationKey, isTextSelectionGesture } from "./git-bar-trigger";
import { NarratorWorktreeControls } from "./NarratorWorktreeControls";

/**
 * Git strip for a narrator's workspace.
 *
 * Every workspace reserves 30px immediately: skeleton, ordinary cwd or Git facts
 * replace each other in place. A cached non-Git result must not permanently hide
 * Git features after git init or a directory switch.
 */
export function NarratorGitBar({
	narratorId,
	onOpenGitPanel,
	onRequirement,
}: {
	narratorId: string;
	onOpenGitPanel: () => void;
	onRequirement?: (text: string) => void;
}) {
	const { t } = useTranslation("git");
	const workspace = useGitWorkspace(narratorId);
	const { data: executionContext } = useWorkspaceContext(narratorId);
	const target = !workspace.isError ? gitWorkspaceTarget(narratorId, workspace.data) : null;
	const status = useGitStatus(target, "summary");
	const lineStats = useGitLineStats(target, "summary");
	const workspaceState = workspace.data?.state;
	useEffect(() => {
		if (status.data) workspace.rememberCounts?.(status.data);
	}, [status.data, workspace.rememberCounts]);
	const counts = status.data ?? workspace.displayCounts;
	const canOpen = !!target;
	const WorkspaceIcon = workspaceState === "not_git" ? IconFolder : IconGitBranch;
	return (
		<Group
			px="md"
			py={4}
			gap={6}
			wrap="nowrap"
			data-git-slot
			role={canOpen ? "button" : undefined}
			tabIndex={canOpen ? 0 : undefined}
			aria-label={t("panel.title")}
			style={{
				height: 30,
				flexShrink: 0,
				overflow: "hidden",
				cursor: canOpen ? "pointer" : undefined,
				userSelect: "text",
			}}
			onClick={(event) => {
				// Portal events bubble through React, even when outside this DOM row.
				if (!canOpen || !event.currentTarget.contains(event.target as Node)) return;
				if (!isTextSelectionGesture(window.getSelection())) onOpenGitPanel();
			}}
			onKeyDown={(event) => {
				if (!canOpen || !event.currentTarget.contains(event.target as Node)) return;
				if (isActivationKey(event.key)) {
					event.preventDefault();
					onOpenGitPanel();
				}
			}}
		>
			<Group gap={6} wrap="nowrap">
				<WorkspaceIcon size={14} color="var(--mantine-color-dimmed)" aria-hidden="true" />
				{workspace.isPending && !workspace.data ? (
					<Skeleton height={12} width={140} radius="sm" />
				) : (
					<Text
						size="xs"
						c="dimmed"
						ff="monospace"
						truncate
						title={
							executionContext ? `${executionContext.deviceId}: ${executionContext.cwd}` : undefined
						}
					>
						{workspaceState === "not_git"
							? executionContext?.cwd
							: workspaceState === "ready"
								? status.data?.branch || workspace.data?.branch || t("workspace.ready")
								: t(`workspace.${workspace.isError ? "error" : (workspaceState ?? "error")}`)}
					</Text>
				)}
			</Group>
			{counts && (
				<Tooltip label={t("panel.changes")}>
					<Badge size="xs" variant="light">
						<Group gap={5} wrap="nowrap">
							<Text span size="xs" fw={600}>
								{counts.totalFilesExact === false ||
								(counts.totalFilesExact === undefined && counts.truncated)
									? t("workspace.atLeastFiles", { count: counts.totalFiles })
									: counts.totalFiles}
							</Text>
							{target && <GitLineStatsSummary {...lineStats} compact />}
						</Group>
					</Badge>
				</Tooltip>
			)}
			<NarratorWorktreeControls
				key={narratorId}
				narratorId={narratorId}
				onRequirement={onRequirement}
			/>
			{target && !workspace.data?.capabilities.write && (
				<Text size="xs" c="dimmed">
					{t("workspace.readOnly")}
				</Text>
			)}
		</Group>
	);
}
