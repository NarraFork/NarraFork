/**
 * Shared file/history confirmation. The new action host reviews one durable plan
 * and its complete paged file list. The presentational dialog also retains the
 * legacy scope display for edit/regenerate, whose executor remains unavailable.
 * No path widens the scope or interprets missing evidence as an empty file set.
 */

import { useRevertActionPreview } from "@frontend/hooks/useNarrator";
import type {
	RevertActionConfirmOptions,
	RevertPlanReview,
	RevertScope,
	RevertScopePreviews,
} from "@frontend/lib/api/narrators";
import { formatRevertWarning, formatRevertWarnings } from "@frontend/lib/revert-warnings";
import {
	Alert,
	Badge,
	Button,
	Center,
	Group,
	Loader,
	Modal,
	SegmentedControl,
	Stack,
	Text,
} from "@mantine/core";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TruncatedPath } from "../../common/TruncatedPath";

export interface RevertScopeConfirmModalProps {
	opened: boolean;
	title: string;
	/** What will be deleted, phrased by the host (blocks, messages, a regenerate). */
	description: string;
	data: RevertScopePreviews | undefined;
	/** Current target/opening token, not the token carried by a cached response. */
	previewKey?: string;
	isLoading: boolean;
	loadingDescription?: string;
	onReload?: () => void;
	/** Disables the exits while the host's request is in flight. */
	submitting?: boolean;
	/** Confirm label when there ARE files to revert. */
	confirmWithRevertLabel: string;
	/** Confirm label when there are none, so it does not promise a rollback. */
	confirmNoFilesLabel: string;
	/** The history-only exit: delete/regenerate but leave the workspace alone. */
	messagesOnlyLabel: string;
	onConfirm: (opts: RevertActionConfirmOptions) => void;
	onCancel: () => void;
}

type ScopePreview = NonNullable<
	RevertScopePreviews["narratorScope"] | RevertScopePreviews["workspaceScope"]
>;

/** Missing, unknown and partial evidence must never look like an empty change set. */
function scopeUnavailableKey(preview: ScopePreview | undefined): string | null {
	if (!preview) return "revertScopeUnavailable";
	if (preview.reason !== undefined && preview.reason !== "nothing_owned") {
		switch (preview.reason) {
			case "no_boundaries":
			case "legacy_unverified":
				return "revertScopeLegacyUnverified";
			case "execution_unavailable":
				return "revertScopeExecutionUnavailable";
			case "runtime_reload_required":
				return "revertScopeRuntimeReloadRequired";
			case "snapshot_missing":
				return "revertScopeSnapshotMissing";
			case "incomplete_coverage":
				return "revertScopeIncompleteCoverage";
			case "window_too_large":
				return "revertScopeWindowTooLarge";
			case "pending_operations":
				return "revertScopePendingOperations";
			case "no_workspace":
			case "git_unsupported":
			case "unsupported_target":
				return "revertScopeUnsupportedTarget";
			case "platform_unsupported":
				return "revertScopePlatformUnsupported";
			default:
				return "revertScopeUnavailable";
		}
	}
	if (preview.available !== true || !Array.isArray(preview.files)) {
		return "revertScopeUnavailable";
	}
	if (
		("hasMore" in preview && preview.hasMore) ||
		("totalFileCount" in preview &&
			preview.totalFileCount !== undefined &&
			preview.totalFileCount !== preview.files.length)
	) {
		return "revertScopePreviewTruncated";
	}
	if (preview.reason === "nothing_owned" && preview.files.length > 0) {
		return "revertScopeUnavailable";
	}
	return null;
}

const planIssueKeys = {
	expired: "revertPlanExpired",
	not_prepared: "revertPlanNotPrepared",
	preview_failed: "revertPlanPreviewFailed",
	incomplete_files: "revertScopePreviewTruncated",
	window_too_large: "revertScopeWindowTooLarge",
	reload_required: "revertPlanReloadRequired",
} as const;

/** Rechecked in the click handler as well: the deadline can pass between renders. */
function planUnavailableKey(
	plan: RevertPlanReview,
	previewKey: string | undefined,
	fileCount: number,
): string | null {
	if (!previewKey || plan.previewKey !== previewKey) return "revertPlanReloadRequired";
	if (plan.expired !== false || !(Date.parse(plan.expiresAt) > Date.now())) {
		return "revertPlanExpired";
	}
	if (!plan.planId || !plan.planHash || plan.status !== "prepared") return "revertPlanNotPrepared";
	if (plan.coverageComplete !== true) return "revertScopeIncompleteCoverage";
	if (
		!plan.filesComplete ||
		!Number.isSafeInteger(plan.expectedFileCount) ||
		plan.expectedFileCount !== fileCount ||
		fileCount > FILE_CHANGE_LIMITS.revertFiles
	) {
		return "revertScopePreviewTruncated";
	}
	return null;
}

export function RevertScopeConfirmModal({
	opened,
	title,
	description,
	data,
	previewKey,
	isLoading,
	loadingDescription,
	onReload,
	submitting,
	confirmWithRevertLabel,
	confirmNoFilesLabel,
	messagesOnlyLabel,
	onConfirm,
	onCancel,
}: RevertScopeConfirmModalProps) {
	const { t } = useTranslation("narrator");
	const [selection, setSelection] = useState<{
		preview: RevertScopePreviews;
		scope: RevertScope;
	} | null>(null);

	// Workspace consent belongs to this preview and this opening of the dialog.
	// Ignore the server's recommendation: an unavailable narrator scope must never
	// silently widen to workspace. The identity check also revokes stale consent
	// during render, before the reset effect runs for a changed preview.
	useEffect(() => {
		setSelection((current) => (opened && !isLoading && current?.preview === data ? current : null));
	}, [opened, data, isLoading]);
	const scope = selection && selection.preview === data ? selection.scope : "narrator";
	const plan = data?.revertPlan;
	const lastReadyPlan = useRef<string | null>(null);
	const [retiredPlanId, setRetiredPlanId] = useState<string | null>(null);
	const [, setExpiryTick] = useState(0);
	useEffect(() => {
		if (!opened || !plan) return;
		const remaining = Date.parse(plan.expiresAt) - Date.now();
		if (!(remaining > 0)) return;
		const timer = setTimeout(
			() => setExpiryTick((value) => value + 1),
			Math.min(remaining, FILE_CHANGE_LIMITS.planLifetimeMs),
		);
		return () => clearTimeout(timer);
	}, [opened, plan]);

	const narratorScope = data?.narratorScope;
	const workspaceScope = data?.workspaceScope;
	const conflicts = narratorScope?.conflicts ?? [];
	const hasKnownScope = data?.scope === "narrator" || data?.scope === "workspace";
	const narratorUnavailable = scopeUnavailableKey(narratorScope);
	const workspaceUnavailable = scopeUnavailableKey(workspaceScope);
	const narratorUsable =
		hasKnownScope &&
		narratorUnavailable === null &&
		Array.isArray(narratorScope?.conflicts) &&
		conflicts.length === 0;
	const workspaceUsable = hasKnownScope && workspaceUnavailable === null;
	const hasScopeChoice = !!narratorScope || !!workspaceScope;
	const selectedPreview = scope === "workspace" ? workspaceScope : narratorScope;
	// Legacy file lists remain viewable, but are not executable rollback plans.
	const listedFiles = hasScopeChoice ? selectedPreview?.files : data?.affectedFiles;
	const activeFiles = Array.isArray(listedFiles) ? listedFiles : [];
	const planUnavailable = data?.previewIssue
		? planIssueKeys[data.previewIssue]
		: plan
			? plan.planId === retiredPlanId
				? "revertPlanReloadRequired"
				: planUnavailableKey(plan, previewKey, activeFiles.length)
			: null;
	const revertBlocked =
		!opened ||
		isLoading ||
		(!!previewKey && !plan) ||
		!!planUnavailable ||
		!(scope === "workspace" ? workspaceUsable : narratorUsable);
	useEffect(() => {
		if (!opened || isLoading || submitting) {
			if (lastReadyPlan.current) setRetiredPlanId(lastReadyPlan.current);
			lastReadyPlan.current = null;
		} else if (plan && !revertBlocked) {
			lastReadyPlan.current = plan.planId;
		}
	}, [opened, isLoading, submitting, plan, revertBlocked]);
	const scopeUnavailable = !data
		? "revertScopeUnavailable"
		: !hasKnownScope
			? data.scope === undefined
				? "revertScopeLegacyUnverified"
				: "revertScopeUnavailable"
			: ((scope === "workspace" ? workspaceUnavailable : narratorUnavailable) ??
				(revertBlocked && conflicts.length === 0 ? "revertScopeUnavailable" : null));
	const unavailableKey = planUnavailable ?? scopeUnavailable;
	const workspaceWarningText = formatRevertWarnings(t, workspaceScope?.warnings);
	const blockers = data?.blockers ?? [];
	const subagentWarningText = narratorScope?.subagentWarning
		? formatRevertWarning(t, {
				code: "SUBAGENT_CHANGES_REVERTED",
				changeCount: narratorScope.subagentWarning.changeCount,
				sampleFilePaths: narratorScope.subagentWarning.sampleFiles,
			})
		: null;

	const showScopeChoice = !!data && hasScopeChoice && !previewKey;

	return (
		<Modal
			opened={opened}
			onClose={() => {
				if (!submitting) onCancel();
			}}
			closeOnClickOutside={!submitting}
			closeOnEscape={!submitting}
			closeButtonProps={{ disabled: submitting }}
			title={title}
			centered
			size="md"
		>
			<Stack gap="md">
				{isLoading ? (
					<Center py="md">
						<Stack align="center" gap="xs">
							<Loader size="sm" />
							{loadingDescription && <Text size="xs">{loadingDescription}</Text>}
						</Stack>
					</Center>
				) : (
					<>
						<Text size="sm">{description}</Text>

						{plan && !revertBlocked && (
							<Alert color="yellow" variant="light">
								<Text size="xs">{t("revertPlanExternalWritesWarning")}</Text>
							</Alert>
						)}

						{showScopeChoice && (
							<SegmentedControl
								size="xs"
								fullWidth
								value={scope}
								disabled={submitting}
								onChange={(value) => {
									if (!data || isLoading || submitting) return;
									if (
										(value === "narrator" && narratorUsable) ||
										(value === "workspace" && workspaceUsable)
									) {
										setSelection({ preview: data, scope: value });
									}
								}}
								data={[
									{
										value: "narrator",
										label: t("revertScopeNarrator"),
										disabled: !narratorUsable,
									},
									{
										value: "workspace",
										label: t("revertScopeWorkspace"),
										disabled: !workspaceUsable,
									},
								]}
							/>
						)}

						{unavailableKey && (
							<Alert color="yellow" variant="light" title={t("revertScopeUnavailableTitle")}>
								<Text size="xs">{t(unavailableKey)}</Text>
								{data?.previewError && <Text size="xs">{data.previewError}</Text>}
								{blockers.length > 0 && (
									<Stack gap={4} mt="xs">
										<Text size="xs" fw={500}>
											{t("revertBlockersTitle")}
										</Text>
										{blockers.map((blocker, index) => {
											const kindLabel = t(`revertBlockerKind.${blocker.kind}`, {
												defaultValue: t("revertBlockerKind.unknown"),
											});
											const who = blocker.toolName
												? `${blocker.toolName}${blocker.toolCallId ? ` (${blocker.toolCallId.slice(0, 8)})` : ""}`
												: blocker.leaseId
													? blocker.leaseId.slice(0, 12)
													: blocker.operationId
														? blocker.operationId.slice(0, 12)
														: null;
											return (
												<Text
													key={`${blocker.kind}-${blocker.toolCallId ?? blocker.operationId ?? blocker.leaseId ?? index}`}
													size="xs"
												>
													• {kindLabel}
													{who ? ` — ${who}` : ""}
													{blocker.detail ? `: ${blocker.detail}` : ""}
												</Text>
											);
										})}
										<Text size="xs" c="dimmed">
											{blockers.some((blocker) => blocker.kind === "running_tool")
												? t("revertBlockersStopRunning")
												: t("revertBlockersLeftover")}
										</Text>
									</Stack>
								)}
								<Text size="xs">{t("revertScopeKeepFiles")}</Text>
							</Alert>
						)}

						{scope === "narrator" && workspaceUsable && (
							<Text size="xs" c="dimmed">
								{t("revertScopeWorkspaceExplicit")}
							</Text>
						)}

						{scope === "narrator" && conflicts.length > 0 && (
							<Alert color="red" variant="light" title={t("revertScopeConflictTitle")}>
								<Text size="xs">
									{t("revertScopeConflictDesc", { files: conflicts.slice(0, 5).join(", ") })}
								</Text>
							</Alert>
						)}

						{scope === "narrator" && subagentWarningText && (
							<Alert color="yellow" variant="light" title={t("revertScopeSubagentTitle")}>
								<Text size="xs">{subagentWarningText}</Text>
							</Alert>
						)}

						{scope === "workspace" && (
							<Alert color="red" variant="light" title={t("revertScopeWorkspaceWarnTitle")}>
								<Text size="xs">{t("revertScopeWorkspaceWarning")}</Text>
								{workspaceWarningText && <Text size="xs">{workspaceWarningText}</Text>}
							</Alert>
						)}

						{activeFiles.length > 0 ? (
							<>
								<Text size="sm" fw={500}>
									{t(revertBlocked ? "revertScopeRecordedFiles" : "rollbackConfirmFiles")}
								</Text>
								<Stack gap={4} mah={260} style={{ overflowY: "auto" }}>
									{activeFiles.map((file) => (
										<Group
											key={file.fileKey ?? `${file.deviceId}:${file.filePath}`}
											gap="xs"
											wrap="nowrap"
										>
											<TruncatedPath path={file.filePath} />
											{plan && (
												<Badge size="xs" variant="outline">
													{file.deviceId}
												</Badge>
											)}
											{!revertBlocked && (
												<Badge
													size="xs"
													variant="light"
													color={file.willBeDeleted ? "red" : "orange"}
												>
													{file.willBeDeleted
														? t("fileMod_willBeDeleted")
														: t("fileMod_willBeReverted")}
												</Badge>
											)}
										</Group>
									))}
								</Stack>
							</>
						) : !revertBlocked ? (
							<Text size="sm" c="dimmed">
								{scope === "narrator" && narratorScope?.reason === "nothing_owned"
									? t("revertScopeNothingOwned")
									: t("rollbackConfirmNoFiles")}
							</Text>
						) : null}
					</>
				)}
				<Group gap="xs" justify="flex-end">
					{onReload && (
						<Button
							size="xs"
							variant="subtle"
							disabled={isLoading || submitting}
							onClick={() => {
								if (!opened || isLoading || submitting) return;
								if (plan) setRetiredPlanId(plan.planId);
								onReload();
							}}
						>
							{t("revertPlanReload")}
						</Button>
					)}
					<Button size="xs" variant="subtle" onClick={onCancel} disabled={submitting}>
						{t("cancel")}
					</Button>
					<Button
						size="xs"
						variant="default"
						onClick={() => {
							if (!opened || submitting) return;
							onConfirm({ skipRevert: true });
						}}
						loading={submitting}
						disabled={submitting}
					>
						{messagesOnlyLabel}
					</Button>
					<Button
						size="xs"
						color="red"
						disabled={revertBlocked || submitting}
						onClick={() => {
							if (revertBlocked || submitting) return;
							if (plan) {
								if (planUnavailableKey(plan, previewKey, activeFiles.length) || !plan.planHash)
									return;
								setRetiredPlanId(plan.planId);
								onConfirm({
									skipRevert: false,
									revertPlan: { planId: plan.planId, planHash: plan.planHash, action: plan.action },
								});
							} else {
								onConfirm({ skipRevert: false, scope });
							}
						}}
						loading={isLoading || submitting}
					>
						{revertBlocked
							? t("revertScopeUnavailableTitle")
							: activeFiles.length > 0
								? confirmWithRevertLabel
								: confirmNoFilesLabel}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

/** New history actions share the fixed-plan flow; edit/regenerate stays on its legacy preview. */
export function RevertActionConfirmModal({
	narratorId,
	action,
	pending,
	submitting,
	onConfirm,
	onCancel,
}: {
	narratorId: string;
	action: "rollback_to_block" | "delete_tool_block";
	pending: { messageId: string; blockIndex: number } | null;
	submitting?: boolean;
	onConfirm: (opts: RevertActionConfirmOptions) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation("narrator");
	const preview = useRevertActionPreview(narratorId, action, pending);
	const isBlockDelete = action === "delete_tool_block";
	const summary = preview.historySummary;
	const plan = preview.data?.revertPlan;
	return (
		<RevertScopeConfirmModal
			opened={!!pending}
			title={t(isBlockDelete ? "blockDeleteConfirmTitle" : "rollbackConfirmTitle")}
			description={
				summary
					? t("revertPlanHistorySummary", {
							blockCount: summary.deletedBlockCount,
							messageCount: summary.deletedMessageCount,
						})
					: t("revertPlanHistoryUnknown")
			}
			data={preview.data}
			previewKey={preview.previewKey}
			isLoading={preview.isLoading}
			loadingDescription={
				plan
					? t("revertPlanLoadingFiles", {
							loaded: preview.data?.affectedFiles.length ?? 0,
							total: plan.expectedFileCount,
						})
					: undefined
			}
			submitting={submitting}
			onReload={preview.reload}
			confirmWithRevertLabel={t(
				isBlockDelete ? "blockDeleteWithRevert" : "rollbackConfirmWithRevert",
			)}
			confirmNoFilesLabel={t(isBlockDelete ? "contextMenu_delete" : "rollbackConfirm")}
			messagesOnlyLabel={t(
				isBlockDelete ? "blockDeleteHistoryOnly" : "rollbackConfirmMessagesOnly",
			)}
			onConfirm={(opts) => {
				if (!pending || submitting) return;
				if (!opts.skipRevert && opts.revertPlan?.action !== action) return;
				// No background re-plan after an attempt, even when the response is lost.
				preview.invalidate();
				onConfirm(opts);
			}}
			onCancel={onCancel}
		/>
	);
}
