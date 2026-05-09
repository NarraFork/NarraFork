import {
	Anchor,
	Badge,
	Button,
	Card,
	Group,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";
import { normalizeProxyUrl } from "../../lib/proxy";

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

			<SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
				<CodexProxyCard />
				<AnthropicProxyCard />
				<WebFetchProxyCard />
			</SimpleGrid>
		</Stack>
	);
}

	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const [proxy, setProxy] = useState("");
	const [initialized, setInitialized] = useState(false);

		gcTime: PROXY_SETTINGS_QUERY_GC_TIME_MS,
	});

	useEffect(() => {
			setInitialized(true);
		}

	const saveMut = useMutation({
		onSuccess: () => {
			notifications.show({ message: t("proxySaved"), color: "green" });
		},
	});

	const handleSave = useCallback(() => {
		const normalized = normalizeProxyUrl(proxy);
		setProxy(normalized ?? "");
		saveMut.mutate(normalized);
	}, [proxy, saveMut]);

	return (
		<Card withBorder padding="md">
			<Stack gap="xs">
				<Group justify="space-between">
					<Badge size="xs" color={proxy ? "green" : "gray"} variant="light">
						{proxy ? t("proxyConfigured") : t("proxyNotConfigured")}
					</Badge>
				</Group>
				<Text size="xs" c="dimmed">
				</Text>
				<Group align="flex-end" gap="xs">
					<TextInput
						size="xs"
						placeholder={t("proxyPlaceholder")}
						value={proxy}
						onChange={(e) => setProxy(e.target.value)}
						style={{ flex: 1 }}
					/>
					<Button size="xs" onClick={handleSave} loading={saveMut.isPending}>
						{t("proxySave")}
					</Button>
				</Group>
			</Stack>
		</Card>
	);
}

function CodexProxyCard() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const [proxy, setProxy] = useState("");
	const [initialized, setInitialized] = useState(false);

	const { data: codexStatus } = useQuery({
		queryKey: ["codex", "status"],
		queryFn: () => api.codexStatus(),
		gcTime: PROXY_SETTINGS_QUERY_GC_TIME_MS,
	});

	useEffect(() => {
		if (codexStatus && !initialized) {
			setProxy(codexStatus.globalProxy ?? "");
			setInitialized(true);
		}
	}, [codexStatus, initialized]);

	const saveMut = useMutation({
		mutationFn: (p?: string) => api.codexSetGlobalProxy(p),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["codex", "status"] });
			notifications.show({ message: t("proxySaved"), color: "green" });
		},
	});

	const handleSave = useCallback(() => {
		const normalized = normalizeProxyUrl(proxy);
		setProxy(normalized ?? "");
		saveMut.mutate(normalized);
	}, [proxy, saveMut]);

	return (
		<Card withBorder padding="md">
			<Stack gap="xs">
				<Group justify="space-between">
					<Text fw={600}>{t("proxyCodexTitle")}</Text>
					<Badge size="xs" color={proxy ? "green" : "gray"} variant="light">
						{proxy ? t("proxyConfigured") : t("proxyNotConfigured")}
					</Badge>
				</Group>
				<Text size="xs" c="dimmed">
					{t("proxyProviderDesc_codex")}
				</Text>
				<Group align="flex-end" gap="xs">
					<TextInput
						size="xs"
						placeholder={t("proxyPlaceholder")}
						value={proxy}
						onChange={(e) => setProxy(e.target.value)}
						style={{ flex: 1 }}
					/>
					<Button size="xs" onClick={handleSave} loading={saveMut.isPending}>
						{t("proxySave")}
					</Button>
				</Group>
			</Stack>
		</Card>
	);
}

function AnthropicProxyCard() {
	const { t } = useTranslation("settings");

	const { data: settingsData } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		gcTime: PROXY_SETTINGS_QUERY_GC_TIME_MS,
	});

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const providers = ((settingsData as any)?.anthropicProviders ?? []) as Array<{
		id: string;
		name: string;
		proxy?: string;
	}>;
	const configuredCount = providers.filter((p) => p.proxy).length;

	return (
		<Card withBorder padding="md">
			<Stack gap="xs">
				<Group justify="space-between">
					<Text fw={600}>{t("proxyAnthropicTitle")}</Text>
					<Badge size="xs" color={configuredCount > 0 ? "green" : "gray"} variant="light">
						{configuredCount > 0
							? `${configuredCount}/${providers.length} ${t("proxyConfigured")}`
							: t("proxyNotConfigured")}
					</Badge>
				</Group>
				<Text size="xs" c="dimmed">
					{t("proxyProviderDesc_anthropic")}
				</Text>
				{providers.length > 0 ? (
					<Stack gap={4}>
						{providers.map((p) => (
							<Group key={p.id} gap="xs">
								<Text size="xs" fw={500}>
									{p.name}:
								</Text>
								<Text size="xs" c={p.proxy ? undefined : "dimmed"}>
									{p.proxy || t("proxyDirectConnection")}
								</Text>
							</Group>
						))}
					</Stack>
				) : (
					<Text size="xs" c="dimmed" fs="italic">
						{t("proxyNotConfigured")}
					</Text>
				)}
				<Anchor component={Link} to="/settings/providers" size="xs">
					{t("proxyGoToProviderSettings")}
				</Anchor>
			</Stack>
		</Card>
	);
}

function WebFetchProxyCard() {
	const { t } = useTranslation("settings");

	const { data: settingsData } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		gcTime: PROXY_SETTINGS_QUERY_GC_TIME_MS,
	});

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const agentSettings = (settingsData as any)?.agent;
	const proxyMode = agentSettings?.webFetchPolicy?.proxy ?? "direct";
	const proxyUrl = agentSettings?.webFetchPolicy?.proxyUrl;

	const displayValue =
		proxyMode === "direct"
			? t("proxyDirectConnection")
			: proxyMode === "system"
				? t("webFetchProxySystem")
				: proxyUrl || t("webFetchProxyCustom");

	return (
		<Card withBorder padding="md">
			<Stack gap="xs">
				<Group justify="space-between">
					<Text fw={600}>{t("proxyWebFetchTitle")}</Text>
					<Badge size="xs" color={proxyMode !== "direct" ? "green" : "gray"} variant="light">
						{proxyMode !== "direct" ? t("proxyConfigured") : t("proxyNotConfigured")}
					</Badge>
				</Group>
				<Text size="xs" c="dimmed">
					{t("proxyProviderDesc_webfetch")}
				</Text>
				<Text size="xs">{displayValue}</Text>
				<Anchor component={Link} to="/settings/agent" size="xs">
					{t("proxyGoToAgentSettings")}
				</Anchor>
			</Stack>
		</Card>
	);
}
