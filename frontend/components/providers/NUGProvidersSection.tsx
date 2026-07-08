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
	IconChevronDown,
	IconChevronRight,
	IconEye,
	IconEyeOff,
	IconLogin,
	IconPlayerPlay,
	IconRefresh,
	IconTrash,
	IconUser,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useProviderModelRefreshCapability,
	useProviderQuotaCapability,
	useProviderRuntimeCapability,
} from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import type { ModelOption } from "../../lib/constants";
import type { ProxyOverride } from "../../lib/proxy";
import { extractPrimaryDomainLabel } from "../../lib/url";
import { ProxyOverrideField } from "../common/ProxyOverrideField";
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
	proxy?: ProxyOverride;
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
	detailedQuotaBalance?: string | null;
	extra?: unknown;
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
	reasoningTokens?: number;
	quotaCost: number;
	meterUsage: number;
	status: string;
	durationMs: number;
	createdAt: string;
	extra?: Record<string, unknown> | string | null;
	metadata?: Record<string, unknown> | string | null;
	[key: string]: unknown;
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
	onMergeContextWindows?: (windows: Record<string, number>) => void;
	isProviderDirty?: (providerId: string) => boolean;
	onSaveBeforeRefresh?: () => Promise<boolean>;
	onSaveBeforeNugAction?: () => Promise<boolean>;
	onLoginSuccess?: (providerId: string, apiKey: string, username: string) => Promise<boolean>;
	customModels: CustomModelEntry[];
	onCustomModelsChange: (models: CustomModelEntry[]) => void;
	getPrefixError?: (prefix: string, providerId: string) => string | undefined;
	getUniquePrefix?: (base: string, providerId: string) => string;
	onTestModel?: (model: string) => void;
}

/** Sanitize a prefix value: any text except an ASCII colon is allowed. */
function sanitizePrefix(value: string): string {
	return value.replace(/:/g, "");
}

const CHANNEL_COLORS: Record<string, string> = {
	codex: "teal",
	openai: "green",
	anthropic: "orange",
};

const TIME_RANGES = ["today", "7days", "30days", "all"] as const;
type TimeRange = (typeof TIME_RANGES)[number];

function usageNumber(record: Record<string, unknown>, keys: string[], fallback = 0): number {
	for (const key of keys) {
		const value = record[key];
		const numberValue =
			typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
		if (Number.isFinite(numberValue)) return numberValue;
	}
	return fallback;
}

function usageString(record: Record<string, unknown>, keys: string[], fallback = ""): string {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return fallback;
}

function usageTime(record: Record<string, unknown>): string {
	const createdAt = usageString(record, ["createdAt", "created_at", "timestamp"]);
	if (!createdAt) return "-";
	const date = new Date(createdAt);
	return Number.isNaN(date.getTime()) ? "-" : date.toLocaleTimeString();
}

function usageRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value === "string" && value.trim().startsWith("{")) {
		try {
			const parsed = JSON.parse(value) as unknown;
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}
	return null;
}

const USAGE_STANDARD_KEYS = new Set([
	"id",
	"requestId",
	"request_id",
	"channelType",
	"channel_type",
	"channel",
	"provider",
	"providerType",
	"model",
	"model_id",
	"modelId",
	"modelName",
	"inputTokens",
	"input_tokens",
	"promptTokens",
	"prompt_tokens",
	"tokensIn",
	"tokens_in",
	"outputTokens",
	"output_tokens",
	"completionTokens",
	"completion_tokens",
	"cacheCreationInputTokens",
	"cache_creation_input_tokens",
	"cacheCreationTokens",
	"cache_creation_tokens",
	"cacheWriteInputTokens",
	"cache_write_input_tokens",
	"cacheWriteTokens",
	"cache_write_tokens",
	"cacheReadInputTokens",
	"cache_read_input_tokens",
	"cachedInputTokens",
	"cached_input_tokens",
	"cacheReadTokens",
	"cache_read_tokens",
	"reasoningTokens",
	"reasoning_tokens",
	"quotaCost",
	"quota_cost",
	"cost",
	"quota",
	"meterUsage",
	"meter_usage",
	"meter",
	"usageAmount",
	"status",
	"state",
	"durationMs",
	"duration_ms",
	"latencyMs",
	"latency_ms",
	"createdAt",
	"created_at",
	"timestamp",
	"time",
	"extra",
	"metadata",
	"usage",
	"usageData",
]);

function formatUsageExtraValue(value: unknown): string {
	if (value == null) return "null";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function usageExtraDetails(record: Record<string, unknown>): string[] {
	const details: string[] = [];
	const seen = new Set<string>();
	const addRecord = (source: Record<string, unknown> | null, prefix = "") => {
		if (!source) return;
		for (const [key, value] of Object.entries(source)) {
			if (value == null || USAGE_STANDARD_KEYS.has(key)) continue;
			const label = prefix ? `${prefix}.${key}` : key;
			if (seen.has(label)) continue;
			seen.add(label);
			details.push(`${label}: ${formatUsageExtraValue(value)}`);
		}
	};
	const extra = usageRecord(record.extra);
	const metadata = usageRecord(record.metadata);
	const usage = usageRecord(record.usage);
	const usageData = usageRecord(record.usageData);
	addRecord(extra);
	addRecord(usageRecord(extra?.usage), "usage");
	addRecord(usageRecord(extra?.metadata), "metadata");
	addRecord(metadata, "metadata");
	addRecord(usageRecord(metadata?.usage), "metadata.usage");
	addRecord(usage);
	addRecord(usageData, "usageData");
	if (details.length === 0) addRecord(record);
	return details;
}

/* ── NUG Login Modal ───────────────────────────────────── */

function NUGLoginModal({
	opened,
	onClose,
	providerId,
	baseUrl,
	canLogin,
	onEnsureSaved,
	onLoginSuccess,
}: {
	opened: boolean;
	onClose: () => void;
	providerId: string;
	baseUrl: string;
	canLogin: boolean;
	onEnsureSaved?: () => Promise<boolean>;
	onLoginSuccess: (apiKey: string, username: string) => boolean | Promise<boolean>;
}) {
	const { t } = useTranslation("settings");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [loading, setLoading] = useState(false);

	const handleLogin = useCallback(async () => {
		if (!canLogin || !username || !password) return;
		setLoading(true);
		try {
			if (onEnsureSaved) {
				const saved = await onEnsureSaved();
				if (!saved) return;
			}
			const res = await api.nugLogin(providerId, { username, password });
			const savedLogin = await onLoginSuccess(res.apiKey, username);
			if (!savedLogin) return;
			notifications.show({
				color: "green",
				title: t("nugLoginSuccess"),
				message: t("nugLoginAutoSaved"),
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
	}, [username, password, providerId, canLogin, onEnsureSaved, onLoginSuccess, onClose, t]);

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
					autoComplete="off"
					onChange={(e) => setPassword(e.currentTarget.value)}
					onKeyDown={(e) => e.key === "Enter" && handleLogin()}
				/>
				<Button
					loading={loading}
					onClick={handleLogin}
					disabled={!canLogin || !username || !password}
					title={!canLogin ? t("providerRouteUnsupported") : undefined}
				>
					{t("nugLoginBtn")}
				</Button>
			</Stack>
		</Modal>
	);
}

/* ── Account Info Panel ────────────────────────────────── */

function NUGAccountInfo({
	providerId,
	nugUsername,
	quotaRouteSupported,
	quotaRouteUnsupportedReason,
}: {
	providerId: string;
	nugUsername?: string;
	quotaRouteSupported: boolean;
	quotaRouteUnsupportedReason: string;
}) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const quotaCapability = useProviderQuotaCapability("nug");
	const canReadQuota = quotaCapability.supported && quotaRouteSupported;
	const quotaUnsupportedReason = quotaCapability.supported
		? quotaRouteUnsupportedReason
		: (quotaCapability.reason ?? t("providerQuotaUnsupported"));
	const [quota, setQuota] = useState<QuotaInfo | null>(null);
	const [loading, setLoading] = useState(false);

	const fetchQuota = useCallback(async () => {
		if (!canReadQuota) return;
		setLoading(true);
		try {
			const res = await api.nugGetQuota(providerId);
			setQuota(res);
			qc.setQueryData(["nug", "quotas"], (old: unknown) => {
				const quotas = old && typeof old === "object" ? (old as Record<string, unknown>) : {};
				const existing =
					quotas[providerId] && typeof quotas[providerId] === "object"
						? (quotas[providerId] as Record<string, unknown>)
						: {};
				return {
					...quotas,
					[providerId]: {
						...existing,
						balance: res.balance,
						totalGranted: res.totalGranted,
						detailedQuotaBalance: res.detailedQuotaBalance ?? null,
						...(res.extra !== undefined ? { extra: res.extra } : {}),
					},
				};
			});
		} catch {
			/* ignore */
		} finally {
			setLoading(false);
		}
	}, [providerId, canReadQuota, qc]);

	useEffect(() => {
		if (canReadQuota) fetchQuota();
	}, [fetchQuota, canReadQuota]);

	if (!nugUsername && !quota) return null;

	return (
		<Paper withBorder p="xs">
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
					<ActionIcon
						variant="subtle"
						size="sm"
						loading={loading}
						disabled={!canReadQuota}
						title={!canReadQuota ? quotaUnsupportedReason : undefined}
						onClick={fetchQuota}
					>
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
	const [opened, setOpened] = useState(false);

	return (
		<Paper withBorder p="xs">
			<Group justify="space-between" mb={opened ? "xs" : 0}>
				<Button
					variant="subtle"
					size="compact-xs"
					leftSection={opened ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
					onClick={() => setOpened((value) => !value)}
					aria-expanded={opened}
				>
					{t("nugUsageTitle")}
				</Button>
				{!opened && (
					<Text size="xs" c="dimmed">
						{t("nugUsageCollapsedHint")}
					</Text>
				)}
			</Group>
			{opened && <NUGUsageRecords providerId={providerId} />}
		</Paper>
	);
}

function NUGUsageRecords({ providerId }: { providerId: string }) {
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
			setEvents(Array.isArray(eventsRes.events) ? eventsRes.events : []);
		} catch {
			/* ignore */
		} finally {
			setLoading(false);
		}
	}, [providerId, range]);

	useEffect(() => {
		fetchUsage();
	}, [fetchUsage]);

	const summaryRecord = summary as unknown as Record<string, unknown> | null;
	const requestCount = summaryRecord
		? usageNumber(summaryRecord, ["requestCount", "request_count"])
		: 0;
	const totalMeterUsage = summaryRecord
		? usageNumber(summaryRecord, ["totalMeterUsage", "total_meter_usage"])
		: 0;
	const totalQuotaCost = summaryRecord
		? usageNumber(summaryRecord, ["totalQuotaCost", "total_quota_cost"])
		: 0;

	return (
		<>
			<Group justify="flex-end" mb="xs">
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

			{summary && (
				<SimpleGrid cols={3} mb="xs">
					<Paper withBorder p="xs" ta="center">
						<Text size="xs" c="dimmed">
							{t("nugStatRequests")}
						</Text>
						<Text fw={600}>{requestCount.toLocaleString()}</Text>
					</Paper>
					<Paper withBorder p="xs" ta="center">
						<Text size="xs" c="dimmed">
							{t("nugStatMeterUsage")}
						</Text>
						<Text fw={600}>{totalMeterUsage.toFixed(2)}</Text>
					</Paper>
					<Paper withBorder p="xs" ta="center">
						<Text size="xs" c="dimmed">
							{t("nugStatQuotaCost")}
						</Text>
						<Text fw={600}>{totalQuotaCost.toFixed(2)}</Text>
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
						<Table.Th>{t("nugColExtra")}</Table.Th>
						<Table.Th ta="right">{t("nugColMeterUsage")}</Table.Th>
						<Table.Th ta="right">{t("nugColQuotaCost")}</Table.Th>
						<Table.Th ta="center">{t("nugColStatus")}</Table.Th>
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{events.map((ev, index) => {
						const record = ev as unknown as Record<string, unknown>;
						const inputTokens = usageNumber(record, [
							"inputTokens",
							"input_tokens",
							"tokensIn",
							"tokens_in",
						]);
						const outputTokens = usageNumber(record, [
							"outputTokens",
							"output_tokens",
							"completionTokens",
						]);
						const cacheCreationInputTokens = usageNumber(record, [
							"cacheCreationInputTokens",
							"cache_creation_input_tokens",
							"cacheCreationTokens",
							"cache_creation_tokens",
							"cacheWriteInputTokens",
							"cache_write_input_tokens",
							"cacheWriteTokens",
							"cache_write_tokens",
						]);
						const cacheReadInputTokens = usageNumber(record, [
							"cacheReadInputTokens",
							"cache_read_input_tokens",
							"cachedInputTokens",
							"cached_input_tokens",
							"cacheReadTokens",
							"cache_read_tokens",
						]);
						const channelType = usageString(
							record,
							["channelType", "channel_type", "channel"],
							"unknown",
						);
						const model = usageString(record, ["model", "model_id", "modelId"], "-");
						const status = usageString(record, ["status"], "unknown");
						const reasoningTokens = usageNumber(record, ["reasoningTokens", "reasoning_tokens"]);
						const meterUsage = usageNumber(record, ["meterUsage", "meter_usage"]);
						const quotaCost = usageNumber(record, ["quotaCost", "quota_cost"]);
						const normalInput = Math.max(
							0,
							inputTokens - cacheCreationInputTokens - cacheReadInputTokens,
						);
						const hasCache = cacheCreationInputTokens > 0 || cacheReadInputTokens > 0;
						const extraDetails = usageExtraDetails(record);
						const extraPreview = extraDetails.slice(0, 3).join(" · ");
						return (
							<Table.Tr key={ev.id || `usage-${index}`}>
								<Table.Td>{usageTime(record)}</Table.Td>
								<Table.Td>
									<Badge size="xs" color={CHANNEL_COLORS[channelType] ?? "blue"}>
										{channelType}
									</Badge>
								</Table.Td>
								<Table.Td>{model}</Table.Td>
								<Table.Td>
									<Stack gap={2}>
										<Group gap={4} wrap="nowrap">
											<Text size="xs" c="dimmed" style={{ minWidth: 16 }}>
												In:
											</Text>
											<Text size="xs">{normalInput.toLocaleString()}</Text>
											{hasCache && (
												<>
													{cacheCreationInputTokens > 0 && (
														<Text size="xs" c="orange">
															+W:{cacheCreationInputTokens.toLocaleString()}
														</Text>
													)}
													{cacheReadInputTokens > 0 && (
														<Text size="xs" c="teal">
															+R:{cacheReadInputTokens.toLocaleString()}
														</Text>
													)}
												</>
											)}
										</Group>
										<Group gap={4} wrap="nowrap">
											<Text size="xs" c="dimmed" style={{ minWidth: 16 }}>
												Out:
											</Text>
											<Text size="xs">{outputTokens.toLocaleString()}</Text>
										</Group>
										{reasoningTokens > 0 && (
											<Group gap={4} wrap="nowrap">
												<Text size="xs" c="dimmed" style={{ minWidth: 16 }}>
													Rsn:
												</Text>
												<Text size="xs" c="violet">
													{reasoningTokens.toLocaleString()}
												</Text>
											</Group>
										)}
									</Stack>
								</Table.Td>
								<Table.Td maw={220}>
									{extraDetails.length > 0 ? (
										<Tooltip label={extraDetails.join("\n")} multiline w={360} withArrow>
											<Text size="xs" c="dimmed" truncate="end">
												{extraPreview}
												{extraDetails.length > 3 ? ` · +${extraDetails.length - 3}` : ""}
											</Text>
										</Tooltip>
									) : (
										<Text size="xs" c="dimmed">
											{t("nugUsageExtraNone")}
										</Text>
									)}
								</Table.Td>
								<Table.Td ta="right">{meterUsage.toFixed(2)}</Table.Td>
								<Table.Td ta="right">{quotaCost.toFixed(4)}</Table.Td>
								<Table.Td ta="center">
									<Badge size="xs" color={status === "completed" ? "green" : "red"}>
										{status}
									</Badge>
								</Table.Td>
							</Table.Tr>
						);
					})}
					{events.length === 0 && (
						<Table.Tr>
							<Table.Td colSpan={8} ta="center">
								<Text size="xs" c="dimmed">
									{t("nugNoUsageData")}
								</Text>
							</Table.Td>
						</Table.Tr>
					)}
				</Table.Tbody>
			</Table>
		</>
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
	onMergeContextWindows,
	isProviderDirty,
	onSaveBeforeRefresh,
	onSaveBeforeNugAction,
	onLoginSuccess,
	customModels,
	onCustomModelsChange,
	getPrefixError,
	getUniquePrefix,
	onTestModel,
}: NUGProvidersSectionProps) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const nugRuntimeCapability = useProviderRuntimeCapability("nug");
	const nugRefreshCapability = useProviderModelRefreshCapability("nug");
	const providerRouteUnsupportedReason = t("providerRouteUnsupported");
	const nugRefreshReason = nugRefreshCapability.reason ?? t("providerRefreshModelsUnsupported");
	const nugRoutesSupported = nugRuntimeCapability?.routes?.supported !== false;
	const isNugRouteSupported = (route: string) =>
		nugRoutesSupported && nugRuntimeCapability?.routes?.[route] !== false;
	const canRefreshNugProviderModels =
		nugRefreshCapability.supported && isNugRouteSupported("perProviderModelsRefresh");
	const nugRefreshUnsupportedReason = nugRefreshCapability.supported
		? providerRouteUnsupportedReason
		: nugRefreshReason;
	const canLogin = isNugRouteSupported("login");
	const canOAuthStart = isNugRouteSupported("oauthStart");
	const canReadQuota = isNugRouteSupported("quota");
	const canReadChannelsHealth = isNugRouteSupported("channelsHealth");
	const canReadUsage = isNugRouteSupported("usage") && isNugRouteSupported("usageSummary");
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

	// Track which providers have a manually-edited prefix / name (keyed by id). A
	// provider that already has a prefix is treated as locked; new ones start
	// name-driven and can also be seeded from the base URL domain.
	const [manualPrefixIds, setManualPrefixIds] = useState<Set<string>>(
		() => new Set(providers.filter((p) => p.prefix).map((p) => p.id)),
	);
	const [manualNameIds, setManualNameIds] = useState<Set<string>>(
		() => new Set(providers.filter((p) => p.prefix).map((p) => p.id)),
	);

	// On mount, seed an empty prefix from the current name for each provider so a
	// prefix shows up immediately. Tracked per id to avoid re-seeding after the
	// user clears a prefix.
	const seededIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const toSeed = providers.filter(
			(p) => !seededIdsRef.current.has(p.id) && !p.prefix && p.name.trim(),
		);
		for (const p of providers) seededIdsRef.current.add(p.id);
		if (toSeed.length === 0) return;
		onProvidersChange((prev) =>
			prev.map((p) => {
				if (!toSeed.some((s) => s.id === p.id)) return p;
				const base = sanitizePrefix(p.name.trim());
				if (!base) return p;
				const nextPrefix = getUniquePrefix?.(base, p.id) ?? base;
				return nextPrefix ? { ...p, prefix: nextPrefix } : p;
			}),
		);
	}, [providers, onProvidersChange, getUniquePrefix]);

	const handleNameChange = useCallback(
		(id: string, name: string) => {
			const manual = manualPrefixIds.has(id);
			setManualNameIds((prev) => {
				const updated = new Set(prev);
				updated.add(id);
				return updated;
			});
			onProvidersChange((prev) =>
				prev.map((p) => {
					if (p.id !== id) return p;
					if (manual) return { ...p, name };
					const base = sanitizePrefix(name.trim());
					const nextPrefix = base ? (getUniquePrefix?.(base, p.id) ?? base) : "";
					return { ...p, name, prefix: nextPrefix };
				}),
			);
		},
		[onProvidersChange, manualPrefixIds, getUniquePrefix],
	);

	const handlePrefixChange = useCallback(
		(id: string, value: string) => {
			const next = sanitizePrefix(value);
			setManualPrefixIds((prev) => {
				const updated = new Set(prev);
				if (next.length > 0) updated.add(id);
				else updated.delete(id);
				return updated;
			});
			updateProvider(id, { prefix: next });
		},
		[updateProvider],
	);

	// Derive name + prefix from the base URL's primary domain label while neither
	// the name nor the prefix has been manually edited for this provider.
	const handleBaseUrlChange = useCallback(
		(id: string, value: string) => {
			if (manualNameIds.has(id) || manualPrefixIds.has(id)) {
				updateProvider(id, { baseUrl: value });
				return;
			}
			const label = extractPrimaryDomainLabel(value);
			onProvidersChange((prev) =>
				prev.map((p) => {
					if (p.id !== id) return p;
					if (!label) return { ...p, baseUrl: value };
					const nextPrefix = getUniquePrefix?.(label, p.id) ?? label;
					return { ...p, baseUrl: value, name: label, prefix: nextPrefix };
				}),
			);
		},
		[manualNameIds, manualPrefixIds, onProvidersChange, updateProvider, getUniquePrefix],
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
			if (!canRefreshNugProviderModels) return;
			if (isProviderDirty?.(providerId)) {
				const saved = await onSaveBeforeRefresh?.();
				if (!saved) return;
			}
			setRefreshingProvider(providerId);
			try {
				const result = await api.nugRefreshProviderModels(providerId);
				if (result.modelContextWindows) onMergeContextWindows?.(result.modelContextWindows);
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
		[
			canRefreshNugProviderModels,
			qc,
			t,
			isProviderDirty,
			onSaveBeforeRefresh,
			onMergeContextWindows,
		],
	);

	const handleLoginSuccess = useCallback(
		async (providerId: string, apiKey: string, username: string) => {
			if (onLoginSuccess) return onLoginSuccess(providerId, apiKey, username);
			updateProvider(providerId, { apiKey, nugUsername: username });
			return true;
		},
		[onLoginSuccess, updateProvider],
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
											{t("nugModelsCount", { count: providerModelCount })}
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
								onChange={(e) => handleNameChange(p.id, e.currentTarget.value)}
							/>
							<TextInput
								size="xs"
								label={t("nugProviderPrefix")}
								description={t("nugProviderPrefixDesc")}
								placeholder="nug"
								value={p.prefix}
								error={getPrefixError?.(p.prefix, p.id)}
								onChange={(e) => handlePrefixChange(p.id, e.currentTarget.value)}
							/>
							<TextInput
								size="xs"
								label={t("nugBaseUrl")}
								placeholder="http://localhost:7800"
								value={p.baseUrl}
								onChange={(e) => handleBaseUrlChange(p.id, e.currentTarget.value)}
							/>
							<ProxyOverrideField
								value={p.proxy}
								onChange={(next) => updateProvider(p.id, { proxy: next })}
							/>
							<Group gap="xs" align="flex-end">
								<PasswordInput
									size="xs"
									label={t("nugApiKey")}
									placeholder={t("nugApiKeyPlaceholder")}
									value={p.apiKey}
									autoComplete="off"
									onChange={(e) => updateProvider(p.id, { apiKey: e.currentTarget.value })}
									style={{ flex: 1 }}
								/>
								<Tooltip label={t("nugLoginTooltip")}>
									<Button
										size="xs"
										variant="light"
										leftSection={<IconLogin size={14} />}
										disabled={!p.baseUrl || !canLogin}
										title={!canLogin ? providerRouteUnsupportedReason : undefined}
										onClick={() => canLogin && setLoginModalProvider(p.id)}
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
											disabled={!p.baseUrl || !p.oauthClientId || !canOAuthStart}
											title={!canOAuthStart ? providerRouteUnsupportedReason : undefined}
											onClick={async () => {
												if (!canOAuthStart) return;

												if (isProviderDirty?.(p.id)) {
													const saved = await onSaveBeforeNugAction?.();
													if (!saved) return;
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
									autoComplete="off"
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
								<NUGAccountInfo
									providerId={p.id}
									nugUsername={p.nugUsername}
									quotaRouteSupported={canReadQuota}
									quotaRouteUnsupportedReason={providerRouteUnsupportedReason}
								/>
							)}

							{/* Channel health */}
							{p.apiKey && p.baseUrl && !p.disabled && canReadChannelsHealth && (
								<NUGChannelHealth providerId={p.id} />
							)}

							{/* Usage panel */}
							{p.apiKey && p.baseUrl && !p.disabled && canReadUsage && (
								<NUGUsagePanel providerId={p.id} />
							)}

							{/* Models */}
							<Group gap="xs">
								<Button
									size="xs"
									variant="light"
									leftSection={<IconRefresh size={14} />}
									loading={refreshingProvider === p.id}
									disabled={!p.apiKey || !p.baseUrl || !canRefreshNugProviderModels}
									title={!canRefreshNugProviderModels ? nugRefreshUnsupportedReason : undefined}
									onClick={() => handleRefreshModels(p.id)}
								>
									{refreshingProvider === p.id
										? t("nugRefreshModelsLoading")
										: t("nugRefreshModels")}
								</Button>
								{providerModelCount > 0 && (
									<Text size="xs" c="dimmed">
										{t("nugModelsCount", { count: providerModelCount })}
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
					canLogin={canLogin}
					onEnsureSaved={isProviderDirty?.(loginProvider.id) ? onSaveBeforeNugAction : undefined}
					onLoginSuccess={(apiKey, username) =>
						handleLoginSuccess(loginProvider.id, apiKey, username)
					}
				/>
			)}
		</Stack>
	);
});
