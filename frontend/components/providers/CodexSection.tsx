import {
	ActionIcon,
	Badge,
	Button,
	Collapse,
	Group,
	Modal,
	NumberInput,
	Paper,
	SegmentedControl,
	Stack,
	Table,
	Text,
	Textarea,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconDeviceFloppy,
	IconEye,
	IconEyeOff,
	IconPencil,
	IconRefresh,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

// Hardcoded Codex models (no API to fetch them)
const BUILTIN_CODEX_MODELS = [
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.2",
	"gpt-5.1-codex",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
];

function relativeTime(iso: string | undefined): string {
	if (!iso) return "-";
	const diff = Date.now() - new Date(iso).getTime();
	if (diff < 60_000) return "<1m ago";
	if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
	return `${Math.floor(diff / 86400_000)}d ago`;
}

interface CodexSectionProps {
	hiddenModels: string[];
	onToggleHidden: (modelVal: string) => void;
}

export function CodexSection({ hiddenModels, onToggleHidden }: CodexSectionProps) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const [expanded, setExpanded] = useState(true);
	const [browserAuthLoading, setBrowserAuthLoading] = useState(false);
	const [deviceAuthModal, setDeviceAuthModal] = useState(false);
	const [deviceAuthData, setDeviceAuthData] = useState<{
		userCode: string;
		verificationUrl: string;
	} | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editForm, setEditForm] = useState<{
		displayName: string;
		priority: number;
	}>({ displayName: "", priority: 0 });
	const [globalProxy, setGlobalProxy] = useState("");
	const [globalProxyInitialized, setGlobalProxyInitialized] = useState(false);
	const [importJson, setImportJson] = useState("");
	const [importError, setImportError] = useState<string | null>(null);
	const [importResult, setImportResult] = useState<string | null>(null);

	const { data: status } = useQuery({
		queryKey: ["codex", "status"],
		queryFn: api.codexStatus,
		refetchInterval: 30_000,
	});

	// Initialize global proxy from status
	if (status?.globalProxy && !globalProxyInitialized) {
		setGlobalProxy(status.globalProxy);
		setGlobalProxyInitialized(true);
	}

	const entries = status?.entries ?? [];
	const loadBalancingMode = status?.loadBalancingMode ?? "priority";

	// Mutations
	const disableMut = useMutation({
		mutationFn: (id: string) => api.codexCredentialDisable(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["codex", "status"] }),
	});
	const enableMut = useMutation({
		mutationFn: (id: string) => api.codexCredentialEnable(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["codex", "status"] }),
	});
	const resetMut = useMutation({
		mutationFn: (id: string) => api.codexCredentialReset(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["codex", "status"] }),
	});
	const deleteMut = useMutation({
		mutationFn: (id: string) => api.codexCredentialDelete(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["codex", "status"] }),
	});
	const refreshMut = useMutation({
		mutationFn: (id: string) => api.codexCredentialRefresh(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			notifications.show({ message: t("codexRefreshSuccess"), color: "green" });
		},
		onError: (err: Error) => {
			notifications.show({ message: err.message, color: "red" });
		},
	});
	const updateMut = useMutation({
		mutationFn: ({ id, data }: { id: string; data: { displayName?: string; priority?: number } }) =>
			api.codexCredentialUpdate(id, data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			setEditingId(null);
			notifications.show({ message: t("codexUpdateSuccess"), color: "green" });
		},
	});
	const lbModeMut = useMutation({
		mutationFn: (mode: "priority" | "balanced") => api.codexSetLoadBalancingMode(mode),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["codex", "status"] }),
	});
	const globalProxyMut = useMutation({
		mutationFn: (proxy?: string) => api.codexSetGlobalProxy(proxy),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			notifications.show({ message: t("codexProxyUpdated"), color: "green" });
		},
	});
	const importMut = useMutation({
		mutationFn: (
			credentials: Array<{
				refreshToken: string;
				displayName?: string;
				priority?: number;
				proxy?: string;
			}>,
		) => api.codexImportCredentials(credentials),
		onSuccess: (data) => {
			setImportResult(t("codexImportSuccess", { added: data.added, duplicates: data.duplicates }));
			setImportError(null);
			setImportJson("");
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
		},
		onError: (err: Error) => {
			setImportError(err.message);
			setImportResult(null);
		},
	});

	const handleBrowserAuth = async () => {
		setBrowserAuthLoading(true);
		try {
			const result = await api.codexBrowserAuth();
			window.open(result.authorizeUrl, "_blank");
			notifications.show({
				message: t("codexBrowserAuthStarted"),
				color: "blue",
			});
		} catch (err) {
			notifications.show({
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		} finally {
			setBrowserAuthLoading(false);
		}
	};

	const handleDeviceAuth = async () => {
		try {
			const result = await api.codexDeviceAuthStart();
			setDeviceAuthData({
				userCode: result.userCode,
				verificationUrl: result.verificationUrl,
			});
			setDeviceAuthModal(true);
			// Start polling
			pollDeviceAuth();
		} catch (err) {
			notifications.show({
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		}
	};

	const pollDeviceAuth = async () => {
		const interval = setInterval(async () => {
			try {
				const result = await api.codexDeviceAuthPoll();
				if (!result.pending) {
					clearInterval(interval);
					setDeviceAuthModal(false);
					setDeviceAuthData(null);
					qc.invalidateQueries({ queryKey: ["codex", "status"] });
					notifications.show({
						message: t("codexDeviceAuthSuccess"),
						color: "green",
					});
				}
			} catch {
				clearInterval(interval);
			}
		}, 3000);
	};

	const handleEdit = (entry: (typeof entries)[0]) => {
		setEditingId(entry.id);
		setEditForm({
			displayName: entry.displayName ?? "",
			priority: entry.priority,
		});
	};

	const handleSaveEdit = () => {
		if (!editingId) return;
		const data: { displayName?: string; priority?: number } = {
			displayName: editForm.displayName || undefined,
			priority: editForm.priority,
		};
		updateMut.mutate({ id: editingId, data });
	};

	const handleSaveGlobalProxy = () => {
		globalProxyMut.mutate(globalProxy || undefined);
	};

	const handleImport = () => {
		setImportError(null);
		setImportResult(null);
		try {
			const parsed = JSON.parse(importJson);
			const arr = Array.isArray(parsed) ? parsed : [parsed];

			// Transform the input format to our API format
			const credentials = arr.map((item: any) => {
				// Support both formats:
				// 1. Direct format: { refreshToken, displayName?, priority? }
				// 2. Extended format: { type: "codex", refresh_token, email?, ... }
				if (item.refresh_token) {
					return {
						refreshToken: item.refresh_token,
						displayName: item.email || item.displayName,
						priority: item.priority,
					};
				}
				return {
					refreshToken: item.refreshToken,
					displayName: item.displayName,
					priority: item.priority,
				};
			});

			importMut.mutate(credentials);
		} catch (_err) {
			setImportError(t("codexImportInvalidJson"));
		}
	};

	return (
		<Paper p="md" withBorder>
			<Stack gap="md">
				<Group
					justify="space-between"
					style={{ cursor: "pointer" }}
					onClick={() => setExpanded(!expanded)}
				>
					<Group gap="xs">
						{expanded ? <IconChevronDown size={20} /> : <IconChevronRight size={20} />}
						<Title order={4}>{t("codexTitle")}</Title>
					</Group>
					<Badge size="sm" color={status?.available ? "green" : "gray"}>
						{status?.available ?? 0} / {status?.total ?? 0}
					</Badge>
				</Group>

				<Collapse in={expanded}>
					<Stack gap="md">
						<Text size="sm" c="dimmed">
							{t("codexDescription")}
						</Text>

						{/* Global settings */}
						<Stack gap="xs">
							<Group justify="space-between">
								<Text size="sm" fw={500}>
									{t("codexGlobalSettings")}
								</Text>
								<SegmentedControl
									size="xs"
									value={loadBalancingMode}
									onChange={(v) => lbModeMut.mutate(v as "priority" | "balanced")}
									data={[
										{ label: t("codexModePriority"), value: "priority" },
										{ label: t("codexModeBalanced"), value: "balanced" },
									]}
								/>
							</Group>
							<Group align="flex-end">
								<TextInput
									label={t("codexGlobalProxy")}
									description={t("codexGlobalProxyDesc")}
									placeholder={t("codexProxyPlaceholder")}
									value={globalProxy}
									onChange={(e) => setGlobalProxy(e.target.value)}
									style={{ flex: 1 }}
								/>
								<Button
									size="sm"
									onClick={handleSaveGlobalProxy}
									loading={globalProxyMut.isPending}
								>
									{t("codexSave")}
								</Button>
							</Group>
						</Stack>

						{/* Add credentials */}
						<Stack gap="xs">
							<Text size="sm" fw={500}>
								{t("codexAddCredentials")}
							</Text>
							<Group>
								<Button size="sm" onClick={handleBrowserAuth} loading={browserAuthLoading}>
									{t("codexAddBrowser")}
								</Button>
								<Button size="sm" variant="light" onClick={handleDeviceAuth}>
									{t("codexAddDevice")}
								</Button>
							</Group>
						</Stack>

						{/* Import credentials */}
						<Stack gap="xs">
							<Text size="sm" fw={500}>
								{t("codexImportTitle")}
							</Text>
							<Text size="xs" c="dimmed">
								{t("codexImportDesc")}
							</Text>
							<Textarea
								placeholder={t("codexImportPlaceholder")}
								value={importJson}
								onChange={(e) => setImportJson(e.target.value)}
								minRows={4}
								maxRows={8}
							/>
							{importError && (
								<Text size="xs" c="red">
									{importError}
								</Text>
							)}
							{importResult && (
								<Text size="xs" c="green">
									{importResult}
								</Text>
							)}
							<Group>
								<Button
									size="sm"
									onClick={handleImport}
									loading={importMut.isPending}
									disabled={!importJson.trim()}
								>
									{t("codexImport")}
								</Button>
								<Button
									size="sm"
									variant="subtle"
									onClick={() => {
										setImportJson("");
										setImportError(null);
										setImportResult(null);
									}}
								>
									{t("codexClear")}
								</Button>
							</Group>
						</Stack>

						{/* Credentials table */}
						{entries.length > 0 && (
							<Table>
								<Table.Thead>
									<Table.Tr>
										<Table.Th>{t("codexColName")}</Table.Th>
										<Table.Th>{t("codexColAccount")}</Table.Th>
										<Table.Th>{t("codexColPriority")}</Table.Th>
										<Table.Th>{t("codexColStatus")}</Table.Th>
										<Table.Th>{t("codexColStats")}</Table.Th>
										<Table.Th>{t("codexColLastUsed")}</Table.Th>
										<Table.Th>{t("codexColActions")}</Table.Th>
									</Table.Tr>
								</Table.Thead>
								<Table.Tbody>
									{entries.map((entry) => {
										const isEditing = editingId === entry.id;
										return (
											<Table.Tr key={entry.id}>
												<Table.Td>
													{isEditing ? (
														<TextInput
															size="xs"
															value={editForm.displayName}
															onChange={(e) =>
																setEditForm({ ...editForm, displayName: e.target.value })
															}
															placeholder={entry.accountId ?? entry.id}
														/>
													) : (
														<Text size="sm">
															{entry.displayName || entry.accountId || entry.id.slice(0, 8)}
														</Text>
													)}
												</Table.Td>
												<Table.Td>
													<Text size="xs" c="dimmed">
														{entry.accountId?.slice(0, 12) ?? "-"}
													</Text>
												</Table.Td>
												<Table.Td>
													{isEditing ? (
														<NumberInput
															size="xs"
															value={editForm.priority}
															onChange={(v) => setEditForm({ ...editForm, priority: Number(v) })}
															min={0}
															max={100}
															w={80}
														/>
													) : (
														<Text size="sm">{entry.priority}</Text>
													)}
												</Table.Td>
												<Table.Td>
													{entry.disabled ? (
														<Badge size="sm" color="red">
															{entry.disabledReason || "Disabled"}
														</Badge>
													) : (
														<Badge size="sm" color="green">
															Active
														</Badge>
													)}
												</Table.Td>
												<Table.Td>
													<Text size="xs">
														✓ {entry.successCount} / ✗ {entry.failureCount}
													</Text>
												</Table.Td>
												<Table.Td>
													<Text size="xs" c="dimmed">
														{relativeTime(entry.lastUsedAt)}
													</Text>
												</Table.Td>
												<Table.Td>
													<Group gap="xs">
														{isEditing ? (
															<>
																<Tooltip label={t("codexSave")}>
																	<ActionIcon
																		size="sm"
																		color="green"
																		onClick={handleSaveEdit}
																		loading={updateMut.isPending}
																	>
																		<IconCheck size={16} />
																	</ActionIcon>
																</Tooltip>
																<Tooltip label={t("codexCancel")}>
																	<ActionIcon
																		size="sm"
																		color="gray"
																		onClick={() => setEditingId(null)}
																	>
																		<IconX size={16} />
																	</ActionIcon>
																</Tooltip>
															</>
														) : (
															<>
																<Tooltip label={t("codexEdit")}>
																	<ActionIcon size="sm" onClick={() => handleEdit(entry)}>
																		<IconPencil size={16} />
																	</ActionIcon>
																</Tooltip>
																<Tooltip label={t("codexRefresh")}>
																	<ActionIcon
																		size="sm"
																		onClick={() => refreshMut.mutate(entry.id)}
																		loading={refreshMut.isPending}
																	>
																		<IconRefresh size={16} />
																	</ActionIcon>
																</Tooltip>
																{entry.disabled ? (
																	<Tooltip label={t("codexEnable")}>
																		<ActionIcon
																			size="sm"
																			color="green"
																			onClick={() => enableMut.mutate(entry.id)}
																		>
																			<IconCheck size={16} />
																		</ActionIcon>
																	</Tooltip>
																) : (
																	<Tooltip label={t("codexDisable")}>
																		<ActionIcon
																			size="sm"
																			color="orange"
																			onClick={() => disableMut.mutate(entry.id)}
																		>
																			<IconX size={16} />
																		</ActionIcon>
																	</Tooltip>
																)}
																{entry.failureCount > 0 && (
																	<Tooltip label={t("codexReset")}>
																		<ActionIcon
																			size="sm"
																			color="blue"
																			onClick={() => resetMut.mutate(entry.id)}
																		>
																			<IconDeviceFloppy size={16} />
																		</ActionIcon>
																	</Tooltip>
																)}
																<Tooltip label={t("codexDelete")}>
																	<ActionIcon
																		size="sm"
																		color="red"
																		onClick={() => {
																			if (confirm(t("codexDeleteConfirm"))) {
																				deleteMut.mutate(entry.id);
																			}
																		}}
																	>
																		<IconTrash size={16} />
																	</ActionIcon>
																</Tooltip>
															</>
														)}
													</Group>
												</Table.Td>
											</Table.Tr>
										);
									})}
								</Table.Tbody>
							</Table>
						)}

						{/* Models section */}
						<Stack gap="xs">
							<Text size="sm" fw={500}>
								{t("codexModels")}
							</Text>
							<Text size="xs" c="dimmed">
								{t("codexModelsDesc")}
							</Text>
							<Stack gap="xs">
								{BUILTIN_CODEX_MODELS.map((modelId) => {
									const modelVal = `codex:${modelId}`;
									const isHidden = hiddenModels.includes(modelVal);
									return (
										<Group key={modelId} gap="xs" style={isHidden ? { opacity: 0.5 } : undefined}>
											<TextInput value={modelVal} disabled style={{ flex: 1 }} size="xs" />
											<TextInput value={modelId} disabled style={{ flex: 1 }} size="xs" />
											<ActionIcon
												variant="subtle"
												color={isHidden ? "gray" : "blue"}
												onClick={() => onToggleHidden(modelVal)}
											>
												{isHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
											</ActionIcon>
										</Group>
									);
								})}
							</Stack>
						</Stack>
					</Stack>
				</Collapse>
			</Stack>

			{/* Device auth modal */}
			<Modal
				opened={deviceAuthModal}
				onClose={() => {
					setDeviceAuthModal(false);
					api.codexDeviceAuthCancel();
				}}
				title={t("codexDeviceAuthTitle")}
			>
				<Stack>
					<Text size="sm">{t("codexDeviceAuthInstructions")}</Text>
					<Paper p="md" withBorder>
						<Text size="xl" fw={700} ta="center">
							{deviceAuthData?.userCode}
						</Text>
					</Paper>
					<Button
						component="a"
						href={deviceAuthData?.verificationUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						{t("codexDeviceAuthOpen")}
					</Button>
					<Text size="xs" c="dimmed" ta="center">
						{t("codexDeviceAuthWaiting")}
					</Text>
				</Stack>
			</Modal>
		</Paper>
	);
}
