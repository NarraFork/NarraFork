import {
	Alert,
	Badge,
	Button,
	Code,
	CopyButton,
	Divider,
	Group,
	Modal,
	Progress,
	ScrollArea,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconCheck,
	IconCopy,
	IconDownload,
	IconInfoCircle,
	IconRefresh,
	IconRocket,
	IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useUpdateApply, useUpdateCheck, useUpdateDownload } from "../hooks/useUpdateCheck";

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
		releaseNotes,
		releaseDate,
		downloadSize,
		totalSize,
		diffBlocks,
		totalBlocks,
		dismiss,
	} = useUpdateCheck();

	const { download, cancel, reset, progress, result, isDownloading } = useUpdateDownload();
	const { apply, isApplying } = useUpdateApply();

	if (!updateAvailable) return null;

	const handleDownload = () => {
		if (releaseInfo) {
			download(releaseInfo);
		}
	};

	const handleApply = async () => {
		const { clearPwaCache } = await import("@frontend/lib/pwa");
		await clearPwaCache();
		await apply();
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

	const canAutoRestart = result?.success && result.instructions && !result.instructions.manual;

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
						leftSection={<IconInfoCircle size={14} />}
						onClick={open}
					>
						{t("updateViewDetails")}
					</Button>
				</Group>
			</Alert>

			<Modal
				opened={opened}
				onClose={handleClose}
				title={t("updateDownloadTitle", { version: latestVersion })}
				size="lg"
				centered
			>
				<Stack gap="md">
					{/* Release info */}
					{releaseDate && (
						<Text size="xs" c="dimmed">
							{new Date(releaseDate).toLocaleDateString(undefined, {
								year: "numeric",
								month: "long",
								day: "numeric",
							})}
						</Text>
					)}

					{/* Release notes */}
					<div>
						<Text size="sm" fw={500} mb={4}>
							{t("updateReleaseNotes")}
						</Text>
						<ScrollArea.Autosize mah={300}>
							{releaseNotes ? (
								<Text size="sm" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
									{releaseNotes}
								</Text>
							) : (
								<Text size="sm" c="dimmed" fs="italic">
									{t("updateNoNotes")}
								</Text>
							)}
						</ScrollArea.Autosize>
					</div>

					{/* Download size info */}
					{savingsPercent > 0 && !result?.success && (
						<Text size="xs" c="dimmed">
							{t("updateDeltaInfo", {
								diffBlocks,
								totalBlocks,
								downloadSize: formatBytes(downloadSize ?? 0),
								totalSize: formatBytes(totalSize ?? 0),
							})}
						</Text>
					)}

					<Divider />

					{/* Download / progress / apply section */}
					{!progress && !result && (
						<Button fullWidth leftSection={<IconDownload size={16} />} onClick={handleDownload}>
							{t("download")} ({formatBytes(downloadSize ?? totalSize ?? 0)})
						</Button>
					)}

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

							{canAutoRestart ? (
								<>
									<Text size="sm">{t("updateReadyToApply")}</Text>
									<Button
										fullWidth
										color="indigo"
										leftSection={<IconRefresh size={16} />}
										onClick={handleApply}
										loading={isApplying}
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
