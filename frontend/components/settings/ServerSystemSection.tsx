import { Button, NumberInput, Stack, Text, Title } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { PathInput } from "../common/PathInput";
import { DependencyStatus } from "./DependencyStatus";

export interface ServerSystemSectionProps {
	port: number | undefined;
	setPort: (v: number | undefined) => void;
	projectDir: string;
	setProjectDir: (v: string) => void;
	pwaUpdating: boolean;
	handlePwaUpdate: () => void;
}

export function ServerSystemSection({
	port,
	setPort,
	projectDir,
	setProjectDir,
	pwaUpdating,
	handlePwaUpdate,
}: ServerSystemSectionProps) {
	const { t } = useTranslation("settings");

	return (
		<Stack>
			{/* Server */}
			<Title order={5}>{t("serverSubSection")}</Title>
			<NumberInput
				label={t("serverPort")}
				value={port}
				onChange={(v) => setPort(typeof v === "number" ? v : 7778)}
				min={1024}
				max={65535}
			/>
			<PathInput label={t("defaultProjectDir")} value={projectDir} onChange={setProjectDir} />

			{/* System Dependencies */}
			<Title order={5} mt="sm">
				{t("depsSubSection")}
			</Title>
			<DependencyStatus />

			{/* PWA Update */}
			<Title order={5} mt="sm">
				{t("pwaSubSection")}
			</Title>
			<Text size="sm" c="dimmed">
				{t("pwaForceUpdateDesc")}
			</Text>
			<Button
				leftSection={<IconRefresh size={16} />}
				variant="default"
				loading={pwaUpdating}
				onClick={handlePwaUpdate}
			>
				{pwaUpdating ? t("pwaUpdating") : t("pwaForceUpdate")}
			</Button>
		</Stack>
	);
}
