/**
 * RevertScopeConfirmModal.tsx — the shared confirmation dialog for any action that
 * deletes narrator history and may roll the workspace back.
 *
 * Extracted from NarratorPanel's RollbackConfirmModal so rollback-to-block and
 * edit-and-regenerate present the SAME decision instead of two different ones. They
 * had drifted badly: rollback showed the scope choice, the conflicts and the exact
 * file list, while editing offered a "keep code changes" button whose value the
 * server ignored — so the destructive path was also the uninformed one.
 *
 * Purely presentational: the caller owns the preview query, so each host can fetch
 * the window it is about to act on (a block boundary, or "everything after this
 * message") while the rendering, the scope semantics and the three exits stay
 * identical.
 *
 * A worktree is shared, so the scope choice is the important part of this dialog:
 * the narrow scope undoes only this narrator's changes, while the workspace scope
 * also discards whatever other narrators or the user's editor did in the same
 * window. Both file lists come from the server's own comparison, and each scope
 * shows what it cannot cover, so the destructive option is never the silent one.
 */

import type { RevertScope, RevertScopePreviews } from "@frontend/lib/api/narrators";
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
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TruncatedPath } from "../common/TruncatedPath";

export interface RevertScopeConfirmModalProps {
	opened: boolean;
	title: string;
	/** What will be deleted, phrased by the host (blocks, messages, a regenerate). */
	description: string;
	data: RevertScopePreviews | undefined;
	isLoading: boolean;
	/** Disables the exits while the host's request is in flight. */
	submitting?: boolean;
	/** Confirm label when there ARE files to revert. */
	confirmWithRevertLabel: string;
	/** Confirm label when there are none, so it does not promise a rollback. */
	confirmNoFilesLabel: string;
	/** The history-only exit: delete/regenerate but leave the workspace alone. */
	messagesOnlyLabel: string;
	onConfirm: (opts: { skipRevert: boolean; scope?: RevertScope }) => void;
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

export function RevertScopeConfirmModal({
	opened,
	title,
	description,
	data,
	isLoading,
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
	const revertBlocked =
		!opened || isLoading || !(scope === "workspace" ? workspaceUsable : narratorUsable);
	const unavailableKey = !data
		? "revertScopeUnavailable"
		: !hasKnownScope
			? data.scope === undefined
				? "revertScopeLegacyUnverified"
				: "revertScopeUnavailable"
			: ((scope === "workspace" ? workspaceUnavailable : narratorUnavailable) ??
				(revertBlocked && conflicts.length === 0 ? "revertScopeUnavailable" : null));
	const workspaceWarningText = formatRevertWarnings(t, workspaceScope?.warnings);
	const subagentWarningText = narratorScope?.subagentWarning
		? formatRevertWarning(t, {
				code: "SUBAGENT_CHANGES_REVERTED",
				changeCount: narratorScope.subagentWarning.changeCount,
				sampleFilePaths: narratorScope.subagentWarning.sampleFiles,
			})
		: null;

	const showScopeChoice = !!data && hasScopeChoice;

	return (
		<Modal opened={opened} onClose={onCancel} title={title} centered size="md">
			<Stack gap="md">
				{isLoading ? (
					<Center py="md">
						<Loader size="sm" />
					</Center>
				) : (
					<>
						<Text size="sm">{description}</Text>

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
										<Group key={`${file.deviceId}:${file.filePath}`} gap="xs" wrap="nowrap">
											<TruncatedPath path={file.filePath} />
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
							onConfirm({ skipRevert: false, scope });
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
