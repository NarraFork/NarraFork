import { Alert, Box, Button, Group, Loader, Stack } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	type GitTarget,
	gitWorkspaceTarget,
	invalidateWorkspaceQueries,
	useGitWorkspace,
	useGitWorkspaceSubscription,
} from "../../hooks/useGit";
import { gitTargetKey } from "../../lib/api/git";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";
import { GitChangesTab } from "./GitChangesTab";
import { GitCommitGraph } from "./GitCommitGraph";

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
	const target = useMemo(
		() => (!workspaceQuery.isError ? gitWorkspaceTarget(narratorId, workspace) : null),
		[narratorId, workspace, workspaceQuery.isError],
	);

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
	useGitWorkspaceSubscription(target);

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
			<Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
				<GitChangesTab target={target} onRefresh={refresh} />
				<GitCommitGraph target={target} />
			</Box>
		</div>
	);
}
