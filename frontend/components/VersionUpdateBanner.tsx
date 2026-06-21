import { Alert, Button, Group, Text } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useVersionCheck } from "../hooks/useVersionCheck";
import { Z } from "../lib/z-index";

export function VersionUpdateBanner() {
	const { t } = useTranslation("common");
	const { updateAvailable, serverVersion, refresh, dismiss } = useVersionCheck();

	if (!updateAvailable) return null;

	return (
		<Alert
			color="indigo"
			variant="light"
			withCloseButton
			onClose={dismiss}
			style={{
				position: "fixed",
				top: 8,
				left: "50%",
				transform: "translateX(-50%)",
				zIndex: Z.toast,
				maxWidth: 500,
				width: "calc(100% - 32px)",
				borderRadius: "var(--mantine-radius-sm)",
			}}
		>
			<Group justify="space-between" wrap="nowrap">
				<Text size="sm">{t("versionUpdate", { version: serverVersion })}</Text>
				<Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={refresh}>
					{t("refresh")}
				</Button>
			</Group>
		</Alert>
	);
}
