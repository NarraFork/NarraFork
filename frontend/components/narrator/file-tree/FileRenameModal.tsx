/**
 * FileRenameModal.tsx — rename one file-tree entry.
 *
 * A dialog rather than an inline editor in the row: the row is re-rendered from the store
 * whenever the watcher patches the listing, so an input living there can be replaced
 * mid-edit by an unrelated change elsewhere in the directory. A dialog keeps what the user
 * typed, and it is the pattern the rest of the app renames with
 * (`RecentTabFolderEditModal`).
 *
 * The submitted value is a NAME. The server takes the parent directory from the path it is
 * given, so this dialog cannot turn a rename into a move even if the input contains a
 * separator — which is refused here as well, before the request.
 */

import { api } from "@frontend/lib/api";
import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { apiFailureStatus } from "./FileContextMenu";
import { type FileMenuTarget, fileMenuRelativeDirectory } from "./file-menu-target";

export interface FileRenameModalProps {
	/** The entry being renamed, or null when the dialog is closed. */
	target: FileMenuTarget | null;
	narratorId: string;
	onClose: () => void;
	/** Called after a successful rename with the directory that must be re-read. */
	onRenamed: (relativeDirectory: string) => void;
}

/** The same characters the server's validator refuses, mirrored so the user sees it first. */
const INVALID_NAME = /[/\\<>:"|?*]/;

export function FileRenameModal({ target, narratorId, onClose, onRenamed }: FileRenameModalProps) {
	// Nothing to rename: mount no dialog at all, rather than a closed one whose form would
	// still have to be keyed against a target that does not exist.
	if (!target) return null;
	return (
		<Modal opened onClose={onClose} title={null} centered size="sm" withCloseButton={false}>
			{/* Keyed by path so the form starts from that entry's name on every open. */}
			<RenameForm
				key={target.absolutePath}
				target={target}
				narratorId={narratorId}
				onClose={onClose}
				onRenamed={onRenamed}
			/>
		</Modal>
	);
}

function RenameForm({
	target,
	narratorId,
	onClose,
	onRenamed,
}: {
	target: FileMenuTarget;
	narratorId: string;
	onClose: () => void;
	onRenamed: (relativeDirectory: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const [name, setName] = useState(target.name);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const trimmed = name.trim();
	const unchanged = trimmed === target.name;
	const invalid = !trimmed || INVALID_NAME.test(trimmed) || trimmed === "." || trimmed === "..";

	const submit = async () => {
		// An unchanged name is a no-op, not an error: just close.
		if (unchanged) {
			onClose();
			return;
		}
		if (invalid) return;
		setSaving(true);
		setError(null);
		try {
			await api.fsRename({ narratorId, path: target.absolutePath, name: trimmed });
			onRenamed(fileMenuRelativeDirectory(target.relativePath));
			onClose();
		} catch (caught) {
			// Keep the dialog open so nothing typed is lost; say what the server refused.
			setError(
				apiFailureStatus(caught) === 409
					? t("fileTree.renameExists", { name: trimmed })
					: caught instanceof Error
						? caught.message
						: String(caught),
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Stack gap="md">
			<Text size="sm" fw={500}>
				{t("fileTree.renameTitle", { name: target.name })}
			</Text>
			<TextInput
				label={t("fileTree.renameLabel")}
				value={name}
				maxLength={255}
				error={invalid && trimmed.length > 0 ? t("fileTree.renameInvalid") : undefined}
				onChange={(event) => setName(event.currentTarget.value)}
				onKeyDown={(event) => {
					// Enter while an IME candidate is open commits the word, not the dialog.
					if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit();
				}}
				data-autofocus
				data-file-rename-input
			/>
			{error && (
				<Text size="sm" c="red">
					{error}
				</Text>
			)}
			<Group justify="flex-end">
				<Button variant="default" onClick={onClose}>
					{t("common:cancel")}
				</Button>
				<Button loading={saving} disabled={invalid} onClick={() => void submit()}>
					{t("common:save")}
				</Button>
			</Group>
		</Stack>
	);
}
