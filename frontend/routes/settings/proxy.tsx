import {
	Alert,
	Button,
	Card,
	Group,
	List,
	Select,
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
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";
import {
	normalizeProxyUrl,
	type OutboundProxyMode,
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
		</Stack>
	);
}

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
	const [mode, setMode] = useState<OutboundProxyMode>("system");
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
				<Group justify="space-between">
					<Text fw={600}>{t("proxyOutboundTitle")}</Text>
				</Group>
				<Text size="xs" c="dimmed">
					{t("proxyOutboundDesc")}
				</Text>

				<Select
					label={t("proxyModeLabel")}
					data={[
						{ value: "system", label: t("proxyModeSystem") },
						{ value: "direct", label: t("proxyModeDirect") },
						{ value: "custom", label: t("proxyModeCustom") },
					]}
					value={mode}
					onChange={(v) => setMode((v as OutboundProxyMode) ?? "system")}
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
