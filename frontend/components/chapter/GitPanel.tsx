import { ActionIcon, Alert, Box, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { IconArrowLeft, IconRefresh } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type GitTarget,
	gitWorkspaceTarget,
	invalidateWorkspaceQueries,
	useGitWorkspace,
} from "../../hooks/useGit";
import { gitTargetKey } from "../../lib/api/git";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";
import { GitChangesTab } from "./GitChangesTab";
import { GitCommitsTab } from "./GitCommitsTab";
import { GitStashTab } from "./GitStashTab";

type GitPanelView = "changes" | "commits" | "stash";

/** Legacy chapter callers keep their existing contract; every narrator host resolves capability. */
export function GitPanel({
	chapterId,
	narratorId,
}: {
	chapterId?: string | null;
	narratorId?: string;
}) {
	if (narratorId) return <NarratorGitPanel narratorId={narratorId} />;
	if (chapterId) return <GitPanelContent key={chapterId} target={chapterId} />;
	return null;
}

function NarratorGitPanel({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation("git");
	const qc = useQueryClient();
	const workspaceQuery = useGitWorkspace(narratorId);
	const workspace = workspaceQuery.data;
	const target = !workspaceQuery.isError ? gitWorkspaceTarget(narratorId, workspace) : null;

	if (workspaceQuery.isPending) return <Loader size="sm" />;

	return (
		<Stack gap={4} style={{ height: "100%", minHeight: 0 }}>
			{!target ? (
				<Stack gap={4} p="xs">
					<Group justify="flex-end">
						<Button
							size="compact-xs"
							variant="subtle"
							leftSection={<IconRefresh size={13} />}
							loading={workspaceQuery.isFetching}
							onClick={() => workspaceQuery.refetch()}
						>
							{t("workspace.retry")}
						</Button>
					</Group>
					<Alert
						color="yellow"
						title={t(
							`workspace.${workspaceQuery.isError ? "error" : (workspace?.state ?? "error")}`,
						)}
					>
						{workspaceQuery.error?.message || workspace?.reason}
					</Alert>
				</Stack>
			) : (
				<ConfirmDialogProvider
					key={`${narratorId}:${gitTargetKey(target)}:${workspace?.cwd}:${workspace?.capabilities.write}`}
				>
					<GitPanelContent
						target={target}
						onRefresh={() => invalidateWorkspaceQueries(qc, target)}
						readOnly={!workspace?.capabilities.write}
					/>
				</ConfirmDialogProvider>
			)}
		</Stack>
	);
}

function GitPanelContent({
	target,
	onRefresh,
	readOnly = false,
}: {
	target: GitTarget;
	onRefresh?: () => void;
	readOnly?: boolean;
}) {
	const { t } = useTranslation("git");
	const qc = useQueryClient();
	const [view, setView] = useState<GitPanelView>("changes");

	const refresh = () => {
		if (onRefresh) onRefresh();
		else invalidateWorkspaceQueries(qc, target);
	};

	return (
		<div
			style={{ height: "100%", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
		>
			{readOnly && (
				<Alert color="yellow" m="xs" mb={0}>
					{t("workspace.readOnly")}
				</Alert>
			)}
			{view === "changes" ? (
				<GitChangesTab target={target} onRefresh={refresh} onOpenSecondaryView={setView} />
			) : (
				<Stack gap={0} style={{ flex: 1, minHeight: 0 }}>
					<Group
						gap={4}
						px="xs"
						py={4}
						style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-default-border)" }}
					>
						<ActionIcon
							variant="subtle"
							size="sm"
							aria-label={t("panel.backToChanges")}
							onClick={() => setView("changes")}
						>
							<IconArrowLeft size={14} />
						</ActionIcon>
						<Text size="sm" fw={600}>
							{t(view === "commits" ? "panel.commits" : "panel.stash")}
						</Text>
						<ActionIcon
							variant="subtle"
							size="sm"
							aria-label={t("workspace.retry")}
							onClick={refresh}
							style={{ marginLeft: "auto" }}
						>
							<IconRefresh size={14} />
						</ActionIcon>
					</Group>
					<Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
						{view === "commits" ? (
							<GitCommitsTab target={target} />
						) : (
							<GitStashTab target={target} />
						)}
					</Box>
				</Stack>
			)}
		</div>
	);
}
