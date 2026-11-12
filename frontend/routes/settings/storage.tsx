import { Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { BlockBackfillCard } from "../../components/settings/BlockBackfillCard";
import { CredentialTransferCard } from "../../components/settings/CredentialTransferCard";
import { DataPortabilityCard } from "../../components/settings/DataPortabilityCard";
import { StorageRetentionSection } from "../../components/settings/StorageRetentionSection";
import { StorageSection } from "../../components/settings/StorageSection";

export const Route = createFileRoute("/settings/storage")({
	component: SettingsStoragePage,
});

function SettingsStoragePage() {
	const { t } = useTranslation("settings");
	const [refreshToken, setRefreshToken] = useState(0);
	const refreshStorage = useCallback(() => setRefreshToken((value) => value + 1), []);

	return (
		<Stack>
			<Title order={3}>{t("storageSection")}</Title>
			<StorageRetentionSection onSettled={refreshStorage} />
			<BlockBackfillCard />
			<StorageSection refreshToken={refreshToken} />
			<DataPortabilityCard />
			<CredentialTransferCard />
		</Stack>
	);
}
