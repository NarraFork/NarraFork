import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconBox, IconBrowser, IconRefresh, IconTerminal2, IconTrash } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type RuntimeScanResult } from "../../lib/api";

export function RuntimeSection() {
	const { t } = useTranslation("settings");
	const [scanResult, setScanResult] = useState<RuntimeScanResult | null>(null);
	const [scanning, setScanning] = useState(false);
	const [cleaningTarget, setCleaningTarget] = useState<string | null>(null);

	// Load cached result on mount
	useEffect(() => {
		let cancelled = false;
		api
			.getCachedRuntime()
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
		try {
			const result = await api.scanRuntime();
			setScanResult(result);
		} catch (err) {
			console.error("Runtime scan failed:", err);
			notifications.show({
				color: "red",
				message: t("runtimeScanFailed"),
			});
		} finally {
			setScanning(false);
		}
	};

	const handleCleanup = async (target: "terminals" | "containers" | "browsers") => {
		if (!window.confirm(t("runtimeCleanupConfirm"))) return;
		setCleaningTarget(target);
		try {
			const res = await api.cleanupRuntime(target);
			if (res.ok) {
				if (target === "terminals") {
					notifications.show({
						message: t("runtimeCleanupTerminalsSuccess", { count: res.killed ?? 0 }),
						color: "green",
					});
				} else if (target === "containers") {
					notifications.show({
						message: t("runtimeCleanupContainersSuccess", { count: res.stopped ?? 0 }),
						color: "green",
					});
				} else if (target === "browsers") {
					notifications.show({
						message: t("runtimeCleanupBrowsersSuccess", {
							count: res.closedSessions ?? 0,
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
				message: t("runtimeCleanupFailed"),
			});
		} finally {
			setCleaningTarget(null);
		}
	};

	const term = scanResult?.terminals;
	const cont = scanResult?.containers;
	const brow = scanResult?.browsers;

	const canCleanTerminals = term ? term.exited > 0 || term.orphanSockets > 0 : false;
	const canCleanContainers = cont ? cont.running > 0 : false;
	const canCleanBrowsers = brow ? brow.processRunning || brow.activeSessions > 0 : false;

	return (
		<Stack gap="md">
			{/* Header */}
			<Group justify="space-between" align="center">
				<div />
				<Group gap="xs">
					{scanResult && (
						<Text size="xs" c="dimmed">
							{t("runtimeLastScanned", {
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
						{scanning ? t("runtimeScanning") : scanResult ? t("runtimeRescan") : t("runtimeScan")}
					</Button>
				</Group>
			</Group>

			{/* Not scanned yet */}
			{!scanResult && !scanning && (
				<Text size="sm" c="dimmed" ta="center" py="xl">
					{t("runtimeNotScanned")}
				</Text>
			)}

			{/* Resource cards */}
			{scanResult && (
				<Stack gap="xs">
					{/* Terminals */}
					<Paper p="sm" radius="sm" withBorder>
						<Group justify="space-between" align="center" wrap="nowrap">
							<Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
								<IconTerminal2 size={18} />
								<div style={{ flex: 1, minWidth: 0 }}>
									<Group gap="xs" align="center">
										<Text size="sm" fw={500}>
											{t("runtimeTerminals")}
										</Text>
										{term && term.running > 0 && (
											<Badge size="xs" variant="light" color="green">
												{t("runtimeTerminalsRunning", {
													count: term.running,
												})}
											</Badge>
										)}
										{term && term.exited > 0 && (
											<Badge size="xs" variant="light" color="gray">
												{t("runtimeTerminalsExited", {
													count: term.exited,
												})}
											</Badge>
										)}
										{term && term.orphanSockets > 0 && (
											<Badge size="xs" variant="light" color="orange">
												{t("runtimeTerminalsOrphan", {
													count: term.orphanSockets,
												})}
											</Badge>
										)}
										{term &&
											term.running === 0 &&
											term.exited === 0 &&
											term.orphanSockets === 0 && (
												<Text size="xs" c="dimmed">
													{t("runtimeNone")}
												</Text>
											)}
									</Group>
									<Text size="xs" c="dimmed">
										{t("runtimeTerminalsDesc")}
									</Text>
								</div>
							</Group>
							<Tooltip label={t("runtimeCleanupTerminals")}>
								<ActionIcon
									variant="subtle"
									color="red"
									size="sm"
									disabled={!canCleanTerminals || cleaningTarget === "terminals"}
									loading={cleaningTarget === "terminals"}
									onClick={() => handleCleanup("terminals")}
								>
									<IconTrash size={14} />
								</ActionIcon>
							</Tooltip>
						</Group>
					</Paper>

					{/* Containers */}
					<Paper p="sm" radius="sm" withBorder>
						<Group justify="space-between" align="center" wrap="nowrap">
							<Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
								<IconBox size={18} />
								<div style={{ flex: 1, minWidth: 0 }}>
									<Group gap="xs" align="center">
										<Text size="sm" fw={500}>
											{t("runtimeContainers")}
										</Text>
										{cont?.podmanAvailable ? (
											<>
												{cont.running > 0 && (
													<Badge size="xs" variant="light" color="green">
														{t("runtimeContainersRunning", {
															count: cont.running,
														})}
													</Badge>
												)}
												{cont.stopped > 0 && (
													<Badge size="xs" variant="light" color="gray">
														{t("runtimeContainersStopped", {
															count: cont.stopped,
														})}
													</Badge>
												)}
												{cont.running === 0 && cont.stopped === 0 && (
													<Text size="xs" c="dimmed">
														{t("runtimeNone")}
													</Text>
												)}
											</>
										) : (
											<Text size="xs" c="dimmed">
												{t("runtimeContainersUnavailable")}
											</Text>
										)}
									</Group>
									<Text size="xs" c="dimmed">
										{t("runtimeContainersDesc")}
									</Text>
								</div>
							</Group>
							<Tooltip label={t("runtimeCleanupContainers")}>
								<ActionIcon
									variant="subtle"
									color="red"
									size="sm"
									disabled={!canCleanContainers || cleaningTarget === "containers"}
									loading={cleaningTarget === "containers"}
									onClick={() => handleCleanup("containers")}
								>
									<IconTrash size={14} />
								</ActionIcon>
							</Tooltip>
						</Group>
					</Paper>

					{/* Browsers */}
					<Paper p="sm" radius="sm" withBorder>
						<Group justify="space-between" align="center" wrap="nowrap">
							<Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
								<IconBrowser size={18} />
								<div style={{ flex: 1, minWidth: 0 }}>
									<Group gap="xs" align="center">
										<Text size="sm" fw={500}>
											{t("runtimeBrowsers")}
										</Text>
										<Badge
											size="xs"
											variant="light"
											color={brow?.processRunning ? "green" : "gray"}
										>
											{t("runtimeBrowserProcess", {
												status: brow?.processRunning
													? t("runtimeBrowserProcessRunning")
													: t("runtimeBrowserProcessStopped"),
											})}
										</Badge>
										{brow && brow.activeSessions > 0 && (
											<Badge size="xs" variant="light" color="blue">
												{t("runtimeBrowserSessions", {
													count: brow.activeSessions,
												})}
											</Badge>
										)}
									</Group>
									<Text size="xs" c="dimmed">
										{t("runtimeBrowsersDesc")}
									</Text>
								</div>
							</Group>
							<Tooltip label={t("runtimeCleanupBrowsers")}>
								<ActionIcon
									variant="subtle"
									color="red"
									size="sm"
									disabled={!canCleanBrowsers || cleaningTarget === "browsers"}
									loading={cleaningTarget === "browsers"}
									onClick={() => handleCleanup("browsers")}
								>
									<IconTrash size={14} />
								</ActionIcon>
							</Tooltip>
						</Group>
					</Paper>
				</Stack>
			)}
		</Stack>
	);
}
