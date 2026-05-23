import {
	ActionIcon,
	Alert,
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
import {
	useBenchmarkContainerExecutionCapability,
	useRuntimeMaintenanceCapability,
	useVNetCapability,
} from "../../hooks/usePlatform";
import { api, type RuntimeScanResult } from "../../lib/api";
import { useConfirmDialog } from "../common/ConfirmDialogProvider";

function runtimeDiagnosticMessage(value?: {
	reason?: string;
	message?: string;
	error?: string;
	code?: string;
	dbError?: string;
}): string | undefined {
	return value?.reason ?? value?.message ?? value?.error ?? value?.code ?? value?.dbError;
}

export function RuntimeSection() {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const benchmarkCapability = useBenchmarkContainerExecutionCapability();
	const benchmarkUnsupportedReason = benchmarkCapability.supported
		? undefined
		: (benchmarkCapability.reason ?? t("runtimeBenchmarkContainerExecutionUnsupported"));
	const vnetCapability = useVNetCapability();
	const vnetUnsupportedReason = vnetCapability.supported
		? undefined
		: (vnetCapability.reason ?? t("runtimeVNetUnsupported"));
	const vnetUdpInfo = vnetCapability.udpRendezvous
		? t("runtimeVNetUdpEnabled")
		: (vnetCapability.udpRendezvousReason ?? t("runtimeVNetUdpDisabled"));
	const vnetModeInfo =
		vnetCapability.supported && (vnetCapability.mode || !vnetCapability.udpRendezvous)
			? t("runtimeVNetModeInfo", {
					mode: vnetCapability.mode ?? t("runtimeVNetModeUnknown"),
					udp: vnetUdpInfo,
				})
			: undefined;
	const { scanSupported, scanReason, cachedSupported, cleanup } = useRuntimeMaintenanceCapability();
	const runtimeScanDisabledReason = scanReason ?? t("runtimeScanUnsupported");

	const terminalsCleanupCapability = cleanup.terminals;
	const terminalsCleanupDisabledReason = terminalsCleanupCapability.supported
		? undefined
		: (terminalsCleanupCapability.reason ?? t("runtimeCleanupTerminalsUnsupported"));
	const containersCleanupCapability = cleanup.containers;
	const containersCleanupDisabledReason = containersCleanupCapability.supported
		? undefined
		: (containersCleanupCapability.reason ?? t("runtimeCleanupContainersUnsupported"));
	const browsersCleanupCapability = cleanup.browsers;
	const browsersCleanupDisabledReason = browsersCleanupCapability.supported
		? undefined
		: (browsersCleanupCapability.reason ?? t("runtimeCleanupBrowsersUnsupported"));
	const [scanResult, setScanResult] = useState<RuntimeScanResult | null>(null);
	const [scanning, setScanning] = useState(false);
	const [cleaningTarget, setCleaningTarget] = useState<string | null>(null);

	// Load cached result on mount
	useEffect(() => {
		if (!cachedSupported) return;
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
	}, [cachedSupported]);

	const handleScan = async () => {
		if (scanning || !scanSupported) return;
		setScanning(true);
		try {
			const result = await api.scanRuntime();
			setScanResult(result);
		} catch (err) {
			console.error("Runtime scan failed:", err);
			notifications.show({
				color: "red",
				message: err instanceof Error && err.message ? err.message : t("runtimeScanFailed"),
			});
		} finally {
			setScanning(false);
		}
	};

	const handleCleanup = async (target: "terminals" | "containers" | "browsers") => {
		const targetCapability = cleanup[target];
		if (!targetCapability.supported) return;
		if (!(await confirm({ message: t("runtimeCleanupConfirm") }))) return;
		setCleaningTarget(target);
		try {
			const res = await api.cleanupRuntime(target);
			if (res.dryRun) {
				notifications.show({
					message: t("runtimeCleanupPreviewOnly"),
					color: "yellow",
				});
				return;
			}
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
			} else {
				notifications.show({
					color: "red",
					message: res.errors?.[0]?.error ?? t("runtimeCleanupFailed"),
				});
			}
		} catch (err) {
			console.error("Cleanup failed:", err);
			notifications.show({
				color: "red",
				message: err instanceof Error && err.message ? err.message : t("runtimeCleanupFailed"),
			});
		} finally {
			setCleaningTarget(null);
		}
	};

	const term = scanResult?.terminals;
	const cont = scanResult?.containers;
	const brow = scanResult?.browsers;
	const terminalDiagnostic = runtimeDiagnosticMessage(term);
	const containerDiagnostic = runtimeDiagnosticMessage(cont);
	const browserDiagnostic = runtimeDiagnosticMessage(brow);

	const canCleanTerminals =
		terminalsCleanupCapability.supported && term
			? term.exited > 0 || term.orphanSockets > 0
			: false;
	const canCleanContainers =
		containersCleanupCapability.supported && cont ? cont.running > 0 : false;
	const canCleanBrowsers =
		browsersCleanupCapability.supported && brow
			? brow.processRunning || brow.activeSessions > 0
			: false;

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
						disabled={scanning || !scanSupported}
						title={!scanSupported ? runtimeScanDisabledReason : undefined}
					>
						{scanning ? t("runtimeScanning") : scanResult ? t("runtimeRescan") : t("runtimeScan")}
					</Button>
				</Group>
			</Group>

			{benchmarkUnsupportedReason && (
				<Alert
					color="yellow"
					variant="light"
					title={t("runtimeBenchmarkContainerExecutionUnsupported")}
				>
					{benchmarkUnsupportedReason}
				</Alert>
			)}

			{vnetUnsupportedReason && (
				<Alert color="yellow" variant="light" title={t("runtimeVNetUnsupported")}>
					{vnetUnsupportedReason}
				</Alert>
			)}
			{vnetModeInfo && (
				<Alert color="blue" variant="light" title={t("runtimeVNetModeTitle")}>
					{vnetModeInfo}
				</Alert>
			)}

			{!scanSupported && (
				<Alert color="yellow" variant="light" title={t("runtimeScanUnsupportedTitle")}>
					{runtimeScanDisabledReason}
				</Alert>
			)}

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
									{terminalDiagnostic && (
										<Text size="xs" c="orange">
											{terminalDiagnostic}
										</Text>
									)}
								</div>
							</Group>
							<Tooltip label={terminalsCleanupDisabledReason ?? t("runtimeCleanupTerminals")}>
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
												{containerDiagnostic ?? t("runtimeContainersUnavailable")}
											</Text>
										)}
									</Group>
									<Text size="xs" c="dimmed">
										{t("runtimeContainersDesc")}
									</Text>
									{containerDiagnostic && cont?.podmanAvailable && (
										<Text size="xs" c="orange">
											{containerDiagnostic}
										</Text>
									)}
								</div>
							</Group>
							<Tooltip label={containersCleanupDisabledReason ?? t("runtimeCleanupContainers")}>
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
									{browserDiagnostic && (
										<Text size="xs" c="orange">
											{browserDiagnostic}
										</Text>
									)}
								</div>
							</Group>
							<Tooltip label={browsersCleanupDisabledReason ?? t("runtimeCleanupBrowsers")}>
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
