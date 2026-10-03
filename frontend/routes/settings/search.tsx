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
	Textarea,
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
import type {
	CustomSearchProviderConfig,
	SearchChannelConfig,
	SearchChannelKind,
} from "../../lib/api/settings";

export const Route = createFileRoute("/settings/search")({
	component: SettingsSearchPage,
});

/** Backend-resolved label and availability, keyed by channel id. */
interface SearchChannelInfo {
	id: string;
	kind: SearchChannelKind;
	label: string;
	available: boolean;
}

interface SearchProtocolMeta {
	id: string;
	label: { en: string; "zh-CN": string };
	description: { en: string; "zh-CN": string };
	defaultBaseUrl: string;
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
	searchChannelInfo?: SearchChannelInfo[];
}

function asSearchSettingsResponse(value: unknown): SearchSettingsResponse | undefined {
	return value && typeof value === "object" ? (value as SearchSettingsResponse) : undefined;
}

function shortId(): string {
	return Math.random().toString(36).slice(2, 10);
}

function normalizeSearchSettings(
	settings: SearchSettingsResponse | undefined,
): SearchSettingsState {
	const search = settings?.search ?? {};
	return {
		channels: Array.isArray(search.channels) ? search.channels : [],
		customProviders: Array.isArray(search.customProviders) ? search.customProviders : [],
		defaultTimeoutMs: search.defaultTimeoutMs ?? 60000,
		maxOutputChars: search.maxOutputChars ?? 24000,
	};
}

function channelBadgeColor(kind: SearchChannelKind): string {
	switch (kind) {
		case "native":
			return "violet";
		case "nug-mcp":
			return "green";
		case "custom-api":
			return "orange";
		case "subagent":
			return "pink";
		case "plugin":
			return "teal";
	}
}

function channelLabel(
	channel: SearchChannelConfig,
	settings: SearchSettingsResponse | undefined,
): string {
	if (channel.kind === "native") return "Model native search";
	if (channel.kind === "subagent") return "Search subagent";
	if (channel.kind === "plugin") {
		// Only the backend knows the plugin and contribution titles; there is nothing in
		// settings to derive them from.
		const info = settings?.searchChannelInfo?.find((item) => item.id === channel.id);
		return info?.label ?? channel.id;
	}
	const providerId = channel.providerId;
	if (channel.kind === "nug-mcp") {
		const provider = settings?.nugProviders?.find((p) => p.id === providerId);
		return `NUG: ${provider?.name ?? providerId ?? channel.id}`;
	}
	const provider = settings?.search?.customProviders?.find((p) => p.id === providerId);
	return `Custom: ${provider?.name ?? providerId ?? channel.id}`;
}

// ─── PLACEHOLDER_MAIN_COMPONENT ───

function SettingsSearchPage() {
	const { t } = useTranslation("settings");
	const { t: tc } = useTranslation("common");
	const { t: tn } = useTranslation("narrator");
	const { i18n } = useTranslation();
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

	const lang = i18n.language.startsWith("zh") ? "zh-CN" : "en";

	const { data: settingsData, isLoading } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		enabled: user?.role === "admin",
	});

	const { data: protocols } = useQuery({
		queryKey: ["searchProtocols"],
		queryFn: api.getSearchProtocols,
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
		mutationFn: (channel: SearchChannelConfig) =>
			api.testSearchChannel({
				channelId: channel.id,
				channel,
				...(channel.kind === "custom-api"
					? {
							customProvider: state?.customProviders.find(
								(provider) => provider.id === channel.providerId,
							),
						}
					: {}),
				query: testQuery,
				purpose: testPurpose,
			}),
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

	// Build protocol options from registry
	const protocolOptions = (protocols ?? []).map((p) => ({
		value: p.id,
		label: p.label[lang as "en" | "zh-CN"] || p.label.en,
	}));
	const getProtocolMeta = (id: string): SearchProtocolMeta | undefined =>
		(protocols ?? []).find((p) => p.id === id);
	const getProtocolDefaultBaseUrl = (id: string): string =>
		getProtocolMeta(id)?.defaultBaseUrl ?? "";

	// ─── PLACEHOLDER_HANDLERS ───

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
		const defaultProtocol = protocols?.[0]?.id ?? "zhipu-web-search-v1";
		setState((prev) =>
			prev
				? {
						...prev,
						customProviders: [
							...prev.customProviders,
							{
								id,
								name: t("searchCustomProviderDefaultName"),
								protocol: defaultProtocol,
								baseUrl: getProtocolDefaultBaseUrl(defaultProtocol),
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
	const updateCustomProviderProtocol = (id: string, protocol: string) => {
		setState((prev) =>
			prev
				? {
						...prev,
						customProviders: prev.customProviders.map((provider) => {
							if (provider.id !== id) return provider;
							const oldDefault = getProtocolDefaultBaseUrl(provider.protocol);
							const shouldReplaceBaseUrl = !provider.baseUrl || provider.baseUrl === oldDefault;
							return {
								...provider,
								protocol,
								baseUrl: shouldReplaceBaseUrl
									? getProtocolDefaultBaseUrl(protocol)
									: provider.baseUrl,
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
	const updateProviderOption = (providerId: string, key: string, value: unknown) => {
		setState((prev) =>
			prev
				? {
						...prev,
						customProviders: prev.customProviders.map((provider) => {
							if (provider.id !== providerId) return provider;
							const options = { ...(provider.options ?? {}) };
							if (value === undefined || value === "") {
								delete options[key];
							} else {
								options[key] = value;
							}
							return { ...provider, options };
						}),
					}
				: prev,
		);
	};
	const updateProviderResponseMapping = (providerId: string, key: string, value: string) => {
		setState((prev) =>
			prev
				? {
						...prev,
						customProviders: prev.customProviders.map((provider) => {
							if (provider.id !== providerId) return provider;
							const options = { ...(provider.options ?? {}) };
							const mapping = {
								...((options.responseMapping as Record<string, string>) ?? {}),
							};
							if (value === "") {
								delete mapping[key];
							} else {
								mapping[key] = value;
							}
							options.responseMapping = mapping;
							return { ...provider, options };
						}),
					}
				: prev,
		);
	};

	// ─── PLACEHOLDER_JSX ───

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
										{channel.kind === "plugin" &&
											settingsRecord?.searchChannelInfo?.find((item) => item.id === channel.id)
												?.available === false && (
												// A plugin channel is unusable when its plugin is disabled or the
												// bound provider has no credential yet. Without this the channel
												// looks ready and quietly fails when dispatched.
												<Badge color="gray" variant="light">
													{t("searchChannelUnavailable")}
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
												testChannel.mutate(channel);
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

			{/* ─── Custom Providers Section ─── */}
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
					{state.customProviders.map((provider) => {
						const meta = getProtocolMeta(provider.protocol);
						const isCustomHttp = provider.protocol === "custom-http";
						const options = (provider.options ?? {}) as Record<string, unknown>;
						const responseMapping = (options.responseMapping ?? {}) as Record<string, string>;
						return (
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
											value={provider.protocol}
											onChange={(value) => {
												if (value) updateCustomProviderProtocol(provider.id, value);
											}}
										/>
										<TextInput
											label={t("searchCustomProviderBaseUrl")}
											value={provider.baseUrl}
											onChange={(event) =>
												updateCustomProvider(provider.id, { baseUrl: event.currentTarget.value })
											}
										/>
									</Group>
									{meta && (
										<Text size="xs" c="dimmed">
											{meta.description[lang as "en" | "zh-CN"] || meta.description.en}
										</Text>
									)}
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

									{/* ─── Custom HTTP specific UI ─── */}
									{isCustomHttp && (
										<Stack gap="xs" mt="xs">
											<Text size="sm" fw={500}>
												{t("searchCustomHttpConfig")}
											</Text>
											<Group grow align="flex-end">
												<Select
													label={t("searchCustomHttpMethod")}
													data={[
														{ value: "POST", label: "POST" },
														{ value: "GET", label: "GET" },
													]}
													value={(options.method as string) ?? "POST"}
													onChange={(value) =>
														updateProviderOption(provider.id, "method", value ?? "POST")
													}
												/>
												<Select
													label={t("searchCustomHttpAuthStyle")}
													data={[
														{ value: "bearer", label: "Bearer Token" },
														{ value: "query", label: "Query Param" },
														{ value: "none", label: t("searchCustomHttpAuthNone") },
													]}
													value={(options.authStyle as string) ?? "bearer"}
													onChange={(value) =>
														updateProviderOption(provider.id, "authStyle", value ?? "bearer")
													}
												/>
												{options.authStyle === "query" && (
													<TextInput
														label={t("searchCustomHttpAuthQueryParam")}
														placeholder="apiKey"
														value={(options.authQueryParam as string) ?? ""}
														onChange={(event) =>
															updateProviderOption(
																provider.id,
																"authQueryParam",
																event.currentTarget.value,
															)
														}
													/>
												)}
											</Group>
											<Textarea
												label={t("searchCustomHttpBodyTemplate")}
												description={t("searchCustomHttpBodyTemplateDesc")}
												placeholder={'{"query":"{{query}}","count":{{count}}}'}
												autosize
												minRows={2}
												maxRows={6}
												value={(options.bodyTemplate as string) ?? ""}
												onChange={(event) =>
													updateProviderOption(
														provider.id,
														"bodyTemplate",
														event.currentTarget.value,
													)
												}
											/>
											<Text size="sm" fw={500} mt="xs">
												{t("searchCustomHttpResponseMapping")}
											</Text>
											<Group grow align="flex-end">
												<TextInput
													label={t("searchCustomHttpResultsPath")}
													placeholder="data.webPages"
													value={responseMapping.resultsPath ?? ""}
													onChange={(event) =>
														updateProviderResponseMapping(
															provider.id,
															"resultsPath",
															event.currentTarget.value,
														)
													}
												/>
												<TextInput
													label={t("searchCustomHttpTitleField")}
													placeholder="title"
													value={responseMapping.titleField ?? ""}
													onChange={(event) =>
														updateProviderResponseMapping(
															provider.id,
															"titleField",
															event.currentTarget.value,
														)
													}
												/>
												<TextInput
													label={t("searchCustomHttpUrlField")}
													placeholder="url"
													value={responseMapping.urlField ?? ""}
													onChange={(event) =>
														updateProviderResponseMapping(
															provider.id,
															"urlField",
															event.currentTarget.value,
														)
													}
												/>
											</Group>
											<Group grow align="flex-end">
												<TextInput
													label={t("searchCustomHttpSnippetField")}
													placeholder="snippet"
													value={responseMapping.snippetField ?? ""}
													onChange={(event) =>
														updateProviderResponseMapping(
															provider.id,
															"snippetField",
															event.currentTarget.value,
														)
													}
												/>
												<TextInput
													label={t("searchCustomHttpSourceField")}
													placeholder="source"
													value={responseMapping.sourceField ?? ""}
													onChange={(event) =>
														updateProviderResponseMapping(
															provider.id,
															"sourceField",
															event.currentTarget.value,
														)
													}
												/>
												<TextInput
													label={t("searchCustomHttpDateField")}
													placeholder="datePublished"
													value={responseMapping.publishedAtField ?? ""}
													onChange={(event) =>
														updateProviderResponseMapping(
															provider.id,
															"publishedAtField",
															event.currentTarget.value,
														)
													}
												/>
											</Group>
										</Stack>
									)}
								</Stack>
							</Card>
						);
					})}
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
