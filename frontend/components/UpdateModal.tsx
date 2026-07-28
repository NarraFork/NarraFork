import {
	Alert,
	Badge,
	Button,
	Code,
	Divider,
	Group,
	Modal,
	Progress,
	ScrollArea,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { getLocaleFallbackChain } from "@shared/i18n-locales";
import {
	IconAlertTriangle,
	IconCheck,
	IconClock,
	IconCopy,
	IconDownload,
	IconPower,
	IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePlatform, useUpdateCapability } from "../hooks/usePlatform";
import {
	type UpdateDownloadResult,
	type UpdateInstructions,
	useUpdateApply,
	useUpdateDownload,
} from "../hooks/useUpdateCheck";
import { api } from "../lib/api";
import { normalizeLanguage } from "../lib/i18n";
import { formatLocaleDate } from "../lib/intl-format";
import {
	resolveUpdateCoordinationCounts,
	shouldShowUpdateScheduleButton,
	type UpdateCoordinationPhase,
} from "../lib/update-state";
import { CopyButton } from "./common/CopyButton";
import { MarkdownContent } from "./narrator/MarkdownContent";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Resolve localized release notes with English and first-value fallbacks. */
function resolveNotes(
	notes: string | Record<string, string> | undefined,
	lang: string,
): string | undefined {
	if (!notes) return undefined;
	if (typeof notes === "string") return notes;
	const locale = normalizeLanguage(lang);
	for (const candidate of getLocaleFallbackChain(locale)) {
		if (notes[candidate]) return notes[candidate];
	}
	return Object.values(notes)[0];
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

type PreparedUpdateStatus = {
	ready: boolean;
	updateFile?: string;
	canAutoRestart: boolean;
	newBinaryPath?: string;
	updatePath?: string;
	artifactPath?: string;
	directory?: string;
	placed?: boolean;
	version?: string;
	phase?: UpdateCoordinationPhase;
	scheduled?: boolean;
	targetVersion?: string;
	pendingExecutionCount?: number;
	pendingBackgroundBashCount?: number;
	pendingOrdinaryExecutionCount?: number;
	resumableExecutionCount?: number;
	pausedToolCount?: number;
	error?: string;
	selfUpdateAvailable?: boolean;
	manualOnly?: boolean;
	instructions?: UpdateInstructions;
};

export function UpdateModal({ opened, onClose, data }: UpdateModalProps) {
	const { t, i18n } = useTranslation("common");
	const { download, cancel, reset, progress, result, isDownloading } = useUpdateDownload();
	const { apply, isApplying, applyResult } = useUpdateApply();
	const restartWaitRef = useRef<{ targetVersion?: string; controller: AbortController } | null>(
		null,
	);
	const [applyAttemptStartedAt, setApplyAttemptStartedAt] = useState<number | null>(null);
	const [restartWaitError, setRestartWaitError] = useState<string | null>(null);
	const updateCapability = useUpdateCapability();
	const platform = usePlatform();
	const downloadAvailable = updateCapability.download.supported && updateCapability.download.sse;
	const downloadUnavailableReason = !updateCapability.download.supported
		? (updateCapability.download.reason ?? t("updateDownloadUnavailable"))
		: !updateCapability.download.sse
			? t("updateDownloadRequiresSse")
			: undefined;
	const autoApplyAvailable =
		updateCapability.apply.supported &&
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
	const requestedTargetVersion = releaseInfo?.version ?? latestVersion;
	// A 409 download response can transparently re-check and switch to a newer release.
	// From that point onward, status polling, apply scheduling, and reload readiness must
	// follow the version actually downloaded rather than the modal's stale check payload.
	const targetVersion = result?.success
		? (result.version ?? requestedTargetVersion)
		: requestedTargetVersion;

	const {
		data: preparedStatus,
		dataUpdatedAt: preparedStatusUpdatedAt,
		isLoading: isCheckingPreparedStatus,
		refetch: refetchPreparedStatus,
	} = useQuery({
		queryKey: ["update-status", targetVersion],
		queryFn: () => api.getUpdateStatus(targetVersion),
		enabled: !!targetVersion && (opened || applyResult?.scheduled === true),
		staleTime: 0,
		refetchInterval: (query) => {
			const status = query.state.data as PreparedUpdateStatus | undefined;
			const statusErrorIsCurrent =
				!!status?.error &&
				(applyAttemptStartedAt === null || query.state.dataUpdatedAt >= applyAttemptStartedAt);
			if (statusErrorIsCurrent && !status?.scheduled) return false;
			return applyResult?.scheduled === true || status?.scheduled === true ? 1000 : false;
		},
	});

	const handleDownload = (options?: { retry?: boolean }) => {
		if (!downloadAvailable || !releaseInfo) return;
		download(releaseInfo, options);
	};

	const startRestartWait = useCallback(async (version?: string) => {
		if (restartWaitRef.current?.targetVersion === version) return;
		restartWaitRef.current?.controller.abort();
		const controller = new AbortController();
		restartWaitRef.current = { targetVersion: version, controller };
		setRestartWaitError(null);
		try {
			const { waitForUpdatedServerAndReload } = await import("@frontend/lib/pwa");
			await waitForUpdatedServerAndReload({
				targetVersion: version,
				requestTimeoutMs: 3000,
				signal: controller.signal,
			});
		} catch (error) {
			if (!controller.signal.aborted) {
				setRestartWaitError(error instanceof Error ? error.message : String(error));
			}
		} finally {
			if (restartWaitRef.current?.controller === controller) restartWaitRef.current = null;
		}
	}, []);

	const handleApply = async () => {
		setApplyAttemptStartedAt(Date.now());
		setRestartWaitError(null);
		const { clearPwaCache } = await import("@frontend/lib/pwa");
		const applyResponse = await apply(targetVersion);
		if (!applyResponse.success) return;
		if ("scheduled" in applyResponse && applyResponse.scheduled) {
			void refetchPreparedStatus();
			void startRestartWait(targetVersion);
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
	const preparedStatusDetails = preparedStatus as PreparedUpdateStatus | undefined;
	const preparedStatusMatches =
		preparedStatusDetails?.ready &&
		!!targetVersion &&
		preparedStatusDetails.version === targetVersion;
	const restoredInstructions = preparedStatusDetails?.instructions;
	const restoredResult: UpdateDownloadResult | null =
		preparedStatusMatches && preparedStatusDetails
			? {
					success: true,
					version: preparedStatusDetails.version,
					ready: preparedStatusDetails.ready,
					updatePath:
						preparedStatusDetails.updatePath ??
						preparedStatusDetails.newBinaryPath ??
						preparedStatusDetails.artifactPath,
					artifactPath: preparedStatusDetails.artifactPath,
					newBinaryPath: preparedStatusDetails.newBinaryPath,
					directory: preparedStatusDetails.directory,
					placed: preparedStatusDetails.placed,
					selfUpdateAvailable: preparedStatusDetails.selfUpdateAvailable,
					canAutoRestart: preparedStatusDetails.canAutoRestart,
					manualOnly: preparedStatusDetails.manualOnly,
					phase: preparedStatusDetails.phase,
					scheduled: preparedStatusDetails.scheduled,
					targetVersion: preparedStatusDetails.targetVersion,
					pendingExecutionCount: preparedStatusDetails.pendingExecutionCount,
					pendingBackgroundBashCount: preparedStatusDetails.pendingBackgroundBashCount,
					pendingOrdinaryExecutionCount: preparedStatusDetails.pendingOrdinaryExecutionCount,
					resumableExecutionCount: preparedStatusDetails.resumableExecutionCount,
					pausedToolCount: preparedStatusDetails.pausedToolCount,
					error: preparedStatusDetails.error,
					instructions: restoredInstructions ?? {
						manual: !preparedStatusDetails.canAutoRestart,
						newBinaryPath: preparedStatusDetails.newBinaryPath,
						command: preparedStatusDetails.newBinaryPath
							? `"${preparedStatusDetails.newBinaryPath}"`
							: undefined,
						message: preparedStatusDetails.placed
							? t("updatePreparedDescription")
							: t("updateCachedDescription"),
					},
				}
			: null;
	const effectiveResult = result ?? restoredResult;

	const preparedBinaryPath =
		effectiveResult?.instructions?.newBinaryPath ??
		effectiveResult?.newBinaryPath ??
		effectiveResult?.instructions?.updatePath ??
		effectiveResult?.updatePath ??
		effectiveResult?.artifactPath;
	const preparedCommand =
		effectiveResult?.instructions?.command ??
		(preparedBinaryPath ? `"${preparedBinaryPath}"` : undefined);
	// Command 仅在与二进制路径实质不同时才单独展示（去掉首尾引号后比较，避免仅因引号而重复显示）
	const stripQuotes = (value: string) => value.replace(/^"(.*)"$/, "$1");
	const commandDiffersFromPath =
		!!preparedCommand &&
		(!preparedBinaryPath || stripQuotes(preparedCommand) !== stripQuotes(preparedBinaryPath));
	const statusErrorIsCurrent =
		!!preparedStatusDetails?.error &&
		(applyAttemptStartedAt === null || preparedStatusUpdatedAt >= applyAttemptStartedAt);
	const coordinationFailed = statusErrorIsCurrent && preparedStatusDetails?.scheduled !== true;
	const updateScheduled = coordinationFailed
		? false
		: applyResult?.scheduled === true || preparedStatusDetails?.scheduled === true;
	const coordinationPhase =
		preparedStatusDetails?.scheduled || coordinationFailed
			? preparedStatusDetails.phase
			: (applyResult?.phase ?? preparedStatusDetails?.phase);
	const coordinationCountsSource = preparedStatusDetails?.scheduled
		? preparedStatusDetails
		: (applyResult ?? preparedStatusDetails ?? {});
	const {
		pendingBackgroundBashCount,
		pendingOrdinaryExecutionCount,
		resumableExecutionCount,
		pausedToolCount,
	} = resolveUpdateCoordinationCounts(coordinationCountsSource);
	const canRestartIntoUpdate =
		autoApplyAvailable &&
		!updateScheduled &&
		effectiveResult?.success &&
		effectiveResult.instructions &&
		!effectiveResult.instructions.manual;
	const showUpdateScheduleButton = shouldShowUpdateScheduleButton({
		canRestartIntoUpdate: Boolean(canRestartIntoUpdate),
		applySucceeded: applyResult?.success === true,
		coordinationFailed,
	});
	const preparedDescription = effectiveResult?.placed
		? t("updatePreparedDescription")
		: t("updateCachedDescription");
	const shouldShowPreparedDescription = !canRestartIntoUpdate || !preparedBinaryPath;
	const isDrainingBackgroundBash =
		updateScheduled &&
		(coordinationPhase === "draining" || coordinationPhase === "draining_background_bash");
	const isQuiescingTools = updateScheduled && coordinationPhase === "quiescing_tools";
	const restartStarted = updateScheduled && coordinationPhase === "restarting";
	const serverStopped = applyResult?.success && !applyResult.restarting;
	const rawDownloadError = result && !result.success ? result.error : null;
	const isZstdMissing = rawDownloadError === "ZSTD_CLI_MISSING";
	const downloadError = isZstdMissing ? null : rawDownloadError;
	const applyError =
		restartWaitError ??
		(applyResult && !applyResult.success ? applyResult.error : null) ??
		(statusErrorIsCurrent ? preparedStatusDetails?.error : null) ??
		null;

	useEffect(() => {
		if (coordinationFailed) {
			restartWaitRef.current?.controller.abort();
			restartWaitRef.current = null;
			return;
		}
		if (updateScheduled && coordinationPhase === "restarting") {
			void startRestartWait(targetVersion);
		}
	}, [coordinationFailed, coordinationPhase, startRestartWait, targetVersion, updateScheduled]);

	return (
		<Modal
			opened={opened}
			onClose={handleClose}
			title={t("updateDownloadTitle", { version: targetVersion ?? latestVersion })}
			size="lg"
			centered
		>
			<Stack gap="md">
				{releaseDate && (
					<Text size="xs" c="dimmed">
						{formatLocaleDate(releaseDate, {
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
														{formatLocaleDate(v.releaseDate, {
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
						onClick={() => handleDownload()}
						loading={isCheckingPreparedStatus}
						disabled={!downloadAvailable}
						title={downloadUnavailableReason}
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
						{platform === "windows" ? (
							<Text size="sm">{t("updateZstdMissingDescWindows")}</Text>
						) : (
							<>
								<Text size="sm">{t("updateZstdMissingDesc")}</Text>
								<Code block mt={8} style={{ fontSize: "0.75rem" }}>
									{t("updateZstdInstallCmd")}
								</Code>
							</>
						)}
						<Button
							variant="light"
							color="orange"
							size="xs"
							mt={8}
							disabled={!downloadAvailable}
							title={downloadUnavailableReason}
							onClick={() => {
								reset();
								handleDownload({ retry: true });
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

						{preparedCommand && commandDiffersFromPath && (
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

						{showUpdateScheduleButton && (
							<>
								<Text size="sm">{t("updateApplyDescription")}</Text>
								<Button
									fullWidth
									color="red"
									variant="light"
									leftSection={<IconClock size={16} />}
									onClick={handleApply}
									loading={isApplying && !coordinationFailed}
								>
									{t("updateSchedule")}
								</Button>
							</>
						)}

						{isDrainingBackgroundBash && (
							<Alert color="blue" variant="light" icon={<IconClock size={16} />}>
								<Group gap="xs" wrap="nowrap" justify="space-between" align="center">
									<Text size="sm" fw={500}>
										{t("updateDrainingBackgroundBash")}
									</Text>
									{pendingBackgroundBashCount > 0 && (
										<Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
											{t("updateWaitingBackgroundBash", {
												count: pendingBackgroundBashCount,
											})}
										</Text>
									)}
								</Group>
								<Text size="sm" mt={4}>
									{t("updateDrainingBackgroundBashDescription")}
								</Text>
							</Alert>
						)}

						{isQuiescingTools && (
							<Alert color="blue" variant="light" icon={<IconClock size={16} />}>
								<Group gap="xs" wrap="nowrap" justify="space-between" align="center">
									<Text size="sm" fw={500}>
										{t("updateQuiescingTools")}
									</Text>
									{pendingOrdinaryExecutionCount > 0 && (
										<Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
											{t("updateWaitingOrdinaryExecutions", {
												count: pendingOrdinaryExecutionCount,
											})}
										</Text>
									)}
								</Group>
								<Text size="sm" mt={4}>
									{t("updateQuiescingToolsDescription")}
								</Text>
								{pausedToolCount > 0 && (
									<Text size="sm" c="dimmed" mt={4}>
										{t("updatePausedTools", { count: pausedToolCount })}
									</Text>
								)}
							</Alert>
						)}

						{updateScheduled && resumableExecutionCount > 0 && (
							<Alert color="indigo" variant="light" icon={<IconClock size={16} />}>
								{t("updateResumableExecutions", { count: resumableExecutionCount })}
							</Alert>
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
