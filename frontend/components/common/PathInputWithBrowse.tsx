import { ActionIcon, Group, Modal } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconFolderOpen } from "@tabler/icons-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { DirectoryBrowser } from "./DirectoryPicker";
import { PathInput } from "./PathInput";

interface PathInputWithBrowseProps {
	placeholder?: string;
	onConfirm: (path: string) => void;
}

/**
 * PathInput with a browse button that opens the DirectoryBrowser modal.
 * Used in places like PathRulesPopover where we need uncontrolled PathInput + browse capability.
 */
export function PathInputWithBrowse({ placeholder, onConfirm }: PathInputWithBrowseProps) {
	const { t } = useTranslation("common");
	const [opened, { open, close }] = useDisclosure(false);

	const handleSelect = useCallback(
		(path: string) => {
			onConfirm(path);
			close();
		},
		[onConfirm, close],
	);

	return (
		<>
			<Group gap={4} wrap="nowrap">
				<PathInput placeholder={placeholder} onConfirm={onConfirm} />
				<ActionIcon variant="subtle" size="sm" onClick={open} aria-label={t("browse")}>
					<IconFolderOpen size={16} />
				</ActionIcon>
			</Group>
			<Modal
				opened={opened}
				onClose={close}
				title={t("selectDirectory")}
				size="lg"
				styles={{ body: { padding: 0 } }}
			>
				<DirectoryBrowser onSelect={handleSelect} onCancel={close} />
			</Modal>
		</>
	);
}
