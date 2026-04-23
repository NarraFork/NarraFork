import {
	ActionIcon,
	Badge,
	Button,
	Divider,
	Group,
	Modal,
	NumberInput,
	Paper,
	PasswordInput,
	Progress,
	SegmentedControl,
	SimpleGrid,
	Stack,
	Switch,
	Table,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconEye,
	IconEyeOff,
	IconLogin,
	IconPlayerPlay,
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
	oauthClientId?: string;
	oauthClientSecret?: string;
	oauthDeviceId?: string;
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
						<Table.Th>{t("nugColTokens")}</Table.Th>
						<Table.Th ta="right">{t("nugColMeterUsage")}</Table.Th>
						<Table.Th ta="right">{t("nugColQuotaCost")}</Table.Th>
						<Table.Th ta="center">{t("nugColStatus")}</Table.Th>
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{events.map((ev) => {
						const normalInput =
							ev.inputTokens - ev.cacheCreationInputTokens - ev.cacheReadInputTokens;
						const hasCache = ev.cacheCreationInputTokens > 0 || ev.cacheReadInputTokens > 0;
						return (
							<Table.Tr key={ev.id}>
								<Table.Td>{new Date(ev.createdAt).toLocaleTimeString()}</Table.Td>
								<Table.Td>
									<Badge size="xs" color={CHANNEL_COLORS[ev.channelType] ?? "blue"}>
										{ev.channelType}
									</Badge>
								</Table.Td>
								<Table.Td>{ev.model}</Table.Td>
								<Table.Td>
									<Stack gap={2}>
										<Group gap={4} wrap="nowrap">
											<Text size="xs" c="dimmed" style={{ minWidth: 16 }}>
												In:
											</Text>
											<Text size="xs">{normalInput.toLocaleString()}</Text>
											{hasCache && (
												<>
													{ev.cacheCreationInputTokens > 0 && (
														<Text size="xs" c="orange">
															+W:{ev.cacheCreationInputTokens.toLocaleString()}
														</Text>
													)}
													{ev.cacheReadInputTokens > 0 && (
														<Text size="xs" c="teal">
															+R:{ev.cacheReadInputTokens.toLocaleString()}
														</Text>
													)}
												</>
											)}
										</Group>
										<Group gap={4} wrap="nowrap">
											<Text size="xs" c="dimmed" style={{ minWidth: 16 }}>
												Out:
											</Text>
											<Text size="xs">{ev.outputTokens.toLocaleString()}</Text>
										</Group>
									</Stack>
								</Table.Td>
								<Table.Td ta="right">{ev.meterUsage.toFixed(2)}</Table.Td>
								<Table.Td ta="right">{ev.quotaCost.toFixed(4)}</Table.Td>
								<Table.Td ta="center">
									<Badge size="xs" color={ev.status === "completed" ? "green" : "red"}>
										{ev.status}
									</Badge>
								</Table.Td>
							</Table.Tr>
						);
					})}
					{events.length === 0 && (
						<Table.Tr>
							<Table.Td colSpan={7} ta="center">
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
	const [refreshingProvider, setRefreshingProvider] = useState<string | null>(null);
	const [loginModalProvider, setLoginModalProvider] = useState<string | null>(null);

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
		<Stack>
			<Text size="xs" c="dimmed">
				{t("nugProvidersSectionDesc")}
			</Text>

			{providers.map((p, idx) => {
				const pModels = providerModelsMap[p.id] ?? [];
				const providerModelCount = pModels.length;
				return (
					<React.Fragment key={p.id}>
						{idx > 0 && <Divider />}
						<Stack gap="xs" style={p.disabled ? { opacity: 0.6 } : undefined}>
							{/* Provider header */}
							<Group justify="space-between">
								<Group gap="xs">
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
										onChange={() => toggleProviderDisabled(p.id)}
									/>
									<ActionIcon
										color="red"
										variant="subtle"
										size="sm"
										onClick={() => handleRemoveProvider(p.id)}
									>
										<IconTrash size={14} />
									</ActionIcon>
								</Group>
							</Group>

							{/* Connection settings */}
							<TextInput
								size="xs"
								label={t("nugProviderName")}
								placeholder="NUG"
								value={p.name}
								onChange={(e) => updateProvider(p.id, { name: e.currentTarget.value })}
							/>
							<TextInput
								size="xs"
								label={t("nugProviderPrefix")}
								description={t("nugProviderPrefixDesc")}
								placeholder="nug"
								value={p.prefix}
								error={getPrefixError?.(p.prefix, p.id)}
								onChange={(e) =>
									updateProvider(p.id, {
										prefix: e.currentTarget.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""),
									})
								}
							/>
							<TextInput
								size="xs"
								label={t("nugBaseUrl")}
								placeholder="http://localhost:7800"
								value={p.baseUrl}
								onChange={(e) => updateProvider(p.id, { baseUrl: e.currentTarget.value })}
							/>
							<Group gap="xs" align="flex-end">
								<PasswordInput
									size="xs"
									label={t("nugApiKey")}
									placeholder={t("nugApiKeyPlaceholder")}
									value={p.apiKey}
									onChange={(e) => updateProvider(p.id, { apiKey: e.currentTarget.value })}
									style={{ flex: 1 }}
								/>
								<Tooltip label={t("nugLoginTooltip")}>
									<Button
										size="xs"
										variant="light"
										leftSection={<IconLogin size={14} />}
										disabled={!p.baseUrl}
										onClick={() => setLoginModalProvider(p.id)}
									>
										{t("nugLoginBtn")}
									</Button>
								</Tooltip>
								{p.oauthClientId && (
									<Tooltip label={t("nugOAuthTooltip")}>
										<Button
											size="xs"
											variant="light"
											color="grape"
											disabled={!p.baseUrl || !p.oauthClientId || isProviderDirty?.(p.id)}
											onClick={async () => {
												if (isProviderDirty?.(p.id)) {
													notifications.show({
														color: "yellow",
														title: t("refreshModelsSaveFirst"),
														message: "",
													});
													return;
												}
												try {
													const result = await api.nugOAuthStart(p.id);
													window.location.href = result.authorizeUrl;
												} catch (err) {
													notifications.show({
														title: t("nugOAuthError"),
														message: err instanceof Error ? err.message : "OAuth failed",
														color: "red",
													});
												}
											}}
										>
											{t("nugOAuthBtn")}
										</Button>
									</Tooltip>
								)}
							</Group>

							{/* OAuth config (collapsible) */}
							<Group gap="xs">
								<TextInput
									size="xs"
									label={t("nugOAuthClientId")}
									placeholder="OAuth Client ID"
									value={p.oauthClientId ?? ""}
									onChange={(e) => updateProvider(p.id, { oauthClientId: e.currentTarget.value })}
									style={{ flex: 1 }}
								/>
								<PasswordInput
									size="xs"
									label={t("nugOAuthClientSecret")}
									placeholder="OAuth Client Secret"
									value={p.oauthClientSecret ?? ""}
									onChange={(e) =>
										updateProvider(p.id, { oauthClientSecret: e.currentTarget.value })
									}
									style={{ flex: 1 }}
								/>
							</Group>
							{p.oauthDeviceId && (
								<Text size="xs" c="dimmed">
									{t("nugOAuthDeviceId")}: {p.oauthDeviceId}
								</Text>
							)}

							{/* Account info */}
							{p.apiKey && p.baseUrl && (
								<NUGAccountInfo providerId={p.id} nugUsername={p.nugUsername} />
							)}

							{/* Channel health */}
							{p.apiKey && p.baseUrl && !p.disabled && <NUGChannelHealth providerId={p.id} />}

							{/* Usage panel */}
							{p.apiKey && p.baseUrl && !p.disabled && <NUGUsagePanel providerId={p.id} />}

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
								<Stack gap="xs">
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
													size="xs"
													value={m.value}
													disabled
													style={{ flex: 1, minWidth: 120 }}
												/>
												<TextInput
													size="xs"
													value={m.label}
													disabled
													style={{ flex: 1, minWidth: 120 }}
												/>
												<NumberInput
													size="xs"
													placeholder={t("contextWindowPlaceholder")}
													value={modelContextWindows[m.value] || ""}
													onChange={(v) =>
														onContextWindowChange(m.value, typeof v === "number" ? v : null)
													}
													min={1}
													step={1000}
													suffix={` ${t("contextWindowSuffix")}`}
													w={180}
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
					</React.Fragment>
				);
			})}

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
		</Stack>
	);
});
