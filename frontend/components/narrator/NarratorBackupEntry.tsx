import { Button, Menu } from "@mantine/core";
import { IconDownload, IconUpload } from "@tabler/icons-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useNarrator } from "../../hooks/useNarrator";
import { canExportPrivateBackup } from "./narrator-backup-policy";

const BackupModal = lazy(() =>
	import("./NarratorBackupModal").then((m) => ({ default: m.NarratorBackupModal })),
);

/** Pinned overflow action; project membership or public read never grants private export. */
export function NarratorBackupEntry({
	narratorId,
	onOpen,
}: {
	narratorId: string;
	onOpen: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { data: actor } = useCurrentUser();
	const { data: narrator } = useNarrator(narratorId);
	if (!canExportPrivateBackup(actor, narrator)) return null;
	return (
		<Menu.Item leftSection={<IconDownload size={14} />} onClick={onOpen}>
			{t("backup.exportTitle")}
		</Menu.Item>
	);
}

/** Available even with no sessions: restoring a deleted conversation needs no project. */
export function NarratorBackupRestoreButton() {
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	const [loaded, setLoaded] = useState(false);
	return (
		<>
			<Button
				variant="default"
				size="xs"
				leftSection={<IconUpload size={14} />}
				onClick={() => {
					setLoaded(true);
					setOpened(true);
				}}
			>
				{t("backup.restoreTitle")}
			</Button>
			{loaded && (
				<Suspense fallback={null}>
					<BackupModal opened={opened} onClose={() => setOpened(false)} />
				</Suspense>
			)}
		</>
	);
}
