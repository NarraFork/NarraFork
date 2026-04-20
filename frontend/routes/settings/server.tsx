import { Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ServerSystemSection } from "../../components/settings/ServerSystemSection";
import { useInstanceSettingsContext } from "../../hooks/useInstanceSettings";

export const Route = createFileRoute("/settings/server")({
	component: SettingsServerPage,
});

function SettingsServerPage() {
	const { t } = useTranslation("settings");
	const is = useInstanceSettingsContext();
	const [pwaUpdating, setPwaUpdating] = useState(false);

	const handlePwaUpdate = async () => {
		setPwaUpdating(true);
		const { clearPwaCacheAndReload } = await import("@frontend/lib/pwa");
		await clearPwaCacheAndReload();
	};

	return (
		<Stack>
			<Title order={3}>{t("serverAndSystemSection")}</Title>
			<ServerSystemSection
				port={is.port}
				setPort={is.setPort}
				host={is.host}
				setHost={is.setHost}
				projectDir={is.projectDir}
				setProjectDir={is.setProjectDir}
				openBrowser={is.openBrowser}
				setOpenBrowser={is.setOpenBrowser}
				pwaUpdating={pwaUpdating}
				handlePwaUpdate={handlePwaUpdate}
				tlsEnabled={is.tlsEnabled}
				setTlsEnabled={is.setTlsEnabled}
				tlsCertFile={is.tlsCertFile}
				setTlsCertFile={is.setTlsCertFile}
				tlsKeyFile={is.tlsKeyFile}
				setTlsKeyFile={is.setTlsKeyFile}
				tlsPassphrase={is.tlsPassphrase}
				setTlsPassphrase={is.setTlsPassphrase}
				tlsCaFile={is.tlsCaFile}
				setTlsCaFile={is.setTlsCaFile}
				updateServerUrl={is.updateServerUrl}
				setUpdateServerUrl={is.setUpdateServerUrl}
				updateChannel={is.updateChannel}
				setUpdateChannel={is.setUpdateChannel}
				updateAutoDownload={is.updateAutoDownload}
				setUpdateAutoDownload={is.setUpdateAutoDownload}
			/>
		</Stack>
	);
}
