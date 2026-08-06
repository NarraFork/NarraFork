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
	const [scope, setScope] = useState<RevertScope | null>(null);

	// Follow the server's recommendation once it arrives. Left null until then (and
	// when the server offers no scope at all) so the dialog never preselects a scope
	// the server did not offer.
	useEffect(() => {
		if (data?.scope) setScope(data.scope);
	}, [data?.scope]);

	const narratorScope = data?.narratorScope;
	const workspaceScope = data?.workspaceScope;
	const conflicts = narratorScope?.conflicts ?? [];
	const narratorUsable = !!narratorScope?.available && conflicts.length === 0;
	// A response without scope information comes from the legacy replay preview
	// (pre-snapshot history, a non-git workspace, a remote device). That rollback
	// still works — it just has one behaviour — so its files come from
	// `affectedFiles` and the scope picker stays hidden.
	const hasScopeChoice = !!narratorScope || !!workspaceScope;
	const activeFiles = !hasScopeChoice
		? (data?.affectedFiles ?? [])
		: scope === "workspace"
			? (workspaceScope?.files ?? [])
			: (narratorScope?.files ?? []);
	// Only a scope that exists and cannot run may block the button; the legacy path
	// has no scope to be blocked by.
	const revertBlocked = hasScopeChoice && scope === "narrator" && !narratorUsable;
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
								value={scope ?? "narrator"}
								onChange={(value) => setScope(value as RevertScope)}
								data={[
									{
										value: "narrator",
										label: t("revertScopeNarrator"),
										disabled: !narratorUsable,
									},
									{
										value: "workspace",
										label: t("revertScopeWorkspace"),
										disabled: !workspaceScope?.available,
									},
								]}
							/>
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

						{scope === "workspace" && workspaceWarningText && (
							<Alert color="red" variant="light" title={t("revertScopeWorkspaceWarnTitle")}>
								<Text size="xs">{workspaceWarningText}</Text>
							</Alert>
						)}

						{activeFiles.length > 0 ? (
							<>
								<Text size="sm" fw={500}>
									{t("rollbackConfirmFiles")}
								</Text>
								<Stack gap={4} mah={260} style={{ overflowY: "auto" }}>
									{activeFiles.map((file) => (
										<Group key={file.filePath} gap="xs" wrap="nowrap">
											<TruncatedPath path={file.filePath} />
											<Badge
												size="xs"
												variant="light"
												color={file.willBeDeleted ? "red" : "orange"}
											>
												{file.willBeDeleted
													? t("fileMod_willBeDeleted")
													: t("fileMod_willBeReverted")}
											</Badge>
										</Group>
									))}
								</Stack>
							</>
						) : (
							<Text size="sm" c="dimmed">
								{conflicts.length > 0
									? t("revertScopeBlocked")
									: scope === "narrator" && narratorScope?.reason === "nothing_owned"
										? // Says why the list is empty. A shared worktree makes "no files"
											// ambiguous — the user can see other narrators editing the same
											// directory — so state that this narrator's own set is empty.
											t("revertScopeNothingOwned")
										: t("rollbackConfirmNoFiles")}
							</Text>
						)}
					</>
				)}
				<Group gap="xs" justify="flex-end">
					<Button size="xs" variant="subtle" onClick={onCancel} disabled={submitting}>
						{t("cancel")}
					</Button>
					<Button
						size="xs"
						variant="default"
						onClick={() => onConfirm({ skipRevert: true })}
						loading={isLoading || submitting}
						disabled={submitting}
					>
						{messagesOnlyLabel}
					</Button>
					<Button
						size="xs"
						color="red"
						disabled={revertBlocked || submitting}
						onClick={() => onConfirm({ skipRevert: false, ...(scope ? { scope } : {}) })}
						loading={isLoading || submitting}
					>
						{activeFiles.length > 0 ? confirmWithRevertLabel : confirmNoFilesLabel}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
