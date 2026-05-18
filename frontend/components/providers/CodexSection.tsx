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
import {
	ActionIcon,
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
	SimpleGrid,
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
	IconCheck,
	IconDeviceFloppy,
	IconGripVertical,
	IconPencil,
	IconRefresh,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type {
	CodexLoadBalancingMode,
	CodexPlanTier,
	CodexUsageForecast,
	CodexUsageSchedulerSnapshot,
	CodexUsageSummary,
	CodexUsageTierStats,
} from "../../lib/api/types";
import { normalizeProxyUrl } from "../../lib/proxy";
import { relativeTime } from "../../lib/relative-time";
import { useConfirmDialog } from "../common/ConfirmDialogProvider";
import { CodexQuotaTrendChart as SharedCodexQuotaTrendChart } from "./CodexQuotaTrendChart";
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
	refreshToken?: string;
	accessToken?: string;
	expiresAt?: number;
	accountId?: string;
	email?: string;
	sub?: string;
	displayName?: string;
	priority?: number;
}

const CODEX_STATUS_GC_TIME_MS = 60_000;
const REFRESH_TOKEN_PATTERN = /^rt_[A-Za-z0-9._-]+$/;
const REFRESH_TOKEN_SEARCH_PATTERN = /rt_[A-Za-z0-9._-]+/g;
const CODEX_DISPLAY_TIERS: CodexPlanTier[] = ["free", "plus", "team", "prolite", "pro"];
const CODEX_TIER_ORDER_VALUES: CodexPlanTier[] = [
	"pro",
	"prolite",
	"plus",
	"team",
	"free",
	"other",
];
const CODEX_DEFAULT_TIER_ORDER: CodexPlanTier[] = ["pro", "prolite", "plus", "team", "free"];
const CODEX_TIER_COLORS: Record<CodexPlanTier, string> = {
	free: "gray",
	plus: "blue",
	team: "cyan",
	prolite: "violet",
	pro: "green",
	other: "dark",
};
function getDisplayTierOrder(order?: CodexPlanTier[]): CodexPlanTier[] {
	const result: CodexPlanTier[] = [];
	for (const tier of order ?? CODEX_DEFAULT_TIER_ORDER) {
		if (!CODEX_TIER_ORDER_VALUES.includes(tier)) continue;
		if (tier === "other") continue;
		if (!result.includes(tier)) result.push(tier);
	}
	for (const tier of CODEX_DEFAULT_TIER_ORDER) {
		if (!result.includes(tier)) result.push(tier);
	}
	return result;
}

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

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPriority(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function credentialFromObject(item: unknown): CodexImportCredential | null {
	if (!item || typeof item !== "object" || Array.isArray(item)) return null;
	const record = item as Record<string, unknown>;
	const refreshToken = normalizeRefreshToken(record.refresh_token ?? record.refreshToken);
	const accessToken = normalizeAccessToken(record.access_token ?? record.accessToken);
	if (!refreshToken && !accessToken) return null;
	const email = optionalString(record.email);
	const accountId = optionalString(record.account_id ?? record.accountId);
	const sub = optionalString(record.sub);
	const displayName = email ?? optionalString(record.displayName ?? record.display_name);
	const priority = optionalPriority(record.priority);
	const expiresAt = normalizeExpiresAt(record.expires_at ?? record.expiresAt);
	return {
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
	const parts = record.split("----").map((part) => part.trim());
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
	const items = Array.isArray(parsed) ? parsed : [parsed];
	return items.flatMap((item) => {
		if (typeof item === "string") return credentialsFromText(item);
		const credential = credentialFromObject(item);
		return credential ? [credential] : [];
	});
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
	const { t: tn } = useTranslation("narrator");
	const confirm = useConfirmDialog();
	const qc = useQueryClient();
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
	const [globalProxy, setGlobalProxy] = useState("");
	const [globalProxyInitialized, setGlobalProxyInitialized] = useState(false);
	const [defaultReasoningEffort, setDefaultReasoningEffort] = useState("");
	const [defaultReasoningInitialized, setDefaultReasoningInitialized] = useState(false);
	const [useWebSocket, setUseWebSocket] = useState(true);
	const [useWebSocketInitialized, setUseWebSocketInitialized] = useState(false);
	const [tierOrder, setTierOrder] = useState<CodexPlanTier[]>(CODEX_DEFAULT_TIER_ORDER);
	const [tierOrderInitialized, setTierOrderInitialized] = useState(false);
	const [importJson, setImportJson] = useState("");
	const [importError, setImportError] = useState<string | null>(null);
	const [importResult, setImportResult] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [availablePage, setAvailablePage] = useState(1);
	const [unavailablePage, setUnavailablePage] = useState(1);
	const PAGE_SIZE = 20;
	const tierOrderSensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
	);
	const deviceAuthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const browserAuthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const browserAuthTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
		queryKey: ["codex", "status", { availablePage, unavailablePage, pageSize: PAGE_SIZE }],
		queryFn: () => api.codexStatus({ availablePage, unavailablePage, pageSize: PAGE_SIZE }),
		refetchInterval: (query) => {
			if (browserAuthPending) return 3_000;
			if (query.state.data?.usageQueue?.isRunning) return 3_000;
			return 30_000;
		},
		gcTime: CODEX_STATUS_GC_TIME_MS,
	});

	const codexModelIds: string[] = settingsData?.codexModels ?? [];
	const builtinContextWindows: Record<string, number> =
		settingsData?.builtinModelContextWindows ?? {};
	const entries = status?.entries ?? [];
	const availableEntries = status?.availableEntries ?? [];
	const unavailableEntries = status?.unavailableEntries ?? [];
	const availableTotal = status?.availableTotal ?? 0;
	const unavailableTotal = status?.unavailableTotal ?? 0;
	const loadBalancingMode = status?.loadBalancingMode ?? "tier-balanced";
	const usageCache = status?.usageCache ?? {};
	const stickySessionCount = status?.stickySessionCount ?? 0;
	const lastBrowserAuthError = status?.lastBrowserAuthError;

	useEffect(() => {
		if (!status) return;
		if (!globalProxyInitialized) {
			setGlobalProxy(status.globalProxy ?? "");
			setGlobalProxyInitialized(true);
		}
		if (!defaultReasoningInitialized) {
			setDefaultReasoningEffort(status.defaultReasoningEffort ?? "");
			setDefaultReasoningInitialized(true);
		}
		if (!useWebSocketInitialized) {
			setUseWebSocket(status.useWebSocket ?? true);
			setUseWebSocketInitialized(true);
		}
		if (!tierOrderInitialized) {
			setTierOrder(getDisplayTierOrder(status.tierOrder));
			setTierOrderInitialized(true);
		}
	}, [
		status,
		globalProxyInitialized,
		defaultReasoningInitialized,
		useWebSocketInitialized,
		tierOrderInitialized,
	]);

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
	const lbModeMut = useMutation({
		mutationFn: (mode: CodexLoadBalancingMode) => api.codexSetLoadBalancingMode(mode),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["codex", "status"] }),
	});
	const globalProxyMut = useMutation({
		mutationFn: (proxy?: string) => api.codexSetGlobalProxy(proxy),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			notifications.show({ message: t("codexProxyUpdated"), color: "green" });
		},
	});
	const defaultReasoningMut = useMutation({
		mutationFn: (reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | null) =>
			api.codexSetDefaultReasoningEffort(reasoningEffort),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			notifications.show({ message: t("codexDefaultReasoningUpdated"), color: "green" });
		},
	});
	const useWebSocketMut = useMutation({
		mutationFn: (useWebSocket: boolean) => api.codexSetUseWebSocket(useWebSocket),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			notifications.show({ message: t("codexWebSocketUpdated"), color: "green" });
		},
	});
	const tierOrderMut = useMutation({
		mutationFn: (tierOrder: CodexPlanTier[]) => api.codexSetTierOrder(tierOrder),
		onSuccess: (data) => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			setTierOrder(getDisplayTierOrder(data.tierOrder));
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
			notifications.show({
				message: t("codexBatchDeleteSuccess", { count: data.removed.length }),
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
		if (selectedIds.size === 0) return;
		if (await confirm({ message: t("codexBatchDeleteConfirm", { count: selectedIds.size }) })) {
			batchDeleteMut.mutate([...selectedIds]);
		}
	};

	const handleBrowserAuth = async () => {
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
		if (!editingId) return;
		const data: { displayName?: string; priority?: number } = {
			displayName: editForm.displayName || undefined,
			priority: editForm.priority,
		};
		updateMut.mutate({ id: editingId, data });
	};

	const handleSaveGlobalProxy = () => {
		const normalized = normalizeProxyUrl(globalProxy);
		setGlobalProxy(normalized ?? "");
		globalProxyMut.mutate(normalized);
	};

	const effectiveDefaultReasoningEffort = defaultReasoningInitialized
		? defaultReasoningEffort
		: (status?.defaultReasoningEffort ?? "");
	const effectiveDefaultReasoningEffortLabel =
		effectiveDefaultReasoningEffort === "low"
			? tn("reasoning_low")
			: effectiveDefaultReasoningEffort === "medium"
				? tn("reasoning_medium")
				: effectiveDefaultReasoningEffort === "high"
					? tn("reasoning_high")
					: effectiveDefaultReasoningEffort === "xhigh"
						? tn("reasoning_xhigh")
						: effectiveDefaultReasoningEffort === "none"
							? tn("reasoning_none")
							: tn("reasoning_auto");

	const handleSaveDefaultReasoningEffort = () => {
		const nextReasoningEffort =
			(effectiveDefaultReasoningEffort as "none" | "low" | "medium" | "high" | "xhigh") || null;
		defaultReasoningMut.mutate(nextReasoningEffort, {
			onSuccess: () => {
				setDefaultReasoningEffort(nextReasoningEffort ?? "");
			},
		});
	};

	const handleTierOrderDragEnd = (event: DragEndEvent) => {
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
		setTierOrder(CODEX_DEFAULT_TIER_ORDER);
		tierOrderMut.mutate(CODEX_DEFAULT_TIER_ORDER);
	};

	const handleImport = () => {
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
						onChange={(v) => lbModeMut.mutate(v as CodexLoadBalancingMode)}
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
				<Group align="flex-end">
					<TextInput
						size="xs"
						label={t("codexGlobalProxy")}
						description={t("codexGlobalProxyDesc")}
						placeholder={t("codexProxyPlaceholder")}
						value={globalProxy}
						onChange={(e) => setGlobalProxy(e.target.value)}
						style={{ flex: 1 }}
					/>
					<Button size="xs" onClick={handleSaveGlobalProxy} loading={globalProxyMut.isPending}>
						{t("codexSave")}
					</Button>
				</Group>
				<Group align="flex-end">
					<TextInput
						size="xs"
						label={t("codexDefaultReasoningEffort")}
						description={t("codexDefaultReasoningEffortDesc")}
						value={effectiveDefaultReasoningEffortLabel}
						readOnly
						style={{ flex: 1 }}
					/>
					<SegmentedControl
						size="xs"
						value={effectiveDefaultReasoningEffort || "auto"}
						onChange={(v) => setDefaultReasoningEffort(v === "auto" ? "" : v)}
						data={[
							{ label: tn("reasoning_auto"), value: "auto" },
							{ label: tn("reasoning_none"), value: "none" },
							{ label: tn("reasoning_low"), value: "low" },
							{ label: tn("reasoning_medium"), value: "medium" },
							{ label: tn("reasoning_high"), value: "high" },
							{ label: tn("reasoning_xhigh"), value: "xhigh" },
						]}
					/>
					<Button
						size="xs"
						onClick={handleSaveDefaultReasoningEffort}
						loading={defaultReasoningMut.isPending}
					>
						{t("codexSave")}
					</Button>
				</Group>
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
					/>
					<Button
						size="xs"
						onClick={() => useWebSocketMut.mutate(useWebSocket)}
						loading={useWebSocketMut.isPending}
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
							<Button size="xs" variant="light" color="orange" onClick={handleCancelBrowserAuth}>
								Cancel
							</Button>
						</Stack>
					</Paper>
				) : (
					<Group>
						<Button size="xs" onClick={handleBrowserAuth} loading={browserAuthLoading}>
							{t("codexAddBrowser")}
						</Button>
						<Button size="xs" variant="light" onClick={handleDeviceAuth}>
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
						disabled={!importJson.trim()}
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
								onClick={() => usageQueueClearMut.mutate()}
								loading={usageQueueClearMut.isPending}
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
				/>
			)}

			{/* Credentials list (responsive: cards on mobile, table on desktop) */}
			{(status?.total ?? 0) > 0 && (
				<Stack gap="xs">
					{availableTotal > 0 && (
						<Stack gap="xs">
							<Group justify="space-between">
								<Text size="sm" fw={500}>
									{t("codexCredentialsAvailable")}
								</Text>
								<Group gap="xs">
									{selectedIds.size > 0 && (
										<Button
											size="compact-xs"
											color="red"
											variant="light"
											leftSection={<IconTrash size={14} />}
											onClick={handleBatchDelete}
											loading={batchDeleteMut.isPending}
										>
											{t("codexBatchDelete")} ({selectedIds.size})
										</Button>
									)}
									<Badge size="sm" color="green">
										{availableTotal}
									</Badge>
								</Group>
							</Group>
							<CredentialList
								entries={availableEntries}
								totalEntries={availableTotal}
								page={availablePage}
								pageSize={PAGE_SIZE}
								onPageChange={setAvailablePage}
								currentId={status?.currentId}
								usageCache={usageCache}
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
								selectedIds={selectedIds}
								onToggleSelect={toggleSelect}
								onToggleSelectAll={toggleSelectAll}
								t={t}
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
								selectedIds={selectedIds}
								onToggleSelect={toggleSelect}
								onToggleSelectAll={toggleSelectAll}
								t={t}
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
		</Stack>
	);
});

function getCodexTierLabel(t: (key: string) => string, tier: CodexPlanTier): string {
	if (tier === "free") return t("codexQuotaTierFree");
	if (tier === "plus") return t("codexQuotaTierPlus");
	if (tier === "team") return t("codexQuotaTierTeam");
	if (tier === "prolite") return t("codexQuotaTierProLite");
	if (tier === "pro") return t("codexQuotaTierPro");
	return t("codexQuotaTierOther");
}

function getEmptyCodexUsageTierStats(tier: CodexPlanTier): CodexUsageTierStats {
	return {
		tier,
		accountCount: 0,
		knownUsageCount: 0,
		zeroUsageCount: 0,
		scheduledAccountCount: 0,
		remainingAccountEquivalents: 0,
		averageRemainingPercent: null,
	};
}

function formatAccountEquivalent(value: number): string {
	return new Intl.NumberFormat(undefined, {
		minimumFractionDigits: 0,
		maximumFractionDigits: 2,
	}).format(value);
}

function formatResetTimestamp(timestamp?: number): string {
	if (!timestamp) return "-";
	return relativeTime(new Date(timestamp).toISOString());
}

function CodexQuotaOverview({
	summary,
	trend,
	scheduler,
}: {
	summary: CodexUsageSummary;
	trend: CodexUsageForecast;
	scheduler: CodexUsageSchedulerSnapshot;
}) {
	const { t } = useTranslation("settings");
	const [selectedTierValues, setSelectedTierValues] = useState<string[]>(CODEX_DISPLAY_TIERS);
	const selectedTiers = CODEX_DISPLAY_TIERS.filter((tier) => selectedTierValues.includes(tier));
	const summaryByTier = (summary.byTier ?? {}) as Partial<
		Record<CodexPlanTier, CodexUsageTierStats>
	>;

	return (
		<Paper withBorder p="sm">
			<Stack gap="sm">
				<Group justify="space-between" align="flex-start">
					<Stack gap={2}>
						<Text size="sm" fw={500}>
							{t("codexQuotaOverviewTitle")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("codexQuotaOverviewDesc", {
								known: summary.totalKnownUsageAccounts,
								missing: summary.missingUsageAccounts,
							})}
						</Text>
					</Stack>
					<Stack gap={2} align="flex-end">
						<Badge size="sm" color={scheduler.started ? "green" : "gray"} variant="light">
							{scheduler.started ? t("codexQuotaSchedulerOn") : t("codexQuotaSchedulerOff")}
						</Badge>
						<Text size="xs" c="dimmed">
							{scheduler.nextRunAt
								? t("codexQuotaSchedulerNext", {
										when: formatResetTimestamp(scheduler.nextRunAt),
									})
								: t("codexQuotaSchedulerIdle")}
						</Text>
					</Stack>
				</Group>

				<Stack gap={4}>
					<Text size="xs" c="dimmed">
						{t("codexQuotaVisibleTiers")}
					</Text>
					<Checkbox.Group value={selectedTierValues} onChange={setSelectedTierValues}>
						<Group gap="xs" wrap="wrap">
							{CODEX_DISPLAY_TIERS.map((tier) => (
								<Checkbox
									key={tier}
									value={tier}
									label={getCodexTierLabel(t, tier)}
									size="xs"
									color={CODEX_TIER_COLORS[tier]}
								/>
							))}
						</Group>
					</Checkbox.Group>
				</Stack>

				{selectedTiers.length === 0 ? (
					<Paper withBorder p="sm">
						<Text size="xs" c="dimmed" ta="center">
							{t("codexQuotaNoTierSelected")}
						</Text>
					</Paper>
				) : (
					<SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} spacing="xs">
						{selectedTiers.map((tier) => {
							const stat = summaryByTier[tier] ?? getEmptyCodexUsageTierStats(tier);
							const average = stat.averageRemainingPercent ?? 0;
							return (
								<Paper key={tier} withBorder p="xs">
									<Stack gap={6}>
										<Group justify="space-between" wrap="nowrap">
											<Badge color={CODEX_TIER_COLORS[tier]} variant="light">
												{getCodexTierLabel(t, tier)}
											</Badge>
											<Text size="xs" c="dimmed">
												{t("codexQuotaAccounts", { count: stat.accountCount })}
											</Text>
										</Group>
										<Text size="lg" fw={700}>
											{formatAccountEquivalent(stat.remainingAccountEquivalents)}{" "}
											<Text span size="xs" c="dimmed" fw={400}>
												{t("codexQuotaAccountEquivalent")}
											</Text>
										</Text>
										<Progress value={average} size="xs" color={CODEX_TIER_COLORS[tier]} />
										<Group justify="space-between" gap="xs">
											<Text size="xs" c="dimmed">
												{t("codexQuotaAverageRemaining")}: {average.toFixed(1)}%
											</Text>
											<Text size="xs" c="dimmed">
												{t("codexQuotaKnown", { count: stat.knownUsageCount })}
											</Text>
										</Group>
										<Text size="xs" c="dimmed">
											{stat.nextResetAt
												? t("codexQuotaNextReset", {
														when: formatResetTimestamp(stat.nextResetAt),
													})
												: t("codexQuotaNoResetScheduled")}
										</Text>
										{stat.zeroUsageCount > 0 && (
											<Text size="xs" c="dimmed">
												{t("codexQuotaZeroUsage", { count: stat.zeroUsageCount })}
											</Text>
										)}
									</Stack>
								</Paper>
							);
						})}
					</SimpleGrid>
				)}

				<Stack gap="xs">
					<Group justify="space-between">
						<Text size="sm" fw={500}>
							{t("codexQuotaTrendTitle")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("codexQuotaTrendUnit")}
						</Text>
					</Group>
					<SharedCodexQuotaTrendChart trend={trend} selectedTiers={selectedTiers} />
				</Stack>
			</Stack>
		</Paper>
	);
}

// Credential list wrapper (responsive)
function CredentialList(props: {
	entries: Array<{
		id: string;
		displayName?: string;
		accountId?: string;
		priority: number;
		disabled: boolean;
		disabledReason?: string;
		successCount: number;
		failureCount: number;
		lastUsedAt?: string;
		expiresAt?: number;
	}>;
	totalEntries: number;
	page: number;
	pageSize: number;
	onPageChange: (page: number) => void;
	currentId?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic usage cache structure
	usageCache: Record<string, any>;
	editingId: string | null;
	editForm: { displayName: string; priority: number };
	// biome-ignore lint/suspicious/noExplicitAny: entry type matches parent array
	onEdit: (entry: any) => void;
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
	selectedIds: Set<string>;
	onToggleSelect: (id: string) => void;
	onToggleSelectAll: (entryIds: string[]) => void;
	t: (key: string) => string;
}) {
	const {
		entries,
		totalEntries,
		page,
		pageSize,
		onPageChange,
		currentId,
		usageCache,
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
		selectedIds,
		onToggleSelect,
		onToggleSelectAll,
		t,
	} = props;
	const isMobile = useMediaQuery("(max-width: 768px)");
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
										<Text size="sm" fw={isCurrent ? 700 : 400}>
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
									<UsageDisplay usage={usage} />
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
													<ActionIcon size="sm" color="green" onClick={onSaveEdit}>
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
													<ActionIcon size="sm" onClick={() => onEdit(entry)}>
														<IconPencil size={16} />
													</ActionIcon>
												</Tooltip>

												<Tooltip label={t("codexQueryUsage")}>
													<ActionIcon
														size="sm"
														color="blue"
														onClick={() => usageMut.mutate(entry.id)}
														loading={usageMut.isPending}
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
														onClick={async () => {
															if (await confirm({ message: t("codexDeleteConfirm") })) {
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

// Mobile: card layout
function CredentialCards(props: {
	entries: Array<{
		id: string;
		displayName?: string;
		accountId?: string;
		priority: number;
		disabled: boolean;
		disabledReason?: string;
		successCount: number;
		failureCount: number;
		lastUsedAt?: string;
		expiresAt?: number;
	}>;
	totalEntries: number;
	page: number;
	pageSize: number;
	onPageChange: (page: number) => void;
	currentId?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic usage cache structure
	usageCache: Record<string, any>;
	editingId: string | null;
	editForm: { displayName: string; priority: number };
	// biome-ignore lint/suspicious/noExplicitAny: entry type matches parent array
	onEdit: (entry: any) => void;
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
	selectedIds: Set<string>;
	onToggleSelect: (id: string) => void;
	onToggleSelectAll: (entryIds: string[]) => void;
	t: (key: string) => string;
}) {
	const {
		entries,
		totalEntries,
		page,
		pageSize,
		onPageChange,
		currentId,
		usageCache,
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
		selectedIds,
		onToggleSelect,
		t,
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
								</Group>
								<Group gap="xs">
									{entry.disabled ? (
										<Badge color="red" size="sm">
											{entry.disabledReason || "Disabled"}
										</Badge>
									) : (
										<Badge color="green" size="sm">
											Active
										</Badge>
									)}
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
											onClick={onSaveEdit}
											leftSection={<IconDeviceFloppy size={12} />}
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
										<UsageDisplay usage={usage} />
									</Stack>
								</>
							)}

							{/* Row 4: Actions */}
							<Group gap="xs" wrap="wrap">
								{!isEditing && (
									<>
										<Button variant="subtle" size="compact-xs" onClick={() => onEdit(entry)}>
											{t("codexEdit")}
										</Button>

										<Button
											variant="subtle"
											size="compact-xs"
											onClick={() => usageMut.mutate(entry.id)}
											loading={usageMut.isPending}
										>
											{t("codexQueryUsage")}
										</Button>
										{entry.disabled ? (
											<Button
												variant="subtle"
												size="compact-xs"
												color="green"
												onClick={() => enableMut.mutate(entry.id)}
											>
												{t("codexEnable")}
											</Button>
										) : (
											<Button
												variant="subtle"
												size="compact-xs"
												color="orange"
												onClick={() => disableMut.mutate(entry.id)}
											>
												{t("codexDisable")}
											</Button>
										)}
										{entry.failureCount > 0 && (
											<Button
												variant="subtle"
												size="compact-xs"
												color="blue"
												onClick={() => resetMut.mutate(entry.id)}
											>
												{t("codexReset")}
											</Button>
										)}
										<ActionIcon
											variant="subtle"
											color="red"
											size="sm"
											onClick={async () => {
												if (await confirm({ message: t("codexDeleteConfirm") })) {
													deleteMut.mutate(entry.id);
												}
											}}
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

// Usage display component
function UsageDisplay({
	usage,
}: {
	usage?: {
		plan_type: string;
		primary_window?: {
			used_percent: number;
			remaining_percent: number;
			reset_at: number;
			reset_after_seconds: number;
			window_type: "5h" | "weekly" | "unknown";
		};
		secondary_window?: {
			used_percent: number;
			remaining_percent: number;
			reset_at: number;
			reset_after_seconds: number;
			window_type: "5h" | "weekly" | "unknown";
		};
		queriedAt: string;
	};
}) {
	const { t } = useTranslation("settings");

	if (!usage) {
		return (
			<Text size="xs" c="dimmed">
				-
			</Text>
		);
	}

	const primaryWindow = usage.primary_window;
	const secondaryWindow = usage.secondary_window;

	const formatResetTime = (resetAt: number) => {
		const date = new Date(resetAt * 1000);
		const diff = date.getTime() - Date.now();

		if (diff < 0) return t("codexUsageExpired");
		const totalMinutes = Math.floor(diff / 60_000);
		const days = Math.floor(totalMinutes / 1440);
		const hours = Math.floor((totalMinutes % 1440) / 60);
		const minutes = totalMinutes % 60;
		if (days > 0) return `${days}d ${hours}h ${minutes}m`;
		if (hours > 0) return `${hours}h ${minutes}m`;
		return `${minutes}m`;
	};

	const getWindowLabel = (windowType: string) => {
		if (windowType === "5h") return t("codexUsage5h");
		if (windowType === "weekly") return t("codexUsageWeekly");
		return t("codexUsageUnknown");
	};

	return (
		<Stack gap={4}>
			<Group gap={4}>
				<Badge size="xs" variant="light" color="blue">
					{usage.plan_type}
				</Badge>
			</Group>

			{/* Primary window */}
			{primaryWindow && (
				<Stack gap={2}>
					<Text size="xs" fw={500}>
						{getWindowLabel(primaryWindow.window_type)}
					</Text>
					<Text size="xs">
						{t("codexUsageRemaining")}: {primaryWindow.remaining_percent.toFixed(1)}%
					</Text>
					<Progress
						value={primaryWindow.used_percent}
						size="xs"
						color={
							primaryWindow.remaining_percent < 10
								? "red"
								: primaryWindow.remaining_percent < 30
									? "yellow"
									: "green"
						}
						style={{ width: 100 }}
					/>
					<Text size="xs" c="dimmed">
						{t("codexUsageReset")}: {formatResetTime(primaryWindow.reset_at)}
					</Text>
				</Stack>
			)}

			{/* Secondary window */}
			{secondaryWindow && (
				<Stack gap={2}>
					<Text size="xs" fw={500}>
						{getWindowLabel(secondaryWindow.window_type)}
					</Text>
					<Text size="xs">
						{t("codexUsageRemaining")}: {secondaryWindow.remaining_percent.toFixed(1)}%
					</Text>
					<Progress
						value={secondaryWindow.used_percent}
						size="xs"
						color={
							secondaryWindow.remaining_percent < 10
								? "red"
								: secondaryWindow.remaining_percent < 30
									? "yellow"
									: "green"
						}
						style={{ width: 100 }}
					/>
					<Text size="xs" c="dimmed">
						{t("codexUsageReset")}: {formatResetTime(secondaryWindow.reset_at)}
					</Text>
				</Stack>
			)}

			<Text size="xs" c="dimmed">
				{relativeTime(usage.queriedAt)}
			</Text>
		</Stack>
	);
}
