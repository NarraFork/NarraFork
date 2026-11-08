/** Rename a folder and choose its icon and colour, in one dialog. */

import type { RecentTab } from "@frontend/hooks/recent-tabs-utils";
import {
	ActionIcon,
	Button,
	ColorSwatch,
	Group,
	Modal,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import {
	RECENT_TAB_FOLDER_COLORS,
	RECENT_TAB_FOLDER_ICONS,
	RECENT_TAB_FOLDER_TITLE_MAX_CHARS,
	type RecentTabFolderColor,
	type RecentTabFolderIcon,
} from "@shared/recent-tabs";
import { IconCheck, IconX } from "@tabler/icons-react";
import { useState } from "react";
import type { RecentTabFolderPatch } from "../../lib/api/settings";
import { FOLDER_ICON_COMPONENTS, folderColorVar } from "./recent-tab-folder-icons";

export interface RecentTabFolderEditModalProps {
	folder: RecentTab | null;
	onClose: () => void;
	onSave: (folderId: string, patch: RecentTabFolderPatch) => Promise<void>;
	t: (key: string, opts?: Record<string, unknown>) => string;
}

export function RecentTabFolderEditModal(props: RecentTabFolderEditModalProps) {
	return (
		<Modal
			opened={!!props.folder}
			onClose={props.onClose}
			title={props.t("editFolder")}
			centered
			size="sm"
		>
			{/* Keyed by folder so the form starts from that folder's values on every open. */}
			{props.folder && <FolderForm key={props.folder.id} {...props} folder={props.folder} />}
		</Modal>
	);
}

function FolderForm({
	folder,
	onClose,
	onSave,
	t,
}: RecentTabFolderEditModalProps & { folder: RecentTab }) {
	const [title, setTitle] = useState(folder.title);
	const [icon, setIcon] = useState<RecentTabFolderIcon | undefined>(folder.folderIcon);
	const [color, setColor] = useState<RecentTabFolderColor | undefined>(folder.folderColor);
	const [saving, setSaving] = useState(false);

	const trimmed = title.trim();
	const submit = async () => {
		if (!trimmed) return;
		const patch: RecentTabFolderPatch = {};
		if (trimmed !== folder.title) patch.title = trimmed;
		if (icon !== folder.folderIcon) patch.icon = icon ?? null;
		if (color !== folder.folderColor) patch.color = color ?? null;
		if (Object.keys(patch).length === 0) {
			onClose();
			return;
		}
		setSaving(true);
		try {
			await onSave(folder.id, patch);
			onClose();
		} catch {
			// The caller already reported the failure; keep the dialog so nothing typed is lost.
		} finally {
			setSaving(false);
		}
	};

	const accent = folderColorVar(color);
	return (
		<Stack gap="md">
			<TextInput
				label={t("folderName")}
				value={title}
				maxLength={RECENT_TAB_FOLDER_TITLE_MAX_CHARS}
				onChange={(e) => setTitle(e.currentTarget.value)}
				onKeyDown={(e) => {
					// Enter while an IME candidate is open commits the word, not the dialog.
					if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit();
				}}
				data-autofocus
			/>
			<Stack gap={6}>
				<Text size="sm" fw={500}>
					{t("folderIcon")}
				</Text>
				<SimpleGrid cols={10} spacing={4} verticalSpacing={4}>
					{RECENT_TAB_FOLDER_ICONS.map((key) => {
						const Icon = FOLDER_ICON_COMPONENTS[key];
						const selected = (icon ?? "folder") === key;
						return (
							<ActionIcon
								key={key}
								variant={selected ? "light" : "subtle"}
								color={selected ? "indigo" : "gray"}
								aria-label={t(`folderIconName_${key}`)}
								aria-pressed={selected}
								onClick={() => setIcon(key === "folder" ? undefined : key)}
							>
								<Icon size={16} color={selected ? accent : undefined} />
							</ActionIcon>
						);
					})}
				</SimpleGrid>
			</Stack>
			<Stack gap={6}>
				<Text size="sm" fw={500}>
					{t("folderColor")}
				</Text>
				<Group gap={6}>
					<Tooltip label={t("folderColorDefault")} withArrow>
						<ActionIcon
							variant={color ? "subtle" : "light"}
							color="gray"
							radius="xl"
							aria-label={t("folderColorDefault")}
							aria-pressed={!color}
							onClick={() => setColor(undefined)}
						>
							<IconX size={14} />
						</ActionIcon>
					</Tooltip>
					{RECENT_TAB_FOLDER_COLORS.map((key) => (
						<ColorSwatch
							key={key}
							component="button"
							type="button"
							color={`var(--mantine-color-${key}-5)`}
							size={24}
							aria-label={t(`folderColorName_${key}`)}
							aria-pressed={color === key}
							onClick={() => setColor(key)}
							style={{ cursor: "pointer", color: "white" }}
						>
							{color === key && <IconCheck size={14} />}
						</ColorSwatch>
					))}
				</Group>
			</Stack>
			<Group justify="flex-end">
				<Button variant="default" onClick={onClose}>
					{t("cancel")}
				</Button>
				<Button loading={saving} disabled={!trimmed} onClick={() => void submit()}>
					{t("save")}
				</Button>
			</Group>
		</Stack>
	);
}
