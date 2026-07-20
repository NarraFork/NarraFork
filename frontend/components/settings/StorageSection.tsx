import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Divider,
	Group,
	Loader,
	Modal,
	Paper,
	Progress,
	Select,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconAlertTriangle,
	IconBox,
	IconDatabase,
	IconGitBranch,
	IconInfoCircle,
	IconPhoto,
	IconRefresh,
	IconShare,
	IconTrash,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useDatabaseCapability,
	useStorageCapability,
	useStorageCleanupOperationCapabilities,
	useStorageDatabaseCleanupCapabilities,
	useStorageDatabasePreviewCapability,
} from "../../hooks/usePlatform";
import {
	api,
	type DatabaseCleanupApiRequestSample,
	type DatabaseCleanupBlockedItem,
	type DatabaseCleanupExecutionResult,
	type DatabaseCleanupNarratorSample,
	type DatabaseCleanupPreviewResult,
	type DatabaseCleanupTarget,
	type DatabaseStorageBreakdown,
	type DatabaseVacuumResult,
	type StorageCategoryResult,
	type StorageScanResult,
	scanStorageStream,
} from "../../lib/api";
import { formatLocaleDateTime, formatLocaleTime } from "../../lib/intl-format";
import { useConfirmDialog } from "../common/ConfirmDialogProvider";

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const val = bytes / 1024 ** i;
	return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDateTime(value: string | null | undefined): string {
	if (!value) return "—";
	return formatLocaleDateTime(value);
}

function fallbackDiagnosticMessage(value?: {
	reason?: string;
	message?: string;
	error?: string;
	code?: string;
}): string | undefined {
	return value?.reason ?? value?.message ?? value?.error ?? value?.code;
}

function getDatabaseBreakdown(category?: StorageCategoryResult): DatabaseStorageBreakdown | null {
	const details = category?.details as Partial<DatabaseStorageBreakdown> | undefined;
	if (!details) return null;
	if (
		typeof details.mainBytes !== "number" ||
		typeof details.walBytes !== "number" ||
		typeof details.shmBytes !== "number" ||
		typeof details.cleanupCandidates !== "object"
	) {
		return null;
	}
	return details as DatabaseStorageBreakdown;
}

function isNarratorSample(
	sample: DatabaseCleanupPreviewResult["samples"][number],
): sample is DatabaseCleanupNarratorSample {
	return sample.type === "narrator";
}

function isApiRequestSample(
	sample: DatabaseCleanupPreviewResult["samples"][number],
): sample is DatabaseCleanupApiRequestSample {
	return sample.type === "apiRequest";
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
	database: <IconDatabase size={18} />,
	uploads: <IconPhoto size={18} />,
	shares: <IconShare size={18} />,
	worktrees: <IconGitBranch size={18} />,
	containers: <IconBox size={18} />,
};

const CATEGORY_COLORS: Record<string, string> = {
	database: "blue",
	uploads: "grape",
	shares: "teal",
	worktrees: "orange",
	containers: "cyan",
};
const STORAGE_SETTINGS_QUERY_GC_TIME_MS = 60_000;

const DATABASE_TARGET_DEFAULT_DAYS: Record<
	Exclude<DatabaseCleanupTarget, "archivedSessions">,
	number
> = {
	staleSessions: 90,
	apiRequestDumps: 30,
};

const DATABASE_TARGET_DAY_OPTIONS: Record<
	Exclude<DatabaseCleanupTarget, "archivedSessions">,
	string[]
> = {
	staleSessions: ["30", "90", "180", "365"],
	apiRequestDumps: ["7", "30", "90", "180"],
};

interface CleanupTarget {
	key: string;
	target: "uploads" | "shares" | "worktrees" | "containers";
	labelKey: string;
}

const CLEANUP_TARGETS: CleanupTarget[] = [
	{ key: "uploads", target: "uploads", labelKey: "storageCleanupUploads" },
	{ key: "shares", target: "shares", labelKey: "storageCleanupShares" },
	{ key: "worktrees", target: "worktrees", labelKey: "storageCleanupWorktrees" },
	{ key: "containers", target: "containers", labelKey: "storageCleanupContainers" },
];

export function StorageSection() {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const rawDatabaseCapability = useDatabaseCapability();
	const {
		scanSupported,
		scanReason,
		cachedSupported,
		vacuumSupported,
		vacuumReason,
		healthState: storageHealthState,
		healthError: storageHealthError,
		healthFetching: storageHealthFetching,
		refetchHealth,
	} = useStorageCapability();
	const storageHealthReady =
		storageHealthState === "legacy" || storageHealthState === "capabilities";
	const storageHealthLoadingMessage = t("storageHealthLoading", {
		defaultValue: "Loading storage capabilities…",
	});
	const storageHealthErrorFallback = t("storageHealthError", {
		defaultValue: "Could not load storage capabilities. Retry to continue.",
	});
	const storageHealthErrorMessage =
		storageHealthError?.message?.trim() || storageHealthErrorFallback;
	const storageHealthDisabledReason =
		storageHealthState === "loading"
			? storageHealthLoadingMessage
			: storageHealthState === "error"
				? storageHealthErrorMessage
				: undefined;
	const databaseCapability = storageHealthReady ? rawDatabaseCapability : undefined;
	const databaseUnsupportedReason = databaseCapability?.reason;
	const databaseCompatibilityInfo = databaseCapability
		? t("storageDatabaseCompatibilityInfo", {
				owner: databaseCapability.mainSchemaOwner ?? "—",
				ftsRepair: databaseCapability.ftsRepair ? t("yes") : t("no"),
			})
		: null;
	const databasePreviewDisabledReason =
		storageHealthDisabledReason ?? t("storageDatabasePreviewUnsupported");
	const rawCleanupOperationCapabilities = useStorageCleanupOperationCapabilities();
	const cleanupOperationCapabilities = storageHealthReady
		? rawCleanupOperationCapabilities
		: {
				uploads: {
					...rawCleanupOperationCapabilities.uploads,
					supported: false,
					reason: storageHealthDisabledReason,
				},
				shares: {
					...rawCleanupOperationCapabilities.shares,
					supported: false,
					reason: storageHealthDisabledReason,
				},
				worktrees: {
					...rawCleanupOperationCapabilities.worktrees,
					supported: false,
					reason: storageHealthDisabledReason,
				},
				containers: {
					...rawCleanupOperationCapabilities.containers,
					supported: false,
					reason: storageHealthDisabledReason,
				},
			};
	const rawDatabaseCleanupCapabilities = useStorageDatabaseCleanupCapabilities();
	const databaseCleanupCapabilities = storageHealthReady
		? rawDatabaseCleanupCapabilities
		: {
				archivedSessions: {
					...rawDatabaseCleanupCapabilities.archivedSessions,
					supported: false,
					reason: storageHealthDisabledReason,
				},
				staleSessions: {
					...rawDatabaseCleanupCapabilities.staleSessions,
					supported: false,
					reason: storageHealthDisabledReason,
				},
				apiRequestDumps: {
					...rawDatabaseCleanupCapabilities.apiRequestDumps,
					supported: false,
					reason: storageHealthDisabledReason,
				},
			};
	const rawDatabasePreviewCapability = useStorageDatabasePreviewCapability();
	const databasePreviewCapability = storageHealthReady
		? rawDatabasePreviewCapability
		: { supported: false };
	const scanDisabledReason =
		storageHealthDisabledReason ?? scanReason ?? t("storageScanUnsupported");
	const [scanResult, setScanResult] = useState<StorageScanResult | null>(null);
	const [scanning, setScanning] = useState(false);
	const [progressMsg, setProgressMsg] = useState("");
	const [cleaningTarget, setCleaningTarget] = useState<string | null>(null);
	const [databaseTarget, setDatabaseTarget] = useState<DatabaseCleanupTarget | null>(null);
	const [databaseOlderThanDays, setDatabaseOlderThanDays] = useState<number>(
		DATABASE_TARGET_DEFAULT_DAYS.staleSessions,
	);
	const [databasePreview, setDatabasePreview] = useState<DatabaseCleanupPreviewResult | null>(null);
	const [databasePreviewLoading, setDatabasePreviewLoading] = useState(false);
	const [databasePreviewError, setDatabasePreviewError] = useState<string | null>(null);
	const [databaseCleaning, setDatabaseCleaning] = useState(false);
	const [databaseVacuuming, setDatabaseVacuuming] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	const { data: settingsData } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		gcTime: STORAGE_SETTINGS_QUERY_GC_TIME_MS,
	});
	const requestDumpEnabled = Boolean(
		(settingsData as { agent?: { requestDumpEnabled?: boolean } } | undefined)?.agent
			?.requestDumpEnabled,
	);

	useEffect(() => {
		return () => {
			abortRef.current?.abort();
			abortRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (!cachedSupported) return;
		let cancelled = false;
		api
			.getCachedStorage()
			.then((res) => {
				if (!cancelled && res.cached && res.data) {
					setScanResult(res.data);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [cachedSupported]);

	useEffect(() => {
		if (!databaseTarget) return;
		if (!databasePreviewCapability.supported) {
			setDatabasePreview(null);
			setDatabasePreviewLoading(false);
			setDatabasePreviewError(databasePreviewDisabledReason);
			return;
		}
		let cancelled = false;
		setDatabasePreviewLoading(true);
		setDatabasePreviewError(null);
		api
			.previewDatabaseCleanup({
				target: databaseTarget,
				olderThanDays: databaseTarget === "archivedSessions" ? undefined : databaseOlderThanDays,
				sampleLimit: 8,
			})
			.then((preview) => {
				if (!cancelled) {
					setDatabasePreview(preview);
				}
			})
			.catch((error) => {
				if (!cancelled) {
					setDatabasePreview(null);
					setDatabasePreviewError(
						error instanceof Error ? error.message : t("storageDatabasePreviewFailed"),
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setDatabasePreviewLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [
		databaseTarget,
		databaseOlderThanDays,
		databasePreviewCapability.supported,
		databasePreviewDisabledReason,
		t,
	]);

	const handleStorageHealthRetry = async () => {
		try {
			await refetchHealth();
		} catch {
			// The query remains in its error state and keeps the retry affordance visible.
		}
	};

	const handleScan = async () => {
		if (!storageHealthReady || scanning || !scanSupported) return;
		setScanning(true);
		setProgressMsg("");
		abortRef.current = new AbortController();

		try {
			const result = await scanStorageStream({
				onProgress: (msg) => setProgressMsg(msg),
				onCategory: (cat) => {
					setScanResult((prev) => {
						const categories = prev ? [...prev.categories] : [];
						const idx = categories.findIndex((c) => c.key === cat.key);
						if (idx >= 0) categories[idx] = cat;
						else categories.push(cat);
						return {
							categories,
							totalBytes: categories.reduce((s, c) => s + c.sizeBytes, 0),
							scannedAt: Date.now(),
						};
					});
				},
				signal: abortRef.current.signal,
			});
			setScanResult(result);
		} catch (err) {
			if ((err as Error).name !== "AbortError") {
				console.error("Storage scan failed:", err);
				notifications.show({
					color: "red",
					message: err instanceof Error && err.message ? err.message : t("storageScanFailed"),
				});
			}
		} finally {
			setScanning(false);
			setProgressMsg("");
			abortRef.current = null;
		}
	};

	const usesRuntimeWorktreeCleanup = (target: CleanupTarget | undefined): boolean =>
		target ? cleanupOperationCapabilities[target.target].route === "runtime" : false;

	const handleCleanup = async (target: CleanupTarget) => {
		if (!storageHealthReady) return;
		const cleanupCap = cleanupOperationCapabilities[target.target];
		if (cleanupCap.supported === false) return;
		if (target.target === "uploads" && cleanupCap.preservesMessageImageRefs === false) return;
		if (!(await confirm({ message: t("storageCleanupConfirm") }))) return;
		setCleaningTarget(target.key);
		try {
			if (usesRuntimeWorktreeCleanup(target)) {
				const res = await api.cleanupRuntime("worktrees");
				if (res.ok) {
					notifications.show({
						message: t("storageCleanupWorktreesSuccess", {
							count: res.removedCounts?.worktrees ?? 0,
						}),
						color: "green",
					});
					void handleScan();
				}
				return;
			}

			const res = await api.cleanupStorage(target.target);
			if (res.ok) {
				if (target.target === "containers") {
					notifications.show({
						message: t("storageCleanupContainersSuccess"),
						color: "green",
					});
				} else if (res.removed !== undefined && res.freedBytes !== undefined) {
					notifications.show({
						message: t("storageCleanupSuccess", {
							count: res.removed,
							size: formatBytes(res.freedBytes),
						}),
						color: "green",
					});
				}
				void handleScan();
			}
		} catch (err) {
			console.error("Cleanup failed:", err);
			notifications.show({
				color: "red",
				message: err instanceof Error && err.message ? err.message : t("storageCleanupFailed"),
			});
		} finally {
			setCleaningTarget(null);
		}
	};

	const handleDatabaseVacuum = async () => {
		if (!storageHealthReady || !vacuumSupported) return;
		if (
			!(await confirm({
				title: t("storageDatabaseVacuumConfirmTitle"),
				message: t("storageDatabaseVacuumConfirm"),
				confirmLabel: t("storageDatabaseVacuumConfirmLabel"),
				confirmColor: "red",
			}))
		) {
			return;
		}
		setDatabaseVacuuming(true);
		try {
			const result: DatabaseVacuumResult = await api.vacuumDatabase();
			notifications.show({
				color: result.freedBytes > 0 ? "green" : "blue",
				message: t("storageDatabaseVacuumSuccess", {
					size: formatBytes(result.freedBytes),
					freeBefore: formatBytes(result.freelistBeforeBytes),
					duration: (result.durationMs / 1000).toFixed(1),
				}),
			});
			void handleScan();
		} catch (err) {
			console.error("Database VACUUM failed:", err);
			notifications.show({
				color: "red",
				message: t("storageDatabaseVacuumFailed"),
			});
		} finally {
			setDatabaseVacuuming(false);
		}
	};

	const openDatabasePreview = (target: DatabaseCleanupTarget) => {
		if (!storageHealthReady || !databasePreviewCapability.supported) {
			notifications.show({ color: "yellow", message: databasePreviewDisabledReason });
			return;
		}
		setDatabaseTarget(target);
		setDatabasePreview(null);
		setDatabasePreviewError(null);
		if (target === "staleSessions") {
			setDatabaseOlderThanDays(DATABASE_TARGET_DEFAULT_DAYS.staleSessions);
		} else if (target === "apiRequestDumps") {
			setDatabaseOlderThanDays(DATABASE_TARGET_DEFAULT_DAYS.apiRequestDumps);
		}
	};

	const closeDatabasePreview = () => {
		setDatabaseTarget(null);
		setDatabasePreview(null);
		setDatabasePreviewError(null);
		setDatabasePreviewLoading(false);
		setDatabaseCleaning(false);
	};

	const handleDatabaseCleanup = async () => {
		if (!storageHealthReady || !databaseTarget) return;
		const targetCapability = databaseCleanupCapabilities[databaseTarget];
		if (targetCapability.supported === false) {
			notifications.show({
				color: "yellow",
				message: targetCapability.reason ?? t("storageDatabaseCleanupUnsupported"),
			});
			return;
		}
		setDatabaseCleaning(true);
		try {
			const result = await api.cleanupDatabase({
				target: databaseTarget,
				olderThanDays: databaseTarget === "archivedSessions" ? undefined : databaseOlderThanDays,
			});
			const cleanedCount = getDatabaseCleanupCount(result);
			if (!result.changed || cleanedCount === 0) {
				notifications.show({
					color: "blue",
					message: t("storageDatabaseNothingToCleanup"),
				});
			} else {
				notifications.show({
					color: "green",
					message: t("storageDatabaseCleanupSuccess", {
						target: getDatabaseTargetLabel(databaseTarget),
						count: cleanedCount,
						size: formatBytes(result.freedBytes),
					}),
				});
			}
			closeDatabasePreview();
			void handleScan();
		} catch (err) {
			console.error("Database cleanup failed:", err);
			notifications.show({
				color: "red",
				message:
					err instanceof Error && err.message ? err.message : t("storageDatabaseCleanupFailed"),
			});
		} finally {
			setDatabaseCleaning(false);
		}
	};

	const getCategory = (key: string): StorageCategoryResult | undefined =>
		scanResult?.categories.find((c) => c.key === key);

	const getCategorySubtext = (cat: StorageCategoryResult): string | null => {
		const d = cat.details;
		if (!d) return null;
		switch (cat.key) {
			case "database": {
				const details = getDatabaseBreakdown(cat);
				if (!details) return null;
				return t("storageDatabaseFiles", {
					main: formatBytes(details.mainBytes),
					wal: formatBytes(details.walBytes),
					shm: formatBytes(details.shmBytes),
				});
			}
			case "uploads":
				return t("storageNarratorDirs", { count: Number(d.narratorDirs ?? 0) });
			case "shares":
				return t("storageShareCount", { count: Number(d.shareCount ?? 0) });
			case "worktrees":
				return t("storageWorktreeCount", { count: Number(d.worktreeCount ?? 0) });
			case "containers":
				if (d.available === false) return t("storageContainersUnavailable");
				return null;
			default:
				return null;
		}
	};

	const cleanupCapability = (target: CleanupTarget | undefined) => {
		if (!target) {
			return {
				supported: true,
				reason: undefined,
				mode: undefined,
				alternative: undefined,
				preservesMessageImageRefs: undefined,
				route: "storage" as const,
			};
		}
		return cleanupOperationCapabilities[target.target];
	};

	const canCleanup = (key: string, target?: CleanupTarget): boolean => {
		const cat = getCategory(key);
		if (!cat) return false;
		const cleanupCap = cleanupCapability(target);
		if (cleanupCap.supported === false) return false;
		if (target?.target === "uploads" && cleanupCap.preservesMessageImageRefs === false)
			return false;
		if (key === "containers" && cat.details?.available === false) return false;
		return cat.sizeBytes > 0;
	};

	const databaseCategory = getCategory("database");
	const databaseDetails = getDatabaseBreakdown(databaseCategory);
	const databaseUnreleasedBytes =
		(databaseDetails?.freelistBytes ?? 0) + (databaseDetails?.walBytes ?? 0);
	const canVacuumDatabase = Boolean(databaseDetails) && databaseUnreleasedBytes > 0;
	const databaseUsageCategories =
		databaseDetails?.categories?.filter((category) => category.totalBytes > 0) ?? [];
	const databaseTopTables =
		databaseDetails?.topTables?.filter((table) => table.totalBytes > 0) ?? [];
	const databaseRows = databaseDetails
		? [
				{
					target: "archivedSessions" as const,
					summary: databaseDetails.cleanupCandidates.archivedSessions,
					description: t("storageDatabaseArchivedSessionsDesc"),
				},
				{
					target: "staleSessions" as const,
					summary: databaseDetails.cleanupCandidates.staleSessions,
					description: t("storageDatabaseStaleSessionsDesc", {
						days: databaseDetails.cleanupCandidates.staleSessions.retentionDays ?? 90,
					}),
				},
				{
					target: "apiRequestDumps" as const,
					summary: databaseDetails.cleanupCandidates.apiRequestDumps,
					description: t("storageDatabaseApiRequestDumpsDesc", {
						days: databaseDetails.cleanupCandidates.apiRequestDumps.retentionDays ?? 30,
					}),
				},
			]
		: [];

	const retentionOptions =
		databaseTarget && databaseTarget !== "archivedSessions"
			? DATABASE_TARGET_DAY_OPTIONS[databaseTarget].map((days) => ({
					value: days,
					label: t("storageDatabaseOlderThanDaysOption", { days }),
				}))
			: [];

	const databasePreviewCount = databasePreview ? getDatabaseCleanupCount(databasePreview) : 0;
	const databaseCleanupCapability = databaseTarget
		? databaseCleanupCapabilities[databaseTarget]
		: undefined;
	const databaseCleanupDisabledReason =
		databaseCleanupCapability?.supported === false
			? (databaseCleanupCapability.reason ?? t("storageDatabaseCleanupUnsupported"))
			: undefined;
	const vacuumDisabledReason =
		storageHealthDisabledReason ?? vacuumReason ?? t("storageDatabaseVacuumDisabled");

	return (
		<>
			<Stack gap="md">
				<Group justify="space-between" align="center">
					<div>
						{scanResult && (
							<>
								<Text size="sm" c="dimmed">
									{t("storageTotal")}
								</Text>
								<Text fw={600} size="lg">
									{formatBytes(scanResult.totalBytes)}
								</Text>
							</>
						)}
					</div>
					<Group gap="xs">
						{scanResult && (
							<Text size="xs" c="dimmed">
								{t("storageLastScanned", {
									time: formatLocaleTime(scanResult.scannedAt),
								})}
							</Text>
						)}
						<Button
							size="xs"
							variant="light"
							leftSection={scanning ? <Loader size={14} /> : <IconRefresh size={14} />}
							onClick={handleScan}
							disabled={scanning || !storageHealthReady || !scanSupported}
							title={!storageHealthReady || !scanSupported ? scanDisabledReason : undefined}
						>
							{scanning ? t("storageScanning") : scanResult ? t("storageRescan") : t("storageScan")}
						</Button>
					</Group>
				</Group>

				{storageHealthState === "loading" && (
					<Alert color="blue" variant="light">
						<Group gap="xs" wrap="nowrap">
							<Loader size="sm" />
							<Text size="sm">{storageHealthLoadingMessage}</Text>
						</Group>
					</Alert>
				)}

				{storageHealthState === "error" && (
					<Alert
						color="red"
						variant="light"
						title={t("storageHealthErrorTitle", {
							defaultValue: "Storage status unavailable",
						})}
					>
						<Stack gap="xs" align="flex-start">
							<Text size="sm">{storageHealthErrorMessage}</Text>
							<Button
								size="xs"
								variant="light"
								leftSection={<IconRefresh size={14} />}
								loading={storageHealthFetching}
								onClick={() => void handleStorageHealthRetry()}
							>
								{t("storageHealthRetry", { defaultValue: "Retry" })}
							</Button>
						</Stack>
					</Alert>
				)}

				{databaseUnsupportedReason && (
					<Alert color="yellow" variant="light" title={t("storageDatabaseOwnershipTitle")}>
						{databaseUnsupportedReason}
					</Alert>
				)}
				{databaseCompatibilityInfo && (
					<Text size="xs" c="dimmed">
						{databaseCompatibilityInfo}
					</Text>
				)}

				{storageHealthState === "capabilities" && !scanSupported && (
					<Alert color="yellow" variant="light" title={t("storageScanUnsupportedTitle")}>
						{scanDisabledReason}
					</Alert>
				)}

				{scanning && progressMsg && (
					<Text size="xs" c="dimmed">
						{t(`storageScanProgress_${progressMsg}`, { defaultValue: progressMsg })}
					</Text>
				)}

				{storageHealthReady && !scanResult && !scanning && (
					<Text size="sm" c="dimmed" ta="center" py="xl">
						{t("storageNotScanned")}
					</Text>
				)}

				{scanResult && (
					<Stack gap="xs">
						{["database", "uploads", "shares", "worktrees", "containers"].map((key) => {
							const cat = getCategory(key);
							if (!cat) return null;
							const color = CATEGORY_COLORS[key] ?? "gray";
							const pct =
								scanResult.totalBytes > 0 ? (cat.sizeBytes / scanResult.totalBytes) * 100 : 0;
							const subtext = getCategorySubtext(cat);
							const cleanupTarget = CLEANUP_TARGETS.find((ct) => ct.key === key);
							const cleanupCap = cleanupCapability(cleanupTarget);
							const cleanupUsesRuntime = usesRuntimeWorktreeCleanup(cleanupTarget);
							const cleanupUnsafeReason =
								cleanupTarget?.target === "uploads" &&
								cleanupCap.preservesMessageImageRefs === false
									? (cleanupCap.reason ?? t("storageCleanupUploadsUnsafe"))
									: null;
							const cleanupUnsupportedReason =
								cleanupCap.supported === false
									? (cleanupCap.reason ?? t("storageCleanupUnsupported"))
									: cleanupUnsafeReason;

							const cleanupDisabled = !canCleanup(key, cleanupTarget) || cleaningTarget === key;
							const isDatabase = key === "database";

							return (
								<Paper key={key} p="sm" radius="sm" withBorder>
									<Stack gap="sm">
										<Group justify="space-between" align="center" wrap="nowrap">
											<Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
												{CATEGORY_ICONS[key]}
												<div style={{ flex: 1, minWidth: 0 }}>
													<Group gap="xs" align="center" wrap="wrap">
														<Text size="sm" fw={500}>
															{t(`storage${key.charAt(0).toUpperCase() + key.slice(1)}` as never)}
														</Text>
														<Badge size="xs" variant="light" color={color}>
															{formatBytes(cat.sizeBytes)}
														</Badge>
													</Group>
													{subtext && (
														<Text size="xs" c="dimmed">
															{subtext}
														</Text>
													)}
													<Text size="xs" c="dimmed">
														{t(`storage${key.charAt(0).toUpperCase() + key.slice(1)}Desc` as never)}
													</Text>
													<Progress value={pct} color={color} size="xs" mt={4} radius="xl" />
												</div>
											</Group>
											{cleanupTarget && (
												<Tooltip
													label={
														cleanupUnsupportedReason ??
														(cleanupUsesRuntime
															? t("storageCleanupWorktreesRuntimeFallback")
															: t(cleanupTarget.labelKey as never))
													}
												>
													<span>
														<ActionIcon
															variant="subtle"
															color="red"
															size="sm"
															disabled={cleanupDisabled}
															loading={cleaningTarget === key}
															onClick={() => handleCleanup(cleanupTarget)}
														>
															<IconTrash size={14} />
														</ActionIcon>
													</span>
												</Tooltip>
											)}
										</Group>

										{isDatabase && databaseDetails && (
											<>
												<Divider />
												{databaseUsageCategories.length > 0 && (
													<Stack gap="xs">
														<Group justify="space-between" align="center" gap="xs">
															<Text size="sm" fw={500}>
																{t("storageDatabaseUsageTitle")}
															</Text>
															<Group gap="xs">
																{databaseDetails.scanMode && (
																	<Badge size="xs" variant="outline" color="gray">
																		{t(
																			`storageDatabaseScanMode_${databaseDetails.scanMode}` as never,
																		)}
																	</Badge>
																)}
																{vacuumSupported ? (
																	<Button
																		size="xs"
																		variant="light"
																		color="orange"
																		loading={databaseVacuuming}
																		disabled={!canVacuumDatabase || scanning}
																		onClick={handleDatabaseVacuum}
																	>
																		{t("storageDatabaseVacuum")}
																	</Button>
																) : (
																	<Tooltip label={vacuumDisabledReason}>
																		<span>
																			<Button size="xs" variant="light" color="orange" disabled>
																				{t("storageDatabaseVacuum")}
																			</Button>
																		</span>
																	</Tooltip>
																)}
															</Group>
														</Group>

														{databaseDetails.objectBytes != null && (
															<Text size="xs" c="dimmed">
																{t("storageDatabaseUsageDesc", {
																	objects: formatBytes(databaseDetails.objectBytes),
																	free: formatBytes(databaseDetails.freelistBytes ?? 0),
																})}
															</Text>
														)}
														<Stack gap={6}>
															{databaseUsageCategories.map((category) => (
																<Paper key={category.key} p="xs" radius="sm" bg="dark.6" withBorder>
																	<Group
																		justify="space-between"
																		align="flex-start"
																		gap="xs"
																		wrap="nowrap"
																	>
																		<div style={{ flex: 1, minWidth: 0 }}>
																			<Text size="sm" fw={500}>
																				{t(`storageDatabaseUsageCategory_${category.key}` as never)}
																			</Text>
																			<Text size="xs" c="dimmed">
																				{category.key === "free"
																					? t("storageDatabaseUsageFreeStats")
																					: t("storageDatabaseUsageCategoryStats", {
																							tables: category.tableCount,
																							rows: category.rowCount,
																							indexes: formatBytes(category.indexBytes),
																						})}
																			</Text>
																		</div>
																		<Badge variant="light" color="blue">
																			{formatBytes(category.totalBytes)}
																		</Badge>
																	</Group>
																</Paper>
															))}
														</Stack>
														{databaseTopTables.length > 0 && (
															<Text size="xs" c="dimmed">
																{t("storageDatabaseTopTables", {
																	tables: databaseTopTables
																		.slice(0, 5)
																		.map(
																			(table) => `${table.name} ${formatBytes(table.totalBytes)}`,
																		)
																		.join(" · "),
																})}
															</Text>
														)}
													</Stack>
												)}
												{databaseUsageCategories.length > 0 && <Divider />}
												<Stack gap="xs">
													{databaseRows.map((row) => (
														<Paper key={row.target} p="xs" radius="sm" bg="dark.6" withBorder>
															<Group
																justify="space-between"
																align="flex-start"
																gap="sm"
																wrap="nowrap"
															>
																<div style={{ flex: 1, minWidth: 0 }}>
																	<Group gap="xs" wrap="wrap">
																		<Text size="sm" fw={500}>
																			{getDatabaseTargetLabel(row.target)}
																		</Text>
																		<Badge size="xs" variant="light" color="blue">
																			{formatBytes(row.summary.approxBytes)}
																		</Badge>
																	</Group>
																	<Text size="xs" c="dimmed">
																		{row.description}
																	</Text>
																	<Group gap="xs" mt={4} wrap="wrap">
																		<Text size="xs" c="dimmed">
																			{row.target === "apiRequestDumps"
																				? t("storageDatabaseSummaryRequests", {
																						count: row.summary.count,
																					})
																				: t("storageDatabaseSummarySessions", {
																						count: row.summary.count,
																					})}
																		</Text>
																		{row.summary.oldestAt && (
																			<Text size="xs" c="dimmed">
																				{t("storageDatabaseSummaryOldest", {
																					time: formatDateTime(row.summary.oldestAt),
																				})}
																			</Text>
																		)}
																		{row.summary.blockedCount > 0 && (
																			<Text size="xs" c="yellow">
																				{t("storageDatabaseSummaryBlocked", {
																					count: row.summary.blockedCount,
																				})}
																			</Text>
																		)}
																	</Group>
																	{row.target === "apiRequestDumps" && requestDumpEnabled && (
																		<Group mt={6} gap={6} wrap="nowrap">
																			<IconInfoCircle size={14} />
																			<Text size="xs" c="dimmed">
																				{t("storageDatabaseDumpEnabledNote")}
																			</Text>
																		</Group>
																	)}
																</div>
																<Button
																	size="xs"
																	variant="light"
																	onClick={() => openDatabasePreview(row.target)}
																	disabled={!databasePreviewCapability.supported}
																	title={
																		!databasePreviewCapability.supported
																			? databasePreviewDisabledReason
																			: undefined
																	}
																>
																	{t("storageDatabasePreview")}
																</Button>
															</Group>
														</Paper>
													))}
												</Stack>
											</>
										)}
									</Stack>
								</Paper>
							);
						})}
					</Stack>
				)}
			</Stack>

			<Modal
				opened={!!databaseTarget}
				onClose={closeDatabasePreview}
				title={
					databaseTarget
						? t("storageDatabaseCleanupPreviewTitle", {
								target: getDatabaseTargetLabel(databaseTarget),
							})
						: t("storageDatabasePreview")
				}
				size="lg"
				centered
			>
				<Stack gap="md">
					{databaseTarget && databaseTarget !== "archivedSessions" && (
						<Select
							label={t("storageDatabaseOlderThanDays")}
							data={retentionOptions}
							value={String(databaseOlderThanDays)}
							onChange={(value) => {
								if (!value) return;
								setDatabaseOlderThanDays(Number(value));
							}}
						/>
					)}

					{requestDumpEnabled && databaseTarget === "apiRequestDumps" && (
						<Alert color="blue" icon={<IconInfoCircle size={16} />}>
							{t("storageDatabaseDumpEnabledNote")}
						</Alert>
					)}

					{databaseCleanupDisabledReason && (
						<Alert color="yellow" title={t("storageDatabaseCleanupUnsupportedTitle")}>
							{databaseCleanupDisabledReason}
						</Alert>
					)}

					{!databasePreviewCapability.supported && (
						<Alert color="yellow" title={t("storageDatabasePreviewUnsupportedTitle")}>
							{databasePreviewDisabledReason}
						</Alert>
					)}

					{databasePreview?.warningCodes.includes("deletesUsageHistory") && (
						<Alert color="orange" icon={<IconAlertTriangle size={16} />}>
							{t("storageDatabaseWillDeleteUsageHistory")}
						</Alert>
					)}

					{databasePreview?.fallback && fallbackDiagnosticMessage(databasePreview) && (
						<Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
							{fallbackDiagnosticMessage(databasePreview)}
						</Alert>
					)}

					{databasePreviewLoading ? (
						<Group justify="center" py="xl">
							<Loader size="sm" />
							<Text size="sm" c="dimmed">
								{t("storageDatabasePreviewLoading")}
							</Text>
						</Group>
					) : databasePreviewError ? (
						<Alert color="red">{databasePreviewError}</Alert>
					) : databasePreview ? (
						<Stack gap="md">
							<Group gap="xs" wrap="wrap">
								<Badge variant="light" color="blue">
									{formatBytes(databasePreview.approxBytes)}
								</Badge>
								{databasePreview.oldestAt && (
									<Badge variant="light" color="gray">
										{t("storageDatabaseSummaryOldest", {
											time: formatDateTime(databasePreview.oldestAt),
										})}
									</Badge>
								)}
								{databasePreview.blockedCount > 0 && (
									<Badge variant="light" color="yellow">
										{t("storageDatabaseSummaryBlocked", {
											count: databasePreview.blockedCount,
										})}
									</Badge>
								)}
							</Group>

							<Group gap="xs" wrap="wrap">
								{databasePreview.target === "apiRequestDumps" ? (
									<Text size="sm" c="dimmed">
										{t("storageDatabaseCountsDumps", {
											count: databasePreview.counts.dumpsCleared,
										})}
									</Text>
								) : (
									<>
										<Text size="sm" c="dimmed">
											{t("storageDatabaseCountsSessions", {
												count: databasePreview.counts.sessions,
											})}
										</Text>
										<Text size="sm" c="dimmed">
											{t("storageDatabaseCountsNarrators", {
												count: databasePreview.counts.narrators,
											})}
										</Text>
										<Text size="sm" c="dimmed">
											{t("storageDatabaseCountsMessages", {
												count: databasePreview.counts.messages,
											})}
										</Text>
										<Text size="sm" c="dimmed">
											{t("storageDatabaseCountsToolCalls", {
												count: databasePreview.counts.toolCalls,
											})}
										</Text>
										<Text size="sm" c="dimmed">
											{t("storageDatabaseCountsApiRequests", {
												count: databasePreview.counts.apiRequests,
											})}
										</Text>
										{databasePreview.counts.descendantNarrators > 0 && (
											<Text size="sm" c="dimmed">
												{t("storageDatabaseCountsDescendants", {
													count: databasePreview.counts.descendantNarrators,
												})}
											</Text>
										)}
									</>
								)}
							</Group>

							<Divider />

							{databasePreview.samples.length > 0 ? (
								<Stack gap="xs">
									<Text fw={500} size="sm">
										{databasePreview.target === "apiRequestDumps"
											? t("storageDatabaseSampleRequests")
											: t("storageDatabaseSampleSessions")}
									</Text>
									<Stack gap="xs" style={{ maxHeight: 260, overflow: "auto" }}>
										{databasePreview.samples.map((sample) =>
											isNarratorSample(sample) ? (
												<Paper key={sample.id} p="xs" withBorder>
													<Group justify="space-between" align="flex-start" wrap="nowrap">
														<div style={{ flex: 1, minWidth: 0 }}>
															<Text size="sm" fw={500} truncate>
																{sample.title || sample.id.slice(0, 8)}
															</Text>
															<Group gap="xs" wrap="wrap" mt={4}>
																<Text size="xs" c="dimmed">
																	{t("storageDatabaseLastActivity", {
																		time: formatDateTime(sample.lastActivityAt),
																	})}
																</Text>
																<Text size="xs" c="dimmed">
																	{t("storageDatabaseMessageCount", {
																		count: sample.messageCount ?? 0,
																	})}
																</Text>
																{sample.descendantNarratorCount > 0 && (
																	<Text size="xs" c="dimmed">
																		{t("storageDatabaseDescendantCount", {
																			count: sample.descendantNarratorCount,
																		})}
																	</Text>
																)}
															</Group>
															{fallbackDiagnosticMessage(sample) && (
																<Text size="xs" c="orange" mt={4}>
																	{fallbackDiagnosticMessage(sample)}
																</Text>
															)}
														</div>
														<Badge variant="light" color="blue">
															{formatBytes(sample.approxBytes ?? 0)}
														</Badge>
													</Group>
												</Paper>
											) : isApiRequestSample(sample) ? (
												<Paper key={sample.id} p="xs" withBorder>
													<Group justify="space-between" align="flex-start" wrap="nowrap">
														<div style={{ flex: 1, minWidth: 0 }}>
															<Text size="sm" fw={500} truncate>
																{sample.narratorTitle || sample.narratorId || sample.id.slice(0, 8)}
															</Text>
															<Group gap="xs" wrap="wrap" mt={4}>
																{sample.chapterTitle && (
																	<Text size="xs" c="dimmed">
																		{sample.chapterTitle}
																	</Text>
																)}
																<Text size="xs" c="dimmed">
																	{t("storageDatabaseCreatedAt", {
																		time: formatDateTime(sample.createdAt),
																	})}
																</Text>
															</Group>
															{fallbackDiagnosticMessage(sample) && (
																<Text size="xs" c="orange" mt={4}>
																	{fallbackDiagnosticMessage(sample)}
																</Text>
															)}
														</div>
														<Badge variant="light" color="blue">
															{formatBytes(sample.approxBytes)}
														</Badge>
													</Group>
												</Paper>
											) : null,
										)}
									</Stack>
								</Stack>
							) : (
								<Text size="sm" c="dimmed">
									{t("storageDatabaseNoCandidates")}
								</Text>
							)}

							{databasePreview.blockedCount > 0 && (
								<Stack gap="xs">
									<Text fw={500} size="sm">
										{t("storageDatabaseBlocked")}
									</Text>
									<Stack gap="xs">
										{databasePreview.blocked.map((item: DatabaseCleanupBlockedItem) => (
											<Paper key={item.narratorId} p="xs" withBorder>
												<Text size="sm" fw={500}>
													{item.title || item.narratorId.slice(0, 8)}
												</Text>
												<Text size="xs" c="dimmed" mt={4}>
													{formatBlockedReason(item)}
												</Text>
											</Paper>
										))}
									</Stack>
									{databasePreview.blockedCount > databasePreview.blocked.length && (
										<Text size="xs" c="dimmed">
											{t("storageDatabaseBlockedMore", {
												count: databasePreview.blockedCount - databasePreview.blocked.length,
											})}
										</Text>
									)}
								</Stack>
							)}

							<Group justify="flex-end" gap="xs">
								<Button variant="subtle" onClick={closeDatabasePreview}>
									{t("storageDatabaseClose")}
								</Button>
								<Button
									color="red"
									leftSection={<IconTrash size={16} />}
									onClick={handleDatabaseCleanup}
									loading={databaseCleaning}
									disabled={databasePreviewCount === 0 || !!databaseCleanupDisabledReason}
									title={databaseCleanupDisabledReason}
								>
									{t("storageDatabaseCleanupAction")}
								</Button>
							</Group>
						</Stack>
					) : null}
				</Stack>
			</Modal>
		</>
	);

	function getDatabaseTargetLabel(target: DatabaseCleanupTarget): string {
		return t(`storageDatabaseTarget_${target}`);
	}

	function getDatabaseCleanupCount(
		result: DatabaseCleanupPreviewResult | DatabaseCleanupExecutionResult,
	): number {
		return result.target === "apiRequestDumps"
			? result.counts.dumpsCleared
			: result.counts.sessions;
	}

	function formatBlockedReason(item: DatabaseCleanupBlockedItem): string {
		const reason = t(`storageDatabaseBlockedReason_${item.reasonCode}`);
		const blockingName = item.blockingTitle || item.blockingNarratorId.slice(0, 8);
		if (item.blockingNarratorId === item.narratorId) {
			return reason;
		}
		return t("storageDatabaseBlockedReasonWithItem", {
			reason,
			name: blockingName,
		});
	}
}
