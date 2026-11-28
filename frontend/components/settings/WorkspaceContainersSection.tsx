import { Alert, Button, Group, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useContainersCapability } from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import { PodmanInstallModal } from "../container/PodmanInstallModal";

export function WorkspaceContainersSection() {
	const { t } = useTranslation("settings");
	const containersCapability = useContainersCapability();
	const [podmanOpen, setPodmanOpen] = useState(false);
	const { data: podman } = useQuery({
		queryKey: ["podmanStatus"],
		queryFn: api.getPodmanStatus,
		enabled: containersCapability.supported,
	});

	return (
		<Stack>
			<Title order={5}>{t("containersSubSection")}</Title>
			<Text size="sm" c="dimmed">
				{t("containersDesc")}
			</Text>
			{containersCapability.supported ? (
				<Group gap="sm">
					<Text size="sm">
						{podman?.installed
							? t("podmanInstalled", { version: podman.version ?? "" })
							: t("podmanNotInstalled")}
					</Text>
					<Button size="xs" variant="light" onClick={() => setPodmanOpen(true)}>
						{t("podmanManage")}
					</Button>
				</Group>
			) : (
				<Alert color="yellow" variant="light" title={t("containersUnsupportedTitle")}>
					{containersCapability.reason || t("containersUnsupported")}
				</Alert>
			)}
			<PodmanInstallModal opened={podmanOpen} onClose={() => setPodmanOpen(false)} />
		</Stack>
	);
}
