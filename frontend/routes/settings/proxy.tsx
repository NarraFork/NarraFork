import {
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
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProxyOverrideField } from "../../components/common/ProxyOverrideField";
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";
import { miscApi } from "../../lib/api/misc";
import {
	normalizeProxyUrl,
	type OutboundProxyMode,
	type ProxyOverride,
	summarizeOutboundProxyPolicy,
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

			<div>
				<Title order={3}>{t("proxyOverridesSection")}</Title>
				<Text size="sm" c="dimmed">
					{t("proxyOverridesDesc")}
				</Text>
			</div>

			<AiProviderOverrides />
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
			api.updateSettings({ proxy: payload }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			notifications.show({ message: t("proxySaved"), color: "green" });
		},
	});

	const handleSave = useCallback(() => {
		if (mode === "custom") {
			const normalized = normalizeProxyUrl(url);
			setUrl(normalized ?? "");
			saveMut.mutate({ mode: "custom", url: normalized });
		} else {
			saveMut.mutate({ mode });
		}
	}, [mode, url, saveMut]);

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
						<List.Item>{t("proxyScopeImWsLimit")}</List.Item>
						<List.Item>{t("proxyScopeLoopbackExempt")}</List.Item>
					</List>
				</Alert>

				<Group justify="flex-end">
					<Button size="xs" onClick={handleSave} loading={saveMut.isPending}>
						{t("proxySave")}
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
	const clineProviders = (s?.clineProviders ?? []) as ProviderLike[];

	const saveMut = useMutation({
		mutationFn: (payload: Record<string, unknown>) => api.updateSettings(payload),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			notifications.show({ message: t("proxySaved"), color: "green" });
		},
	});

	const updateArrayProxy = (
		key: "customApiProviders" | "nugProviders" | "clineProviders",
		list: ProviderLike[],
		id: string,
		next: ProxyOverride | undefined,
	) => {
		const updated = list.map((p) => (p.id === id ? { ...p, proxy: next } : p));
		saveMut.mutate({ [key]: updated });
	};

	const hasAny =
		!!s?.codex ||
		customApiProviders.length > 0 ||
		nugProviders.length > 0 ||
		clineProviders.length > 0;

	const label = (p: ProviderLike) => p.name || p.prefix || p.id;

	return (
		<GroupCard title={t("proxyGroupAiProviders")} loading={isLoading} empty={!hasAny}>
			<Stack gap="sm">
				<OverrideRow
					disabled={saveMut.isPending}
				/>
				<OverrideRow
					name="Codex"
					value={codexProxy}
					disabled={saveMut.isPending}
					onChange={(next) => saveMut.mutate({ codex: { proxy: next } })}
				/>
				{(customApiProviders.length > 0 ||
					nugProviders.length > 0 ||
					clineProviders.length > 0) && <Divider />}
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
				{clineProviders.map((p) => (
					<OverrideRow
						key={p.id}
						name={label(p)}
						badge="Cline"
						value={p.proxy}
						disabled={saveMut.isPending}
						onChange={(next) => updateArrayProxy("clineProviders", clineProviders, p.id, next)}
					/>
				))}
			</Stack>
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
