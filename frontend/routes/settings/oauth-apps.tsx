import {
	Alert,
	Badge,
	Button,
	Checkbox,
	Code,
	CopyButton,
	Divider,
	Group,
	Loader,
	Modal,
	NumberInput,
	Select,
	SimpleGrid,
	Stack,
	Switch,
	Table,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconApps, IconEdit, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/ConfirmDialogProvider";
import { useCurrentUser } from "../../hooks/useAuth";
import { type ApiError, api, type OAuthApp } from "../../lib/api";
import {
	OAUTH_APP_AVAILABLE_SCOPES,
	OAUTH_APP_LEGACY_SCOPES,
	OAUTH_APP_RECOMMENDED_SCOPES,
	type OAuthAppPermissionMode,
	type OAuthAppPolicy,
	type OAuthAppSystemPromptMode,
} from "../../lib/api/oauth-apps";
import { formatLocaleDateTime } from "../../lib/intl-format";

export const Route = createFileRoute("/settings/oauth-apps")({
	component: SettingsOAuthAppsPage,
});

const PERMISSION_MODES = ["readOnly", "dontAsk"] as const;

interface ExternalWebSocketSettingsForm {
	enabled: boolean;
	readEnabled: boolean;
	messageEnabled: boolean;
	interruptEnabled: boolean;
	ticketTtlMs: number;
	maxTickets: number;
	maxFrameBytes: number;
	allowedOriginsText: string;
	maxSubscriptionsPerFrame: number;
	maxSubscriptionsPerConnection: number;
	maxGlobalConnections: number;
	maxConnectionsPerToken: number;
	maxConnectionsPerGrant: number;
	maxConnectionsPerClient: number;
	maxConnectionsPerUser: number;
	maxBufferedAmount: number;
}

interface OAuthSettingsPayload {
	oauth?: {
		externalWebSocket?: Partial<
			Omit<ExternalWebSocketSettingsForm, "allowedOriginsText"> & { allowedOrigins: string[] }
		>;
	};
}

const DEFAULT_EXTERNAL_WEBSOCKET_SETTINGS: ExternalWebSocketSettingsForm = {
	enabled: false,
	readEnabled: false,
	messageEnabled: false,
	interruptEnabled: false,
	ticketTtlMs: 30_000,
	maxTickets: 4096,
	maxFrameBytes: 65_536,
	allowedOriginsText: "",
	maxSubscriptionsPerFrame: 20,
	maxSubscriptionsPerConnection: 50,
	maxGlobalConnections: 1000,
	maxConnectionsPerToken: 8,
	maxConnectionsPerGrant: 16,
	maxConnectionsPerClient: 256,
	maxConnectionsPerUser: 32,
	maxBufferedAmount: 1_048_576,
};

const DEFAULT_POLICY: OAuthAppPolicy = {
	defaultPermissionMode: "readOnly",
	allowedPermissionModes: ["readOnly"],
	systemPromptMode: "managed",
	maxSystemPromptChars: 0,
	allowGlobalDevice: false,
	allowKnowledgeWrite: false,
};

function createDefaultPolicy(): OAuthAppPolicy {
	return { ...DEFAULT_POLICY, allowedPermissionModes: [...DEFAULT_POLICY.allowedPermissionModes] };
}

function hasLegacyOAuthScopes(scopes: readonly string[]): boolean {
	return scopes.some((scope) => (OAUTH_APP_LEGACY_SCOPES as readonly string[]).includes(scope));
}

type ExternalWebSocketNumberField = {
	[K in keyof ExternalWebSocketSettingsForm]: ExternalWebSocketSettingsForm[K] extends number
		? K
		: never;
}[keyof ExternalWebSocketSettingsForm];

function ExternalWebSocketSettingsSection() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const [form, setForm] = useState(DEFAULT_EXTERNAL_WEBSOCKET_SETTINGS);
	const { data, isLoading } = useQuery({
		queryKey: ["settings"],
		queryFn: async () => (await api.getSettings()) as unknown as OAuthSettingsPayload,
	});

	useEffect(() => {
		const externalWebSocket = data?.oauth?.externalWebSocket;
		if (!externalWebSocket) return;
		const { allowedOrigins, ...values } = externalWebSocket;
		setForm({
			...DEFAULT_EXTERNAL_WEBSOCKET_SETTINGS,
			...values,
			allowedOriginsText: (allowedOrigins ?? []).join("\n"),
		});
	}, [data]);

	const saveMutation = useMutation({
		mutationFn: () => {
			const { allowedOriginsText, ...values } = form;
			return api.updateSettings({
				oauth: {
					externalWebSocket: {
						...values,
						allowedOrigins: splitLines(allowedOriginsText),
					},
				},
			});
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["settings"] });
			notifications.show({ color: "green", message: t("oauthExternalWebSocketSaved") });
		},
		onError: (err: ApiError) => {
			notifications.show({
				color: "red",
				message: err.message || t("oauthExternalWebSocketSaveFailed"),
			});
		},
	});

	const updateNumber = (field: ExternalWebSocketNumberField, value: string | number) => {
		if (typeof value !== "number") return;
		setForm((current) => ({ ...current, [field]: value }));
	};

	if (isLoading) return <Loader size="sm" />;

	return (
		<Stack gap="md">
			<div>
				<Title order={4}>{t("oauthExternalWebSocketSection")}</Title>
				<Text size="sm" c="dimmed">
					{t("oauthExternalWebSocketDescription")}
				</Text>
			</div>
			<Alert color="yellow">{t("oauthExternalWebSocketWarning")}</Alert>
			<SimpleGrid cols={{ base: 1, sm: 2 }}>
				<Switch
					label={t("oauthExternalWebSocketEnabled")}
					checked={form.enabled}
					onChange={(event) =>
						setForm((current) => ({ ...current, enabled: event.currentTarget.checked }))
					}
				/>
				<Switch
					label={t("oauthExternalWebSocketReadEnabled")}
					checked={form.readEnabled}
					onChange={(event) =>
						setForm((current) => ({ ...current, readEnabled: event.currentTarget.checked }))
					}
				/>
				<Switch
					label={t("oauthExternalWebSocketMessageEnabled")}
					checked={form.messageEnabled}
					onChange={(event) =>
						setForm((current) => ({ ...current, messageEnabled: event.currentTarget.checked }))
					}
				/>
				<Switch
					label={t("oauthExternalWebSocketInterruptEnabled")}
					checked={form.interruptEnabled}
					onChange={(event) =>
						setForm((current) => ({ ...current, interruptEnabled: event.currentTarget.checked }))
					}
				/>
			</SimpleGrid>
			<Textarea
				label={t("oauthExternalWebSocketAllowedOrigins")}
				description={t("oauthExternalWebSocketAllowedOriginsHint")}
				value={form.allowedOriginsText}
				onChange={(event) =>
					setForm((current) => ({
						...current,
						allowedOriginsText: event.currentTarget.value,
					}))
				}
				minRows={2}
				autosize
			/>
			<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
				<NumberInput
					label={t("oauthExternalWebSocketTicketTtlMs")}
					value={form.ticketTtlMs}
					min={30_000}
					max={60_000}
					onChange={(value) => updateNumber("ticketTtlMs", value)}
				/>
				<NumberInput
					label={t("oauthExternalWebSocketMaxTickets")}
					value={form.maxTickets}
					min={1}
					max={10_000}
					onChange={(value) => updateNumber("maxTickets", value)}
				/>
				<NumberInput
					label={t("oauthExternalWebSocketMaxFrameBytes")}
					value={form.maxFrameBytes}
					min={4096}
					max={262_144}
					onChange={(value) => updateNumber("maxFrameBytes", value)}
				/>
				<NumberInput
					label={t("oauthExternalWebSocketMaxSubscriptionsPerFrame")}
					value={form.maxSubscriptionsPerFrame}
					min={1}
					max={100}
					onChange={(value) => updateNumber("maxSubscriptionsPerFrame", value)}
				/>
				<NumberInput
					label={t("oauthExternalWebSocketMaxSubscriptionsPerConnection")}
					value={form.maxSubscriptionsPerConnection}
					min={1}
					max={200}
					onChange={(value) => updateNumber("maxSubscriptionsPerConnection", value)}
				/>
				<NumberInput
					label={t("oauthExternalWebSocketMaxGlobalConnections")}
					value={form.maxGlobalConnections}
					min={1}
					max={5000}
					onChange={(value) => updateNumber("maxGlobalConnections", value)}
				/>
				<NumberInput
					label={t("oauthExternalWebSocketMaxConnectionsPerToken")}
					value={form.maxConnectionsPerToken}
					min={1}
					max={32}
					onChange={(value) => updateNumber("maxConnectionsPerToken", value)}
				/>
				<NumberInput
					label={t("oauthExternalWebSocketMaxConnectionsPerGrant")}
					value={form.maxConnectionsPerGrant}
					min={1}
					max={128}
					onChange={(value) => updateNumber("maxConnectionsPerGrant", value)}
				/>
				<NumberInput
					label={t("oauthExternalWebSocketMaxConnectionsPerClient")}
					value={form.maxConnectionsPerClient}
					min={1}
					max={1000}
					onChange={(value) => updateNumber("maxConnectionsPerClient", value)}
				/>
				<NumberInput
					label={t("oauthExternalWebSocketMaxConnectionsPerUser")}
					value={form.maxConnectionsPerUser}
					min={1}
					max={128}
					onChange={(value) => updateNumber("maxConnectionsPerUser", value)}
				/>
				<NumberInput
					label={t("oauthExternalWebSocketMaxBufferedAmount")}
					value={form.maxBufferedAmount}
					min={65_536}
					max={8_388_608}
					onChange={(value) => updateNumber("maxBufferedAmount", value)}
				/>
			</SimpleGrid>
			<Group justify="flex-end">
				<Button onClick={() => saveMutation.mutate()} loading={saveMutation.isPending}>
					{t("oauthExternalWebSocketSave")}
				</Button>
			</Group>
		</Stack>
	);
}

function SettingsOAuthAppsPage() {
	const { t } = useTranslation("settings");
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const qc = useQueryClient();
	const confirm = useConfirmDialog();

	const [createOpen, setCreateOpen] = useState(false);
	const [createdApp, setCreatedApp] = useState<OAuthApp | null>(null);
	const [editingApp, setEditingApp] = useState<OAuthApp | null>(null);
	const [editName, setEditName] = useState("");
	const [editRedirectUrisText, setEditRedirectUrisText] = useState("");
	const [editScopes, setEditScopes] = useState<string[]>([]);
	const [editPolicy, setEditPolicy] = useState<OAuthAppPolicy>(createDefaultPolicy);
	const [clientId, setClientId] = useState("robot-assistant");
	const [name, setName] = useState("");
	const [redirectUrisText, setRedirectUrisText] = useState(
		"robot-assistant://oauth/callback\nhttp://127.0.0.1:0/callback",
	);
	const [scopes, setScopes] = useState<string[]>([...OAUTH_APP_RECOMMENDED_SCOPES]);
	const [policy, setPolicy] = useState<OAuthAppPolicy>(createDefaultPolicy);
	const [formError, setFormError] = useState("");

	const { data: apps, isLoading } = useQuery({
		queryKey: ["oauth-apps"],
		queryFn: () => api.listOAuthApps(),
		enabled: isAdmin,
	});

	const createMut = useMutation({
		mutationFn: () =>
			api.createOAuthApp({
				clientId: clientId.trim() || undefined,
				name: name.trim(),
				redirectUris: splitLines(redirectUrisText),
				scopes,
				publicClient: true,
				policy,
			}),
		onSuccess: (app) => {
			qc.invalidateQueries({ queryKey: ["oauth-apps"] });
			setCreateOpen(false);
			setCreatedApp(app);
			resetForm();
		},
		onError: (err: ApiError) => {
			setFormError(err.message || t("oauthAppsCreateFailed"));
		},
	});

	const updateMut = useMutation({
		mutationFn: (app: OAuthApp) =>
			api.updateOAuthApp(app.id, {
				name: editName.trim(),
				redirectUris: splitLines(editRedirectUrisText),
				scopes: editScopes,
				policy: editPolicy,
			}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["oauth-apps"] });
			setEditingApp(null);
			notifications.show({ color: "green", message: t("oauthAppsUpdated") });
		},
		onError: (err: ApiError) => {
			setFormError(err.message || t("oauthAppsUpdateFailed"));
		},
	});

	const revokeMut = useMutation({
		mutationFn: (id: string) => api.deleteOAuthApp(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["oauth-apps"] });
			notifications.show({ color: "green", message: t("oauthAppsRevoked") });
		},
		onError: (err: ApiError) => {
			notifications.show({
				color: "red",
				message: err.message || t("oauthAppsRevokeFailed"),
			});
		},
	});

	if (!isAdmin) return null;
	if (isLoading) return <Loader />;

	const resetForm = () => {
		setClientId("robot-assistant");
		setName("");
		setRedirectUrisText("robot-assistant://oauth/callback\nhttp://127.0.0.1:0/callback");
		setScopes([...OAUTH_APP_RECOMMENDED_SCOPES]);
		setPolicy(createDefaultPolicy());
		setFormError("");
	};

	const toggleScope = (scope: string) => {
		setScopes((prev) =>
			prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
		);
	};

	const openEdit = (app: OAuthApp) => {
		setFormError("");
		setEditingApp(app);
		setEditName(app.name);
		setEditRedirectUrisText(app.redirectUris.join("\n"));
		setEditScopes(app.scopes);
		setEditPolicy({
			...app.policy,
			allowedPermissionModes: [...app.policy.allowedPermissionModes],
		});
	};

	const toggleEditScope = (scope: string) => {
		setEditScopes((prev) =>
			prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
		);
	};

	const getPolicyError = (candidate: OAuthAppPolicy): string | null => {
		if (!PERMISSION_MODES.some((mode) => mode === candidate.defaultPermissionMode)) {
			return t("oauthAppsPolicyInvalidDefaultPermissionMode");
		}
		if (
			candidate.allowedPermissionModes.length === 0 ||
			!candidate.allowedPermissionModes.every((allowed) =>
				PERMISSION_MODES.some((mode) => mode === allowed),
			)
		) {
			return t("oauthAppsPolicyInvalidAllowedPermissionModes");
		}
		if (!candidate.allowedPermissionModes.includes(candidate.defaultPermissionMode)) {
			return t("oauthAppsPolicyDefaultMustBeAllowed");
		}
		if (
			!Number.isInteger(candidate.maxSystemPromptChars) ||
			candidate.maxSystemPromptChars < 0 ||
			candidate.maxSystemPromptChars > 10_000
		) {
			return t("oauthAppsPolicyInvalidMaxSystemPromptChars");
		}
		return null;
	};

	const handleUpdate = () => {
		setFormError("");
		if (!editingApp || !editName.trim()) {
			setFormError(t("oauthAppsNameRequired"));
			return;
		}
		if (splitLines(editRedirectUrisText).length === 0) {
			setFormError(t("oauthAppsRedirectRequired"));
			return;
		}
		if (editScopes.length === 0) {
			setFormError(t("oauthAppsScopesRequired"));
			return;
		}
		const policyError = getPolicyError(editPolicy);
		if (policyError) {
			setFormError(policyError);
			return;
		}
		updateMut.mutate(editingApp);
	};

	const handleCreate = () => {
		setFormError("");
		if (!name.trim()) {
			setFormError(t("oauthAppsNameRequired"));
			return;
		}
		if (splitLines(redirectUrisText).length === 0) {
			setFormError(t("oauthAppsRedirectRequired"));
			return;
		}
		if (scopes.length === 0) {
			setFormError(t("oauthAppsScopesRequired"));
			return;
		}
		const policyError = getPolicyError(policy);
		if (policyError) {
			setFormError(policyError);
			return;
		}
		createMut.mutate();
	};

	const handleRevoke = async (app: OAuthApp) => {
		if (
			await confirm({
				message: t("oauthAppsRevokeConfirm"),
				confirmColor: "red",
			})
		) {
			revokeMut.mutate(app.id);
		}
	};

	const scopeLabel = (scope: string) => {
		const keyByScope: Record<string, string> = {
			"device:manage": "oauthAppsScopeDeviceManage",
			"narrator:use": "oauthAppsScopeNarratorUse",
			"project:read": "oauthAppsScopeProjectRead",
			"device:read": "oauthAppsScopeDeviceRead",
			"device:provision": "oauthAppsScopeDeviceProvision",
			"device:rotate": "oauthAppsScopeDeviceRotate",
			"narrator:read": "oauthAppsScopeNarratorRead",
			"narrator:subscribe": "oauthAppsScopeNarratorSubscribe",
			"narrator:provision": "oauthAppsScopeNarratorProvision",
			"narrator:message": "oauthAppsScopeNarratorMessage",
			"narrator:interrupt": "oauthAppsScopeNarratorInterrupt",
		};
		const key = keyByScope[scope];
		return key ? t(key) : scope;
	};

	return (
		<Stack>
			<ExternalWebSocketSettingsSection />
			<Divider />
			<Group justify="space-between" align="center">
				<Group gap="xs">
					<IconApps size={22} />
					<Title order={3}>{t("oauthAppsSection")}</Title>
				</Group>
				<Button
					size="compact-sm"
					variant="light"
					leftSection={<IconPlus size={16} />}
					onClick={() => {
						resetForm();
						setCreateOpen(true);
					}}
				>
					{t("oauthAppsCreate")}
				</Button>
			</Group>
			<Text size="sm" c="dimmed">
				{t("oauthAppsDescription")}
			</Text>

			{!apps || apps.length === 0 ? (
				<Text size="sm" c="dimmed" mt="md">
					{t("oauthAppsEmpty")}
				</Text>
			) : (
				<Table striped highlightOnHover withTableBorder>
					<Table.Thead>
						<Table.Tr>
							<Table.Th>{t("oauthAppsName")}</Table.Th>
							<Table.Th>{t("oauthAppsClientId")}</Table.Th>
							<Table.Th>{t("oauthAppsRedirectUris")}</Table.Th>
							<Table.Th>{t("oauthAppsScopes")}</Table.Th>
							<Table.Th>{t("oauthAppsPolicySection")}</Table.Th>
							<Table.Th>{t("oauthAppsCreatedAt")}</Table.Th>
							<Table.Th>{t("connectedAppsLastUsedAt")}</Table.Th>
							<Table.Th>{t("oauthAppsActions")}</Table.Th>
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{apps.map((app) => (
							<Table.Tr key={app.id}>
								<Table.Td>
									<Text size="sm" fw={500}>
										{app.name}
									</Text>
								</Table.Td>
								<Table.Td>
									<Code>{app.clientId}</Code>
								</Table.Td>
								<Table.Td>
									<Stack gap={2}>
										{app.redirectUris.map((uri) => (
											<Text key={uri} size="xs" style={{ wordBreak: "break-all" }}>
												{uri}
											</Text>
										))}
									</Stack>
								</Table.Td>
								<Table.Td>
									<Group gap={4}>
										{app.scopes.map((scope) => (
											<Badge key={scope} size="sm" variant="light">
												{scope}
											</Badge>
										))}
									</Group>
								</Table.Td>
								<Table.Td>
									<PolicySummary policy={app.policy} />
								</Table.Td>
								<Table.Td>
									<Text size="xs">{formatLocaleDateTime(app.createdAt)}</Text>
								</Table.Td>
								<Table.Td>
									<Text size="xs">
										{app.lastUsedAt
											? formatLocaleDateTime(app.lastUsedAt)
											: t("connectedAppsNeverUsed")}
									</Text>
								</Table.Td>
								<Table.Td>
									<Group gap="xs">
										<Button
											size="compact-xs"
											variant="light"
											leftSection={<IconEdit size={14} />}
											onClick={() => openEdit(app)}
										>
											{t("oauthAppsEdit")}
										</Button>
										<Button
											size="compact-xs"
											color="red"
											variant="light"
											leftSection={<IconTrash size={14} />}
											loading={revokeMut.isPending && revokeMut.variables === app.id}
											onClick={() => handleRevoke(app)}
										>
											{t("oauthAppsRevoke")}
										</Button>
									</Group>
								</Table.Td>
							</Table.Tr>
						))}
					</Table.Tbody>
				</Table>
			)}

			<Modal
				opened={createOpen}
				onClose={() => setCreateOpen(false)}
				title={t("oauthAppsCreate")}
				centered
			>
				<Stack>
					{formError && <Alert color="red">{formError}</Alert>}
					<TextInput
						label={t("oauthAppsClientId")}
						description={t("oauthAppsClientIdHint")}
						value={clientId}
						onChange={(e) => setClientId(e.currentTarget.value)}
						placeholder="robot-assistant"
					/>
					<TextInput
						label={t("oauthAppsName")}
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						required
					/>
					<Textarea
						label={t("oauthAppsRedirectUris")}
						description={t("oauthAppsRedirectUrisHint")}
						value={redirectUrisText}
						onChange={(e) => setRedirectUrisText(e.currentTarget.value)}
						minRows={3}
						autosize
						required
					/>
					<Stack gap={4}>
						<Text size="sm" fw={500}>
							{t("oauthAppsScopes")}
						</Text>
						{OAUTH_APP_AVAILABLE_SCOPES.map((scope) => (
							<Checkbox
								key={scope}
								label={scopeLabel(scope)}
								checked={scopes.includes(scope)}
								onChange={() => toggleScope(scope)}
							/>
						))}
						{hasLegacyOAuthScopes(scopes) && (
							<Alert color="yellow" variant="light">
								{t("oauthAppsLegacyScopeWarning")}
							</Alert>
						)}
					</Stack>
					<PolicyFields policy={policy} onChange={setPolicy} />
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setCreateOpen(false)}>
							{t("cancel", { ns: "common", defaultValue: "Cancel" })}
						</Button>
						<Button onClick={handleCreate} loading={createMut.isPending}>
							{t("oauthAppsCreate")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			<Modal
				opened={!!editingApp}
				onClose={() => setEditingApp(null)}
				title={t("oauthAppsEdit")}
				centered
			>
				<Stack>
					{formError && <Alert color="red">{formError}</Alert>}
					<TextInput
						label={t("oauthAppsName")}
						value={editName}
						onChange={(e) => setEditName(e.currentTarget.value)}
						required
					/>
					<Textarea
						label={t("oauthAppsRedirectUris")}
						description={t("oauthAppsRedirectUrisHint")}
						value={editRedirectUrisText}
						onChange={(e) => setEditRedirectUrisText(e.currentTarget.value)}
						minRows={3}
						autosize
						required
					/>
					<Stack gap={4}>
						<Text size="sm" fw={500}>
							{t("oauthAppsScopes")}
						</Text>
						{OAUTH_APP_AVAILABLE_SCOPES.map((scope) => (
							<Checkbox
								key={scope}
								label={scopeLabel(scope)}
								checked={editScopes.includes(scope)}
								onChange={() => toggleEditScope(scope)}
							/>
						))}
						{hasLegacyOAuthScopes(editScopes) && (
							<Alert color="yellow" variant="light">
								{t("oauthAppsLegacyScopeWarning")}
							</Alert>
						)}
					</Stack>
					<PolicyFields policy={editPolicy} onChange={setEditPolicy} />
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setEditingApp(null)}>
							{t("cancel", { ns: "common", defaultValue: "Cancel" })}
						</Button>
						<Button onClick={handleUpdate} loading={updateMut.isPending}>
							{t("oauthAppsSave")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			<Modal
				opened={!!createdApp}
				onClose={() => setCreatedApp(null)}
				title={t("oauthAppsCreatedTitle")}
				centered
			>
				{createdApp && (
					<Stack>
						<Text size="sm" c="dimmed">
							{t("oauthAppsCreatedHint")}
						</Text>
						<Text size="sm" fw={500}>
							{createdApp.name}
						</Text>
						<Group>
							<Code style={{ flex: 1, wordBreak: "break-all" }}>{createdApp.clientId}</Code>
							<CopyButton value={createdApp.clientId}>
								{({ copied, copy }) => (
									<Button size="compact-sm" variant="light" onClick={copy}>
										{copied
											? t("copied", { ns: "common", defaultValue: "Copied" })
											: t("oauthAppsCopyClientId")}
									</Button>
								)}
							</CopyButton>
						</Group>
						<Button onClick={() => setCreatedApp(null)}>
							{t("close", { ns: "common", defaultValue: "Close" })}
						</Button>
					</Stack>
				)}
			</Modal>
		</Stack>
	);
}

function PolicyFields({
	policy,
	onChange,
}: {
	policy: OAuthAppPolicy;
	onChange: (policy: OAuthAppPolicy) => void;
}) {
	const { t } = useTranslation("settings");

	const permissionModeLabel = (mode: OAuthAppPermissionMode) =>
		mode === "readOnly"
			? t("oauthAppsPolicyPermissionModeReadOnly")
			: t("oauthAppsPolicyPermissionModeDontAsk");

	const permissionModeDescription = (mode: OAuthAppPermissionMode) =>
		mode === "readOnly"
			? t("oauthAppsPolicyPermissionModeReadOnlyDesc")
			: t("oauthAppsPolicyPermissionModeDontAskDesc");

	const updateDefaultPermissionMode = (value: string | null) => {
		if (!value) return;
		const mode = value as OAuthAppPermissionMode;
		onChange({
			...policy,
			defaultPermissionMode: mode,
			allowedPermissionModes: policy.allowedPermissionModes.includes(mode)
				? policy.allowedPermissionModes
				: [...policy.allowedPermissionModes, mode],
		});
	};

	const toggleAllowedPermissionMode = (mode: OAuthAppPermissionMode, checked: boolean) => {
		onChange({
			...policy,
			allowedPermissionModes: checked
				? [...new Set([...policy.allowedPermissionModes, mode])]
				: policy.allowedPermissionModes.filter((allowed) => allowed !== mode),
		});
	};

	return (
		<Stack gap="sm">
			<Stack gap={2}>
				<Group justify="space-between" align="center">
					<Text size="sm" fw={600}>
						{t("oauthAppsPolicySection")}
					</Text>
					<Button
						size="compact-xs"
						variant="subtle"
						onClick={() => onChange(createDefaultPolicy())}
					>
						{t("oauthAppsPolicyRestoreDefaults")}
					</Button>
				</Group>
				<Text size="xs" c="dimmed">
					{t("oauthAppsPolicyDescription")}
				</Text>
			</Stack>

			<Select
				label={t("oauthAppsPolicyDefaultPermissionMode")}
				description={t("oauthAppsPolicyDefaultPermissionModeDesc")}
				value={policy.defaultPermissionMode}
				data={PERMISSION_MODES.map((mode) => ({
					value: mode,
					label: permissionModeLabel(mode),
				}))}
				onChange={updateDefaultPermissionMode}
				allowDeselect={false}
			/>

			<Stack gap={4}>
				<Text size="sm" fw={500}>
					{t("oauthAppsPolicyAllowedPermissionModes")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("oauthAppsPolicyAllowedPermissionModesDesc")}
				</Text>
				{PERMISSION_MODES.map((mode) => (
					<Checkbox
						key={mode}
						label={permissionModeLabel(mode)}
						description={permissionModeDescription(mode)}
						checked={policy.allowedPermissionModes.includes(mode)}
						disabled={mode === policy.defaultPermissionMode}
						onChange={(event) => toggleAllowedPermissionMode(mode, event.currentTarget.checked)}
					/>
				))}
			</Stack>

			<Select
				label={t("oauthAppsPolicySystemPromptMode")}
				description={t("oauthAppsPolicySystemPromptModeDesc")}
				value={policy.systemPromptMode}
				data={[
					{
						value: "managed",
						label: t("oauthAppsPolicySystemPromptModeManaged"),
					},
					{
						value: "append",
						label: t("oauthAppsPolicySystemPromptModeAppend"),
					},
				]}
				onChange={(value) => {
					if (!value) return;
					onChange({ ...policy, systemPromptMode: value as OAuthAppSystemPromptMode });
				}}
				allowDeselect={false}
			/>
			<Text size="xs" c="dimmed" mt={-8}>
				{policy.systemPromptMode === "managed"
					? t("oauthAppsPolicySystemPromptModeManagedDesc")
					: t("oauthAppsPolicySystemPromptModeAppendDesc")}
			</Text>

			<NumberInput
				label={t("oauthAppsPolicyMaxSystemPromptChars")}
				description={t("oauthAppsPolicyMaxSystemPromptCharsDesc")}
				value={policy.maxSystemPromptChars}
				min={0}
				max={10_000}
				step={100}
				allowDecimal={false}
				onChange={(value) =>
					onChange({
						...policy,
						maxSystemPromptChars: typeof value === "number" ? value : Number(value),
					})
				}
			/>

			<Alert color="orange" variant="light">
				<Stack gap="sm">
					<Switch
						color="orange"
						label={t("oauthAppsPolicyAllowGlobalDevice")}
						description={t("oauthAppsPolicyAllowGlobalDeviceDesc")}
						checked={policy.allowGlobalDevice}
						onChange={(event) =>
							onChange({ ...policy, allowGlobalDevice: event.currentTarget.checked })
						}
					/>
					<Switch
						color="orange"
						label={t("oauthAppsPolicyAllowKnowledgeWrite")}
						description={t("oauthAppsPolicyAllowKnowledgeWriteDesc")}
						checked={policy.allowKnowledgeWrite}
						onChange={(event) =>
							onChange({ ...policy, allowKnowledgeWrite: event.currentTarget.checked })
						}
					/>
				</Stack>
			</Alert>
		</Stack>
	);
}

function PolicySummary({ policy }: { policy: OAuthAppPolicy }) {
	const { t } = useTranslation("settings");
	const permissionModeLabel = (mode: OAuthAppPermissionMode) =>
		mode === "readOnly"
			? t("oauthAppsPolicyPermissionModeReadOnly")
			: t("oauthAppsPolicyPermissionModeDontAsk");
	const systemPromptLabel =
		policy.systemPromptMode === "managed"
			? t("oauthAppsPolicySystemPromptModeManaged")
			: t("oauthAppsPolicySystemPromptModeAppend");

	return (
		<Stack gap={4} miw={180}>
			<Text size="xs">
				{t("oauthAppsPolicyDefaultPermissionMode")}:{" "}
				{permissionModeLabel(policy.defaultPermissionMode)}
			</Text>
			<Group gap={4}>
				{policy.allowedPermissionModes.map((mode) => (
					<Badge key={mode} size="xs" variant="light">
						{permissionModeLabel(mode)}
					</Badge>
				))}
			</Group>
			<Text size="xs" c="dimmed">
				{systemPromptLabel}
				{policy.systemPromptMode === "append" ? ` · ${policy.maxSystemPromptChars}` : ""}
			</Text>
			{(policy.allowGlobalDevice || policy.allowKnowledgeWrite) && (
				<Group gap={4}>
					{policy.allowGlobalDevice && (
						<Badge size="xs" color="orange" variant="light">
							{t("oauthAppsPolicyAllowGlobalDevice")}
						</Badge>
					)}
					{policy.allowKnowledgeWrite && (
						<Badge size="xs" color="orange" variant="light">
							{t("oauthAppsPolicyAllowKnowledgeWrite")}
						</Badge>
					)}
				</Group>
			)}
		</Stack>
	);
}

function splitLines(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}
