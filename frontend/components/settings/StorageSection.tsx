import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Loader,
	Paper,
	Progress,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconBox,
	IconDatabase,
	IconGitBranch,
	IconPhoto,
	IconRefresh,
	IconShare,
	IconTrash,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	api,
	type StorageCategoryResult,
	type StorageScanResult,
	scanStorageStream,
} from "../../lib/api";

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const val = bytes / 1024 ** i;
	return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
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
	const [scanResult, setScanResult] = useState<StorageScanResult | null>(null);
	const [scanning, setScanning] = useState(false);
	const [progressMsg, setProgressMsg] = useState("");
	const [cleaningTarget, setCleaningTarget] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	// Load cached result on mount
	useEffect(() => {
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
	}, []);

	const handleScan = async () => {
		if (scanning) return;
		setScanning(true);
		setProgressMsg("");
		abortRef.current = new AbortController();

		try {
			const result = await scanStorageStream({
				onProgress: (msg) => setProgressMsg(msg),
				onCategory: (cat) => {
					// Incrementally update categories as they arrive
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
					message: t("storageScanFailed"),
				});
			}
		} finally {
			setScanning(false);
			setProgressMsg("");
		}
	};

	const handleCleanup = async (target: CleanupTarget) => {
		if (!window.confirm(t("storageCleanupConfirm"))) return;
		setCleaningTarget(target.key);
		try {
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
				// Re-scan after cleanup
				void handleScan();
			}
		} catch (err) {
			console.error("Cleanup failed:", err);
			notifications.show({
				color: "red",
				message: t("storageCleanupFailed"),
			});
		} finally {
			setCleaningTarget(null);
		}
	};

	const getCategory = (key: string): StorageCategoryResult | undefined =>
		scanResult?.categories.find((c) => c.key === key);

	const getCategorySubtext = (cat: StorageCategoryResult): string | null => {
		const d = cat.details;
		if (!d) return null;
		switch (cat.key) {
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

	const canCleanup = (key: string): boolean => {
		const cat = getCategory(key);
		if (!cat) return false;
		if (key === "containers" && cat.details?.available === false) return false;
		return cat.sizeBytes > 0;
	};

	return (
		<Stack gap="md">
			{/* Header: total + scan button */}
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
								time: new Date(scanResult.scannedAt).toLocaleTimeString(),
							})}
						</Text>
					)}
					<Button
						size="xs"
						variant="light"
						leftSection={scanning ? <Loader size={14} /> : <IconRefresh size={14} />}
						onClick={handleScan}
						disabled={scanning}
					>
						{scanning ? t("storageScanning") : scanResult ? t("storageRescan") : t("storageScan")}
					</Button>
				</Group>
			</Group>

			{/* Progress message during scan */}
			{scanning && progressMsg && (
				<Text size="xs" c="dimmed">
					{t(`storageScanProgress_${progressMsg}`, { defaultValue: progressMsg })}
				</Text>
			)}

			{/* Not scanned yet */}
			{!scanResult && !scanning && (
				<Text size="sm" c="dimmed" ta="center" py="xl">
					{t("storageNotScanned")}
				</Text>
			)}

			{/* Category cards */}
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

						return (
							<Paper key={key} p="sm" radius="sm" withBorder>
								<Group justify="space-between" align="center" wrap="nowrap">
									<Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
										{CATEGORY_ICONS[key]}
										<div style={{ flex: 1, minWidth: 0 }}>
											<Group gap="xs" align="center">
												<Text size="sm" fw={500}>
													{t(`storage${key.charAt(0).toUpperCase() + key.slice(1)}` as never)}
												</Text>
												<Badge size="xs" variant="light" color={color}>
													{formatBytes(cat.sizeBytes)}
												</Badge>
												{subtext && (
													<Text size="xs" c="dimmed">
														{subtext}
													</Text>
												)}
											</Group>
											<Text size="xs" c="dimmed">
												{t(`storage${key.charAt(0).toUpperCase() + key.slice(1)}Desc` as never)}
											</Text>
											<Progress value={pct} color={color} size="xs" mt={4} radius="xl" />
										</div>
									</Group>
									{cleanupTarget && (
										<Tooltip label={t(cleanupTarget.labelKey as never)}>
											<ActionIcon
												variant="subtle"
												color="red"
												size="sm"
												disabled={!canCleanup(key) || cleaningTarget === key}
												loading={cleaningTarget === key}
												onClick={() => handleCleanup(cleanupTarget)}
											>
												<IconTrash size={14} />
											</ActionIcon>
										</Tooltip>
									)}
								</Group>
							</Paper>
						);
					})}
				</Stack>
			)}
		</Stack>
	);
}
