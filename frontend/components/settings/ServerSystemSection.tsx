import {
	Autocomplete,
	Button,
	NumberInput,
	SegmentedControl,
	Stack,
	Switch,
	Text,
	TextInput,
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
	// Update server
	updateServerUrl: string;
	setUpdateServerUrl: (v: string) => void;
	updateChannel: "stable" | "beta";
	setUpdateChannel: (v: "stable" | "beta") => void;
	updateAutoDownload: boolean;
	setUpdateAutoDownload: (v: boolean) => void;
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
	updateServerUrl,
	setUpdateServerUrl,
	updateChannel,
	setUpdateChannel,
	updateAutoDownload,
	setUpdateAutoDownload,
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

			{/* Update Server */}
			<Title order={5} mt="sm">
				{t("updateServerSubSection") ?? "Update Server"}
			</Title>
			<TextInput
				label={t("updateServerUrl") ?? "Update Server URL"}
				description={t("updateServerUrlDesc") ?? "URL of the update server (e.g., https://updates.example.com)"}
				placeholder="https://updates.example.com"
				value={updateServerUrl}
				onChange={(e) => setUpdateServerUrl(e.currentTarget.value)}
			/>
			<div>
				<Text size="sm" fw={500} mb={4}>
					{t("updateChannel") ?? "Update Channel"}
				</Text>
				<SegmentedControl
					value={updateChannel}
					onChange={(v) => setUpdateChannel(v as "stable" | "beta")}
					data={[
						{ label: t("updateChannelStable") ?? "Stable", value: "stable" },
						{ label: t("updateChannelBeta") ?? "Beta", value: "beta" },
					]}
				/>
			</div>
			<Switch
				label={t("updateAutoDownload") ?? "Auto-download updates"}
				description={t("updateAutoDownloadDesc") ?? "Automatically download updates when available"}
				checked={updateAutoDownload}
				onChange={(e) => setUpdateAutoDownload(e.currentTarget.checked)}
			/>

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
