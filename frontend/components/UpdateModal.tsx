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
	useUpdateApply,
	useUpdateDownload,
} from "../hooks/useUpdateCheck";
import { useUpdateScheduleStatus } from "../hooks/useUpdateSchedule";
import { api } from "../lib/api";
import { normalizeLanguage } from "../lib/i18n";
import { formatLocaleDate } from "../lib/intl-format";
import { clearPwaCache, waitForUpdatedServerAndReload } from "../lib/pwa";
import { sameUpdateSource, updateCheckErrorKey, updateSettingsKey } from "../lib/update-source";
import {
	resolveUpdateCoordinationCounts,
	shouldAssumeLocalSchedule,
	shouldShowUpdateScheduleButton,
} from "../lib/update-state";
import { CopyButton } from "./common/CopyButton";
import { useConfirmDialog } from "./common/confirm-dialog-context";
import { MarkdownContent } from "./narrator/markdown/MarkdownContent";

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
		source?: "github" | "update-server";
		repository?: string;
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
	strategy?: "full" | "zstd";
	settingsKey?: string;
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
	const restartWaitRef = useRef<{ targetVersion?: string; controller: AbortController } | null>(
		null,
	);
	const [applyAttemptStartedAt, setApplyAttemptStartedAt] = useState<number | null>(null);
	// When this client's own `/apply` reported a schedule, and whether the server has since
	// confirmed one. Together they bound how long the optimistic claim may replace server truth;
	// see `shouldAssumeLocalSchedule`.
	const [scheduleClaimedAt, setScheduleClaimedAt] = useState<number | null>(null);
	const [serverConfirmedSchedule, setServerConfirmedSchedule] = useState(false);
	// Set once this client asks to end the attempt, so the optimistic claim stops fighting the
	// cancellation it requested. Without it the claim keeps the one-second poll alive forever.
	const [scheduleAbandonedLocally, setScheduleAbandonedLocally] = useState(false);
	const [restartWaitError, setRestartWaitError] = useState<string | null>(null);
	const [cancelError, setCancelError] = useState<string | null>(null);
	const [isCancellingSchedule, setIsCancellingSchedule] = useState(false);
	const [isShuttingDown, setIsShuttingDown] = useState(false);
	const [shutdownError, setShutdownError] = useState<string | null>(null);
	const [shutdownDone, setShutdownDone] = useState<{ newBinaryPath?: string } | null>(null);
	const confirm = useConfirmDialog();
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
	// Subscribe to saved settings without starting an extra admin-only request.
	const { data: savedSettings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		enabled: false,
	});
	const recommendationState = useRef({ data, invalidated: false });
	if (recommendationState.current.data !== data) {
		recommendationState.current = { data, invalidated: false };
	}
	const savedConfigurationChanged =
		!!savedSettings &&
		((data.settingsKey !== undefined &&
			data.settingsKey !== updateSettingsKey(savedSettings.update)) ||
			(!!releaseInfo &&
				!sameUpdateSource(releaseInfo, {
					source: savedSettings.update?.source ?? "github",
					repository: savedSettings.update?.githubRepository ?? "NarraFork/NarraFork",
				})));
	// Switching back does not revive an old recommendation; only a fresh check replaces data.
	if (savedConfigurationChanged) recommendationState.current.invalidated = true;
	const recommendationInvalidated = recommendationState.current.invalidated;
	const requestedTargetVersion = releaseInfo?.version ?? latestVersion;
	// A 409 download response can transparently re-check and switch to a newer release.
	// From that point onward, status polling, apply scheduling, and reload readiness must
	// follow the version actually downloaded rather than the modal's stale check payload.
	const targetVersion = result?.success
		? (result.version ?? requestedTargetVersion)
		: requestedTargetVersion;

	const assumeScheduled = shouldAssumeLocalSchedule({
		applyScheduled: applyResult?.scheduled === true,
		claimedAt: scheduleClaimedAt,
		serverConfirmedSchedule,
		abandonedLocally: scheduleAbandonedLocally,
		now: Date.now(),
	});

	const {
		data: preparedStatus,
		dataUpdatedAt: preparedStatusUpdatedAt,
		isLoading: isCheckingPreparedStatus,
		refetch: refetchPreparedStatus,
	} = useUpdateScheduleStatus({
		targetVersion,
		// Once this server has been told to stop, polling it can only produce failures. Keeping the
		// query alive would turn an intentional shutdown into a stream of errors in the dialog.
		//
		// A closed dialog still follows an attempt this client started, because the restart wait
		// begun here has to survive it. `serverConfirmedSchedule` keeps that true for the rest of
		// the session, which is harmless: `enabled` only decides whether the query may run at all,
		// while `refetchInterval` decides whether it repeats. The repetition is what was broken —
		// the unbounded `applyResult.scheduled` also fed `assumeScheduled`, so a cancelled attempt
		// kept re-requesting `/api/update/status` once a second forever.
		enabled: !shutdownDone && (opened || assumeScheduled || serverConfirmedSchedule),
		errorSinceMs: applyAttemptStartedAt,
		assumeScheduled,
	});

	const handleDownload = (options?: { retry?: boolean }) => {
		if (!downloadAvailable || !releaseInfo || recommendationInvalidated) return;
		download(releaseInfo, options);
	};

	const startRestartWait = useCallback(async (version?: string) => {
		if (restartWaitRef.current?.targetVersion === version) return;
		restartWaitRef.current?.controller.abort();
		const controller = new AbortController();
		restartWaitRef.current = { targetVersion: version, controller };
		setRestartWaitError(null);
		try {
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
		// A retry after a cancelled or failed attempt starts a fresh claim: the previous attempt's
		// abandonment and confirmation must not carry over and suppress this one.
		setScheduleAbandonedLocally(false);
		setServerConfirmedSchedule(false);
		setScheduleClaimedAt(null);
		const applyResponse = await apply(targetVersion);
		if (!applyResponse.success) return;
		if ("scheduled" in applyResponse && applyResponse.scheduled) {
			setScheduleClaimedAt(Date.now());
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

	/**
	 * Abandon a scheduled update that is still waiting for narrator work. The server keeps the
	 * prepared binary, so the schedule button comes back and the update can be retried later.
	 */
	const handleCancelSchedule = async () => {
		setIsCancellingSchedule(true);
		setCancelError(null);
		try {
			await api.cancelUpdate();
			// The attempt is over as far as this client is concerned. Releasing the optimistic claim
			// here is what lets the poll wind down once the coordinator reports idle; leaving it set
			// kept `/api/update/status` running once a second indefinitely.
			setScheduleAbandonedLocally(true);
			restartWaitRef.current?.controller.abort();
			restartWaitRef.current = null;
			setRestartWaitError(null);
			await refetchPreparedStatus();
		} catch (error) {
			// This is a plain call rather than a mutation, so the global mutation error toast never
			// fires. Without an explicit message the button would just spin and return to normal,
			// leaving the user to believe a cancellation happened that never did.
			setCancelError(error instanceof Error ? error.message : String(error));
		} finally {
			setIsCancellingSchedule(false);
		}
	};

	/**
	 * Stop the old version now and let the user start the new one themselves.
	 *
	 * The alternative to waiting for `updateSchedule`, which has no deadline by design. Everything
	 * that polls the server is torn down first: once the process is gone every request fails, and a
	 * live restart-wait would report that as a timeout error on top of a shutdown the user asked
	 * for. The dialog then switches to a terminal "stopped, run this path" state rather than
	 * pretending it can still observe the server.
	 */
	const handleForceShutdown = async () => {
		const confirmed = await confirm({
			title: t("updateForceShutdownConfirmTitle"),
			message: t("updateForceShutdownConfirmMessage"),
			confirmLabel: t("updateForceShutdown"),
			confirmColor: "red",
		});
		if (!confirmed) return;

		setIsShuttingDown(true);
		setShutdownError(null);
		try {
			const response = await api.shutdownForUpdate();
			if (!response.success) {
				setShutdownError(
					response.code === "REPLACEMENT_ALREADY_STARTING"
						? t("updateForceShutdownAlreadyRestarting")
						: response.code === "SHUTDOWN_UNAVAILABLE"
							? t("updateForceShutdownUnavailable")
							: (response.error ?? t("updateForceShutdownFailed")),
				);
				return;
			}
			// `/shutdown` cancels any schedule server-side, so this client's claim is void too.
			setScheduleAbandonedLocally(true);
			restartWaitRef.current?.controller.abort();
			restartWaitRef.current = null;
			setRestartWaitError(null);
			setShutdownDone({ newBinaryPath: response.newBinaryPath ?? preparedBinaryPath });
		} catch (error) {
			// A plain call rather than a mutation, so no global toast fires. The shutdown races the
			// response, so a network failure here genuinely may mean it worked — say so instead of
			// reporting a bare fetch error the user cannot act on.
			setShutdownError(error instanceof Error ? error.message : String(error));
		} finally {
			setIsShuttingDown(false);
		}
	};

	const savingsPercent =
		downloadSize && totalSize ? Math.round((1 - downloadSize / totalSize) * 100) : 0;
	const preparedStatusDetails = preparedStatus;
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
					updatePath: preparedStatusDetails.updatePath ?? preparedStatusDetails.newBinaryPath,
					newBinaryPath: preparedStatusDetails.newBinaryPath,
					placed: preparedStatusDetails.placed,
					canAutoRestart: preparedStatusDetails.canAutoRestart,
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
		effectiveResult?.updatePath;
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
	// An operator cancellation lands in the same error field as a genuine failure, but it is an
	// expected outcome rather than something that went wrong.
	const coordinationCancelled =
		coordinationFailed && preparedStatusDetails?.errorKind === "cancelled";
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
	const waitBlockers = updateScheduled ? (preparedStatusDetails?.blockers ?? []) : [];
	const cancelRequested = updateScheduled && preparedStatusDetails?.cancelRequested === true;
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
	const downloadErrorKey = updateCheckErrorKey(result?.code);
	const downloadError = isZstdMissing
		? null
		: rawDownloadError && downloadErrorKey !== "updateCheckFailed"
			? t(downloadErrorKey)
			: rawDownloadError;
	const applyError =
		cancelError ??
		restartWaitError ??
		(applyResult && !applyResult.success ? applyResult.error : null) ??
		(statusErrorIsCurrent ? preparedStatusDetails?.error : null) ??
		null;

	// Once the coordinator has confirmed a schedule, its own reports drive the poll and the local
	// claim retires. This is the ordinary way the claim ends: it hands over to server truth as soon
	// as server truth exists, and the coordinator reporting idle later is then believed.
	useEffect(() => {
		if (preparedStatus?.scheduled === true) setServerConfirmedSchedule(true);
	}, [preparedStatus?.scheduled]);

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
				{recommendationInvalidated && (
					<Alert color="orange" variant="light">
						{t("updateSourceChanged")}
					</Alert>
				)}
				{releaseInfo && (!recommendationInvalidated || effectiveResult?.success) && (
					<Group gap="xs">
						<Badge variant="light">
							{releaseInfo.source === "github"
								? t("updateSourceGithub", { repository: releaseInfo.repository })
								: t("updateSourceServer")}
						</Badge>
						<Badge variant="outline">
							{t(
								(progress?.strategy ?? data.strategy) === "zstd"
									? "updateStrategyZstd"
									: "updateStrategyFull",
							)}
						</Badge>
					</Group>
				)}
				{releaseDate && !recommendationInvalidated && (
					<Text size="xs" c="dimmed">
						{formatLocaleDate(releaseDate, {
							year: "numeric",
							month: "long",
							day: "numeric",
						})}
					</Text>
				)}

				{/* Release notes */}
				{!recommendationInvalidated && (
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
				)}

				{progress?.fallback && releaseInfo?.source === "github" && (
					<Alert color="yellow" variant="light">
						{t("updateDeltaFallback")}
					</Alert>
				)}
				{savingsPercent > 0 &&
					!progress?.fallback &&
					!recommendationInvalidated &&
					!effectiveResult?.success && (
						<Text size="xs" c="dimmed">
							{t("updatePatchInfo", {
								downloadSize: formatBytes(downloadSize ?? 0),
								totalSize: formatBytes(totalSize ?? 0),
							})}
						</Text>
					)}

				<Divider />

				{/* Download button */}
				{!progress && !effectiveResult && !recommendationInvalidated && (
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
							disabled={!downloadAvailable || recommendationInvalidated}
							title={
								recommendationInvalidated ? t("updateSourceChanged") : downloadUnavailableReason
							}
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

						{/*
						 * Escape hatch from the unbounded wait above: stop this version now and start the
						 * new one by hand. Only offered while nothing is scheduled and no shutdown has
						 * been confirmed, so it cannot be used to interrupt a restart already underway.
						 */}
						{showUpdateScheduleButton && !shutdownDone && (
							<>
								<Divider variant="dashed" />
								<Text size="sm">{t("updateForceShutdownDescription")}</Text>
								<Button
									fullWidth
									color="red"
									variant="outline"
									leftSection={<IconPower size={16} />}
									onClick={handleForceShutdown}
									loading={isShuttingDown}
								>
									{t("updateForceShutdown")}
								</Button>
							</>
						)}

						{shutdownError && (
							<Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
								<Text size="sm">{shutdownError}</Text>
							</Alert>
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

						{updateScheduled && !restartStarted && (
							<Stack gap="xs">
								{waitBlockers.length > 0 && (
									<Stack gap={2}>
										<Text size="xs" c="dimmed">
											{t("updateWaitBlockersTitle")}
										</Text>
										{waitBlockers.slice(0, 5).map((blocker) => (
											<Text
												key={`${blocker.kind}-${blocker.narratorId ?? ""}-${blocker.toolUseId ?? ""}`}
												size="xs"
												c="dimmed"
											>
												{t(`updateWaitBlocker_${blocker.kind}`, {
													seconds: Math.round(blocker.waitingMs / 1000),
												})}
											</Text>
										))}
									</Stack>
								)}
								<Text size="xs" c="dimmed">
									{t("updateNoWaitDeadline")}
								</Text>
								<Button
									variant="subtle"
									color="red"
									size="compact-sm"
									leftSection={<IconX size={14} />}
									onClick={handleCancelSchedule}
									loading={isCancellingSchedule}
									disabled={cancelRequested}
								>
									{cancelRequested ? t("updateCancellingSchedule") : t("updateCancelSchedule")}
								</Button>
							</Stack>
						)}
					</Stack>
				)}

				{applyError && (
					<Alert
						color={coordinationCancelled && !cancelError ? "gray" : "red"}
						variant="light"
						icon={
							coordinationCancelled && !cancelError ? (
								<IconClock size={16} />
							) : (
								<IconAlertTriangle size={16} />
							)
						}
					>
						<Text size="sm">
							{coordinationCancelled && !cancelError ? t("updateScheduleCancelled") : applyError}
						</Text>
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

				{shutdownDone && (
					<Stack gap="sm">
						<Alert color="yellow" variant="light" icon={<IconPower size={16} />}>
							{t("updateForceShutdownDone")}
						</Alert>
						<Text size="sm">{t("updateForceShutdownDoneDescription")}</Text>
						{shutdownDone.newBinaryPath && (
							<Group gap="xs" align="flex-start">
								<Code block style={{ flex: 1, fontSize: "0.75rem", whiteSpace: "pre-wrap" }}>
									{shutdownDone.newBinaryPath}
								</Code>
								<CopyButton value={shutdownDone.newBinaryPath}>
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
