import {
	Autocomplete,
	Button,
	NumberInput,
	SegmentedControl,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { PathInput } from "../common/PathInput";
import { DependencyStatus } from "./DependencyStatus";

const HOST_PRESETS = ["localhost", "127.0.0.1", "::1", "192.168.0.0", "0.0.0.0"];

export interface ServerSystemSectionProps {
	port: number | undefined;
	setPort: (v: number | undefined) => void;
	host: string;
	setHost: (v: string) => void;
	projectDir: string;
	setProjectDir: (v: string) => void;
	openBrowser: string;
	setOpenBrowser: (v: string) => void;
	pwaUpdating: boolean;
	handlePwaUpdate: () => void;
}

export function ServerSystemSection({
	port,
	setPort,
	host,
	setHost,
	projectDir,
	setProjectDir,
	openBrowser,
	setOpenBrowser,
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
			<Autocomplete
				label={t("serverHost")}
				description={t("serverHostDesc")}
				value={host}
				onChange={setHost}
				data={HOST_PRESETS}
			/>
			<PathInput label={t("defaultProjectDir")} value={projectDir} onChange={setProjectDir} />
			<div>
				<Text size="sm" fw={500} mb={4}>
					{t("openBrowser")}
				</Text>
				<Text size="xs" c="dimmed" mb={6}>
					{t("openBrowserDesc")}
				</Text>
				<SegmentedControl
					value={openBrowser}
					onChange={setOpenBrowser}
					data={[
						{ label: t("openBrowserOff"), value: "off" },
						{ label: t("openBrowserBrowser"), value: "browser" },
						{ label: t("openBrowserApp"), value: "app" },
					]}
				/>
			</div>

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
