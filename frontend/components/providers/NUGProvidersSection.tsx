import {
	ActionIcon,
	Badge,
	Button,
	Collapse,
	Group,
	Modal,
	NumberInput,
	Paper,
	PasswordInput,
	Progress,
	RingProgress,
	SegmentedControl,
	SimpleGrid,
	Stack,
	Switch,
	Table,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconChevronDown,
	IconChevronRight,
	IconEye,
	IconEyeOff,
	IconLogin,
	IconPlayerPlay,
	IconPlus,
	IconRefresh,
	IconTrash,
	IconUser,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type { ModelOption } from "../../lib/constants";
import type { CustomModelEntry } from "./InlineCustomModels";
import { InlineCustomModels } from "./InlineCustomModels";

/* ── Types ─────────────────────────────────────────────── */

export interface NUGProviderState {
	id: string;
	name: string;
	prefix: string;
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	disabled?: boolean;
	nugUsername?: string;
	nugUserId?: string;
}

type ProvidersUpdater = NUGProviderState[] | ((prev: NUGProviderState[]) => NUGProviderState[]);

interface ChannelHealth {
	channelType: string;
	totalCredentials: number;
	availableCredentials: number;
	disabledCredentials: number;
	availabilityRate: number;
	currentConcurrency: number;
	maxConcurrency: number;
	queueDepth: number;
}

interface QuotaInfo {
	balance: number;
	totalGranted: number;
	username?: string;
	role?: string;
}

interface UsageEvent {
	id: string;
	channelType: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	quotaCost: number;
	meterUsage: number;
	status: string;
	durationMs: number;
	createdAt: string;
}

interface UsageSummary {
	requestCount: number;
	totalMeterUsage: number;
	totalQuotaCost: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheWriteTokens: number;
	totalCacheReadTokens: number;
}

interface NUGProvidersSectionProps {
	providers: NUGProviderState[];
	onProvidersChange: (updater: ProvidersUpdater) => void;
	providerModelsMap: Record<string, ModelOption[]>;
	hiddenModels: Set<string>;
	onToggleHidden: (modelVal: string) => void;
	modelContextWindows: Record<string, number>;
	onContextWindowChange: (modelVal: string, size: number | null) => void;
	isProviderDirty?: (providerId: string) => boolean;
	customModels: CustomModelEntry[];
	onCustomModelsChange: (models: CustomModelEntry[]) => void;
	getPrefixError?: (prefix: string, providerId: string) => string | undefined;
	onTestModel?: (model: string) => void;
}

const CHANNEL_COLORS: Record<string, string> = {
	codex: "teal",
	openai: "green",
	anthropic: "orange",
};

const TIME_RANGES = ["today", "7days", "30days", "all"] as const;
type TimeRange = (typeof TIME_RANGES)[number];

/* ── NUG Login Modal ───────────────────────────────────── */

function NUGLoginModal({
	opened,
	onClose,
	providerId,
	baseUrl,
	onLoginSuccess,
}: {
	opened: boolean;
	onClose: () => void;
	providerId: string;
	baseUrl: string;
	onLoginSuccess: (apiKey: string, username: string) => void;
}) {
	const { t } = useTranslation("settings");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [loading, setLoading] = useState(false);

	const handleLogin = useCallback(async () => {
		if (!username || !password) return;
		setLoading(true);
		try {
			const res = await api.nugLogin(providerId, { username, password });
			onLoginSuccess(res.apiKey, username);
			notifications.show({
				color: "green",
				title: t("nugLoginSuccess"),
				message: "",
			});
			onClose();
		} catch (err) {
			notifications.show({
				color: "red",
				title: t("nugLoginError"),
				message: err instanceof Error ? err.message : "",
			});
		} finally {
			setLoading(false);
		}
	}, [username, password, providerId, onLoginSuccess, onClose, t]);

	return (
		<Modal opened={opened} onClose={onClose} title={t("nugLoginTitle")} centered>
			<Stack>
				<Text size="sm" c="dimmed">
					{t("nugLoginDesc", { url: baseUrl })}
				</Text>
				<TextInput
					label={t("nugUsername")}
					placeholder={t("nugUsernamePlaceholder")}
					value={username}
					onChange={(e) => setUsername(e.currentTarget.value)}
				/>
				<PasswordInput
					label={t("nugPassword")}
					placeholder={t("nugPasswordPlaceholder")}
					value={password}
					onChange={(e) => setPassword(e.currentTarget.value)}
					onKeyDown={(e) => e.key === "Enter" && handleLogin()}
				/>
				<Button loading={loading} onClick={handleLogin} disabled={!username || !password}>
					{t("nugLoginBtn")}
				</Button>
			</Stack>
		</Modal>
	);
}

/* ── Account Info Panel ────────────────────────────────── */

function NUGAccountInfo({ providerId, nugUsername }: { providerId: string; nugUsername?: string }) {
	const { t } = useTranslation("settings");
	const [quota, setQuota] = useState<QuotaInfo | null>(null);
	const [loading, setLoading] = useState(false);

	const fetchQuota = useCallback(async () => {
		setLoading(true);
		try {
			const res = await api.nugGetQuota(providerId);
			setQuota(res);
		} catch {
			/* ignore */
		} finally {
			setLoading(false);
		}
	}, [providerId]);

	useEffect(() => {
		fetchQuota();
	}, [fetchQuota]);

	if (!nugUsername && !quota) return null;

	return (
		<Paper withBorder p="xs" bg="var(--mantine-color-dark-7)">
			<Group justify="space-between">
				<Group gap="xs">
					<IconUser size={16} />
					<Text size="sm" fw={500}>
						{nugUsername ?? quota?.username ?? "—"}
					</Text>
					{quota?.role && (
						<Badge size="xs" variant="light" color={quota.role === "admin" ? "violet" : "blue"}>
							{quota.role}
						</Badge>
					)}
				</Group>
				<Group gap="xs">
					{quota && (
						<>
							<Badge size="xs" variant="light" color="teal">
								{t("nugQuotaBalance", { balance: quota.balance.toFixed(2) })}
							</Badge>
							<Badge size="xs" variant="light" color="gray">
								{t("nugQuotaGranted", { total: quota.totalGranted.toFixed(2) })}
							</Badge>
						</>
					)}
					<ActionIcon variant="subtle" size="sm" loading={loading} onClick={fetchQuota}>
						<IconRefresh size={14} />
					</ActionIcon>
				</Group>
			</Group>
		</Paper>
	);
}

/* ── Channel Health Panel ──────────────────────────────── */

function NUGChannelHealth({ providerId }: { providerId: string }) {
	const { t } = useTranslation("settings");
	const [channels, setChannels] = useState<ChannelHealth[]>([]);
	const [loading, setLoading] = useState(false);

	const fetchHealth = useCallback(async () => {
		setLoading(true);
		try {
			const res = await api.nugGetChannelsHealth(providerId);
			setChannels(res.channels ?? []);
		} catch {
			/* ignore */
		} finally {
			setLoading(false);
		}
	}, [providerId]);

	useEffect(() => {
		fetchHealth();
	}, [fetchHealth]);

	if (channels.length === 0 && !loading) return null;

	return (
		<Paper withBorder p="xs">
			<Group justify="space-between" mb="xs">
				<Text size="sm" fw={500}>
					{t("nugChannelHealth")}
				</Text>
				<ActionIcon variant="subtle" size="sm" loading={loading} onClick={fetchHealth}>
					<IconRefresh size={14} />
				</ActionIcon>
			</Group>
			<Stack gap="xs">
				{channels.map((ch) => {
					const pct = Math.round(ch.availabilityRate * 100);
					const color = CHANNEL_COLORS[ch.channelType] ?? "blue";
					return (
						<Group key={ch.channelType} gap="xs" wrap="nowrap">
							<Text size="xs" w={80} fw={500} tt="capitalize">
								{ch.channelType}
							</Text>
							<Progress
								value={pct}
								color={pct >= 80 ? color : pct >= 50 ? "yellow" : "red"}
								size="lg"
								style={{ flex: 1 }}
								radius="sm"
							/>
							<Text size="xs" w={40} ta="right">
								{pct}%
							</Text>
							<Text size="xs" c="dimmed" w={60} ta="right">
								{ch.availableCredentials}/{ch.totalCredentials}
							</Text>
							<Tooltip
								label={t("nugConcurrency", {
									current: ch.currentConcurrency,
									max: ch.maxConcurrency,
								})}
							>
								<Badge size="xs" variant="dot" color={color}>
									{ch.currentConcurrency}/{ch.maxConcurrency}
								</Badge>
							</Tooltip>
						</Group>
					);
				})}
			</Stack>
		</Paper>
	);
}

/* ── Usage Panel ───────────────────────────────────────── */

function NUGUsagePanel({ providerId }: { providerId: string }) {
	const { t } = useTranslation("settings");
	const [range, setRange] = useState<TimeRange>("today");
	const [summary, setSummary] = useState<UsageSummary | null>(null);
	const [events, setEvents] = useState<UsageEvent[]>([]);
	const [expandedRow, setExpandedRow] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const fetchUsage = useCallback(async () => {
		setLoading(true);
		try {
			const [summaryRes, eventsRes] = await Promise.all([
				api.nugGetUsageSummary(providerId, range),
				api.nugGetUsage(providerId, range),
			]);
			setSummary(summaryRes);
			setEvents(eventsRes.events ?? []);
		} catch {
			/* ignore */
		} finally {
			setLoading(false);
		}
	}, [providerId, range]);

	useEffect(() => {
		fetchUsage();
	}, [fetchUsage]);

	return (
		<Paper withBorder p="xs">
			<Group justify="space-between" mb="xs">
				<Text size="sm" fw={500}>
					{t("nugUsageTitle")}
				</Text>
				<Group gap="xs">
					<SegmentedControl
						size="xs"
						value={range}
						onChange={(v) => setRange(v as TimeRange)}
						data={TIME_RANGES.map((r) => ({ value: r, label: t(`nugRange_${r}`) }))}
					/>
					<ActionIcon variant="subtle" size="sm" loading={loading} onClick={fetchUsage}>
						<IconRefresh size={14} />
					</ActionIcon>
				</Group>
			</Group>

			{summary && (
				<SimpleGrid cols={3} mb="xs">
					<Paper withBorder p="xs" ta="center">
						<Text size="xs" c="dimmed">
							{t("nugStatRequests")}
						</Text>
						<Text fw={600}>{summary.requestCount.toLocaleString()}</Text>
					</Paper>
					<Paper withBorder p="xs" ta="center">
						<Text size="xs" c="dimmed">
							{t("nugStatMeterUsage")}
						</Text>
						<Text fw={600}>{summary.totalMeterUsage.toFixed(2)}</Text>
					</Paper>
					<Paper withBorder p="xs" ta="center">
						<Text size="xs" c="dimmed">
							{t("nugStatQuotaCost")}
						</Text>
						<Text fw={600}>{summary.totalQuotaCost.toFixed(2)}</Text>
					</Paper>
				</SimpleGrid>
			)}

			<Table striped highlightOnHover withTableBorder withColumnBorders fz="xs">
				<Table.Thead>
					<Table.Tr>
						<Table.Th>{t("nugColTime")}</Table.Th>
						<Table.Th>{t("nugColChannel")}</Table.Th>
						<Table.Th>{t("nugColModel")}</Table.Th>
						<Table.Th ta="right">{t("nugColMeterUsage")}</Table.Th>
						<Table.Th ta="right">{t("nugColQuotaCost")}</Table.Th>
						<Table.Th ta="center">{t("nugColStatus")}</Table.Th>
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{events.map((ev) => {
						const hasCache = ev.cacheCreationInputTokens > 0 || ev.cacheReadInputTokens > 0;
						const isExpanded = expandedRow === ev.id;
						return (
							<React.Fragment key={ev.id}>
								<Table.Tr
									style={{ cursor: hasCache ? "pointer" : undefined }}
									onClick={() => hasCache && setExpandedRow(isExpanded ? null : ev.id)}
								>
									<Table.Td>{new Date(ev.createdAt).toLocaleTimeString()}</Table.Td>
									<Table.Td>
										<Badge size="xs" color={CHANNEL_COLORS[ev.channelType] ?? "blue"}>
											{ev.channelType}
										</Badge>
									</Table.Td>
									<Table.Td>{ev.model}</Table.Td>
									<Table.Td ta="right">{ev.meterUsage.toFixed(2)}</Table.Td>
									<Table.Td ta="right">{ev.quotaCost.toFixed(4)}</Table.Td>
									<Table.Td ta="center">
										<Badge size="xs" color={ev.status === "completed" ? "green" : "red"}>
											{ev.status}
										</Badge>
									</Table.Td>
								</Table.Tr>
								{isExpanded && (
									<Table.Tr>
										<Table.Td colSpan={6}>
											<CacheDetail event={ev} />
										</Table.Td>
									</Table.Tr>
								)}
							</React.Fragment>
						);
					})}
					{events.length === 0 && (
						<Table.Tr>
							<Table.Td colSpan={6} ta="center">
								<Text size="xs" c="dimmed">
									{t("nugNoUsageData")}
								</Text>
							</Table.Td>
						</Table.Tr>
					)}
				</Table.Tbody>
			</Table>
		</Paper>
	);
}

function CacheDetail({ event }: { event: UsageEvent }) {
	const { t } = useTranslation("settings");
	const totalInput =
		event.cacheCreationInputTokens +
		event.cacheReadInputTokens +
		(event.inputTokens - event.cacheCreationInputTokens - event.cacheReadInputTokens);
	const hitRate = totalInput > 0 ? Math.round((event.cacheReadInputTokens / totalInput) * 100) : 0;

	return (
		<SimpleGrid cols={4} p="xs">
			<div>
				<Text size="xs" c="dimmed">
					{t("nugCacheInputTokens")}
				</Text>
				<Text size="sm" fw={500}>
					{event.inputTokens.toLocaleString()}
				</Text>
			</div>
			<div>
				<Text size="xs" c="dimmed">
					{t("nugCacheOutputTokens")}
				</Text>
				<Text size="sm" fw={500}>
					{event.outputTokens.toLocaleString()}
				</Text>
			</div>
			<div>
				<Text size="xs" c="dimmed">
					{t("nugCacheWrite")}
				</Text>
				<Text size="sm" fw={500}>
					{event.cacheCreationInputTokens.toLocaleString()} tokens
				</Text>
			</div>
			<div>
				<Text size="xs" c="dimmed">
					{t("nugCacheRead")}
				</Text>
				<Text size="sm" fw={500}>
					{event.cacheReadInputTokens.toLocaleString()} tokens
				</Text>
			</div>
			<div>
				<Text size="xs" c="dimmed">
					{t("nugCacheHitRate")}
				</Text>
				<Group gap={4}>
					<RingProgress size={28} thickness={4} sections={[{ value: hitRate, color: "teal" }]} />
					<Text size="sm" fw={500}>
						{hitRate}%
					</Text>
				</Group>
			</div>
		</SimpleGrid>
	);
}

/* ── Main Section Component ────────────────────────────── */

export const NUGProvidersSection = React.memo(function NUGProvidersSection({
	providers,
	onProvidersChange,
	providerModelsMap,
	hiddenModels,
	onToggleHidden,
	modelContextWindows,
	onContextWindowChange,
	isProviderDirty,
	customModels,
	onCustomModelsChange,
	getPrefixError,
	onTestModel,
}: NUGProvidersSectionProps) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const [sectionExpanded, setSectionExpanded] = useState(false);
	const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
	const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null);
	const [loginModalProvider, setLoginModalProvider] = useState<string | null>(null);

	const handleAddProvider = useCallback(() => {
		const id = Math.random().toString(36).slice(2, 10);
		onProvidersChange((prev) => [
			...prev,
			{
				id,
				name: "NUG",
				prefix: "nug",
				apiKey: "",
				baseUrl: "",
				defaultModel: "",
			},
		]);
		setExpandedProviders((prev) => new Set(prev).add(id));
	}, [onProvidersChange]);

	const handleRemoveProvider = useCallback(
		(id: string) => {
			onProvidersChange((prev) => prev.filter((p) => p.id !== id));
		},
		[onProvidersChange],
	);

	const updateProvider = useCallback(
		(id: string, updates: Partial<NUGProviderState>) => {
			onProvidersChange((prev) => prev.map((p) => (p.id === id ? { ...p, ...updates } : p)));
		},
		[onProvidersChange],
	);

	const toggleProviderExpanded = useCallback((id: string) => {
		setExpandedProviders((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const toggleProviderDisabled = useCallback(
		(id: string) => {
			onProvidersChange((prev) =>
				prev.map((p) => (p.id === id ? { ...p, disabled: !p.disabled } : p)),
			);
		},
		[onProvidersChange],
	);

	const handleRefreshModels = useCallback(
		async (providerId: string) => {
			if (isProviderDirty?.(providerId)) {
				notifications.show({
					color: "yellow",
					title: t("refreshModelsSaveFirst"),
					message: "",
				});
				return;
			}
			setRefreshingProvider(providerId);
			try {
				await api.nugRefreshProviderModels(providerId);
				qc.invalidateQueries({ queryKey: ["admin", "settings"] });
				qc.invalidateQueries({ queryKey: ["settings"] });
			} catch {
				notifications.show({
					color: "red",
					title: t("nugRefreshModelsError"),
					message: "",
				});
			} finally {
				setRefreshingProvider(null);
			}
		},
		[qc, t, isProviderDirty],
	);

	const handleLoginSuccess = useCallback(
		(providerId: string, apiKey: string, username: string) => {
			updateProvider(providerId, { apiKey, nugUsername: username });
		},
		[updateProvider],
	);

	const loginProvider = loginModalProvider
		? providers.find((p) => p.id === loginModalProvider)
		: null;

	return (
		<Paper withBorder p="md">
			<Stack>
				<Group
					justify="space-between"
					style={{ cursor: "pointer" }}
					onClick={() => setSectionExpanded((v) => !v)}
				>
					<Group gap="xs">
						{sectionExpanded ? <IconChevronDown size={20} /> : <IconChevronRight size={20} />}
						<div>
							<Title order={4}>{t("nugProvidersSection")}</Title>
							<Text size="xs" c="dimmed">
								{t("nugProvidersSectionDesc")}
							</Text>
						</div>
					</Group>
				</Group>
				<Collapse in={sectionExpanded}>
					<Group justify="flex-end" mb="xs">
						<Button
							size="xs"
							variant="light"
							leftSection={<IconPlus size={14} />}
							onClick={() => handleAddProvider()}
						>
							{t("nugAddProvider")}
						</Button>
					</Group>
					<Stack>
						{providers.map((p, idx) => {
							const isExpanded = expandedProviders.has(p.id);
							const pModels = providerModelsMap[p.id] ?? [];
							const providerModelCount = pModels.length;
							return (
								<Paper
									key={p.id}
									withBorder
									p="sm"
									style={p.disabled ? { opacity: 0.6 } : undefined}
								>
									<Stack gap="xs">
										<Group
											justify="space-between"
											style={{ cursor: "pointer" }}
											onClick={() => toggleProviderExpanded(p.id)}
										>
											<Group gap="xs">
												{isExpanded ? (
													<IconChevronDown size={16} />
												) : (
													<IconChevronRight size={16} />
												)}
												<Text fw={500} size="sm">
													{p.name || `NUG #${idx + 1}`}
												</Text>
												{p.disabled && (
													<Badge size="xs" variant="light" color="gray">
														{t("providerDisabled")}
													</Badge>
												)}
												{!p.disabled && providerModelCount > 0 && (
													<Badge size="xs" variant="light">
													</Badge>
												)}
												{p.nugUsername && (
													<Badge size="xs" variant="light" color="teal">
														{p.nugUsername}
													</Badge>
												)}
											</Group>
											<Group gap="xs">
												<Switch
													size="xs"
													checked={!p.disabled}
													onChange={(e) => {
														e.stopPropagation();
														toggleProviderDisabled(p.id);
													}}
													onClick={(e) => e.stopPropagation()}
												/>
												<ActionIcon
													color="red"
													variant="subtle"
													size="sm"
													onClick={(e) => {
														e.stopPropagation();
														handleRemoveProvider(p.id);
													}}
												>
													<IconTrash size={14} />
												</ActionIcon>
											</Group>
										</Group>
										<Collapse in={isExpanded}>
											<Stack gap="xs" mt="xs">
												{/* Connection settings */}
												<TextInput
													label={t("nugProviderName")}
													placeholder="NUG"
													value={p.name}
													onChange={(e) => updateProvider(p.id, { name: e.currentTarget.value })}
												/>
												<TextInput
													label={t("nugProviderPrefix")}
													description={t("nugProviderPrefixDesc")}
													placeholder="nug"
													value={p.prefix}
													error={getPrefixError?.(p.prefix, p.id)}
													onChange={(e) =>
														updateProvider(p.id, {
															prefix: e.currentTarget.value
																.toLowerCase()
																.replace(/[^a-z0-9_-]/g, ""),
														})
													}
												/>
												<TextInput
													label={t("nugBaseUrl")}
													placeholder="http://localhost:7800"
													value={p.baseUrl}
													onChange={(e) => updateProvider(p.id, { baseUrl: e.currentTarget.value })}
												/>
												<Group gap="xs" align="flex-end">
													<PasswordInput
														label={t("nugApiKey")}
														placeholder={t("nugApiKeyPlaceholder")}
														value={p.apiKey}
														onChange={(e) =>
															updateProvider(p.id, { apiKey: e.currentTarget.value })
														}
														style={{ flex: 1 }}
													/>
													<Tooltip label={t("nugLoginTooltip")}>
														<Button
															size="sm"
															variant="light"
															leftSection={<IconLogin size={14} />}
															disabled={!p.baseUrl}
															onClick={(e) => {
																e.stopPropagation();
																setLoginModalProvider(p.id);
															}}
														>
															{t("nugLoginBtn")}
														</Button>
													</Tooltip>
												</Group>

												{/* Account info */}
												{p.apiKey && p.baseUrl && (
													<NUGAccountInfo providerId={p.id} nugUsername={p.nugUsername} />
												)}

												{/* Channel health */}
												{p.apiKey && p.baseUrl && !p.disabled && (
													<NUGChannelHealth providerId={p.id} />
												)}

												{/* Usage panel */}
												{p.apiKey && p.baseUrl && !p.disabled && (
													<NUGUsagePanel providerId={p.id} />
												)}

												{/* Models */}
												<Group gap="xs">
													<Button
														size="xs"
														variant="light"
														leftSection={<IconRefresh size={14} />}
														loading={refreshingProvider === p.id}
														disabled={!p.apiKey || !p.baseUrl}
														onClick={() => handleRefreshModels(p.id)}
													>
														{refreshingProvider === p.id
															? t("nugRefreshModelsLoading")
															: t("nugRefreshModels")}
													</Button>
													{providerModelCount > 0 && (
														<Text size="xs" c="dimmed">
														</Text>
													)}
												</Group>
												{pModels.length > 0 && (
													<Stack gap="xs" mt="xs">
														{pModels.map((m) => {
															const isHidden = hiddenModels.has(m.value);
															return (
																<Group
																	key={m.value}
																	gap="xs"
																	wrap="wrap"
																	style={isHidden ? { opacity: 0.5 } : undefined}
																>
																	<TextInput
																		value={m.value}
																		disabled
																		style={{ flex: 1, minWidth: 120 }}
																	/>
																	<TextInput
																		value={m.label}
																		disabled
																		style={{ flex: 1, minWidth: 120 }}
																	/>
																	<NumberInput
																		placeholder={t("contextWindowPlaceholder")}
																		value={modelContextWindows[m.value] || ""}
																		onChange={(v) =>
																			onContextWindowChange(
																				m.value,
																				typeof v === "number" ? v : null,
																			)
																		}
																		min={1}
																		step={1000}
																		suffix={` ${t("contextWindowSuffix")}`}
																		w={180}
																		size="xs"
																	/>
																	<Tooltip label={t("modelTestBtn")}>
																		<ActionIcon
																			variant="subtle"
																			color="teal"
																			onClick={() => onTestModel?.(m.value)}
																		>
																			<IconPlayerPlay size={16} />
																		</ActionIcon>
																	</Tooltip>
																	<ActionIcon
																		variant="subtle"
																		color={isHidden ? "gray" : "blue"}
																		onClick={() => onToggleHidden(m.value)}
																	>
																		{isHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
																	</ActionIcon>
																</Group>
															);
														})}
													</Stack>
												)}
												<InlineCustomModels
													prefix={p.prefix || "nug"}
													customModels={customModels}
													onCustomModelsChange={onCustomModelsChange}
													hiddenModels={hiddenModels}
													onToggleHidden={onToggleHidden}
													modelContextWindows={modelContextWindows}
													onContextWindowChange={onContextWindowChange}
													onTestModel={onTestModel}
												/>
											</Stack>
										</Collapse>
									</Stack>
								</Paper>
							);
						})}
					</Stack>
				</Collapse>
			</Stack>

			{/* Login modal */}
			{loginProvider && (
				<NUGLoginModal
					opened={!!loginModalProvider}
					onClose={() => setLoginModalProvider(null)}
					providerId={loginProvider.id}
					baseUrl={loginProvider.baseUrl}
					onLoginSuccess={(apiKey, username) =>
						handleLoginSuccess(loginProvider.id, apiKey, username)
					}
				/>
			)}
		</Paper>
	);
});
