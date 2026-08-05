import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { formatCompactNumber } from "@frontend/lib/compact-number";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import type { CredentialUsageTotals } from "@frontend/types/usage-history";
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Checkbox,
	Group,
	Modal,
	NumberInput,
	Pagination,
	Paper,
	Progress,
	SegmentedControl,
	Stack,
	Switch,
	Table,
	Text,
	Textarea,
	TextInput,
	Tooltip,
} from "@mantine/core";

import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
	IconArchive,
	IconArchiveOff,
	IconCheck,
	IconDeviceFloppy,
	IconGripVertical,
	IconPencil,
	IconRefresh,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useCodexManagerParityCapability,
	useProviderRuntimeCapability,
} from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import type {
	CodexAuthMode,
	CodexLoadBalancingMode,
	CodexPlanTier,
	CodexUsageData,
} from "../../lib/api/types";
import {
	CODEX_DEFAULT_TIER_ORDER,
	CODEX_TIER_COLORS,
	getCodexDisplayTierOrder,
	getCodexTierLabel,
} from "../../lib/codex-tiers";
import type { ProxyOverride } from "../../lib/proxy";
import { relativeTime } from "../../lib/relative-time";
import { useConfirmDialog } from "../common/ConfirmDialogProvider";
import { ProxyOverrideField } from "../common/ProxyOverrideField";
import { ClientFingerprintFields } from "./ClientFingerprintFields";
import { CodexQuotaOverview } from "./CodexQuotaOverview";
import { CodexUsageDisplay } from "./CodexUsageDisplay";
import type { CustomModelEntry } from "./InlineCustomModels";
import { InlineCustomModels } from "./InlineCustomModels";
import { ModelList } from "./ModelList";

interface CodexSectionProps {
	hiddenModels: Set<string>;
	onToggleHidden: (modelVal: string) => void;
	customModels: CustomModelEntry[];
	onCustomModelsChange: (models: CustomModelEntry[]) => void;
	modelContextWindows: Record<string, number>;
	onContextWindowChange: (modelVal: string, size: number | null) => void;
	onTestModel?: (model: string) => void;
}

interface CodexImportCredential {
	authMode?: string;
	refreshToken?: string;
	accessToken?: string;
	expiresAt?: number;
	accountId?: string;
	email?: string;
	sub?: string;
	displayName?: string;
	priority?: number;
	agent_identity?: Record<string, unknown>;
}

const CODEX_STATUS_GC_TIME_MS = 60_000;
/**
 * Query key for the durable lifetime rollup.
 *
 * Named because every mutation that *deletes* a credential has to invalidate it:
 * the server drops the credential's rollup row, and a poll-only refresh would
 * leave the deleted account's totals on screen until the next interval fires.
 */
const LIFETIME_TOTALS_QUERY_KEY = ["codex", "credential-usage-totals"] as const;
const REFRESH_TOKEN_PATTERN = /^rt_[A-Za-z0-9._-]+$/;
const REFRESH_TOKEN_SEARCH_PATTERN = /rt_[A-Za-z0-9._-]+/g;

function normalizeRefreshToken(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const token = value.trim();
	return REFRESH_TOKEN_PATTERN.test(token) ? token : null;
}

function normalizeAccessToken(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const token = value.trim();
	return token ? token : null;
}

function normalizeExpiresAt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value > 0 && value < 100_000_000_000 ? value * 1000 : value;
	}
	if (typeof value !== "string" || !value.trim()) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return normalizeExpiresAt(numeric);
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

const EMAIL_SEARCH_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const AT_MARKER_DISPLAY_PATTERN = /(?:^|-{4,})\s*at\s*(?:-{4,}|$)/i;
const REFRESH_TOKEN_DISPLAY_PATTERN = /rt_[A-Za-z0-9._-]+/;

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractEmailFromString(value: unknown): string | undefined {
	const text = optionalString(value);
	return text?.match(EMAIL_SEARCH_PATTERN)?.[0];
}

function isSerializedCodexCredentialLabel(value: unknown): boolean {
	const text = optionalString(value);
	if (!text?.includes("----")) return false;
	return AT_MARKER_DISPLAY_PATTERN.test(text) || REFRESH_TOKEN_DISPLAY_PATTERN.test(text);
}

function safeCredentialDisplayName(value: unknown): string | undefined {
	const text = optionalString(value);
	if (!text || isSerializedCodexCredentialLabel(text)) return undefined;
	return text;
}

function firstSafeCredentialDisplayName(...values: unknown[]): string | undefined {
	for (const value of values) {
		const normalized = safeCredentialDisplayName(value);
		if (normalized) return normalized;
	}
	return undefined;
}

function optionalPriority(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function firstOptionalString(...values: unknown[]): string | undefined {
	for (const value of values) {
		const normalized = optionalString(value);
		if (normalized) return normalized;
	}
	return undefined;
}

function firstOptionalPriority(...values: unknown[]): number | undefined {
	for (const value of values) {
		const normalized = optionalPriority(value);
		if (normalized !== undefined) return normalized;
	}
	return undefined;
}

function credentialFromObject(item: unknown): CodexImportCredential | null {
	if (!isRecord(item)) return null;
	const record = item;
	const user = optionalRecord(record.user);
	const nestedCredentials = optionalRecord(record.credentials);
	const extra = optionalRecord(record.extra);
	const refreshToken = normalizeRefreshToken(
		record.refresh_token ??
			record.refreshToken ??
			nestedCredentials.refresh_token ??
			nestedCredentials.refreshToken,
	);
	const accessToken = normalizeAccessToken(
		record.access_token ??
			record.accessToken ??
			nestedCredentials.access_token ??
			nestedCredentials.accessToken,
	);
	// Agent Identity: pass the nested object through to the backend, which owns
	// validation/normalization. Present when the object carries a runtime id + key.
	const agentSource = isRecord(record.agent_identity)
		? record.agent_identity
		: isRecord(record.agentIdentity)
			? record.agentIdentity
			: optionalRecord(nestedCredentials.agent_identity);
	const agentRuntimeId = optionalString(agentSource.agent_runtime_id ?? agentSource.agentRuntimeId);
	const agentPrivateKey = optionalString(
		agentSource.agent_private_key ?? agentSource.agentPrivateKey,
	);
	if (agentRuntimeId && agentPrivateKey) {
		return { authMode: "agent_identity", agent_identity: agentSource };
	}
	if (!refreshToken && !accessToken) return null;
	const declaredAuthMode = optionalString(record.auth_mode ?? record.authMode)?.toLowerCase();
	const isPat =
		declaredAuthMode === "personal_access_token" ||
		(!refreshToken && !!accessToken && accessToken.startsWith("at-"));
	const email = firstOptionalString(
		record.email,
		user.email,
		nestedCredentials.email,
		extra.email,
		extractEmailFromString(record.displayName),
		extractEmailFromString(record.display_name),
		extractEmailFromString(record.name),
		extractEmailFromString(nestedCredentials.displayName),
		extractEmailFromString(nestedCredentials.display_name),
	);
	const accountId = firstOptionalString(
		record.account_id,
		record.accountId,
		nestedCredentials.account_id,
		nestedCredentials.accountId,
		nestedCredentials.chatgpt_account_id,
		nestedCredentials.chatgptAccountId,
	);
	const sub = firstOptionalString(
		record.sub,
		nestedCredentials.sub,
		nestedCredentials.chatgpt_user_id,
		nestedCredentials.chatgptUserId,
	);
	const displayName =
		firstSafeCredentialDisplayName(
			record.displayName,
			record.display_name,
			record.name,
			nestedCredentials.displayName,
			nestedCredentials.display_name,
		) ?? email;
	const priority = firstOptionalPriority(record.priority, nestedCredentials.priority);
	const expiresAt = normalizeExpiresAt(
		record.expires_at ??
			record.expiresAt ??
			nestedCredentials.expires_at ??
			nestedCredentials.expiresAt,
	);
	return {
		...(isPat ? { authMode: "personal_access_token" } : {}),
		...(refreshToken ? { refreshToken } : {}),
		...(accessToken ? { accessToken } : {}),
		...(expiresAt !== undefined ? { expiresAt } : {}),
		...(accountId ? { accountId } : {}),
		...(email ? { email } : {}),
		...(sub ? { sub } : {}),
		...(displayName ? { displayName } : {}),
		...(priority !== undefined ? { priority } : {}),
	};
}

function credentialsFromAtMarkerRecord(record: string, email?: string): CodexImportCredential[] {
	const parts = record.split(/-{4,}/).map((part) => part.trim());
	return parts.flatMap((part, index) => {
		if (part.toLowerCase() !== "at") return [];
		const accessToken = normalizeAccessToken(parts[index + 1]);
		return accessToken
			? [
					{
						accessToken,
						...(email ? { email, displayName: email } : {}),
					},
				]
			: [];
	});
}

function credentialsFromText(text: string): CodexImportCredential[] {
	const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
	return text.split(/[,\n]+/).flatMap((record) => {
		const email = optionalString(record.match(emailRegex)?.[0]);
		const refreshCredentials = [...record.matchAll(REFRESH_TOKEN_SEARCH_PATTERN)].flatMap(
			(match) => {
				const refreshToken = normalizeRefreshToken(match[0]);
				return refreshToken
					? [
							{
								refreshToken,
								...(email ? { email, displayName: email } : {}),
							},
						]
					: [];
			},
		);
		return [...refreshCredentials, ...credentialsFromAtMarkerRecord(record, email)];
	});
}

function credentialsFromParsedImport(parsed: unknown): CodexImportCredential[] {
	if (typeof parsed === "string") return credentialsFromText(parsed);
	if (Array.isArray(parsed)) return parsed.flatMap((item) => credentialsFromParsedImport(item));
	if (!isRecord(parsed)) return [];

	const accounts = parsed.accounts;
	if (Array.isArray(accounts)) return accounts.flatMap((item) => credentialsFromParsedImport(item));

	const credentials = parsed.credentials;
	if (Array.isArray(credentials)) {
		return credentials.flatMap((item) => credentialsFromParsedImport(item));
	}

	const credential = credentialFromObject(parsed);
	return credential ? [credential] : [];
}

function CodexAuthModeBadge({ authMode }: { authMode?: CodexAuthMode }) {
	const { t } = useTranslation("settings");
	const mode = authMode ?? "oauth";
	// OAuth is the default/common case; keep the UI quiet for it.
	if (mode === "oauth") return null;
	const color = mode === "agent_identity" ? "grape" : "cyan";
	const label = mode === "agent_identity" ? t("codexAuthModeAgentIdentity") : t("codexAuthModePat");
	return (
		<Badge size="xs" variant="light" color={color}>
			{label}
		</Badge>
	);
}

function SortableTierChip({ tier, label }: { tier: CodexPlanTier; label: string }) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: tier,
	});
	return (
		<Paper
			ref={setNodeRef}
			withBorder
			px="xs"
			py={6}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				opacity: isDragging ? 0.55 : 1,
				cursor: "grab",
			}}
			{...attributes}
			{...listeners}
		>
			<Group gap={6} wrap="nowrap">
				<IconGripVertical size={14} color="var(--mantine-color-dimmed)" />
				<Badge color={CODEX_TIER_COLORS[tier]} variant="light">
					{label}
				</Badge>
			</Group>
		</Paper>
	);
}

export const CodexSection = React.memo(function CodexSection({
	hiddenModels,
	onToggleHidden,
	customModels,
	onCustomModelsChange,
	modelContextWindows,
	onContextWindowChange,
	onTestModel,
}: CodexSectionProps) {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const qc = useQueryClient();
	const { data: codexSettingsData } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		gcTime: 60_000,
	});
	// biome-ignore lint/suspicious/noExplicitAny: dynamic settings JSON
	const codexProxy = (codexSettingsData as any)?.codex?.proxy as ProxyOverride | undefined;
	const codexProxyMut = useMutation({
		mutationFn: (proxy: ProxyOverride | undefined) => api.updateSettings({ codex: { proxy } }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			notifications.show({ message: t("proxySaved"), color: "green" });
		},
	});
	const codexRuntimeCapability = useProviderRuntimeCapability("codex");
	const providerRouteUnsupportedReason = t("providerRouteUnsupported");
	const codexRoutesSupported = codexRuntimeCapability?.routes?.supported !== false;
	const isCodexRouteSupported = (route: string) =>
		codexRoutesSupported && codexRuntimeCapability?.routes?.[route] !== false;
	const codexManagerParity = useCodexManagerParityCapability();
	const usageQueueClearSupported = codexManagerParity?.usageQueueClearSupported !== false;
	const canReadCodexStatus = isCodexRouteSupported("status");
	const canSetLoadBalancingMode = isCodexRouteSupported("loadBalancingMode");
	const canSetUseWebSocket = isCodexRouteSupported("useWebSocket");
	const canSetUseWebSearch = isCodexRouteSupported("useWebSearch");
	const canSetUseImageGeneration = isCodexRouteSupported("useImageGeneration");
	const canSetFingerprint = isCodexRouteSupported("fingerprint");
	const canSetTierOrder = isCodexRouteSupported("tierOrder");
	const canQueryCredentialUsage = isCodexRouteSupported("credentialUsage");
	const canEnableCredential = isCodexRouteSupported("credentialEnable");
	const canDisableCredential = isCodexRouteSupported("credentialDisable");
	const canResetCredential = isCodexRouteSupported("credentialReset");
	const canUpdateCredential = isCodexRouteSupported("credentialUpdate");
	const canDeleteCredential = isCodexRouteSupported("credentialDelete");
	const canArchiveCredential =
		isCodexRouteSupported("credentialArchive") && isCodexRouteSupported("credentialUnarchive");
	const canBatchDeleteCredentials = isCodexRouteSupported("credentialBatchDelete");
	const canDeleteUnhealthyCredentials = isCodexRouteSupported("credentialDeleteUnhealthy");
	const canImportCredentials = isCodexRouteSupported("import");
	const canClearUsageQueue = usageQueueClearSupported && isCodexRouteSupported("usageQueueClear");
	const canStartBrowserAuth = isCodexRouteSupported("browserAuth");
	const canCancelBrowserAuth = isCodexRouteSupported("browserAuthCancel");
	const canStartDeviceAuth = isCodexRouteSupported("deviceAuthStart");
	const canPollDeviceAuth = isCodexRouteSupported("deviceAuthPoll");
	const canRunDeviceAuth = canStartDeviceAuth && canPollDeviceAuth;
	const canCancelDeviceAuth = isCodexRouteSupported("deviceAuthCancel");
	const showCodexParityWarning =
		codexManagerParity?.tsCodexManagerEquivalent === false ||
		codexManagerParity?.usageQueueParity === "partial" ||
		codexManagerParity?.snapshotPaginationParity === "partial";
	const [browserAuthPending, setBrowserAuthPending] = useState(false);
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
	const [useWebSocket, setUseWebSocket] = useState(true);
	const [useWebSocketInitialized, setUseWebSocketInitialized] = useState(false);
	const [useWebSearch, setUseWebSearch] = useState(true);
	const [useWebSearchInitialized, setUseWebSearchInitialized] = useState(false);
	const [useImageGeneration, setUseImageGeneration] = useState(true);
	const [useImageGenerationInitialized, setUseImageGenerationInitialized] = useState(false);
	const [tierOrder, setTierOrder] = useState<CodexPlanTier[]>(CODEX_DEFAULT_TIER_ORDER);
	const [fingerprint, setFingerprint] = useState<{
		userAgentMode: "narrafork" | "claude-code" | "codex" | "custom";
		customUserAgent: string;
		extraHeaders: Record<string, string>;
		emulateCodexHeaders: boolean;
	}>({
		userAgentMode: "codex",
		customUserAgent: "",
		extraHeaders: {},
		emulateCodexHeaders: true,
	});
	const [fingerprintInitialized, setFingerprintInitialized] = useState(false);
	const [importJson, setImportJson] = useState("");
	const [importError, setImportError] = useState<string | null>(null);
	const [importResult, setImportResult] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [availablePage, setAvailablePage] = useState(1);
	const [unavailablePage, setUnavailablePage] = useState(1);
	const [archivedPage, setArchivedPage] = useState(1);
	const PAGE_SIZE = 20;
	const tierOrderSensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
	);
	const deviceAuthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const browserAuthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const browserAuthTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastSyncedTierOrderRef = useRef<string | null>(null);

	// Cleanup polling intervals/timeouts on unmount
	useEffect(() => {
		return () => {
			if (deviceAuthIntervalRef.current) {
				clearInterval(deviceAuthIntervalRef.current);
			}
			if (browserAuthIntervalRef.current) {
				clearInterval(browserAuthIntervalRef.current);
			}
			if (browserAuthTimeoutRef.current) {
				clearTimeout(browserAuthTimeoutRef.current);
			}
		};
	}, []);

	const { data: settingsData } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
	});
	const { data: status } = useQuery({
		queryKey: [
			"codex",
			"status",
			{ availablePage, unavailablePage, archivedPage, pageSize: PAGE_SIZE },
		],
		queryFn: () =>
			api.codexStatus({ availablePage, unavailablePage, archivedPage, pageSize: PAGE_SIZE }),
		enabled: canReadCodexStatus,
		refetchInterval: (query) => {
			if (browserAuthPending) return 3_000;
			if (query.state.data?.usageQueue?.isRunning) return 3_000;
			return 30_000;
		},
		gcTime: CODEX_STATUS_GC_TIME_MS,
	});
	const { data: fingerprintData } = useQuery({
		queryKey: ["codex", "fingerprint"],
		queryFn: api.codexGetFingerprint,
		enabled: canReadCodexStatus,
	});
	// Lifetime totals come from their own durable table, so they are fetched
	// separately from the pool snapshot and refresh far less often.
	const { data: lifetimeTotalsData } = useQuery({
		queryKey: LIFETIME_TOTALS_QUERY_KEY,
		queryFn: api.codexCredentialUsageTotals,
		enabled: canReadCodexStatus,
		refetchInterval: 60_000,
		// The rollup only moves as requests complete, so a minute-old value is
		// fine; without this every remount refires the query on top of the poll.
		staleTime: 30_000,
	});

	// Seed local fingerprint state from server data once loaded.
	useEffect(() => {
		if (fingerprintData && !fingerprintInitialized) {
			setFingerprint({
				userAgentMode: fingerprintData.userAgentMode,
				customUserAgent: fingerprintData.customUserAgent,
				extraHeaders: fingerprintData.extraHeaders,
				emulateCodexHeaders: fingerprintData.emulateCodexHeaders,
			});
			setFingerprintInitialized(true);
		}
	}, [fingerprintData, fingerprintInitialized]);

	const codexModelIds: string[] = settingsData?.codexModels ?? [];
	const builtinContextWindows: Record<string, number> =
		settingsData?.builtinModelContextWindows ?? {};
	const entries = status?.entries ?? [];
	const availableEntries = status?.availableEntries ?? [];
	const unavailableEntries = status?.unavailableEntries ?? [];
	const archivedEntries = status?.archivedEntries ?? [];
	const availableTotal = status?.availableTotal ?? 0;
	const unavailableTotal = status?.unavailableTotal ?? 0;
	const archivedTotal = status?.archivedTotal ?? 0;
	const unhealthyTotal = status?.unhealthyTotal ?? 0;
	const loadBalancingMode = status?.loadBalancingMode ?? "tier-balanced";
	const usageCache = status?.usageCache ?? {};
	const lifetimeTotals = useMemo(() => {
		const map: Record<string, CredentialUsageTotals> = {};
		for (const entry of lifetimeTotalsData?.entries ?? []) {
			map[entry.credentialId] = entry;
		}
		return map;
	}, [lifetimeTotalsData]);
	const stickySessionCount = status?.stickySessionCount ?? 0;
	const lastBrowserAuthError = status?.lastBrowserAuthError;
	const statusTierOrder = status ? status.tierOrder : null;

	useEffect(() => {
		const maxAvailablePage = Math.max(1, Math.ceil(availableTotal / PAGE_SIZE));
		const maxUnavailablePage = Math.max(1, Math.ceil(unavailableTotal / PAGE_SIZE));
		const maxArchivedPage = Math.max(1, Math.ceil(archivedTotal / PAGE_SIZE));
		if (availablePage > maxAvailablePage) setAvailablePage(maxAvailablePage);
		if (unavailablePage > maxUnavailablePage) setUnavailablePage(maxUnavailablePage);
		if (archivedPage > maxArchivedPage) setArchivedPage(maxArchivedPage);
	}, [
		availableTotal,
		unavailableTotal,
		archivedTotal,
		availablePage,
		unavailablePage,
		archivedPage,
	]);

	useEffect(() => {
		if (!status) return;
		if (!useWebSocketInitialized) {
			setUseWebSocket(status.useWebSocket ?? true);
			setUseWebSocketInitialized(true);
		}
		if (!useWebSearchInitialized) {
			setUseWebSearch(status.useWebSearch ?? true);
			setUseWebSearchInitialized(true);
		}
		if (!useImageGenerationInitialized) {
			setUseImageGeneration(status.useImageGeneration ?? true);
			setUseImageGenerationInitialized(true);
		}
	}, [status, useWebSocketInitialized, useWebSearchInitialized, useImageGenerationInitialized]);

	useEffect(() => {
		if (statusTierOrder === null) return;
		const nextTierOrder = getCodexDisplayTierOrder(statusTierOrder);
		const nextTierOrderKey = nextTierOrder.join(",");
		if (lastSyncedTierOrderRef.current === nextTierOrderKey) return;
		lastSyncedTierOrderRef.current = nextTierOrderKey;
		setTierOrder((currentTierOrder) =>
			currentTierOrder.join(",") === nextTierOrderKey ? currentTierOrder : nextTierOrder,
		);
	}, [statusTierOrder]);

	// Auto-detect browser auth failure from server-side error
	useEffect(() => {
		if (browserAuthPending && lastBrowserAuthError) {
			// Clean up polling
			if (browserAuthIntervalRef.current) {
				clearInterval(browserAuthIntervalRef.current);
				browserAuthIntervalRef.current = null;
			}
			if (browserAuthTimeoutRef.current) {
				clearTimeout(browserAuthTimeoutRef.current);
				browserAuthTimeoutRef.current = null;
			}
			setBrowserAuthPending(false);
			setBrowserAuthLoading(false);
			notifications.show({
				message: lastBrowserAuthError,
				color: "red",
				autoClose: 10_000,
			});
		}
	}, [browserAuthPending, lastBrowserAuthError]);

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
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			// Deletion clears the server-side rollup; refetch so the removed
			// account's lifetime totals disappear with it.
			qc.invalidateQueries({ queryKey: LIFETIME_TOTALS_QUERY_KEY });
		},
	});
	const archiveMut = useMutation({
		mutationFn: (id: string) => api.codexCredentialArchive(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["codex", "status"] }),
	});
	const unarchiveMut = useMutation({
		mutationFn: (id: string) => api.codexCredentialUnarchive(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["codex", "status"] }),
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
	const fingerprintMut = useMutation({
		mutationFn: (data: {
			userAgentMode?: "narrafork" | "claude-code" | "codex" | "custom";
			customUserAgent?: string;
			extraHeaders?: Record<string, string>;
			emulateCodexHeaders?: boolean;
		}) => api.codexSetFingerprint(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "fingerprint"] });
			notifications.show({ message: t("codexUpdateSuccess"), color: "green" });
		},
	});
	const regenerateInstallationIdMut = useMutation({
		mutationFn: () => api.codexRegenerateInstallationId(),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "fingerprint"] });
			notifications.show({ message: t("codexUpdateSuccess"), color: "green" });
		},
	});
	const lbModeMut = useMutation({
		mutationFn: (mode: CodexLoadBalancingMode) => api.codexSetLoadBalancingMode(mode),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["codex", "status"] }),
	});
	const useWebSocketMut = useMutation({
		mutationFn: (useWebSocket: boolean) => api.codexSetUseWebSocket(useWebSocket),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			notifications.show({ message: t("codexWebSocketUpdated"), color: "green" });
		},
	});
	const useWebSearchMut = useMutation({
		mutationFn: (useWebSearch: boolean) => api.codexSetUseWebSearch(useWebSearch),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			notifications.show({ message: t("codexWebSearchUpdated"), color: "green" });
		},
	});
	const useImageGenerationMut = useMutation({
		mutationFn: (useImageGeneration: boolean) => api.codexSetUseImageGeneration(useImageGeneration),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			notifications.show({ message: t("codexImageGenerationUpdated"), color: "green" });
		},
	});
	const tierOrderMut = useMutation({
		mutationFn: (tierOrder: CodexPlanTier[]) => api.codexSetTierOrder(tierOrder),
		onSuccess: (data) => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			qc.invalidateQueries({ queryKey: ["codex", "quota-overview"] });
			setTierOrder(getCodexDisplayTierOrder(data.tierOrder));
			notifications.show({ message: t("codexTierOrderUpdated"), color: "green" });
		},
		onError: (err: Error) => {
			notifications.show({ message: err.message, color: "red" });
		},
	});
	const importMut = useMutation({
		mutationFn: (credentials: CodexImportCredential[]) => api.codexImportCredentials(credentials),
		onSuccess: (data) => {
			const message = t("codexImportSuccess", {
				added: data.added,
				duplicates: data.duplicates,
			});
			setImportResult(message);
			setImportError(null);
			setImportJson("");
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
		},
		onError: (err: Error) => {
			setImportError(err.message);
			setImportResult(null);
		},
	});
	const usageMut = useMutation({
		mutationFn: (id: string) => api.codexCredentialGetUsage(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			notifications.show({ message: t("codexUsageSuccess"), color: "green" });
		},
		onError: (err: Error) => {
			notifications.show({ message: err.message, color: "red" });
		},
	});
	const batchDeleteMut = useMutation({
		mutationFn: (ids: string[]) => api.codexCredentialBatchDelete(ids),
		onSuccess: (data) => {
			setSelectedIds(new Set());
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			qc.invalidateQueries({ queryKey: LIFETIME_TOTALS_QUERY_KEY });
			notifications.show({
				message: t("codexBatchDeleteSuccess", { count: data.removed.length }),
				color: "green",
			});
		},
	});
	const deleteUnhealthyMut = useMutation({
		mutationFn: () => api.codexCredentialDeleteUnhealthy(),
		onSuccess: (data) => {
			setSelectedIds(new Set());
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			qc.invalidateQueries({ queryKey: LIFETIME_TOTALS_QUERY_KEY });
			notifications.show({
				message: t("codexDeleteUnhealthySuccess", { count: data.removed.length }),
				color: "green",
			});
		},
	});
	const usageQueueClearMut = useMutation({
		mutationFn: () => api.codexUsageQueueClear(),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["codex", "status"] }),
	});

	const toggleSelect = (id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleSelectAll = (entryIds: string[]) => {
		setSelectedIds((prev) => {
			const allSelected = entryIds.every((id) => prev.has(id));
			const next = new Set(prev);
			if (allSelected) {
				for (const id of entryIds) next.delete(id);
			} else {
				for (const id of entryIds) next.add(id);
			}
			return next;
		});
	};

	const handleBatchDelete = async () => {
		if (!canBatchDeleteCredentials || selectedIds.size === 0) return;
		if (await confirm({ message: t("codexBatchDeleteConfirm", { count: selectedIds.size }) })) {
			batchDeleteMut.mutate([...selectedIds]);
		}
	};

	const handleDeleteUnhealthy = async () => {
		if (!canDeleteUnhealthyCredentials || unhealthyTotal === 0) return;
		if (await confirm({ message: t("codexDeleteUnhealthyConfirm", { count: unhealthyTotal }) })) {
			deleteUnhealthyMut.mutate();
		}
	};

	const handleBrowserAuth = async () => {
		if (!canStartBrowserAuth) return;
		const initialTotal = status?.total ?? 0;
		setBrowserAuthLoading(true);
		setBrowserAuthPending(true);

		try {
			const result = await api.codexBrowserAuth();
			window.open(result.authorizeUrl, "_blank");

			const cleanupBrowserAuth = () => {
				if (browserAuthIntervalRef.current) {
					clearInterval(browserAuthIntervalRef.current);
					browserAuthIntervalRef.current = null;
				}
				if (browserAuthTimeoutRef.current) {
					clearTimeout(browserAuthTimeoutRef.current);
					browserAuthTimeoutRef.current = null;
				}
			};

			// Set timeout to auto-cancel after 60 seconds
			browserAuthTimeoutRef.current = setTimeout(() => {
				cleanupBrowserAuth();
				handleCancelBrowserAuth();
				notifications.show({
					message: "Browser authorization timed out",
					color: "orange",
				});
			}, 60_000);

			// Monitor for new credentials
			let detected = false;
			browserAuthIntervalRef.current = setInterval(() => {
				if (detected) return;
				qc.invalidateQueries({ queryKey: ["codex", "status"] });
				// Check total from any cached codex status query
				const queries = qc.getQueriesData<{ total?: number }>({
					queryKey: ["codex", "status"],
				});
				const currentTotal = queries[0]?.[1]?.total ?? 0;

				if (currentTotal > initialTotal) {
					detected = true;
					cleanupBrowserAuth();
					setBrowserAuthPending(false);
					setBrowserAuthLoading(false);
					notifications.show({
						message: t("codexAuthSuccess"),
						color: "green",
					});
				}
			}, 3_000);
		} catch (err) {
			setBrowserAuthPending(false);
			setBrowserAuthLoading(false);
			notifications.show({
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		}
	};

	const handleCancelBrowserAuth = async () => {
		if (!canCancelBrowserAuth) return;
		try {
			await api.codexBrowserAuthCancel();
			setBrowserAuthPending(false);
			setBrowserAuthLoading(false);
		} catch (err) {
			notifications.show({
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		}
	};

	const handleDeviceAuth = async () => {
		if (!canRunDeviceAuth) return;
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
		if (!canPollDeviceAuth) return;
		let polling = true;
		deviceAuthIntervalRef.current = setInterval(async () => {
			if (!polling) return;
			try {
				const result = await api.codexDeviceAuthPoll();
				if (!polling) return;
				if (!result.pending) {
					polling = false;
					if (deviceAuthIntervalRef.current) clearInterval(deviceAuthIntervalRef.current);
					deviceAuthIntervalRef.current = null;
					setDeviceAuthModal(false);
					setDeviceAuthData(null);
					qc.invalidateQueries({ queryKey: ["codex", "status"] });
					notifications.show({
						message: t("codexDeviceAuthSuccess"),
						color: "green",
					});
				}
			} catch {
				polling = false;
				if (deviceAuthIntervalRef.current) clearInterval(deviceAuthIntervalRef.current);
				deviceAuthIntervalRef.current = null;
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
		if (!editingId || !canUpdateCredential) return;
		// Send "" (not undefined) so clearing the name actually persists — the
		// backend skips undefined fields, and JSON.stringify drops them anyway.
		const data: { displayName?: string; priority?: number } = {
			displayName: editForm.displayName,
			priority: editForm.priority,
		};
		updateMut.mutate({ id: editingId, data });
	};

	const handleTierOrderDragEnd = (event: DragEndEvent) => {
		if (!canSetTierOrder) return;
		const { active, over } = event;
		if (!over || active.id === over.id) return;
		const oldIndex = tierOrder.indexOf(active.id as CodexPlanTier);
		const newIndex = tierOrder.indexOf(over.id as CodexPlanTier);
		if (oldIndex === -1 || newIndex === -1) return;
		const nextOrder = arrayMove(tierOrder, oldIndex, newIndex);
		setTierOrder(nextOrder);
		tierOrderMut.mutate(nextOrder);
	};

	const handleResetTierOrder = () => {
		if (!canSetTierOrder) return;
		setTierOrder(CODEX_DEFAULT_TIER_ORDER);
		tierOrderMut.mutate(CODEX_DEFAULT_TIER_ORDER);
	};

	const handleImport = () => {
		if (!canImportCredentials) return;
		setImportError(null);
		setImportResult(null);

		const importText = importJson.trim();
		let credentials: CodexImportCredential[];

		try {
			credentials = credentialsFromParsedImport(JSON.parse(importText));
		} catch (_err) {
			credentials = credentialsFromText(importText);
		}

		if (credentials.length === 0) {
			setImportError(t("codexImportNoValidTokens"));
			return;
		}

		importMut.mutate(credentials);
	};

	return (
		<Stack gap="md">
			<Group justify="space-between">
				<Text size="sm" c="dimmed">
					{t("codexDescription")}
				</Text>
				<Badge size="sm" color={status?.available ? "green" : "gray"}>
					{status?.available ?? 0} / {status?.total ?? 0}
				</Badge>
			</Group>
			{showCodexParityWarning && (
				<Alert color="yellow" variant="light" title={t("codexManagerParityWarning")}>
					{codexManagerParity?.reason ?? t("codexManagerParityWarningDesc")}
				</Alert>
			)}

			{/* Global settings */}
			<Stack gap="xs">
				<Group justify="space-between">
					<Stack gap={2}>
						<Text size="sm" fw={500}>
							{t("codexGlobalSettings")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("codexStickySessionsCount", { count: stickySessionCount })}
						</Text>
					</Stack>
					<SegmentedControl
						size="xs"
						value={loadBalancingMode}
						disabled={!canSetLoadBalancingMode}
						onChange={(v) =>
							canSetLoadBalancingMode && lbModeMut.mutate(v as CodexLoadBalancingMode)
						}
						data={[
							{ label: t("codexModePriority"), value: "priority" },
							{ label: t("codexModeBalanced"), value: "balanced" },
							{ label: t("codexModeTierBalanced"), value: "tier-balanced" },
						]}
					/>
				</Group>
				<Stack gap={4}>
					<Group justify="space-between" align="flex-end">
						<Stack gap={2}>
							<Text size="xs" fw={500}>
								{t("codexTierOrder")}
							</Text>
							<Text size="xs" c="dimmed">
								{t("codexTierOrderDesc")}
							</Text>
						</Stack>
						<Button
							size="compact-xs"
							variant="subtle"
							onClick={handleResetTierOrder}
							loading={tierOrderMut.isPending}
							disabled={!canSetTierOrder}
							title={!canSetTierOrder ? providerRouteUnsupportedReason : undefined}
						>
							{t("codexTierOrderReset")}
						</Button>
					</Group>
					<DndContext
						sensors={tierOrderSensors}
						collisionDetection={closestCenter}
						onDragEnd={handleTierOrderDragEnd}
					>
						<SortableContext items={tierOrder} strategy={rectSortingStrategy}>
							<Group gap="xs" wrap="wrap">
								{tierOrder.map((tier) => (
									<SortableTierChip key={tier} tier={tier} label={getCodexTierLabel(t, tier)} />
								))}
							</Group>
						</SortableContext>
					</DndContext>
				</Stack>
				<ProxyOverrideField
					value={codexProxy}
					onChange={(next) => codexProxyMut.mutate(next)}
					disabled={codexProxyMut.isPending}
				/>
				<Group align="flex-end">
					<Stack gap={4} style={{ flex: 1 }}>
						<Group gap="xs">
							<Text size="xs" fw={500}>
								{t("codexUseWebSocket")}
							</Text>
							<Badge size="xs" color="orange" variant="light">
								{t("codexExperimental")}
							</Badge>
						</Group>
						<Text size="xs" c="dimmed">
							{t("codexUseWebSocketDesc")}
						</Text>
					</Stack>
					<Switch
						size="sm"
						checked={useWebSocket}
						onChange={(e) => setUseWebSocket(e.currentTarget.checked)}
						disabled={!canSetUseWebSocket}
					/>
					<Button
						size="xs"
						onClick={() => canSetUseWebSocket && useWebSocketMut.mutate(useWebSocket)}
						loading={useWebSocketMut.isPending}
						disabled={!canSetUseWebSocket}
						title={!canSetUseWebSocket ? providerRouteUnsupportedReason : undefined}
					>
						{t("codexSave")}
					</Button>
				</Group>
				<Group align="flex-end">
					<Stack gap={4} style={{ flex: 1 }}>
						<Text size="xs" fw={500}>
							{t("codexUseWebSearch")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("codexUseWebSearchDesc")}
						</Text>
					</Stack>
					<Switch
						size="sm"
						checked={useWebSearch}
						onChange={(e) => setUseWebSearch(e.currentTarget.checked)}
						disabled={!canSetUseWebSearch}
					/>
					<Button
						size="xs"
						onClick={() => canSetUseWebSearch && useWebSearchMut.mutate(useWebSearch)}
						loading={useWebSearchMut.isPending}
						disabled={!canSetUseWebSearch}
						title={!canSetUseWebSearch ? providerRouteUnsupportedReason : undefined}
					>
						{t("codexSave")}
					</Button>
				</Group>
				<Group align="flex-end">
					<Stack gap={4} style={{ flex: 1 }}>
						<Text size="xs" fw={500}>
							{t("codexUseImageGeneration")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("codexUseImageGenerationDesc")}
						</Text>
					</Stack>
					<Switch
						size="sm"
						checked={useImageGeneration}
						onChange={(e) => setUseImageGeneration(e.currentTarget.checked)}
						disabled={!canSetUseImageGeneration}
					/>
					<Button
						size="xs"
						onClick={() =>
							canSetUseImageGeneration && useImageGenerationMut.mutate(useImageGeneration)
						}
						loading={useImageGenerationMut.isPending}
						disabled={!canSetUseImageGeneration}
						title={!canSetUseImageGeneration ? providerRouteUnsupportedReason : undefined}
					>
						{t("codexSave")}
					</Button>
				</Group>
			</Stack>

			{/* Client fingerprint */}
			<Stack gap="xs">
				<Group gap="xs">
					<Text size="sm" fw={500}>
						{t("fingerprintTitle")}
					</Text>
				</Group>
				<Text size="xs" c="dimmed">
					{t("fingerprintDesc")}
				</Text>
				<ClientFingerprintFields
					value={fingerprint}
					showEmulateToggle
					emulateCodexDefault
					showInstallationId
					installationId={fingerprintData?.installationId}
					disabled={!canSetFingerprint}
					regenerating={regenerateInstallationIdMut.isPending}
					onRegenerateInstallationId={() => regenerateInstallationIdMut.mutate()}
					onChange={(next) => setFingerprint((prev) => ({ ...prev, ...next }))}
				/>
				<Group justify="flex-end">
					<Button
						size="xs"
						onClick={() => canSetFingerprint && fingerprintMut.mutate(fingerprint)}
						loading={fingerprintMut.isPending}
						disabled={!canSetFingerprint}
						title={!canSetFingerprint ? providerRouteUnsupportedReason : undefined}
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
				{browserAuthPending ? (
					<Paper withBorder p="sm" bg="blue.0">
						<Stack gap="xs">
							<Group gap="xs">
								<Text size="sm" c="blue">
									Waiting for browser authorization...
								</Text>
							</Group>
							<Button
								size="xs"
								variant="light"
								color="orange"
								onClick={handleCancelBrowserAuth}
								disabled={!canCancelBrowserAuth}
								title={!canCancelBrowserAuth ? providerRouteUnsupportedReason : undefined}
							>
								Cancel
							</Button>
						</Stack>
					</Paper>
				) : (
					<Group>
						<Button
							size="xs"
							onClick={handleBrowserAuth}
							loading={browserAuthLoading}
							disabled={!canStartBrowserAuth}
							title={!canStartBrowserAuth ? providerRouteUnsupportedReason : undefined}
						>
							{t("codexAddBrowser")}
						</Button>
						<Button
							size="xs"
							variant="light"
							onClick={handleDeviceAuth}
							disabled={!canRunDeviceAuth}
							title={!canRunDeviceAuth ? providerRouteUnsupportedReason : undefined}
						>
							{t("codexAddDevice")}
						</Button>
					</Group>
				)}
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
					size="xs"
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
						size="xs"
						onClick={handleImport}
						loading={importMut.isPending}
						disabled={!importJson.trim() || !canImportCredentials}
						title={!canImportCredentials ? providerRouteUnsupportedReason : undefined}
					>
						{t("codexImport")}
					</Button>
					<Button
						size="xs"
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

			{/* Usage fetch queue progress */}
			{status?.usageQueue && status.usageQueue.items.length > 0 && (
				<Paper withBorder p="sm">
					<Stack gap="xs">
						<Group justify="space-between">
							<Text size="sm" fw={500}>
								{t("codexUsageQueueTitle")}
							</Text>
							<Button
								size="compact-xs"
								variant="subtle"
								onClick={() => canClearUsageQueue && usageQueueClearMut.mutate()}
								loading={usageQueueClearMut.isPending}
								disabled={!canClearUsageQueue}
								title={
									!canClearUsageQueue
										? usageQueueClearSupported
											? providerRouteUnsupportedReason
											: t("codexUsageQueueClearUnsupported")
										: undefined
								}
							>
								{t("codexUsageQueueClear")}
							</Button>
						</Group>
						{(() => {
							const items = status?.usageQueue?.items ?? [];
							const total = items.length;
							const done = items.filter((i) => i.status === "done").length;
							const failed = items.filter((i) => i.status === "failed").length;
							const pending = items.filter(
								(i) => i.status === "pending" || i.status === "processing",
							).length;
							const pct = total > 0 ? ((done + failed) / total) * 100 : 0;
							return (
								<>
									<Progress
										value={pct}
										size="sm"
										color={failed > 0 ? "orange" : "indigo"}
										animated={status?.usageQueue?.isRunning ?? false}
									/>
									<Text size="xs" c="dimmed">
										{pending > 0
											? t("codexUsageQueueProgress", {
													done,
													total,
													pending,
													failed,
												})
											: t("codexUsageQueueDone")}
									</Text>
								</>
							);
						})()}
					</Stack>
				</Paper>
			)}

			{status?.usageSummary && status?.usageForecast && status?.usageScheduler && (
				<CodexQuotaOverview
					summary={status.usageSummary}
					trend={status.usageForecast}
					scheduler={status.usageScheduler}
					tierOrder={tierOrder}
				/>
			)}

			{/* Credentials list (responsive: cards on mobile, table on desktop) */}
			{(status?.total ?? 0) > 0 && (
				<Stack gap="xs">
					<Group justify="space-between" align="center">
						<Group gap="xs">
							<Text size="sm" fw={500}>
								{t("codexCredentials")}
							</Text>
							<Badge size="sm" color={availableTotal > 0 ? "green" : "red"}>
								{availableTotal} / {status?.total ?? 0}
							</Badge>
						</Group>
						<Group gap="xs">
							{selectedIds.size > 0 && (
								<Button
									size="compact-xs"
									color="red"
									variant="light"
									leftSection={<IconTrash size={14} />}
									onClick={handleBatchDelete}
									loading={batchDeleteMut.isPending}
									disabled={!canBatchDeleteCredentials}
									title={!canBatchDeleteCredentials ? providerRouteUnsupportedReason : undefined}
								>
									{t("codexBatchDelete")} ({selectedIds.size})
								</Button>
							)}
							<Button
								size="compact-xs"
								color="red"
								variant="outline"
								leftSection={<IconTrash size={14} />}
								onClick={handleDeleteUnhealthy}
								loading={deleteUnhealthyMut.isPending}
								disabled={!canDeleteUnhealthyCredentials || unhealthyTotal === 0}
								title={!canDeleteUnhealthyCredentials ? providerRouteUnsupportedReason : undefined}
							>
								{t("codexDeleteUnhealthy")} ({unhealthyTotal})
							</Button>
						</Group>
					</Group>
					{availableTotal > 0 && (
						<Stack gap="xs">
							<Group justify="space-between">
								<Text size="sm" fw={500}>
									{t("codexCredentialsAvailable")}
								</Text>
								<Badge size="sm" color="green">
									{availableTotal}
								</Badge>
							</Group>
							<CredentialList
								entries={availableEntries}
								totalEntries={availableTotal}
								page={availablePage}
								pageSize={PAGE_SIZE}
								onPageChange={setAvailablePage}
								currentId={status?.currentId}
								usageCache={usageCache}
								lifetimeTotals={lifetimeTotals}
								editingId={editingId}
								editForm={editForm}
								onEdit={handleEdit}
								onSaveEdit={handleSaveEdit}
								onCancelEdit={() => setEditingId(null)}
								onEditFormChange={setEditForm}
								usageMut={usageMut}
								enableMut={enableMut}
								disableMut={disableMut}
								resetMut={resetMut}
								deleteMut={deleteMut}
								archiveMut={archiveMut}
								unarchiveMut={unarchiveMut}
								selectedIds={selectedIds}
								onToggleSelect={toggleSelect}
								onToggleSelectAll={toggleSelectAll}
								t={t}
								canQueryCredentialUsage={canQueryCredentialUsage}
								canEnableCredential={canEnableCredential}
								canDisableCredential={canDisableCredential}
								canResetCredential={canResetCredential}
								canUpdateCredential={canUpdateCredential}
								canDeleteCredential={canDeleteCredential}
								canArchiveCredential={canArchiveCredential}
								credentialRouteUnsupportedReason={providerRouteUnsupportedReason}
							/>
						</Stack>
					)}

					{unavailableTotal > 0 && (
						<Stack gap="xs">
							<Group justify="space-between">
								<Text size="sm" fw={500}>
									{t("codexCredentialsUnavailable")}
								</Text>
								<Badge size="sm" color="red">
									{unavailableTotal}
								</Badge>
							</Group>
							<CredentialList
								entries={unavailableEntries}
								totalEntries={unavailableTotal}
								page={unavailablePage}
								pageSize={PAGE_SIZE}
								onPageChange={setUnavailablePage}
								currentId={status?.currentId}
								usageCache={usageCache}
								lifetimeTotals={lifetimeTotals}
								editingId={editingId}
								editForm={editForm}
								onEdit={handleEdit}
								onSaveEdit={handleSaveEdit}
								onCancelEdit={() => setEditingId(null)}
								onEditFormChange={setEditForm}
								usageMut={usageMut}
								enableMut={enableMut}
								disableMut={disableMut}
								resetMut={resetMut}
								deleteMut={deleteMut}
								archiveMut={archiveMut}
								unarchiveMut={unarchiveMut}
								selectedIds={selectedIds}
								onToggleSelect={toggleSelect}
								onToggleSelectAll={toggleSelectAll}
								t={t}
								canQueryCredentialUsage={canQueryCredentialUsage}
								canEnableCredential={canEnableCredential}
								canDisableCredential={canDisableCredential}
								canResetCredential={canResetCredential}
								canUpdateCredential={canUpdateCredential}
								canDeleteCredential={canDeleteCredential}
								canArchiveCredential={canArchiveCredential}
								credentialRouteUnsupportedReason={providerRouteUnsupportedReason}
							/>
						</Stack>
					)}

					{archivedTotal > 0 && (
						<Stack gap="xs">
							<Group justify="space-between">
								<Stack gap={2}>
									<Text size="sm" fw={500}>
										{t("codexCredentialsArchived")}
									</Text>
									<Text size="xs" c="dimmed">
										{t("codexCredentialsArchivedDesc")}
									</Text>
								</Stack>
								<Badge size="sm" color="gray">
									{archivedTotal}
								</Badge>
							</Group>
							<CredentialList
								entries={archivedEntries}
								totalEntries={archivedTotal}
								page={archivedPage}
								pageSize={PAGE_SIZE}
								onPageChange={setArchivedPage}
								currentId={status?.currentId}
								usageCache={usageCache}
								lifetimeTotals={lifetimeTotals}
								editingId={editingId}
								editForm={editForm}
								onEdit={handleEdit}
								onSaveEdit={handleSaveEdit}
								onCancelEdit={() => setEditingId(null)}
								onEditFormChange={setEditForm}
								usageMut={usageMut}
								enableMut={enableMut}
								disableMut={disableMut}
								resetMut={resetMut}
								deleteMut={deleteMut}
								archiveMut={archiveMut}
								unarchiveMut={unarchiveMut}
								selectedIds={selectedIds}
								onToggleSelect={toggleSelect}
								onToggleSelectAll={toggleSelectAll}
								t={t}
								canQueryCredentialUsage={canQueryCredentialUsage}
								canEnableCredential={canEnableCredential}
								canDisableCredential={canDisableCredential}
								canResetCredential={canResetCredential}
								canUpdateCredential={canUpdateCredential}
								canDeleteCredential={canDeleteCredential}
								canArchiveCredential={canArchiveCredential}
								credentialRouteUnsupportedReason={providerRouteUnsupportedReason}
							/>
						</Stack>
					)}
				</Stack>
			)}

			{/* Models section */}
			<Stack gap="xs">
				<Text size="sm" fw={500}>
					{t("codexModels")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("codexModelsDesc")}
				</Text>
				{codexModelIds.length > 0 && (
					<ModelList
						models={codexModelIds.map((id) => ({ value: `codex:${id}`, label: id }))}
						hiddenModels={hiddenModels}
						onToggleHidden={onToggleHidden}
						modelContextWindows={modelContextWindows}
						defaultContextWindows={builtinContextWindows}
						onContextWindowChange={onContextWindowChange}
						onTestModel={onTestModel}
						showContextWindow
					/>
				)}
				<InlineCustomModels
					prefix="codex"
					customModels={customModels}
					onCustomModelsChange={onCustomModelsChange}
					hiddenModels={hiddenModels}
					onToggleHidden={onToggleHidden}
					modelContextWindows={modelContextWindows}
					onContextWindowChange={onContextWindowChange}
					onTestModel={onTestModel}
				/>
			</Stack>

			{/* Device auth modal */}
			<Modal
				opened={deviceAuthModal}
				onClose={() => {
					setDeviceAuthModal(false);
					if (canCancelDeviceAuth) api.codexDeviceAuthCancel();
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
		</Stack>
	);
});

// Credential list wrapper (responsive)
interface CodexCredentialListEntry {
	id: string;
	displayName?: string;
	authMode?: CodexAuthMode;
	accountId?: string;
	priority: number;
	disabled: boolean;
	disabledReason?: string;
	/** Set when the credential is archived (retired from the pool, data retained). */
	archivedAt?: number;
	successCount: number;
	failureCount: number;
	lastUsedAt?: string;
	expiresAt?: number;
}

interface CodexCredentialListProps {
	entries: CodexCredentialListEntry[];
	totalEntries: number;
	page: number;
	pageSize: number;
	onPageChange: (page: number) => void;
	currentId?: string;
	usageCache: Record<string, CodexUsageData>;
	/** Lifetime token/cost totals keyed by credential id. */
	lifetimeTotals: Record<string, CredentialUsageTotals>;
	editingId: string | null;
	editForm: { displayName: string; priority: number };
	onEdit: (entry: CodexCredentialListEntry) => void;
	onSaveEdit: () => void;
	onCancelEdit: () => void;
	onEditFormChange: (form: { displayName: string; priority: number }) => void;

	// biome-ignore lint/suspicious/noExplicitAny: mutation types from react-query
	usageMut: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation types from react-query
	enableMut: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation types from react-query
	disableMut: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation types from react-query
	resetMut: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation types from react-query
	deleteMut: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation types from react-query
	archiveMut: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation types from react-query
	unarchiveMut: any;
	selectedIds: Set<string>;
	onToggleSelect: (id: string) => void;
	onToggleSelectAll: (entryIds: string[]) => void;
	t: (key: string) => string;
	canQueryCredentialUsage: boolean;
	canEnableCredential: boolean;
	canDisableCredential: boolean;
	canResetCredential: boolean;
	canUpdateCredential: boolean;
	canDeleteCredential: boolean;
	canArchiveCredential: boolean;
	credentialRouteUnsupportedReason: string;
}

/**
 * Lifetime token + USD consumption for one credential.
 *
 * The dollar figure is at OpenAI's official reference prices. A ChatGPT
 * subscription is not billed per token, so this is "what these tokens would
 * have cost through the metered API" — the tooltip says so, because presenting
 * it as spend would be wrong.
 */
function CodexLifetimeUsageCell({
	totals,
	t,
}: {
	totals?: CredentialUsageTotals;
	t: (key: string, options?: Record<string, unknown>) => string;
}) {
	if (!totals || totals.requestCount === 0) {
		return (
			<Text size="xs" c="dimmed">
				-
			</Text>
		);
	}
	const tokens = formatCompactNumber(totals.totalTokens);
	const cost = totals.costUsd;
	// A cost of exactly 0 with requests on record means nothing could be priced.
	// "$0.0000*" reads as "this was free"; an em dash says "unknown", which is all
	// we actually know. Kept as a symbol rather than a translated string so it
	// needs no locale entry.
	const costLabel = cost > 0 ? `$${cost >= 0.01 ? cost.toFixed(2) : cost.toFixed(4)}` : "—";
	return (
		<Tooltip
			multiline
			w={280}
			label={
				`${t("codexLifetimeTokensExact", { count: tokens.exact })}\n` +
				`${t("codexLifetimeRequests", { count: totals.requestCount })}\n` +
				`${t("codexLifetimeCostNote")}` +
				(totals.costIsPartial
					? `\n${t("codexLifetimeCostPartial", { count: totals.unpricedRequestCount })}`
					: "")
			}
			style={{ whiteSpace: "pre-line" }}
		>
			<Stack gap={0}>
				<Text size="xs">{tokens.compact}</Text>
				<Text size="xs" c="dimmed">
					{costLabel}
					{totals.costIsPartial ? "*" : ""}
				</Text>
			</Stack>
		</Tooltip>
	);
}

function CredentialList(props: CodexCredentialListProps) {
	const {
		entries,
		totalEntries,
		page,
		pageSize,
		onPageChange,
		currentId,
		usageCache,
		lifetimeTotals,
		editingId,
		editForm,
		onEdit,
		onSaveEdit,
		onCancelEdit,
		onEditFormChange,
		usageMut,
		enableMut,
		disableMut,
		resetMut,
		deleteMut,
		archiveMut,
		unarchiveMut,
		selectedIds,
		onToggleSelect,
		onToggleSelectAll,
		t,
		canQueryCredentialUsage,
		canEnableCredential,
		canDisableCredential,
		canResetCredential,
		canUpdateCredential,
		canDeleteCredential,
		canArchiveCredential,
		credentialRouteUnsupportedReason,
	} = props;
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY);
	const { t: tSettings } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const totalPages = Math.max(1, Math.ceil(totalEntries / pageSize));

	if (isMobile) {
		return <CredentialCards {...props} />;
	}

	const entryIds = entries.map((e) => e.id);
	const allSelected = entryIds.length > 0 && entryIds.every((id) => selectedIds.has(id));
	const someSelected = entryIds.some((id) => selectedIds.has(id)) && !allSelected;

	return (
		<Stack gap="xs">
			<Table>
				<Table.Thead>
					<Table.Tr>
						<Table.Th w={40}>
							<Checkbox
								size="xs"
								checked={allSelected}
								indeterminate={someSelected}
								onChange={() => onToggleSelectAll(entryIds)}
								aria-label={t("codexSelectAll")}
							/>
						</Table.Th>
						<Table.Th>{t("codexColName")}</Table.Th>
						<Table.Th>{t("codexColAccount")}</Table.Th>
						<Table.Th>{t("codexColPriority")}</Table.Th>
						<Table.Th>{t("codexColStatus")}</Table.Th>
						<Table.Th>{t("codexColStats")}</Table.Th>
						<Table.Th>{t("codexColUsage")}</Table.Th>
						<Table.Th>{t("codexColLifetime")}</Table.Th>
						<Table.Th>{t("codexColLastUsed")}</Table.Th>
						<Table.Th>{t("codexColActions")}</Table.Th>
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{entries.map((entry) => {
						const isEditing = editingId === entry.id;
						const usage = usageCache[entry.id];
						const isCurrent = entry.id === currentId;
						return (
							<Table.Tr key={entry.id}>
								<Table.Td>
									<Checkbox
										size="xs"
										checked={selectedIds.has(entry.id)}
										onChange={() => onToggleSelect(entry.id)}
									/>
								</Table.Td>
								<Table.Td>
									{isEditing ? (
										<TextInput
											size="xs"
											value={editForm.displayName}
											onChange={(e) =>
												onEditFormChange({ ...editForm, displayName: e.target.value })
											}
											placeholder={entry.accountId ?? entry.id}
										/>
									) : (
										<Group gap={6} wrap="nowrap">
											<Text size="sm" fw={isCurrent ? 700 : 400}>
												{entry.displayName || entry.accountId || entry.id.slice(0, 8)}
											</Text>
											<CodexAuthModeBadge authMode={entry.authMode} />
										</Group>
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
											onChange={(v) => onEditFormChange({ ...editForm, priority: Number(v) })}
											min={0}
											max={100}
											w={80}
										/>
									) : (
										<Text size="sm">{entry.priority}</Text>
									)}
								</Table.Td>
								<Table.Td>
									<CodexCredentialStatusBadge entry={entry} t={t} />
								</Table.Td>
								<Table.Td>
									<Text size="xs">
										✓ {entry.successCount} / ✗ {entry.failureCount}
									</Text>
								</Table.Td>
								<Table.Td>
									<CodexUsageDisplay usage={usage} />
								</Table.Td>
								<Table.Td>
									<CodexLifetimeUsageCell totals={lifetimeTotals[entry.id]} t={t} />
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
														onClick={() => canUpdateCredential && onSaveEdit()}
														disabled={!canUpdateCredential}
														title={
															!canUpdateCredential ? credentialRouteUnsupportedReason : undefined
														}
													>
														<IconCheck size={16} />
													</ActionIcon>
												</Tooltip>
												<Tooltip label={t("codexCancel")}>
													<ActionIcon size="sm" color="gray" onClick={onCancelEdit}>
														<IconX size={16} />
													</ActionIcon>
												</Tooltip>
											</>
										) : (
											<>
												<Tooltip label={t("codexEdit")}>
													<ActionIcon
														size="sm"
														onClick={() => canUpdateCredential && onEdit(entry)}
														disabled={!canUpdateCredential}
														title={
															!canUpdateCredential ? credentialRouteUnsupportedReason : undefined
														}
													>
														<IconPencil size={16} />
													</ActionIcon>
												</Tooltip>

												<Tooltip label={t("codexQueryUsage")}>
													<ActionIcon
														size="sm"
														color="blue"
														onClick={() => canQueryCredentialUsage && usageMut.mutate(entry.id)}
														loading={usageMut.isPending}
														disabled={!canQueryCredentialUsage}
														title={
															!canQueryCredentialUsage
																? credentialRouteUnsupportedReason
																: undefined
														}
													>
														<IconRefresh size={16} />
													</ActionIcon>
												</Tooltip>
												{entry.disabled ? (
													<Tooltip label={t("codexEnable")}>
														<ActionIcon
															size="sm"
															color="green"
															onClick={() => canEnableCredential && enableMut.mutate(entry.id)}
															disabled={!canEnableCredential}
															title={
																!canEnableCredential ? credentialRouteUnsupportedReason : undefined
															}
														>
															<IconCheck size={16} />
														</ActionIcon>
													</Tooltip>
												) : (
													<Tooltip label={t("codexDisable")}>
														<ActionIcon
															size="sm"
															color="orange"
															onClick={() => canDisableCredential && disableMut.mutate(entry.id)}
															disabled={!canDisableCredential}
															title={
																!canDisableCredential ? credentialRouteUnsupportedReason : undefined
															}
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
															onClick={() => canResetCredential && resetMut.mutate(entry.id)}
															disabled={!canResetCredential}
															title={
																!canResetCredential ? credentialRouteUnsupportedReason : undefined
															}
														>
															<IconDeviceFloppy size={16} />
														</ActionIcon>
													</Tooltip>
												)}
												<CodexArchiveActionIcon
													entry={entry}
													archiveMut={archiveMut}
													unarchiveMut={unarchiveMut}
													canArchiveCredential={canArchiveCredential}
													credentialRouteUnsupportedReason={credentialRouteUnsupportedReason}
													t={t}
												/>
												<Tooltip label={t("codexDelete")}>
													<ActionIcon
														size="sm"
														color="red"
														onClick={async () => {
															if (!canDeleteCredential) return;
															if (await confirm({ message: t("codexDeleteConfirm") })) {
																deleteMut.mutate(entry.id);
															}
														}}
														disabled={!canDeleteCredential}
														title={
															!canDeleteCredential ? credentialRouteUnsupportedReason : undefined
														}
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
			{totalPages > 1 && (
				<Group justify="center">
					<Pagination size="sm" total={totalPages} value={page} onChange={onPageChange} />
					<Text size="xs" c="dimmed">
						{tSettings("codexPageInfo", {
							current: page,
							total: totalPages,
							count: totalEntries,
						})}
					</Text>
				</Group>
			)}
		</Stack>
	);
}

/**
 * Status badge for one Codex credential. Archived wins over enabled/disabled:
 * an archived credential never serves traffic regardless of its stored
 * disabled flag, so showing "Active" for it would be misleading.
 */
function CodexCredentialStatusBadge({
	entry,
	t,
}: {
	entry: Pick<CodexCredentialListEntry, "disabled" | "disabledReason" | "archivedAt">;
	t: (key: string) => string;
}) {
	if (entry.archivedAt) {
		return (
			<Badge size="sm" color="gray">
				{t("codexArchived")}
			</Badge>
		);
	}
	if (entry.disabled) {
		return (
			<Badge size="sm" color="red">
				{entry.disabledReason || "Disabled"}
			</Badge>
		);
	}
	return (
		<Badge size="sm" color="green">
			Active
		</Badge>
	);
}

/** Archive / unarchive toggle for one credential row. */
function CodexArchiveActionIcon({
	entry,
	archiveMut,
	unarchiveMut,
	canArchiveCredential,
	credentialRouteUnsupportedReason,
	t,
}: {
	entry: Pick<CodexCredentialListEntry, "id" | "archivedAt">;
	// biome-ignore lint/suspicious/noExplicitAny: mutation types from react-query
	archiveMut: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation types from react-query
	unarchiveMut: any;
	canArchiveCredential: boolean;
	credentialRouteUnsupportedReason: string;
	t: (key: string) => string;
}) {
	const isArchived = !!entry.archivedAt;
	const mut = isArchived ? unarchiveMut : archiveMut;
	return (
		<Tooltip label={t(isArchived ? "codexUnarchive" : "codexArchive")}>
			<ActionIcon
				size="sm"
				color={isArchived ? "teal" : "gray"}
				onClick={() => canArchiveCredential && mut.mutate(entry.id)}
				loading={mut.isPending}
				disabled={!canArchiveCredential}
				title={!canArchiveCredential ? credentialRouteUnsupportedReason : undefined}
			>
				{isArchived ? <IconArchiveOff size={16} /> : <IconArchive size={16} />}
			</ActionIcon>
		</Tooltip>
	);
}

// Mobile: card layout
function CredentialCards(props: CodexCredentialListProps) {
	const {
		entries,
		totalEntries,
		page,
		pageSize,
		onPageChange,
		currentId,
		usageCache,
		lifetimeTotals,
		editingId,
		editForm,
		onEdit,
		onSaveEdit,
		onCancelEdit,
		onEditFormChange,
		usageMut,
		enableMut,
		disableMut,
		resetMut,
		deleteMut,
		archiveMut,
		unarchiveMut,
		selectedIds,
		onToggleSelect,
		t,
		canQueryCredentialUsage,
		canEnableCredential,
		canDisableCredential,
		canResetCredential,
		canUpdateCredential,
		canDeleteCredential,
		canArchiveCredential,
		credentialRouteUnsupportedReason,
	} = props;

	const { t: tSettings } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const totalPages = Math.max(1, Math.ceil(totalEntries / pageSize));

	return (
		<Stack gap="xs">
			{entries.map((entry) => {
				const isEditing = editingId === entry.id;
				const usage = usageCache[entry.id];
				const isCurrent = entry.id === currentId;
				const displayLabel = entry.displayName || entry.accountId || entry.id.slice(0, 8);

				return (
					<Paper
						key={entry.id}
						withBorder
						p="sm"
						style={
							isCurrent
								? { borderColor: "var(--mantine-color-indigo-5)", borderWidth: 2 }
								: undefined
						}
					>
						<Stack gap="xs">
							{/* Row 1: Checkbox + ID + Display name + Status */}
							<Group justify="space-between" wrap="wrap">
								<Group gap="xs">
									<Checkbox
										size="xs"
										checked={selectedIds.has(entry.id)}
										onChange={() => onToggleSelect(entry.id)}
									/>
									<Text size="xs" c="dimmed" ff="monospace">
										{entry.id}
									</Text>
									<Text size="sm" fw={isCurrent ? 700 : 500} truncate style={{ maxWidth: 200 }}>
										{displayLabel}
									</Text>
									<CodexAuthModeBadge authMode={entry.authMode} />
								</Group>
								<Group gap="xs">
									<CodexCredentialStatusBadge entry={entry} t={t} />
								</Group>
							</Group>

							{/* Inline edit form */}
							{isEditing ? (
								<Stack gap="xs">
									<TextInput
										size="xs"
										label={t("codexColName")}
										value={editForm.displayName}
										onChange={(e) => onEditFormChange({ ...editForm, displayName: e.target.value })}
									/>
									<NumberInput
										size="xs"
										label={t("codexColPriority")}
										value={editForm.priority}
										onChange={(v) => onEditFormChange({ ...editForm, priority: Number(v) || 0 })}
										min={0}
										step={1}
									/>
									<Group gap="xs">
										<Button
											size="compact-xs"
											onClick={() => canUpdateCredential && onSaveEdit()}
											leftSection={<IconDeviceFloppy size={12} />}
											disabled={!canUpdateCredential}
											title={!canUpdateCredential ? credentialRouteUnsupportedReason : undefined}
										>
											{t("codexSave")}
										</Button>
										<Button size="compact-xs" variant="subtle" onClick={onCancelEdit}>
											{t("codexCancel")}
										</Button>
									</Group>
								</Stack>
							) : (
								<>
									{/* Row 2: Details */}
									<Stack gap={4}>
										{entry.accountId && (
											<Group justify="space-between" wrap="nowrap">
												<Text size="xs" c="dimmed">
													{t("codexColAccount")}
												</Text>
												<Text size="xs" ff="monospace">
													{entry.accountId.slice(0, 12)}
												</Text>
											</Group>
										)}
										<Group justify="space-between" wrap="nowrap">
											<Text size="xs" c="dimmed">
												{t("codexColPriority")}
											</Text>
											<Text size="xs">{entry.priority}</Text>
										</Group>
										<Group justify="space-between" wrap="nowrap">
											<Text size="xs" c="dimmed">
												{t("codexColStats")}
											</Text>
											<Text size="xs">
												✓ {entry.successCount} / ✗ {entry.failureCount}
											</Text>
										</Group>
										<Group justify="space-between" wrap="nowrap">
											<Text size="xs" c="dimmed">
												{t("codexColLastUsed")}
											</Text>
											<Text size="xs" c="dimmed">
												{entry.lastUsedAt ? relativeTime(entry.lastUsedAt) : "-"}
											</Text>
										</Group>
										{entry.expiresAt && (
											<Group justify="space-between" wrap="nowrap">
												<Text size="xs" c="dimmed">
													{t("codexColExpires")}
												</Text>
												<ExpiresDisplay expiresAt={entry.expiresAt} />
											</Group>
										)}
									</Stack>

									{/* Row 3: Usage */}
									<Stack gap={4}>
										<Text size="xs" c="dimmed">
											{t("codexColUsage")}
										</Text>
										<CodexUsageDisplay usage={usage} />
									</Stack>

									{/* Row 3b: Lifetime consumption */}
									<Group justify="space-between" wrap="nowrap">
										<Text size="xs" c="dimmed">
											{t("codexColLifetime")}
										</Text>
										<CodexLifetimeUsageCell totals={lifetimeTotals[entry.id]} t={t} />
									</Group>
								</>
							)}

							{/* Row 4: Actions */}
							<Group gap="xs" wrap="wrap">
								{!isEditing && (
									<>
										<Button
											variant="subtle"
											size="compact-xs"
											onClick={() => canUpdateCredential && onEdit(entry)}
											disabled={!canUpdateCredential}
											title={!canUpdateCredential ? credentialRouteUnsupportedReason : undefined}
										>
											{t("codexEdit")}
										</Button>

										<Button
											variant="subtle"
											size="compact-xs"
											onClick={() => canQueryCredentialUsage && usageMut.mutate(entry.id)}
											loading={usageMut.isPending}
											disabled={!canQueryCredentialUsage}
											title={
												!canQueryCredentialUsage ? credentialRouteUnsupportedReason : undefined
											}
										>
											{t("codexQueryUsage")}
										</Button>
										{entry.disabled ? (
											<Button
												variant="subtle"
												size="compact-xs"
												color="green"
												onClick={() => canEnableCredential && enableMut.mutate(entry.id)}
												disabled={!canEnableCredential}
												title={!canEnableCredential ? credentialRouteUnsupportedReason : undefined}
											>
												{t("codexEnable")}
											</Button>
										) : (
											<Button
												variant="subtle"
												size="compact-xs"
												color="orange"
												onClick={() => canDisableCredential && disableMut.mutate(entry.id)}
												disabled={!canDisableCredential}
												title={!canDisableCredential ? credentialRouteUnsupportedReason : undefined}
											>
												{t("codexDisable")}
											</Button>
										)}
										{entry.failureCount > 0 && (
											<Button
												variant="subtle"
												size="compact-xs"
												color="blue"
												onClick={() => canResetCredential && resetMut.mutate(entry.id)}
												disabled={!canResetCredential}
												title={!canResetCredential ? credentialRouteUnsupportedReason : undefined}
											>
												{t("codexReset")}
											</Button>
										)}
										<Button
											variant="subtle"
											size="compact-xs"
											color={entry.archivedAt ? "teal" : "gray"}
											onClick={() =>
												canArchiveCredential &&
												(entry.archivedAt ? unarchiveMut : archiveMut).mutate(entry.id)
											}
											loading={(entry.archivedAt ? unarchiveMut : archiveMut).isPending}
											disabled={!canArchiveCredential}
											title={!canArchiveCredential ? credentialRouteUnsupportedReason : undefined}
										>
											{t(entry.archivedAt ? "codexUnarchive" : "codexArchive")}
										</Button>
										<ActionIcon
											variant="subtle"
											color="red"
											size="sm"
											onClick={async () => {
												if (!canDeleteCredential) return;
												if (await confirm({ message: t("codexDeleteConfirm") })) {
													deleteMut.mutate(entry.id);
												}
											}}
											disabled={!canDeleteCredential}
											title={!canDeleteCredential ? credentialRouteUnsupportedReason : undefined}
										>
											<IconTrash size={14} />
										</ActionIcon>
									</>
								)}
							</Group>
						</Stack>
					</Paper>
				);
			})}
			{totalPages > 1 && (
				<Group justify="center">
					<Pagination size="sm" total={totalPages} value={page} onChange={onPageChange} />
					<Text size="xs" c="dimmed">
						{tSettings("codexPageInfo", {
							current: page,
							total: totalPages,
							count: totalEntries,
						})}
					</Text>
				</Group>
			)}
		</Stack>
	);
}

// Expires display component
function ExpiresDisplay({ expiresAt }: { expiresAt: number }) {
	const { t } = useTranslation("settings");
	const now = Date.now();
	const diff = expiresAt - now;

	// Already expired
	if (diff <= 0) {
		return (
			<Group gap={4}>
				<Text size="xs" c="red">
					{relativeTime(new Date(expiresAt).toISOString())}
				</Text>
				<Badge size="xs" color="red">
					{t("codexUsageExpired")}
				</Badge>
			</Group>
		);
	}

	// Expiring soon (within 60 minutes)
	if (diff < 3600_000) {
		return (
			<Text size="xs" c="orange">
				{relativeTime(new Date(expiresAt).toISOString())}
			</Text>
		);
	}

	// Normal
	return (
		<Text size="xs" c="dimmed">
			{relativeTime(new Date(expiresAt).toISOString())}
		</Text>
	);
}
