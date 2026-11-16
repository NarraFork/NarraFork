import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Card,
	Divider,
	Group,
	List,
	Select,
	Skeleton,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProxyOverrideField } from "../../components/common/ProxyOverrideField";
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";
import { miscApi } from "../../lib/api/misc";
import {
	buildOutboundProxyPatch,
	buildUpdateProxyPatch,
	buildWebToolProxyPatch,
	findNoProxyRuleError,
	MAX_NO_PROXY_RULES,
	type NoProxyRule,
	normalizeProxyUrl,
	type OutboundProxyMode,
	type ProxyOverride,
	summarizeNoProxyRules,
	summarizeOutboundProxyPolicy,
	validateNoProxyPattern,
} from "../../lib/proxy";

export const Route = createFileRoute("/settings/proxy")({
	component: ProxyManagementPage,
});

const PROXY_SETTINGS_QUERY_GC_TIME_MS = 60_000;

function ProxyManagementPage() {
	const { t } = useTranslation("settings");
	const { data: user } = useCurrentUser();

	if (user?.role !== "admin") return null;

	return (
		<Stack gap="md" p="md">
			<div>
				<Title order={2}>{t("proxyManagementSection")}</Title>
				<Text size="sm" c="dimmed">
					{t("proxyManagementDesc")}
				</Text>
			</div>

			<OutboundProxyCard />
			<NoProxyRulesCard />

			<div>
				<Title order={3}>{t("proxyOverridesSection")}</Title>
				<Text size="sm" c="dimmed">
					{t("proxyOverridesDesc")}
				</Text>
			</div>

			<AiProviderOverrides />
			<WebToolOverrides />
			<UpdateOverrides />
			<GatewayOverrides />
			<HookOverrides />
		</Stack>
	);
}

// ---------------------------------------------------------------------------
// Global default policy
// ---------------------------------------------------------------------------

function OutboundProxyCard() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();

	const { data: settingsData } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		gcTime: PROXY_SETTINGS_QUERY_GC_TIME_MS,
	});

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const currentPolicy = (settingsData as any)?.proxy;
	const [mode, setMode] = useState<OutboundProxyMode>("direct");
	const [url, setUrl] = useState("");
	const [initialized, setInitialized] = useState(false);

	useEffect(() => {
		if (settingsData && !initialized) {
			const summary = summarizeOutboundProxyPolicy(currentPolicy);
			setMode(summary.mode);
			setUrl(summary.url);
			setInitialized(true);
		}
	}, [settingsData, currentPolicy, initialized]);

	const saveMut = useMutation({
		mutationFn: (payload: { mode: OutboundProxyMode; url?: string }) =>
			// The server replaces `settings.proxy` wholesale, so the shared no_proxy
			// list must travel with every policy save or it would be dropped.
			api.updateSettings(
				buildOutboundProxyPatch({
					mode: payload.mode,
					url: payload.url,
					noProxyRules: summarizeNoProxyRules(currentPolicy),
				}),
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			notifications.show({ message: t("proxySaved"), color: "green" });
		},
	});

	// Only flag an actual mistake: a blank field is "not filled in yet", and the
	// error would otherwise flash while the user is still typing the address.
	const customUrlInvalid =
		mode === "custom" && initialized && !!url.trim() && !normalizeProxyUrl(url);

	const handleSave = useCallback(() => {
		// Settings replace `proxy` wholesale. Saving before they load would send
		// `noProxyRules: []` and wipe the stored list.
		if (!initialized) return;
		if (mode === "custom") {
			const normalized = normalizeProxyUrl(url);
			if (!normalized) {
				notifications.show({ message: t("proxyInvalidUrl"), color: "red" });
				return;
			}
			setUrl(normalized);
			saveMut.mutate({ mode: "custom", url: normalized });
		} else {
			saveMut.mutate({ mode });
		}
	}, [initialized, mode, url, saveMut, t]);

	return (
		<Card withBorder padding="md" maw={640}>
			<Stack gap="sm">
				<Text fw={600}>{t("proxyOutboundTitle")}</Text>
				<Text size="xs" c="dimmed">
					{t("proxyOutboundDesc")}
				</Text>

				<Select
					label={t("proxyModeLabel")}
					data={[
						{ value: "direct", label: t("proxyModeDirect") },
						{ value: "system", label: t("proxyModeSystem") },
						{ value: "custom", label: t("proxyModeCustom") },
					]}
					value={mode}
					onChange={(v) => setMode((v as OutboundProxyMode) ?? "direct")}
					allowDeselect={false}
				/>

				{mode === "custom" && (
					<TextInput
						label={t("proxyUrlLabel")}
						placeholder={t("proxyPlaceholder")}
						value={url}
						error={customUrlInvalid ? t("proxyInvalidUrl") : undefined}
						onChange={(e) => setUrl(e.currentTarget.value)}
					/>
				)}

				<Alert variant="light" color="gray" p="xs">
					<Text size="xs" c="dimmed">
						{t("proxyScopeNote")}
					</Text>
					<List size="xs" c="dimmed" mt={4}>
						<List.Item>{t("proxyScopeAiProviders")}</List.Item>
						<List.Item>{t("proxyScopeWebFetch")}</List.Item>
						<List.Item>{t("proxyScopeImGateway")}</List.Item>
						<List.Item>{t("proxyScopeHooks")}</List.Item>
						<List.Item>{t("proxyScopeUpdates")}</List.Item>
						<List.Item>{t("proxyScopeImWsLimit")}</List.Item>
						<List.Item>{t("proxyScopeLoopbackExempt")}</List.Item>
					</List>
				</Alert>

				<Group justify="flex-end">
					<Button
						size="xs"
						onClick={handleSave}
						loading={saveMut.isPending}
						disabled={!initialized}
					>
						{t("proxySave")}
					</Button>
				</Group>
			</Stack>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// no_proxy rules (targets that always bypass the proxy)
// ---------------------------------------------------------------------------

/** Local editor row identifier, so React keys survive reordering and deletion. */
function newRuleId(): string {
	const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
	return `np_${random.slice(0, 8)}`;
}

/**
 * Targets that must never go through the proxy.
 *
 * Stored globally (`settings.proxy.noProxyRules`) and applied by the server in
 * the shared proxy resolver, so one list covers every proxied channel. The
 * browser can only honour wildcard host rules — that limit is stated in the card.
 */
function NoProxyRulesCard() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const { data: settingsData, isLoading } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		gcTime: PROXY_SETTINGS_QUERY_GC_TIME_MS,
	});

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const currentPolicy = (settingsData as any)?.proxy;
	const policySummary = summarizeOutboundProxyPolicy(currentPolicy);
	const [rules, setRules] = useState<NoProxyRule[]>([]);
	const [initialized, setInitialized] = useState(false);

	useEffect(() => {
		if (settingsData && !initialized) {
			setRules(summarizeNoProxyRules(currentPolicy));
			setInitialized(true);
		}
	}, [settingsData, currentPolicy, initialized]);

	// Blank rows are "not filled in yet" and are never persisted.
	const editedRules = rules
		.map((rule) => ({ ...rule, pattern: rule.pattern.trim() }))
		.filter((rule) => rule.pattern !== "");
	const dirty =
		JSON.stringify(editedRules) !== JSON.stringify(summarizeNoProxyRules(currentPolicy));

	const updateRule = (index: number, patch: Partial<NoProxyRule>) => {
		setRules((prev) => prev.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
	};

	const addRule = () => {
		setRules((prev) => [
			...prev,
			{ id: newRuleId(), match: "wildcard", pattern: "", enabled: true },
		]);
	};

	const removeRule = (index: number) => {
		setRules((prev) => prev.filter((_, i) => i !== index));
	};

	const saveMut = useMutation({
		mutationFn: (nextRules: NoProxyRule[]) =>
			// `settings.proxy` is replaced wholesale, so the mode and custom URL must
			// travel with the rule list.
			api.updateSettings(
				buildOutboundProxyPatch({
					mode: policySummary.mode,
					url: policySummary.url,
					noProxyRules: nextRules,
				}),
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			notifications.show({ message: t("proxySaved"), color: "green" });
		},
		onError: (error) => {
			notifications.show({
				message: t("proxySaveFailed", { error: error.message }),
				color: "red",
			});
		},
	});

	const handleSave = useCallback(() => {
		const error = findNoProxyRuleError(editedRules);
		if (error) {
			notifications.show({
				message: t("noProxyInvalidRegex", { error: error.message }),
				color: "red",
			});
			return;
		}
		setRules(editedRules);
		saveMut.mutate(editedRules);
	}, [editedRules, saveMut, t]);

	return (
		<Card withBorder padding="md" maw={640}>
			<Stack gap="sm">
				<Text fw={600}>{t("noProxySection")}</Text>
				<Text size="xs" c="dimmed">
					{t("noProxyDesc")}
				</Text>

				{isLoading ? (
					<Skeleton height={48} radius="sm" />
				) : rules.length === 0 ? (
					<Text size="xs" c="dimmed" fs="italic">
						{t("noProxyEmpty")}
					</Text>
				) : (
					<Stack gap="xs">
						{rules.map((rule, index) => {
							const patternError = rule.pattern.trim()
								? validateNoProxyPattern(rule.match, rule.pattern)
								: undefined;
							return (
								<Group
									key={rule.id ?? index}
									align="flex-start"
									gap="xs"
									wrap="nowrap"
									data-testid="no-proxy-rule-row"
								>
									<Select
										w={132}
										data={[
											{ value: "wildcard", label: t("noProxyMatchWildcard") },
											{ value: "regex", label: t("noProxyMatchRegex") },
										]}
										value={rule.match}
										allowDeselect={false}
										aria-label={t("noProxyMatchLabel")}
										onChange={(value) =>
											updateRule(index, { match: value === "regex" ? "regex" : "wildcard" })
										}
									/>
									<TextInput
										style={{ flex: 1, minWidth: 0 }}
										aria-label={t("noProxyPatternLabel")}
										placeholder={
											rule.match === "regex"
												? t("noProxyPatternPlaceholderRegex")
												: t("noProxyPatternPlaceholderWildcard")
										}
										value={rule.pattern}
										error={
											patternError ? t("noProxyInvalidRegex", { error: patternError }) : undefined
										}
										onChange={(event) => updateRule(index, { pattern: event.currentTarget.value })}
									/>
									<Tooltip label={t("noProxyEnabled")} withArrow>
										<Switch
											pt={7}
											checked={rule.enabled !== false}
											aria-label={t("noProxyEnabled")}
											onChange={(event) =>
												updateRule(index, { enabled: event.currentTarget.checked })
											}
										/>
									</Tooltip>
									<Tooltip label={t("noProxyRemove")} withArrow>
										<ActionIcon
											mt={4}
											variant="subtle"
											color="red"
											aria-label={t("noProxyRemove")}
											onClick={() => removeRule(index)}
										>
											<IconTrash size={16} />
										</ActionIcon>
									</Tooltip>
								</Group>
							);
						})}
					</Stack>
				)}

				<Alert variant="light" color="gray" p="xs">
					<Text size="xs" c="dimmed">
						{t("noProxyPriorityNote")}
					</Text>
					<Text size="xs" c="dimmed" mt={4}>
						{t("noProxySyntaxWildcard")}
					</Text>
					<Text size="xs" c="dimmed" mt={2}>
						{t("noProxySyntaxRegex")}
					</Text>
					<Text size="xs" c="dimmed" mt={4}>
						{t("noProxyBrowserNote")}
					</Text>
				</Alert>

				<Group justify="space-between">
					<Button
						size="xs"
						variant="light"
						leftSection={<IconPlus size={14} />}
						disabled={isLoading || rules.length >= MAX_NO_PROXY_RULES}
						onClick={addRule}
					>
						{t("noProxyAdd")}
					</Button>
					<Button
						size="xs"
						onClick={handleSave}
						loading={saveMut.isPending}
						disabled={isLoading || !dirty}
					>
						{t("noProxySave")}
					</Button>
				</Group>
			</Stack>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// Shared override row
// ---------------------------------------------------------------------------

function OverrideRow({
	name,
	badge,
	value,
	onChange,
	disabled,
}: {
	name: string;
	badge?: string;
	value: ProxyOverride | undefined;
	onChange: (next: ProxyOverride | undefined) => void;
	disabled?: boolean;
}) {
	return (
		<Group align="flex-end" gap="sm" wrap="nowrap">
			<Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
				<Group gap={6} wrap="nowrap">
					<Text size="sm" fw={500} truncate>
						{name}
					</Text>
					{badge && (
						<Badge size="xs" variant="light" color="gray">
							{badge}
						</Badge>
					)}
				</Group>
			</Stack>
			<div style={{ flex: 1, minWidth: 0 }}>
				<ProxyOverrideField value={value} onChange={onChange} hideDescription disabled={disabled} />
			</div>
		</Group>
	);
}

function GroupCard({
	title,
	loading,
	empty,
	children,
}: {
	title: string;
	loading: boolean;
	empty: boolean;
	children: React.ReactNode;
}) {
	const { t } = useTranslation("settings");
	return (
		<Card withBorder padding="md" maw={640}>
			<Stack gap="sm">
				<Text fw={600}>{title}</Text>
				{loading ? (
					<Skeleton height={48} radius="sm" />
				) : empty ? (
					<Text size="xs" c="dimmed" fs="italic">
						{t("proxyOverridesEmpty")}
					</Text>
				) : (
					children
				)}
			</Stack>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// AI provider overrides (settings)
// ---------------------------------------------------------------------------

interface ProviderLike {
	id: string;
	name?: string;
	prefix?: string;
	proxy?: ProxyOverride;
}

function AiProviderOverrides() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const { data: settingsData, isLoading } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		gcTime: PROXY_SETTINGS_QUERY_GC_TIME_MS,
	});

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const s = settingsData as any;
	const codexProxy = s?.codex?.proxy as ProxyOverride | undefined;
	const customApiProviders = (s?.customApiProviders ?? []) as ProviderLike[];
	const nugProviders = (s?.nugProviders ?? []) as ProviderLike[];

	const saveMut = useMutation({
		mutationFn: (payload: Record<string, unknown>) => api.updateSettings(payload),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			notifications.show({ message: t("proxySaved"), color: "green" });
		},
	});

	const updateArrayProxy = (
		key: "customApiProviders" | "nugProviders",
		list: ProviderLike[],
		id: string,
		next: ProxyOverride | undefined,
	) => {
		const updated = list.map((p) => (p.id === id ? { ...p, proxy: next } : p));
		saveMut.mutate({ [key]: updated });
	};

	const hasAny = !!s?.codex || customApiProviders.length > 0 || nugProviders.length > 0;

	const label = (p: ProviderLike) => p.name || p.prefix || p.id;

	return (
		<GroupCard title={t("proxyGroupAiProviders")} loading={isLoading} empty={!hasAny}>
			<Stack gap="sm">
				<OverrideRow
					name="Codex"
					value={codexProxy}
					disabled={saveMut.isPending}
					onChange={(next) => saveMut.mutate({ codex: { proxy: next } })}
				/>
				{(customApiProviders.length > 0 || nugProviders.length > 0) && <Divider />}
				{customApiProviders.map((p) => (
					<OverrideRow
						key={p.id}
						name={label(p)}
						badge={t("proxyBadgeCustomApi")}
						value={p.proxy}
						disabled={saveMut.isPending}
						onChange={(next) =>
							updateArrayProxy("customApiProviders", customApiProviders, p.id, next)
						}
					/>
				))}
				{nugProviders.map((p) => (
					<OverrideRow
						key={p.id}
						name={label(p)}
						badge="NUG"
						value={p.proxy}
						disabled={saveMut.isPending}
						onChange={(next) => updateArrayProxy("nugProviders", nugProviders, p.id, next)}
					/>
				))}
			</Stack>
		</GroupCard>
	);
}

// ---------------------------------------------------------------------------
// Web tool overrides (settings)
// ---------------------------------------------------------------------------

function WebToolOverrides() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const {
		data: settingsData,
		isLoading,
		isError,
	} = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		gcTime: PROXY_SETTINGS_QUERY_GC_TIME_MS,
	});
	const agent = (
		settingsData as
			| {
					agent?: {
						webFetchPolicy?: { proxy?: ProxyOverride };
						browserProxy?: ProxyOverride;
					};
			  }
			| undefined
	)?.agent;

	const saveMut = useMutation({
		mutationFn: ({ tool, next }: { tool: "webFetch" | "browser"; next?: ProxyOverride }) =>
			api.updateSettings(buildWebToolProxyPatch(tool, next)),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			notifications.show({ message: t("proxySaved"), color: "green" });
		},
		onError: (error) => {
			notifications.show({
				message: t("proxySaveFailed", { error: error.message }),
				color: "red",
			});
		},
	});

	return (
		<GroupCard title={t("proxyGroupWebTools")} loading={isLoading} empty={false}>
			{isError ? (
				<Alert color="red">{t("proxyLoadFailed")}</Alert>
			) : (
				<Stack gap="sm">
					<OverrideRow
						name="Web Fetch"
						value={agent?.webFetchPolicy?.proxy}
						disabled={saveMut.isPending}
						onChange={(next) => saveMut.mutate({ tool: "webFetch", next })}
					/>
					<OverrideRow
						name="Browser"
						value={agent?.browserProxy}
						disabled={saveMut.isPending}
						onChange={(next) => saveMut.mutate({ tool: "browser", next })}
					/>
					<Text size="xs" c="dimmed">
						{t("proxyBrowserNewSessionsNote")}
					</Text>
				</Stack>
			)}
		</GroupCard>
	);
}

// ---------------------------------------------------------------------------
// Software updates and helper downloads (one shared settings override)
// ---------------------------------------------------------------------------

function UpdateOverrides() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const {
		data: settingsData,
		isLoading,
		isError,
	} = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		gcTime: PROXY_SETTINGS_QUERY_GC_TIME_MS,
	});
	const update = (settingsData as { update?: { proxy?: ProxyOverride } } | undefined)?.update;
	const saveMut = useMutation({
		mutationFn: (next: ProxyOverride | undefined) =>
			api.updateSettings(buildUpdateProxyPatch(next)),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			notifications.show({ message: t("proxySaved"), color: "green" });
		},
		onError: (error) => {
			notifications.show({
				message: t("proxySaveFailed", { error: error.message }),
				color: "red",
			});
		},
	});

	return (
		<GroupCard title={t("proxyGroupUpdates")} loading={isLoading} empty={false}>
			{isError ? (
				<Alert color="red">{t("proxyLoadFailed")}</Alert>
			) : (
				<Stack gap="sm">
					<OverrideRow
						name={t("proxyGroupUpdates")}
						value={update?.proxy}
						disabled={saveMut.isPending}
						onChange={(next) => saveMut.mutate(next)}
					/>
					<Text size="xs" c="dimmed">
						{t("proxyUpdatesDesc")}
					</Text>
				</Stack>
			)}
		</GroupCard>
	);
}

// ---------------------------------------------------------------------------
// IM gateway platform overrides (user preferences)
// ---------------------------------------------------------------------------

interface GatewayPlatformLike {
	platform: string;
	proxy?: ProxyOverride;
	[key: string]: unknown;
}

function GatewayOverrides() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const { data: prefs, isLoading } = useQuery({
		queryKey: ["user-preferences"],
		queryFn: api.getUserPreferences,
		staleTime: 60_000,
	});

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const gatewayConfig = (prefs as any)?.gatewayConfig as
		| { platforms?: GatewayPlatformLike[] }
		| undefined;
	const platforms = gatewayConfig?.platforms ?? [];

	const saveMut = useMutation({
		mutationFn: async ({
			platform,
			next,
		}: {
			platform: string;
			next: ProxyOverride | undefined;
		}) => {
			const updatedPlatforms = platforms.map((p) =>
				p.platform === platform ? { ...p, proxy: next } : p,
			);
			await api.updateUserPreferences({
				gatewayConfig: { ...gatewayConfig, platforms: updatedPlatforms },
				// biome-ignore lint/suspicious/noExplicitAny: gatewayConfig is loosely typed on the prefs API
			} as any);
			// Reload the affected platform so the proxy change takes effect immediately.
			await miscApi.gatewayReload([platform]).catch(() => {});
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["user-preferences"] });
			notifications.show({ message: t("proxySaved"), color: "green" });
		},
	});

	return (
		<GroupCard title={t("proxyGroupImGateway")} loading={isLoading} empty={platforms.length === 0}>
			<Stack gap="sm">
				{platforms.map((p) => (
					<OverrideRow
						key={p.platform}
						name={p.platform}
						value={p.proxy}
						disabled={saveMut.isPending}
						onChange={(next) => saveMut.mutate({ platform: p.platform, next })}
					/>
				))}
			</Stack>
		</GroupCard>
	);
}

// ---------------------------------------------------------------------------
// HTTP hook overrides
// ---------------------------------------------------------------------------

function HookOverrides() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const { data: hooks, isLoading } = useQuery({
		queryKey: ["hooks", "all"],
		queryFn: miscApi.listAllHooks,
		gcTime: PROXY_SETTINGS_QUERY_GC_TIME_MS,
	});

	const httpHooks = (hooks ?? []).filter((h) => h.type === "http");

	const saveMut = useMutation({
		mutationFn: ({ id, next }: { id: string; next: ProxyOverride | undefined }) =>
			api.updateHook(id, {
				proxyMode: next?.mode ?? null,
				proxyUrl: next?.mode === "custom" ? (next.url ?? null) : null,
			}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["hooks"] });
			notifications.show({ message: t("proxySaved"), color: "green" });
		},
	});

	return (
		<GroupCard title={t("proxyGroupHooks")} loading={isLoading} empty={httpHooks.length === 0}>
			<Stack gap="sm">
				{httpHooks.map((h) => (
					<OverrideRow
						key={h.id}
						name={h.url ?? h.id}
						badge={h.projectId ? t("proxyBadgeProject") : t("proxyBadgeGlobal")}
						value={h.proxyMode ? { mode: h.proxyMode, url: h.proxyUrl ?? undefined } : undefined}
						disabled={saveMut.isPending}
						onChange={(next) => saveMut.mutate({ id: h.id, next })}
					/>
				))}
			</Stack>
		</GroupCard>
	);
}
