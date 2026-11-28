import { Alert, Box, Button, Group, Loader, Stack } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	type GitTarget,
	gitWorkspaceTarget,
	invalidateWorkspaceQueries,
	useGitWorkspace,
	useGitWorkspaceSubscription,
} from "../../hooks/useGit";
import { gitTargetKey } from "../../lib/api/git";
import { describeApiError } from "../../lib/api-error";
import { ConfirmDialogProvider } from "../common/ConfirmDialogProvider";
import { GitBranchBar } from "./GitBranchBar";
import { GitChangesTab } from "./GitChangesTab";
import { GitCommitGraph } from "./GitCommitGraph";

/** Every narrator host resolves its own workspace capability. */
export function GitPanel({ narratorId }: { narratorId?: string }) {
	if (narratorId) return <NarratorGitPanel narratorId={narratorId} />;
	return null;
}

function NarratorGitPanel({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation(["git", "errors"]);
	const qc = useQueryClient();
	const workspaceQuery = useGitWorkspace(narratorId);
	const workspace = workspaceQuery.data;
	const target = useMemo(
		() => (!workspaceQuery.isError ? gitWorkspaceTarget(narratorId, workspace) : null),
		[narratorId, workspace, workspaceQuery.isError],
	);

	const retainedTarget = useRef<GitTarget | null>(null);
	if (target || retainedTarget.current?.narratorId !== narratorId)
		retainedTarget.current = target
			? {
					narratorId: target.narratorId,
					workspaceKey: target.workspaceKey,
					repositoryKey: target.repositoryKey,
					canWrite: false,
				}
			: null;
	const subscriptionTarget = target ?? retainedTarget.current;
	// This owner remains mounted when private content is replaced by the recovery state.
	const subscriptions = useGitWorkspaceSubscription(subscriptionTarget);
	const state = subscriptionTarget ? subscriptions.getState(subscriptionTarget) : "waiting";
	const suspended = !!subscriptionTarget && !subscriptions.canRead(subscriptionTarget);
	const described = describeApiError(workspaceQuery.error, t);

	// A refusal withholds `data` and may drop the query entirely; explain it rather than spin or
	// render nothing. No workspace facts are shown, only the refusal and a retry.
	if (workspaceQuery.isPending && !workspaceQuery.accessDenied) return <Loader size="sm" />;

	return (
		<Stack gap={4} style={{ height: "100%", minHeight: 0 }}>
			{!target || workspaceQuery.accessDenied || suspended ? (
				<Stack gap={4} p="xs">
					<Group justify="flex-end">
						<Button
							size="compact-xs"
							variant="subtle"
							leftSection={<IconRefresh size={13} />}
							loading={workspaceQuery.isFetching}
							onClick={() => {
								if (subscriptionTarget && suspended && state !== "workspace_changed")
									subscriptions.refresh(subscriptionTarget);
								else void workspaceQuery.refetch();
							}}
						>
							{t("workspace.retry")}
						</Button>
					</Group>
					<Alert
						color="yellow"
						title={t(
							`workspace.${
								workspaceQuery.accessDenied || state === "denied"
									? "access_denied"
									: suspended
										? state === "refresh_required"
											? "refresh_required"
											: state === "waiting"
												? "loading"
												: "recovering"
										: workspaceQuery.isError
											? "error"
											: (workspace?.state ?? "error")
							}`,
						)}
					>
						{workspaceQuery.accessDenied || suspended
							? null
							: workspaceQuery.error
								? described.status === 503 && !described.localized
									? t("workspace.refresh_required")
									: described.message
								: workspace?.reason}
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

/** The panel for an already-resolved target; exported for tests. */
export function GitPanelContent({
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
	const subscriptions = useGitWorkspaceSubscription(target);
	const state = subscriptions.getState(target);

	const refresh = () => {
		if (onRefresh) onRefresh();
		else invalidateWorkspaceQueries(qc, target);
	};

	if (!subscriptions.canRead(target))
		return (
			<Stack gap={4} p="xs">
				<Group justify="flex-end">
					<Button
						size="compact-xs"
						variant="subtle"
						leftSection={<IconRefresh size={13} />}
						onClick={refresh}
					>
						{t("workspace.retry")}
					</Button>
				</Group>
				<Alert
					color="yellow"
					title={t(
						`workspace.${state === "denied" ? "access_denied" : state === "refresh_required" ? "refresh_required" : state === "waiting" ? "loading" : "recovering"}`,
					)}
				/>
			</Stack>
		);

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
				<GitBranchBar target={target} readOnly={readOnly} />
				<GitChangesTab target={target} onRefresh={refresh} />
				<GitCommitGraph target={target} />
			</Box>
		</div>
	);
}
