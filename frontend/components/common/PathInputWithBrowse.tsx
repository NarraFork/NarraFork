import { ActionIcon, Group, Modal } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { IconFolderOpen } from "@tabler/icons-react";
import { lazy, Suspense, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Z } from "../../lib/z-index";
import { DIRECTORY_BROWSER_MODAL_STYLES } from "./directory-browser-modal";
import { PathInput } from "./PathInput";

const DirectoryBrowser = lazy(() =>
	import("./DirectoryPicker").then((m) => ({ default: m.DirectoryBrowser })),
);

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
	const isWide = useMediaQuery("(min-width: 62em)") ?? false;

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
				size={isWide ? 880 : "md"}
				zIndex={Z.modal}
				styles={DIRECTORY_BROWSER_MODAL_STYLES}
			>
				{opened && (
					<Suspense fallback={null}>
						<DirectoryBrowser onSelect={handleSelect} onCancel={close} isWide={isWide} />
					</Suspense>
				)}
			</Modal>
		</>
	);
}
