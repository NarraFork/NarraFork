import {
	ActionIcon,
	Badge,
	Button,
	Card,
	Group,
	NumberInput,
	PasswordInput,
	Select,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useAllModels } from "../../hooks/useModels";
import { api } from "../../lib/api";

export const Route = createFileRoute("/settings/search")({
	component: SettingsSearchPage,
});


interface SearchChannelConfig {
	id: string;
	kind: SearchChannelKind;
	enabled: boolean;
	providerId?: string;
	model?: string;
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
	maxTurns?: number;
	timeoutMs?: number;
}

type CustomSearchProviderProtocol = "zhipu-web-search-v1" | "tavily-mcp";

interface CustomSearchProviderConfig {
	id: string;
	name: string;
	disabled?: boolean;
	protocol: CustomSearchProviderProtocol;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	options?: Record<string, unknown>;
	timeoutMs?: number;
}

interface SearchSettingsState {
	channels: SearchChannelConfig[];
	customProviders: CustomSearchProviderConfig[];
	defaultTimeoutMs: number;
	maxOutputChars: number;
}

interface SearchSettingsResponse {
	search?: Partial<SearchSettingsState>;
	nugProviders?: Array<{ id: string; name?: string }>;
}

function asSearchSettingsResponse(value: unknown): SearchSettingsResponse | undefined {
	return value && typeof value === "object" ? (value as SearchSettingsResponse) : undefined;
}

function shortId(): string {
	return Math.random().toString(36).slice(2, 10);
}

const PROTOCOL_BASE_URLS: Record<CustomSearchProviderProtocol, string> = {
	"zhipu-web-search-v1": "https://open.bigmodel.cn/api/paas/v4",
	"tavily-mcp": "https://mcp.tavily.com/mcp/",
};

function normalizeProtocol(value: unknown): CustomSearchProviderProtocol {
	return value === "tavily-mcp" ? "tavily-mcp" : "zhipu-web-search-v1";
}

function normalizeProvider(provider: CustomSearchProviderConfig): CustomSearchProviderConfig {
	const protocol = normalizeProtocol(provider.protocol);
	return {
		...provider,
		protocol,
		baseUrl: provider.baseUrl || PROTOCOL_BASE_URLS[protocol],
	};
}

function normalizeSearchSettings(
	settings: SearchSettingsResponse | undefined,
): SearchSettingsState {
	const search = settings?.search ?? {};
	return {
		channels: Array.isArray(search.channels) ? search.channels : [],
		customProviders: Array.isArray(search.customProviders)
			? search.customProviders.map(normalizeProvider)
			: [],
		defaultTimeoutMs: search.defaultTimeoutMs ?? 60000,
		maxOutputChars: search.maxOutputChars ?? 24000,
	};
}

function channelBadgeColor(kind: SearchChannelKind): string {
	switch (kind) {
		case "native":
			return "violet";
			return "blue";
		case "nug-mcp":
			return "green";
			return "cyan";
		case "custom-api":
			return "orange";
		case "subagent":
			return "pink";
	}
}

function channelLabel(
	channel: SearchChannelConfig,
	settings: SearchSettingsResponse | undefined,
): string {
	if (channel.kind === "native") return "Model native search";
	if (channel.kind === "subagent") return "Search subagent";
	const providerId = channel.providerId;
	if (channel.kind === "nug-mcp") {
		const provider = settings?.nugProviders?.find((p) => p.id === providerId);
		return `NUG: ${provider?.name ?? providerId ?? channel.id}`;
	}
	}
	const provider = settings?.search?.customProviders?.find((p) => p.id === providerId);
	return `Custom: ${provider?.name ?? providerId ?? channel.id}`;
}

function SettingsSearchPage() {
	const { t } = useTranslation("settings");
	const { t: tc } = useTranslation("common");
	const { t: tn } = useTranslation("narrator");
	const { data: user } = useCurrentUser();
	const qc = useQueryClient();
	const { groupedModels } = useAllModels();
	const [state, setState] = useState<SearchSettingsState | null>(null);
	const [saved, setSaved] = useState<SearchSettingsState | null>(null);
	const [testQuery, setTestQuery] = useState("latest AI news");
	const [testPurpose, setTestPurpose] = useState(
		"Verify that this search channel can return current web results with sources.",
	);
	const [testingChannel, setTestingChannel] = useState<string | null>(null);

	const { data: settingsData, isLoading } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		enabled: user?.role === "admin",
	});

	useEffect(() => {
		if (!settingsData || state) return;
		const snap = normalizeSearchSettings(asSearchSettingsResponse(settingsData));
		setState(snap);
		setSaved(snap);
	}, [settingsData, state]);

	const updateSettings = useMutation({
		mutationFn: (search: SearchSettingsState) => api.updateSettings({ search }),
		onSuccess: (data) => {
			qc.setQueryData(["settings"], data);
			const snap = normalizeSearchSettings(asSearchSettingsResponse(data));
			setState(snap);
			setSaved(snap);
			notifications.show({ message: t("searchSettingsSaved"), color: "green" });
		},
	});

	const testChannel = useMutation({
		mutationFn: (channelId: string) =>
			api.testSearchChannel({ channelId, query: testQuery, purpose: testPurpose }),
		onSuccess: (data) => {
			notifications.show({
				message: data.text ? data.text.slice(0, 180) : t("searchChannelTestSuccess"),
				color: "green",
			});
		},
		onError: (err) => {
			notifications.show({
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		},
		onSettled: () => setTestingChannel(null),
	});

	const dirty = useMemo(() => JSON.stringify(state) !== JSON.stringify(saved), [state, saved]);

	if (user?.role !== "admin") return null;
	if (isLoading || !state) return <Text>{tc("loading")}</Text>;

	const settingsRecord = asSearchSettingsResponse(settingsData);
	const protocolOptions = [
		{ value: "zhipu-web-search-v1", label: t("searchProtocolZhipu") },
		{ value: "tavily-mcp", label: t("searchProtocolTavily") },
	];
	const protocolDescription = (protocol: CustomSearchProviderProtocol): string => {
		switch (protocol) {
			case "zhipu-web-search-v1":
				return t("searchProtocolZhipuDesc");
			case "tavily-mcp":
				return t("searchProtocolTavilyDesc");
		}
	};
	const updateChannel = (id: string, patch: Partial<SearchChannelConfig>) => {
		setState((prev) =>
			prev
				? {
						...prev,
						channels: prev.channels.map((channel) =>
							channel.id === id ? { ...channel, ...patch } : channel,
						),
					}
				: prev,
		);
	};
	const moveChannel = (id: string, delta: number) => {
		setState((prev) => {
			if (!prev) return prev;
			const index = prev.channels.findIndex((channel) => channel.id === id);
			const nextIndex = index + delta;
			if (index < 0 || nextIndex < 0 || nextIndex >= prev.channels.length) return prev;
			const channels = [...prev.channels];
			const [item] = channels.splice(index, 1);
			channels.splice(nextIndex, 0, item);
			return { ...prev, channels };
		});
	};
	const addCustomProvider = () => {
		const id = shortId();
		setState((prev) =>
			prev
				? {
						...prev,
						customProviders: [
							...prev.customProviders,
							{
								id,
								name: t("searchCustomProviderDefaultName"),
								protocol: "zhipu-web-search-v1",
								baseUrl: PROTOCOL_BASE_URLS["zhipu-web-search-v1"],
							},
						],
						channels: [
							...prev.channels,
							{ id: `custom:${id}`, kind: "custom-api", providerId: id, enabled: true },
						],
					}
				: prev,
		);
	};
	const updateCustomProvider = (id: string, patch: Partial<CustomSearchProviderConfig>) => {
		setState((prev) =>
			prev
				? {
						...prev,
						customProviders: prev.customProviders.map((provider) =>
							provider.id === id ? { ...provider, ...patch } : provider,
						),
					}
				: prev,
		);
	};
	const updateCustomProviderProtocol = (id: string, protocol: CustomSearchProviderProtocol) => {
		setState((prev) =>
			prev
				? {
						...prev,
						customProviders: prev.customProviders.map((provider) => {
							if (provider.id !== id) return provider;
							const oldDefault = PROTOCOL_BASE_URLS[normalizeProtocol(provider.protocol)];
							const shouldReplaceBaseUrl = !provider.baseUrl || provider.baseUrl === oldDefault;
							return {
								...provider,
								protocol,
								baseUrl: shouldReplaceBaseUrl ? PROTOCOL_BASE_URLS[protocol] : provider.baseUrl,
							};
						}),
					}
				: prev,
		);
	};
	const removeCustomProvider = (id: string) => {
		setState((prev) =>
			prev
				? {
						...prev,
						customProviders: prev.customProviders.filter((provider) => provider.id !== id),
						channels: prev.channels.filter((channel) => channel.providerId !== id),
					}
				: prev,
		);
	};

	return (
		<Stack>
			<Group justify="space-between" align="flex-start">
				<div>
					<Title order={3}>{t("searchSection")}</Title>
					<Text size="sm" c="dimmed">
						{t("searchSectionDesc")}
					</Text>
				</div>
				<Button
					onClick={() => updateSettings.mutate(state)}
					disabled={!dirty}
					loading={updateSettings.isPending}
				>
					{tc("save")}
				</Button>
			</Group>

			<Card withBorder>
				<Stack gap="xs">
					<Text fw={600}>{t("searchTestTitle")}</Text>
					<Group grow>
						<TextInput
							label={t("searchTestQuery")}
							value={testQuery}
							onChange={(event) => setTestQuery(event.currentTarget.value)}
						/>
						<TextInput
							label={t("searchTestPurpose")}
							value={testPurpose}
							onChange={(event) => setTestPurpose(event.currentTarget.value)}
						/>
					</Group>
				</Stack>
			</Card>

			<Card withBorder>
				<Stack>
					<Group justify="space-between">
						<div>
							<Text fw={600}>{t("searchChannelsTitle")}</Text>
							<Text size="xs" c="dimmed">
								{t("searchChannelsDesc")}
							</Text>
						</div>
						<Button
							size="xs"
							variant="light"
							leftSection={<IconPlus size={14} />}
							onClick={addCustomProvider}
						>
							{t("searchAddCustomProvider")}
						</Button>
					</Group>

					{state.channels.map((channel, index) => (
						<Card key={channel.id} withBorder padding="sm">
							<Stack gap="xs">
								<Group justify="space-between" align="center">
									<Group gap="xs">
										<Text fw={600}>{channelLabel(channel, settingsRecord)}</Text>
										<Badge color={channelBadgeColor(channel.kind)} variant="light">
											{channel.kind}
										</Badge>
										{channel.kind === "native" && index > 0 && (
											<Badge color="yellow" variant="light">
												{t("searchNativeFirstOnly")}
											</Badge>
										)}
									</Group>
									<Group gap="xs">
										<ActionIcon
											variant="subtle"
											disabled={index === 0}
											onClick={() => moveChannel(channel.id, -1)}
										>
											<IconArrowUp size={16} />
										</ActionIcon>
										<ActionIcon
											variant="subtle"
											disabled={index === state.channels.length - 1}
											onClick={() => moveChannel(channel.id, 1)}
										>
											<IconArrowDown size={16} />
										</ActionIcon>
										<Switch
											checked={channel.enabled}
											onChange={(event) =>
												updateChannel(channel.id, { enabled: event.currentTarget.checked })
											}
										/>
										<Button
											size="xs"
											variant="light"
											loading={testingChannel === channel.id && testChannel.isPending}
											disabled={channel.kind === "native"}
											onClick={() => {
												setTestingChannel(channel.id);
												testChannel.mutate(channel.id);
											}}
										>
											{t("searchTestChannel")}
										</Button>
									</Group>
								</Group>

								{channel.kind === "subagent" && (
									<Group align="flex-end" grow>
										<Select
											label={t("searchSubagentModel")}
											placeholder={t("searchSubagentModelPlaceholder")}
											searchable
											clearable
											data={groupedModels}
											value={channel.model ?? null}
											onChange={(value) => updateChannel(channel.id, { model: value ?? undefined })}
										/>
										<Select
											label={t("searchReasoningEffort")}
											data={[
												{ value: "", label: tn("reasoning_auto") },
												{ value: "none", label: tn("reasoning_none") },
												{ value: "low", label: tn("reasoning_low") },
												{ value: "medium", label: tn("reasoning_medium") },
												{ value: "high", label: tn("reasoning_high") },
												{ value: "xhigh", label: tn("reasoning_xhigh") },
											]}
											value={channel.reasoningEffort ?? ""}
											onChange={(value) =>
												updateChannel(channel.id, {
													reasoningEffort: (value ||
														undefined) as SearchChannelConfig["reasoningEffort"],
												})
											}
										/>
										<NumberInput
											label={t("searchMaxTurns")}
											min={1}
											max={10}
											value={channel.maxTurns ?? 4}
											onChange={(value) =>
												updateChannel(channel.id, { maxTurns: Number(value) || 4 })
											}
										/>
									</Group>
								)}

								<Group align="flex-end">
									<NumberInput
										label={t("searchChannelTimeoutMs")}
										min={1000}
										max={300000}
										value={channel.timeoutMs ?? ""}
										onChange={(value) =>
											updateChannel(channel.id, {
												timeoutMs: typeof value === "number" ? value : undefined,
											})
										}
									/>
								</Group>
							</Stack>
						</Card>
					))}
				</Stack>
			</Card>

			<Card withBorder>
				<Stack>
					<Group justify="space-between">
						<Text fw={600}>{t("searchCustomProvidersTitle")}</Text>
						<Button
							size="xs"
							variant="light"
							leftSection={<IconPlus size={14} />}
							onClick={addCustomProvider}
						>
							{t("searchAddCustomProvider")}
						</Button>
					</Group>
					{state.customProviders.length === 0 && (
						<Text size="sm" c="dimmed">
							{t("searchNoCustomProviders")}
						</Text>
					)}
					{state.customProviders.map((provider) => (
						<Card key={provider.id} withBorder padding="sm">
							<Stack gap="xs">
								<Group justify="space-between">
									<Text fw={500}>{provider.name || provider.id}</Text>
									<ActionIcon
										color="red"
										variant="subtle"
										onClick={() => removeCustomProvider(provider.id)}
									>
										<IconTrash size={16} />
									</ActionIcon>
								</Group>
								<Group grow align="flex-end">
									<TextInput
										label={t("searchCustomProviderName")}
										value={provider.name}
										onChange={(event) =>
											updateCustomProvider(provider.id, { name: event.currentTarget.value })
										}
									/>
									<Select
										label={t("searchCustomProviderProtocol")}
										data={protocolOptions}
										value={normalizeProtocol(provider.protocol)}
										onChange={(value) =>
											updateCustomProviderProtocol(provider.id, normalizeProtocol(value))
										}
									/>
									<TextInput
										label={t("searchCustomProviderBaseUrl")}
										value={provider.baseUrl}
										onChange={(event) =>
											updateCustomProvider(provider.id, { baseUrl: event.currentTarget.value })
										}
									/>
								</Group>
								<Text size="xs" c="dimmed">
									{protocolDescription(normalizeProtocol(provider.protocol))}
								</Text>
								<Group grow align="flex-end">
									<PasswordInput
										label={t("searchCustomProviderApiKey")}
										value={provider.apiKey ?? ""}
										onChange={(event) =>
											updateCustomProvider(provider.id, { apiKey: event.currentTarget.value })
										}
									/>
									<NumberInput
										label={t("searchProviderTimeoutMs")}
										min={1000}
										max={300000}
										value={provider.timeoutMs ?? ""}
										onChange={(value) =>
											updateCustomProvider(provider.id, {
												timeoutMs: typeof value === "number" ? value : undefined,
											})
										}
									/>
									<Switch
										label={t("searchProviderDisabled")}
										checked={provider.disabled ?? false}
										onChange={(event) =>
											updateCustomProvider(provider.id, { disabled: event.currentTarget.checked })
										}
									/>
								</Group>
							</Stack>
						</Card>
					))}
				</Stack>
			</Card>

			<Card withBorder>
				<Group grow>
					<NumberInput
						label={t("searchDefaultTimeoutMs")}
						min={1000}
						max={300000}
						value={state.defaultTimeoutMs}
						onChange={(value) =>
							setState((prev) =>
								prev ? { ...prev, defaultTimeoutMs: Number(value) || 60000 } : prev,
							)
						}
					/>
					<NumberInput
						label={t("searchMaxOutputChars")}
						min={1000}
						max={100000}
						value={state.maxOutputChars}
						onChange={(value) =>
							setState((prev) =>
								prev ? { ...prev, maxOutputChars: Number(value) || 24000 } : prev,
							)
						}
					/>
				</Group>
			</Card>
		</Stack>
	);
}
