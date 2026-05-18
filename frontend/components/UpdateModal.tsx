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
import {
	IconAlertTriangle,
	IconCheck,
	IconCopy,
	IconDownload,
	IconPower,
	IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useUpdateCapability } from "../hooks/usePlatform";
import {
	type UpdateDownloadResult,
	useUpdateApply,
	useUpdateDownload,
} from "../hooks/useUpdateCheck";
import { api } from "../lib/api";
import { MarkdownContent } from "./narrator/MarkdownContent";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Resolve localized release notes — supports plain string or { "en": "...", "zh-CN": "..." } */
function resolveNotes(
	notes: string | Record<string, string> | undefined,
	lang: string,
): string | undefined {
	if (!notes) return undefined;
	if (typeof notes === "string") return notes;
	return notes[lang] ?? notes.en ?? Object.values(notes)[0];
}

export interface UpdateModalData {
	latestVersion?: string;
	currentVersion?: string;
	releaseInfo?: {
		version: string;
		releaseDate: string;
		releaseNotes?: string | Record<string, string>;
		path: string;
		sha512: string;
		files: Array<{ url: string; size: number; sha512: string }>;
		releaseNotesPerVersion?: Array<{
			version: string;
			releaseDate: string;
			releaseNotes?: string | Record<string, string>;
		}>;
	};
	releaseNotes?: string | Record<string, string>;
	releaseNotesPerVersion?: Array<{
		version: string;
		releaseDate: string;
		releaseNotes?: string | Record<string, string>;
	}>;
	releaseDate?: string;
	downloadSize?: number;
	totalSize?: number;
}

export interface UpdateModalProps {
	opened: boolean;
	onClose: () => void;
	data: UpdateModalData;
}

export function UpdateModal({ opened, onClose, data }: UpdateModalProps) {
	const { t, i18n } = useTranslation("common");
	const { download, cancel, reset, progress, result, isDownloading } = useUpdateDownload();
	const { apply, isApplying, applyResult } = useUpdateApply();
	const updateCapability = useUpdateCapability();
	const autoApplyAvailable =
		updateCapability.selfUpdateAvailable &&
		!updateCapability.manualOnly &&
		updateCapability.canAutoRestart;

	const {
		latestVersion,
		releaseInfo,
		releaseNotes,
		releaseNotesPerVersion,
		releaseDate,
		downloadSize,
		totalSize,
	} = data;
	const targetVersion = releaseInfo?.version ?? latestVersion;

	const { data: preparedStatus, isLoading: isCheckingPreparedStatus } = useQuery({
		queryKey: ["update-status", targetVersion],
		queryFn: () => api.getUpdateStatus(targetVersion),
		enabled: opened && !!targetVersion,
		staleTime: 0,
	});

	const handleDownload = () => {
		if (releaseInfo) {
			download(releaseInfo);
		}
	};

	const handleApply = async () => {
		const { clearPwaCache, waitForUpdatedServerAndReload } = await import("@frontend/lib/pwa");
		const applyResponse = await apply(targetVersion);
		if (!applyResponse.success) return;
		if ("restarting" in applyResponse && applyResponse.restarting) {
			void waitForUpdatedServerAndReload({
				targetVersion,
				requestTimeoutMs: 3000,
			});
			return;
		}
		await clearPwaCache();
	};

	const handleClose = () => {
		onClose();
	};

	const handleCancel = () => {
		cancel();
		reset();
	};

	const savingsPercent =
		downloadSize && totalSize ? Math.round((1 - downloadSize / totalSize) * 100) : 0;
	const preparedStatusMatches =
		preparedStatus?.ready && !!targetVersion && preparedStatus.version === targetVersion;
	const restoredResult: UpdateDownloadResult | null = preparedStatusMatches
		? {
				success: true,
				version: preparedStatus.version,
				updatePath: preparedStatus.updatePath ?? preparedStatus.newBinaryPath,
				newBinaryPath: preparedStatus.newBinaryPath,
				placed: preparedStatus.placed,
				instructions: {
					manual: !preparedStatus.placed,
					newBinaryPath: preparedStatus.newBinaryPath,
					command: preparedStatus.newBinaryPath ? `"${preparedStatus.newBinaryPath}"` : undefined,
					message: preparedStatus.placed
						? t("updatePreparedDescription")
						: t("updateCachedDescription"),
				},
			}
		: null;
	const effectiveResult = result ?? restoredResult;

	const preparedBinaryPath =
		effectiveResult?.instructions?.newBinaryPath ??
		effectiveResult?.newBinaryPath ??
		effectiveResult?.updatePath;
	const preparedCommand =
		effectiveResult?.instructions?.command ??
		(preparedBinaryPath ? `"${preparedBinaryPath}"` : undefined);
	const canRestartIntoUpdate =
		autoApplyAvailable &&
		effectiveResult?.success &&
		effectiveResult.instructions &&
		!effectiveResult.instructions.manual;
	const preparedDescription = effectiveResult?.placed
		? t("updatePreparedDescription")
		: t("updateCachedDescription");
	const shouldShowPreparedDescription = !canRestartIntoUpdate || !preparedBinaryPath;
	const restartStarted = applyResult?.success && applyResult.restarting;
	const serverStopped = applyResult?.success && !applyResult.restarting;
	const rawDownloadError = result && !result.success ? result.error : null;
	const isZstdMissing = rawDownloadError === "ZSTD_CLI_MISSING";
	const downloadError = isZstdMissing ? null : rawDownloadError;
	const applyError = applyResult && !applyResult.success ? applyResult.error : null;

	return (
		<Modal
			opened={opened}
			onClose={handleClose}
			title={t("updateDownloadTitle", { version: latestVersion })}
			size="lg"
			centered
		>
			<Stack gap="md">
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
						{releaseNotesPerVersion && releaseNotesPerVersion.length > 1 ? (
							<Stack gap="md">
								{releaseNotesPerVersion.map(
									(v: {
										version: string;
										releaseDate: string;
										releaseNotes?: string | Record<string, string>;
									}) => {
										const notes = resolveNotes(v.releaseNotes, i18n.language);
										return (
											<div key={v.version}>
												<Group gap="xs" mb={4}>
													<Badge size="xs" variant="light">
														v{v.version}
													</Badge>
													<Text size="xs" c="dimmed">
														{new Date(v.releaseDate).toLocaleDateString(undefined, {
															year: "numeric",
															month: "short",
															day: "numeric",
														})}
													</Text>
												</Group>
												{notes ? (
													<MarkdownContent text={notes} />
												) : (
													<Text size="sm" c="dimmed" fs="italic">
														{t("updateNoNotes")}
													</Text>
												)}
											</div>
										);
									},
								)}
							</Stack>
						) : (
							(() => {
								const notes = resolveNotes(releaseNotes, i18n.language);
								return notes ? (
									<MarkdownContent text={notes} />
								) : (
									<Text size="sm" c="dimmed" fs="italic">
										{t("updateNoNotes")}
									</Text>
								);
							})()
						)}
					</ScrollArea.Autosize>
				</div>

				{savingsPercent > 0 && !effectiveResult?.success && (
					<Text size="xs" c="dimmed">
						{t("updatePatchInfo", {
							downloadSize: formatBytes(downloadSize ?? 0),
							totalSize: formatBytes(totalSize ?? 0),
						})}
					</Text>
				)}

				<Divider />

				{/* Download button */}
				{!progress && !effectiveResult && (
					<Button
						fullWidth
						leftSection={<IconDownload size={16} />}
						onClick={handleDownload}
						loading={isCheckingPreparedStatus}
					>
						{t("download")} ({formatBytes(downloadSize ?? totalSize ?? 0)})
					</Button>
				)}

				{/* Download progress */}
				{progress && !effectiveResult && (
					<>
						<Text size="sm" c="dimmed">
							{progress.phase === "checking" && t("updatePhaseChecking")}
							{progress.phase === "downloading" && t("updatePhaseDownloading")}
							{progress.phase === "applying" && t("updatePhaseApplying")}
							{progress.phase === "complete" && t("updatePhaseComplete")}
							{progress.phase === "error" && t("updatePhaseError")}
						</Text>

						{(progress.phase === "downloading" || progress.phase === "applying") && (
							<>
								<Progress value={progress.percent} size="lg" animated />
								<Text size="xs" c="dimmed" ta="center">
									{formatBytes(progress.bytesDownloaded)} / {formatBytes(progress.totalBytes)}
								</Text>
							</>
						)}
					</>
				)}

				{/* Download error */}
				{downloadError && (
					<Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
						<Text size="sm">{downloadError}</Text>
					</Alert>
				)}

				{/* Zstd CLI missing — actionable hint */}
				{isZstdMissing && (
					<Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
						<Text size="sm" fw={500} mb={4}>
							{t("updateZstdMissingTitle")}
						</Text>
						<Text size="sm">{t("updateZstdMissingDesc")}</Text>
						<Code block mt={8} style={{ fontSize: "0.75rem" }}>
							{t("updateZstdInstallCmd")}
						</Code>
						<Button
							variant="light"
							color="orange"
							size="xs"
							mt={8}
							onClick={() => {
								reset();
								if (releaseInfo) download(releaseInfo);
							}}
						>
							{t("retry")}
						</Button>
					</Alert>
				)}

				{/* Download complete — binary is already prepared */}
				{effectiveResult?.success && (
					<Stack gap="sm">
						<Alert color="green" variant="light" icon={<IconCheck size={16} />}>
							{t("updateDownloadComplete")}
						</Alert>

						{!autoApplyAvailable && (
							<Alert color="blue" variant="light" icon={<IconAlertTriangle size={16} />}>
								<Text size="sm">{t("updateManualOnlyNotice")}</Text>
							</Alert>
						)}

						{shouldShowPreparedDescription && (
							<Text size="sm">
								{preparedBinaryPath ? preparedDescription : t("updateApplyInstructions")}
							</Text>
						)}

						{preparedBinaryPath && (
							<Group gap="xs" align="flex-start">
								<Code block style={{ flex: 1, fontSize: "0.75rem", whiteSpace: "pre-wrap" }}>
									{preparedBinaryPath}
								</Code>
								<CopyButton value={preparedBinaryPath}>
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

						{preparedCommand && preparedCommand !== preparedBinaryPath && (
							<Group gap="xs" align="flex-start">
								<Code block style={{ flex: 1, fontSize: "0.75rem", whiteSpace: "pre-wrap" }}>
									{preparedCommand}
								</Code>
								<CopyButton value={preparedCommand}>
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

						{canRestartIntoUpdate && !applyResult?.success && (
							<>
								<Text size="sm">{t("updateApplyDescription")}</Text>
								<Button
									fullWidth
									color="red"
									variant="light"
									leftSection={<IconPower size={16} />}
									onClick={handleApply}
									loading={isApplying}
								>
									{t("updateStopAndApply")}
								</Button>
							</>
						)}
					</Stack>
				)}

				{applyError && (
					<Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
						<Text size="sm">{applyError}</Text>
					</Alert>
				)}

				{restartStarted && (
					<Stack gap="sm">
						<Alert color="blue" variant="light" icon={<IconPower size={16} />}>
							{t("updateRestarting")}
						</Alert>
						<Text size="sm">{t("updateRestartingDescription")}</Text>
					</Stack>
				)}

				{serverStopped && applyResult.newBinaryPath && (
					<Stack gap="sm">
						<Alert color="yellow" variant="light" icon={<IconPower size={16} />}>
							{t("updateServerStopped")}
						</Alert>
						<Text size="sm">{t("updateRunNewBinary")}</Text>
						<Code block style={{ fontSize: "0.75rem", whiteSpace: "pre-wrap" }}>
							{applyResult.newBinaryPath}
						</Code>
					</Stack>
				)}

				<Group justify="flex-end" gap="sm">
					{isDownloading ? (
						<Button
							variant="subtle"
							color="red"
							onClick={handleCancel}
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
	);
}
