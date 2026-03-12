import {
	Alert,
	Badge,
	Button,
	Code,
	CopyButton,
	Group,
	Modal,
	Progress,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconCheck,
	IconCopy,
	IconDownload,
	IconRefresh,
	IconRocket,
	IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
	useUpdateCheck,
	useUpdateDownload,
	useUpdateRestart,
	useUpdateVersion,
} from "../hooks/useUpdateCheck";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateAvailableBanner() {
	const { t } = useTranslation("common");
	const [opened, { open, close }] = useDisclosure(false);
	const {
		updateAvailable,
		latestVersion,
		releaseInfo,
		downloadSize,
		totalSize,
		diffBlocks,
		totalBlocks,
		dismiss,
	} = useUpdateCheck();

	const { download, cancel, reset, progress, result, isDownloading } = useUpdateDownload();
	const { data: versionInfo } = useUpdateVersion();
	const { restart, isRestarting } = useUpdateRestart();

	if (!updateAvailable) return null;

	const canHotRestart = versionInfo?.canHotRestart ?? false;

	const handleDownload = () => {
		if (releaseInfo) {
			open();
			download(releaseInfo);
		}
	};

	const handleRestart = async () => {
		// Clear PWA cache before restart to ensure fresh assets after update
		const { clearPwaCache } = await import("@frontend/lib/pwa");
		await clearPwaCache();

		const result = await restart();
		if (!result.success) {
			// Show error - the manual instructions will be displayed
		}
	};

	const handleClose = () => {
		if (isDownloading) {
			cancel();
		}
		reset();
		close();
	};

	const savingsPercent =
		downloadSize && totalSize ? Math.round((1 - downloadSize / totalSize) * 100) : 0;

	return (
		<>
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
					zIndex: 1000,
					maxWidth: 600,
					width: "calc(100% - 32px)",
					borderRadius: "var(--mantine-radius-sm)",
				}}
			>
				<Group justify="space-between" wrap="nowrap" gap="md">
					<Group gap="xs" wrap="nowrap">
						<IconRocket size={18} />
						<Text size="sm">{t("updateAvailable", { version: latestVersion })}</Text>
						{savingsPercent > 0 && (
							<Tooltip
								label={t("updateDeltaInfo", {
									diffBlocks,
									totalBlocks,
									downloadSize: formatBytes(downloadSize ?? 0),
									totalSize: formatBytes(totalSize ?? 0),
								})}
							>
								<Badge size="xs" variant="light" color="green">
									{t("updateSavings", { percent: savingsPercent })}
								</Badge>
							</Tooltip>
						)}
					</Group>
					<Button
						size="xs"
						variant="light"
						leftSection={<IconDownload size={14} />}
						onClick={handleDownload}
						loading={isDownloading}
					>
						{t("download")}
					</Button>
				</Group>
			</Alert>

			<Modal
				opened={opened}
				onClose={handleClose}
				title={t("updateDownloadTitle")}
				size="md"
				centered
			>
				<Stack gap="md">
					{progress && (
						<>
							<Text size="sm" c="dimmed">
								{progress.phase === "checking" && t("updatePhaseChecking")}
								{progress.phase === "downloading" && t("updatePhaseDownloading")}
								{progress.phase === "applying" && t("updatePhaseApplying")}
								{progress.phase === "complete" && t("updatePhaseComplete")}
								{progress.phase === "error" && t("updatePhaseError")}
							</Text>

							{progress.phase === "downloading" && (
								<>
									<Progress value={progress.percent} size="lg" animated />
									<Text size="xs" c="dimmed" ta="center">
										{formatBytes(progress.bytesDownloaded)} / {formatBytes(progress.totalBytes)}
									</Text>
								</>
							)}

							{progress.phase === "error" && (
								<Alert color="red" variant="light">
									{progress.error}
								</Alert>
							)}
						</>
					)}

					{result?.success && result.instructions && (
						<Stack gap="sm">
							<Alert color="green" variant="light" icon={<IconCheck size={16} />}>
								{t("updateDownloadComplete")}
							</Alert>

							{canHotRestart ? (
								<>
									<Text size="sm">{t("updateReadyToApply")}</Text>
									<Button
										fullWidth
										color="indigo"
										leftSection={<IconRefresh size={16} />}
										onClick={handleRestart}
										loading={isRestarting}
									>
										{t("updateApplyNow")}
									</Button>
								</>
							) : (
								<>
									<Text size="sm">{t("updateApplyInstructions")}</Text>

									{result.instructions.command && (
										<Group gap="xs" align="flex-start">
											<Code block style={{ flex: 1, fontSize: "0.75rem", whiteSpace: "pre-wrap" }}>
												{result.instructions.command}
											</Code>
											<CopyButton value={result.instructions.command}>
												{({ copied, copy }) => (
													<Tooltip label={copied ? t("copied") : t("copy")}>
														<Button
															size="xs"
															variant="subtle"
															color={copied ? "green" : "gray"}
															onClick={copy}
														>
															{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
														</Button>
													</Tooltip>
												)}
											</CopyButton>
										</Group>
									)}
								</>
							)}
						</Stack>
					)}

					<Group justify="flex-end" gap="sm">
						{isDownloading ? (
							<Button
								variant="subtle"
								color="red"
								onClick={cancel}
								leftSection={<IconX size={14} />}
							>
								{t("cancel")}
							</Button>
						) : (
							<Button variant="subtle" onClick={handleClose}>
								{t("close")}
							</Button>
						)}
					</Group>
				</Stack>
			</Modal>
		</>
	);
}
