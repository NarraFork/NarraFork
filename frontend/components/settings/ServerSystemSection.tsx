import {
	Alert,
	Autocomplete,
	Button,
	Group,
	NumberInput,
	SegmentedControl,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconAlertTriangle, IconRefresh, IconSearch } from "@tabler/icons-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsFeatureCapability } from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import { PathInput } from "../common/PathInput";
import type { UpdateModalData } from "../UpdateModal";
import { DependencyStatus } from "./DependencyStatus";
import { TlsSection } from "./TlsSection";

const HOST_PRESETS = ["localhost", "127.0.0.1", "::1", "192.168.0.0", "0.0.0.0"];

const UpdateModal = lazy(() =>
	import("../UpdateModal").then((m) => ({
		default: m.UpdateModal,
	})),
);

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
	// TLS
	tlsEnabled: boolean;
	setTlsEnabled: (v: boolean) => void;
	tlsCertFile: string;
	setTlsCertFile: (v: string) => void;
	tlsKeyFile: string;
	setTlsKeyFile: (v: string) => void;
	tlsPassphrase: string;
	setTlsPassphrase: (v: string) => void;
	tlsCaFile: string;
	setTlsCaFile: (v: string) => void;
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
	tlsEnabled,
	setTlsEnabled,
	tlsCertFile,
	setTlsCertFile,
	tlsKeyFile,
	setTlsKeyFile,
	tlsPassphrase,
	setTlsPassphrase,
	tlsCaFile,
	setTlsCaFile,
	updateServerUrl,
	setUpdateServerUrl,
	updateChannel,
	setUpdateChannel,
	updateAutoDownload,
	setUpdateAutoDownload,
}: ServerSystemSectionProps) {
	const { t } = useTranslation("settings");
	const settingsFeatureCapability = useSettingsFeatureCapability();
	const tlsGenerationDisabledReason = t("tlsGenerationUnsupported");
	const [checking, setChecking] = useState(false);
	const [checkResult, setCheckResult] = useState<string | null>(null);
	const [updateModalOpened, { open: openUpdateModal, close: closeUpdateModal }] =
		useDisclosure(false);
	const [updateData, setUpdateData] = useState<UpdateModalData>({});

	return (
		<Stack>
			{/* Server */}
			<Title order={5}>{t("serverSubSection")}</Title>
			{settingsFeatureCapability.storagePath && (
				<Alert color="blue" variant="light" py={6} title={t("settingsStoragePathTitle")}>
					{t("settingsStoragePathDesc", { path: settingsFeatureCapability.storagePath })}
				</Alert>
			)}
			{!settingsFeatureCapability.secretMasking && (
				<Alert
					color="red"
					icon={<IconAlertTriangle size={16} />}
					variant="light"
					py={6}
					title={t("settingsSecretMaskingUnsupportedTitle")}
				>
					{t("settingsSecretMaskingUnsupportedDesc")}
				</Alert>
			)}
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

			{/* TLS */}
			<Switch
				label={t("tlsEnabled")}
				description={t("tlsEnabledDesc")}
				checked={tlsEnabled}
				onChange={(e) => setTlsEnabled(e.currentTarget.checked)}
			/>
			{settingsFeatureCapability.tlsGeneration ? (
				<TlsSection
					onCertIssued={(certPath, keyPath) => {
						setTlsCertFile(certPath);
						setTlsKeyFile(keyPath);
						setTlsEnabled(true);
					}}
				/>
			) : (
				<Alert color="yellow" icon={<IconAlertTriangle size={16} />} variant="light" py={6}>
					{tlsGenerationDisabledReason}
				</Alert>
			)}
			{tlsEnabled && (
				<>
					<PathInput
						label={t("tlsCertFile")}
						description={t("tlsCertFileDesc")}
						value={tlsCertFile}
						onChange={setTlsCertFile}
					/>
					<PathInput
						label={t("tlsKeyFile")}
						description={t("tlsKeyFileDesc")}
						value={tlsKeyFile}
						onChange={setTlsKeyFile}
					/>
					<Alert color="yellow" icon={<IconAlertTriangle size={16} />} variant="light" py={6}>
						{t("tlsPassphraseSecurityWarning") ??
							"This value is stored in plain text in settings.json. Use file permissions to restrict access."}
					</Alert>
					<TextInput
						label={t("tlsPassphrase")}
						description={t("tlsPassphraseDesc")}
						value={tlsPassphrase}
						onChange={(e) => setTlsPassphrase(e.currentTarget.value)}
						type="password"
						autoComplete="off"
						placeholder={t("tlsPassphrasePlaceholder")}
					/>
					<PathInput
						label={t("tlsCaFile")}
						description={t("tlsCaFileDesc")}
						value={tlsCaFile}
						onChange={setTlsCaFile}
					/>
				</>
			)}

			{/* Update Server */}
			<Title order={5} mt="sm">
				{t("updateServerSubSection") ?? "Update Server"}
			</Title>
			<TextInput
				label={t("updateServerUrl") ?? "Update Server URL"}
				description={
					t("updateServerUrlDesc") ?? "URL of the update server (e.g., https://updates.example.com)"
				}
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
			<Group gap="sm">
				<Button
					leftSection={<IconSearch size={16} />}
					variant="default"
					loading={checking}
					onClick={async () => {
						setChecking(true);
						setCheckResult(null);
						try {
							const result = await api.checkUpdate();
							if (result.updateAvailable && result.latestVersion) {
								setUpdateData({
									latestVersion: result.latestVersion,
									currentVersion: result.currentVersion,
									releaseInfo: result.releaseInfo,
									releaseNotes: result.releaseInfo?.releaseNotes,
									releaseNotesPerVersion: result.releaseInfo?.releaseNotesPerVersion,
									releaseDate: result.releaseInfo?.releaseDate,
									downloadSize: result.downloadSize,
									totalSize: result.totalSize,
								});
								openUpdateModal();
							} else {
								setCheckResult(t("noUpdateAvailable"));
							}
						} catch {
							setCheckResult(t("updateCheckFailed"));
						} finally {
							setChecking(false);
						}
					}}
				>
					{checking ? t("checkingForUpdate") : t("checkForUpdate")}
				</Button>
				{checkResult && (
					<Text size="sm" c="dimmed">
						{checkResult}
					</Text>
				)}
			</Group>

			<Suspense fallback={null}>
				<UpdateModal opened={updateModalOpened} onClose={closeUpdateModal} data={updateData} />
			</Suspense>

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
