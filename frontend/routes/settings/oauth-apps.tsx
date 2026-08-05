import {
	Accordion,
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Card,
	Checkbox,
	Code,
	Divider,
	Drawer,
	Group,
	Loader,
	NumberInput,
	ScrollArea,
	Select,
	SimpleGrid,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	ThemeIcon,
	Title,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconAlertTriangle,
	IconApps,
	IconCheck,
	IconClipboard,
	IconDownload,
	IconEdit,
	IconExternalLink,
	IconInfoCircle,
	IconPlus,
	IconRefresh,
	IconSettings,
	IconTrash,
	IconUpload,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/ConfirmDialogProvider";
import { CopyButton } from "../../components/common/CopyButton";
import { useCurrentUser } from "../../hooks/useAuth";
import { type ApiError, api, type OAuthApp } from "../../lib/api";
import {
	createDefaultOAuthAppPolicy,
	type DeviceOperationLevel,
	OAUTH_APP_AVAILABLE_SCOPES,
	type OAuthAppManifest,
	type OAuthAppMessageDetail,
	type OAuthAppPermissionMode,
	type OAuthAppPolicy,
	type OAuthAppSystemPromptMode,
} from "../../lib/api/oauth-apps";
import { formatLocaleDateTime } from "../../lib/intl-format";
import { APP_VIEWPORT_BOTTOM } from "../../lib/safe-area";

export const Route = createFileRoute("/settings/oauth-apps")({
	component: SettingsOAuthAppsPage,
});

const PERMISSION_MODES = ["readOnly", "dontAsk"] as const;
const DEVICE_OPERATION_LEVELS = ["denied", "readOnly", "readWrite"] as const;
const DEVICE_ACCESS_GROUPS = ["host", "global", "selfRegistered"] as const;
const MESSAGE_DETAIL_LEVELS = ["none", "summary", "full"] as const;

interface ExternalWebSocketSettingsForm {
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
		<Accordion variant="separated" defaultValue={null}>
			<Accordion.Item value="external-websocket">
				<Accordion.Control icon={<IconSettings size={18} />}>
					<Group justify="space-between" pr="sm" wrap="nowrap">
						<Box>
							<Text fw={600}>{t("oauthExternalWebSocketSection")}</Text>
							<Text size="xs" c="dimmed" mt={2}>
								{t("oauthExternalWebSocketAdvancedHint")}
							</Text>
						</Box>
						<Badge color="green" variant="light">
							{t("oauthExternalWebSocketStatusAlwaysOn")}
						</Badge>
					</Group>
				</Accordion.Control>
				<Accordion.Panel>
					<Stack gap="md">
						<Text size="sm" c="dimmed">
							{t("oauthExternalWebSocketDescription")}
						</Text>
						<Alert color="blue" icon={<IconInfoCircle size={18} />}>
							{t("oauthExternalWebSocketInfo")}
						</Alert>
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
				</Accordion.Panel>
			</Accordion.Item>
		</Accordion>
	);
}

function SettingsOAuthAppsPage() {
	const { t } = useTranslation("settings");
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const qc = useQueryClient();
	const confirm = useConfirmDialog();
	const [createOpen, setCreateOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	const [importText, setImportText] = useState("");
	const [importError, setImportError] = useState("");
	const [exportedManifest, setExportedManifest] = useState<OAuthAppManifest | null>(null);
	const [createdApp, setCreatedApp] = useState<OAuthApp | null>(null);
	const [editingApp, setEditingApp] = useState<OAuthApp | null>(null);
	const [editName, setEditName] = useState("");
	const [editRedirectUrisText, setEditRedirectUrisText] = useState("");
	const [editScopes, setEditScopes] = useState<string[]>([]);
	const [editPolicy, setEditPolicy] = useState<OAuthAppPolicy>(createDefaultOAuthAppPolicy);
	const [clientId, setClientId] = useState("");
	const [name, setName] = useState("");
	const [redirectUrisText, setRedirectUrisText] = useState("");
	const [scopes, setScopes] = useState<string[]>([]);
	const [policy, setPolicy] = useState<OAuthAppPolicy>(createDefaultOAuthAppPolicy);
	const [formError, setFormError] = useState("");

	const {
		data: apps,
		isLoading,
		isError,
		error,
		refetch,
	} = useQuery({
		queryKey: ["oauth-apps"],
		queryFn: () => api.listOAuthApps(),
		enabled: isAdmin,
	});

	const activeApps = useMemo(() => apps?.filter((app) => !app.revokedAt) ?? [], [apps]);
	const revokedApps = useMemo(() => apps?.filter((app) => !!app.revokedAt) ?? [], [apps]);

	const resetForm = () => {
		setClientId("");
		setName("");
		setRedirectUrisText("");
		setScopes([]);
		setPolicy(createDefaultOAuthAppPolicy());
		setFormError("");
	};

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
		onError: (err: ApiError) => setFormError(err.message || t("oauthAppsCreateFailed")),
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
		onError: (err: ApiError) => setFormError(err.message || t("oauthAppsUpdateFailed")),
	});

	const importMut = useMutation({
		mutationFn: (manifest: OAuthAppManifest) => api.importOAuthApp(manifest),
		onSuccess: (result) => {
			qc.invalidateQueries({ queryKey: ["oauth-apps"] });
			setImportOpen(false);
			setImportText("");
			setImportError("");
			setCreatedApp(result.client);
			notifications.show({
				color: "green",
				message: result.created ? t("oauthAppsImportCreated") : t("oauthAppsImportUpdated"),
			});
		},
		onError: (err: ApiError) => setImportError(err.message || t("oauthAppsImportFailed")),
	});

	const exportMut = useMutation({
		mutationFn: (id: string) => api.exportOAuthApp(id),
		onSuccess: (manifest) => setExportedManifest(manifest),
		onError: (err: ApiError) =>
			notifications.show({ color: "red", message: err.message || t("oauthAppsExportFailed") }),
	});

	const revokeMut = useMutation({
		mutationFn: (id: string) => api.deleteOAuthApp(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["oauth-apps"] });
			notifications.show({ color: "green", message: t("oauthAppsRevoked") });
		},
		onError: (err: ApiError) =>
			notifications.show({ color: "red", message: err.message || t("oauthAppsRevokeFailed") }),
	});

	if (!user)
		return (
			<Group justify="center" py="xl">
				<Loader />
			</Group>
		);
	if (!isAdmin) return null;
	if (isLoading)
		return (
			<Group justify="center" py="xl">
				<Loader />
			</Group>
		);

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
		if (
			!DEVICE_ACCESS_GROUPS.every((group) =>
				DEVICE_OPERATION_LEVELS.some((level) => level === candidate.deviceAccess[group]),
			)
		) {
			return t("oauthAppsPolicyInvalidDeviceAccess");
		}
		if (!MESSAGE_DETAIL_LEVELS.some((level) => level === candidate.messageDetail)) {
			return t("oauthAppsPolicyInvalidMessageDetail");
		}
		return null;
	};

	const validateForm = (
		formName: string,
		formRedirectUrisText: string,
		formScopes: string[],
		formPolicy: OAuthAppPolicy,
	) => {
		if (!formName.trim()) return t("oauthAppsNameRequired");
		if (splitLines(formRedirectUrisText).length === 0) return t("oauthAppsRedirectRequired");
		if (formScopes.length === 0) return t("oauthAppsScopesRequired");
		return getPolicyError(formPolicy);
	};

	const handleCreate = () => {
		const validationError = validateForm(name, redirectUrisText, scopes, policy);
		setFormError(validationError ?? "");
		if (validationError) return;
		createMut.mutate();
	};

	const handleUpdate = () => {
		const validationError = validateForm(editName, editRedirectUrisText, editScopes, editPolicy);
		setFormError(validationError ?? "");
		if (!editingApp || validationError) return;
		updateMut.mutate(editingApp);
	};

	const handleImport = () => {
		try {
			const parsed = JSON.parse(importText) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error(t("oauthAppsImportInvalidJson"));
			}
			setImportError("");
			importMut.mutate(parsed as OAuthAppManifest);
		} catch (error) {
			setImportError(error instanceof Error ? error.message : t("oauthAppsImportInvalidJson"));
		}
	};

	const openEdit = (app: OAuthApp) => {
		setFormError("");
		setEditingApp(app);
		setEditName(app.name);
		setEditRedirectUrisText(app.redirectUris.join("\n"));
		setEditScopes(app.scopes);
		setEditPolicy({
			...createDefaultOAuthAppPolicy(),
			...app.policy,
			allowedPermissionModes: [...app.policy.allowedPermissionModes],
			deviceAccess: { ...app.policy.deviceAccess },
		});
	};

	const handleRevoke = async (app: OAuthApp) => {
		if (
			await confirm({
				title: t("oauthAppsRevoke"),
				message: t("oauthAppsRevokeConfirm", { name: app.name }),
				confirmLabel: t("oauthAppsRevoke"),
				confirmColor: "red",
			})
		) {
			revokeMut.mutate(app.id);
		}
	};

	return (
		<Stack gap="lg" maw={1100}>
			<Group justify="space-between" align="flex-start" wrap="wrap">
				<Group align="flex-start" gap="sm" wrap="nowrap">
					<ThemeIcon size={42} radius="md" variant="light" color="indigo">
						<IconApps size={23} />
					</ThemeIcon>
					<Box>
						<Title order={3}>{t("oauthAppsSection")}</Title>
						<Text size="sm" c="dimmed" mt={4} maw={720}>
							{t("oauthAppsDescription")}
						</Text>
					</Box>
				</Group>
				<Group gap="xs">
					<Button
						variant="default"
						leftSection={<IconUpload size={16} />}
						onClick={() => {
							setImportError("");
							setImportOpen(true);
						}}
					>
						{t("oauthAppsImport")}
					</Button>
					<Button
						leftSection={<IconPlus size={16} />}
						onClick={() => {
							resetForm();
							setCreateOpen(true);
						}}
					>
						{t("oauthAppsCreate")}
					</Button>
				</Group>
			</Group>

			<SimpleGrid cols={{ base: 1, xs: 3 }} spacing="sm">
				<StatCard label={t("oauthAppsTotal")} value={apps?.length ?? 0} />
				<StatCard label={t("oauthAppsActive")} value={activeApps.length} color="green" />
				<StatCard label={t("oauthAppsRevokedCount")} value={revokedApps.length} color="gray" />
			</SimpleGrid>

			{isError ? (
				<Alert color="red" title={t("oauthAppsLoadFailed")} icon={<IconAlertTriangle size={18} />}>
					<Stack gap="xs">
						<Text size="sm">
							{error instanceof Error ? error.message : t("oauthAppsLoadFailed")}
						</Text>
						<Button
							variant="light"
							size="compact-sm"
							leftSection={<IconRefresh size={15} />}
							onClick={() => void refetch()}
						>
							{t("oauthAppsRetry")}
						</Button>
					</Stack>
				</Alert>
			) : apps && apps.length === 0 ? (
				<Alert color="indigo" variant="light" icon={<IconApps size={18} />}>
					<Stack gap="xs">
						<Text>{t("oauthAppsEmpty")}</Text>
						<Button
							size="compact-sm"
							variant="light"
							leftSection={<IconPlus size={15} />}
							onClick={() => {
								resetForm();
								setCreateOpen(true);
							}}
						>
							{t("oauthAppsCreate")}
						</Button>
					</Stack>
				</Alert>
			) : (
				<Stack gap="sm">
					{apps?.map((app) => (
						<OAuthAppCard
							key={app.id}
							app={app}
							t={t}
							onEdit={() => openEdit(app)}
							onExport={() => exportMut.mutate(app.id)}
							onRevoke={() => void handleRevoke(app)}
							exporting={exportMut.isPending && exportMut.variables === app.id}
							busy={revokeMut.isPending && revokeMut.variables === app.id}
						/>
					))}
				</Stack>
			)}

			<ExternalWebSocketSettingsSection />

			<Drawer
				opened={importOpen}
				onClose={() => setImportOpen(false)}
				title={t("oauthAppsImport")}
				position="right"
				size="min(100%, 560px)"
				overlayProps={{ backgroundOpacity: 0.45, blur: 2 }}
			>
				<Stack>
					<Text size="sm" c="dimmed">
						{t("oauthAppsImportDescription")}
					</Text>
					{importError && <Alert color="red">{importError}</Alert>}
					<Textarea
						label={t("oauthAppsImportJson")}
						value={importText}
						onChange={(event) => setImportText(event.currentTarget.value)}
						minRows={18}
						autosize
						styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
					/>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setImportOpen(false)}>
							{t("cancel", { ns: "common", defaultValue: "Cancel" })}
						</Button>
						<Button
							leftSection={<IconUpload size={16} />}
							loading={importMut.isPending}
							onClick={handleImport}
						>
							{t("oauthAppsImport")}
						</Button>
					</Group>
				</Stack>
			</Drawer>

			<Drawer
				opened={!!exportedManifest}
				onClose={() => setExportedManifest(null)}
				title={t("oauthAppsExport")}
				position="right"
				size="min(100%, 560px)"
				overlayProps={{ backgroundOpacity: 0.45, blur: 2 }}
			>
				{exportedManifest && (
					<Stack>
						<Text size="sm" c="dimmed">
							{t("oauthAppsExportDescription")}
						</Text>
						<Textarea
							value={JSON.stringify(exportedManifest, null, 2)}
							readOnly
							minRows={18}
							autosize
							styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
						/>
						<Group justify="flex-end">
							<CopyButton value={JSON.stringify(exportedManifest, null, 2)} timeout={1500}>
								{({ copied, copy }) => (
									<Button
										variant="default"
										leftSection={<IconClipboard size={16} />}
										onClick={copy}
									>
										{copied ? t("oauthAppsCopied") : t("oauthAppsCopyJson")}
									</Button>
								)}
							</CopyButton>
							<Button
								leftSection={<IconDownload size={16} />}
								onClick={() => downloadOAuthAppManifest(exportedManifest)}
							>
								{t("oauthAppsDownloadJson")}
							</Button>
						</Group>
					</Stack>
				)}
			</Drawer>

			<Drawer
				opened={createOpen}
				onClose={() => setCreateOpen(false)}
				title={t("oauthAppsCreate")}
				position="right"
				size="min(100%, 560px)"
				overlayProps={{ backgroundOpacity: 0.45, blur: 2 }}
			>
				<OAuthAppForm
					mode="create"
					clientId={clientId}
					name={name}
					redirectUrisText={redirectUrisText}
					scopes={scopes}
					policy={policy}
					formError={formError}
					loading={createMut.isPending}
					onClientIdChange={setClientId}
					onNameChange={setName}
					onRedirectUrisChange={setRedirectUrisText}
					onScopesChange={setScopes}
					onPolicyChange={setPolicy}
					onSubmit={handleCreate}
					onCancel={() => setCreateOpen(false)}
				/>
			</Drawer>

			<Drawer
				opened={!!editingApp}
				onClose={() => setEditingApp(null)}
				title={t("oauthAppsEdit")}
				position="right"
				size="min(100%, 560px)"
				overlayProps={{ backgroundOpacity: 0.45, blur: 2 }}
			>
				<OAuthAppForm
					mode="edit"
					clientId={editingApp?.clientId ?? ""}
					name={editName}
					redirectUrisText={editRedirectUrisText}
					scopes={editScopes}
					policy={editPolicy}
					formError={formError}
					loading={updateMut.isPending}
					onNameChange={setEditName}
					onRedirectUrisChange={setEditRedirectUrisText}
					onScopesChange={setEditScopes}
					onPolicyChange={setEditPolicy}
					onSubmit={handleUpdate}
					onCancel={() => setEditingApp(null)}
				/>
			</Drawer>

			<Drawer
				opened={!!createdApp}
				onClose={() => setCreatedApp(null)}
				title={t("oauthAppsCreatedTitle")}
				position="right"
				size="min(100%, 460px)"
				overlayProps={{ backgroundOpacity: 0.45, blur: 2 }}
			>
				{createdApp && (
					<Stack>
						<Alert color="green" icon={<IconCheck size={18} />}>
							{t("oauthAppsCreatedHint")}
						</Alert>
						<Text fw={600}>{createdApp.name}</Text>
						<CopyableValue value={createdApp.clientId} label={t("oauthAppsClientId")} t={t} />
						<Button onClick={() => setCreatedApp(null)}>
							{t("close", { ns: "common", defaultValue: "Close" })}
						</Button>
					</Stack>
				)}
			</Drawer>
		</Stack>
	);
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
	return (
		<Card withBorder padding="md">
			<Text size="xs" c="dimmed" fw={600} tt="uppercase">
				{label}
			</Text>
			<Text size="xl" fw={700} c={color} mt={4}>
				{value}
			</Text>
		</Card>
	);
}

function OAuthAppCard({
	app,
	t,
	onEdit,
	onExport,
	onRevoke,
	exporting,
	busy,
}: {
	app: OAuthApp;
	t: (key: string, options?: Record<string, unknown>) => string;
	onEdit: () => void;
	onExport: () => void;
	onRevoke: () => void;
	exporting: boolean;
	busy: boolean;
}) {
	const revoked = !!app.revokedAt;
	return (
		<Card withBorder padding="lg" radius="md">
			<Stack gap="md">
				<Group justify="space-between" align="flex-start" wrap="wrap">
					<Group align="flex-start" gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
						<ThemeIcon size={38} radius="md" variant="light" color={revoked ? "gray" : "indigo"}>
							<IconApps size={20} />
						</ThemeIcon>
						<Box style={{ minWidth: 0 }}>
							<Group gap="xs" wrap="wrap">
								<Text fw={650} style={{ overflowWrap: "anywhere" }}>
									{app.name}
								</Text>
								<Badge color={revoked ? "gray" : "green"} variant="light">
									{revoked ? t("oauthAppsStatusRevoked") : t("oauthAppsStatusActive")}
								</Badge>
							</Group>
							<Text size="xs" c="dimmed" mt={3}>
								{t("oauthAppsPublicClient")}
							</Text>
						</Box>
					</Group>
					<Group gap="xs">
						<Button
							size="compact-sm"
							variant="light"
							leftSection={<IconEdit size={14} />}
							onClick={onEdit}
						>
							{t("oauthAppsEdit")}
						</Button>
						{!revoked && (
							<Button
								size="compact-sm"
								variant="light"
								leftSection={<IconDownload size={14} />}
								loading={exporting}
								onClick={onExport}
							>
								{t("oauthAppsExport")}
							</Button>
						)}
						{!revoked && (
							<Button
								size="compact-sm"
								color="red"
								variant="light"
								leftSection={<IconTrash size={14} />}
								loading={busy}
								onClick={onRevoke}
							>
								{t("oauthAppsRevoke")}
							</Button>
						)}
					</Group>
				</Group>

				<CopyableValue value={app.clientId} label={t("oauthAppsClientId")} t={t} />

				<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
					<SummaryField label={t("oauthAppsRedirectUris")}>
						<Stack gap={4}>
							{app.redirectUris.map((uri) => (
								<Group key={uri} gap={4} wrap="nowrap" align="flex-start">
									<IconExternalLink size={13} color="var(--mantine-color-dimmed)" />
									<Text size="xs" style={{ overflowWrap: "anywhere" }}>
										{uri}
									</Text>
								</Group>
							))}
						</Stack>
					</SummaryField>
					<SummaryField label={t("oauthAppsScopes")}>
						<Group gap={5}>
							{app.scopes.map((scope) => (
								<Tooltip key={scope} label={scope} withArrow>
									<Badge size="sm" variant="light">
										{scopeLabel(scope, t)}
									</Badge>
								</Tooltip>
							))}
						</Group>
					</SummaryField>
				</SimpleGrid>

				<Divider />
				<SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
					<SummaryField label={t("oauthAppsPolicySection")}>
						<PolicySummary policy={app.policy} t={t} />
					</SummaryField>
					<SummaryField
						label={t("oauthAppsCreatedAt")}
						value={formatLocaleDateTime(app.createdAt)}
					/>
					<SummaryField
						label={t("connectedAppsLastUsedAt")}
						value={
							app.lastUsedAt ? formatLocaleDateTime(app.lastUsedAt) : t("connectedAppsNeverUsed")
						}
					/>
					{revoked && (
						<SummaryField
							label={t("oauthAppsRevokedAt")}
							value={formatLocaleDateTime(app.revokedAt ?? "")}
						/>
					)}
				</SimpleGrid>
			</Stack>
		</Card>
	);
}

function CopyableValue({
	value,
	label,
	t,
}: {
	value: string;
	label: string;
	t: (key: string, options?: Record<string, unknown>) => string;
}) {
	return (
		<Box>
			<Text size="xs" c="dimmed" mb={4}>
				{label}
			</Text>
			<Group gap="xs" wrap="nowrap" align="flex-start">
				<Code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", whiteSpace: "normal" }}>
					{value}
				</Code>
				<CopyButton value={value} timeout={1500}>
					{({ copied, copy }) => (
						<Tooltip label={copied ? t("oauthAppsCopied") : t("oauthAppsCopyClientId")} withArrow>
							<ActionIcon
								variant="light"
								color={copied ? "green" : "indigo"}
								onClick={copy}
								aria-label={label}
							>
								{copied ? <IconCheck size={16} /> : <IconClipboard size={16} />}
							</ActionIcon>
						</Tooltip>
					)}
				</CopyButton>
			</Group>
		</Box>
	);
}

function SummaryField({
	label,
	value,
	children,
}: {
	label: string;
	value?: string;
	children?: ReactNode;
}) {
	return (
		<Box>
			<Text size="xs" c="dimmed" mb={4}>
				{label}
			</Text>
			{children ?? (
				<Text size="sm" style={{ overflowWrap: "anywhere" }}>
					{value || "—"}
				</Text>
			)}
		</Box>
	);
}

function OAuthAppForm({
	mode,
	clientId,
	name,
	redirectUrisText,
	scopes,
	policy,
	formError,
	loading,
	onClientIdChange,
	onNameChange,
	onRedirectUrisChange,
	onScopesChange,
	onPolicyChange,
	onSubmit,
	onCancel,
}: {
	mode: "create" | "edit";
	clientId: string;
	name: string;
	redirectUrisText: string;
	scopes: string[];
	policy: OAuthAppPolicy;
	formError: string;
	loading: boolean;
	onClientIdChange?: (value: string) => void;
	onNameChange: (value: string) => void;
	onRedirectUrisChange: (value: string) => void;
	onScopesChange: (value: string[]) => void;
	onPolicyChange: (value: OAuthAppPolicy) => void;
	onSubmit: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation("settings");
	return (
		<Stack h={`calc(${APP_VIEWPORT_BOTTOM} - 90px)`} gap={0}>
			<ScrollArea flex={1} offsetScrollbars>
				<Stack gap="md" pb="lg" pr="xs">
					{formError && (
						<Alert color="red" icon={<IconAlertTriangle size={18} />}>
							{formError}
						</Alert>
					)}
					<Accordion multiple defaultValue={["basic", "scopes"]} variant="contained">
						<Accordion.Item value="basic">
							<Accordion.Control>{t("oauthAppsFormBasic")}</Accordion.Control>
							<Accordion.Panel>
								<Stack>
									{mode === "create" ? (
										<TextInput
											label={t("oauthAppsClientId")}
											description={t("oauthAppsClientIdHint")}
											value={clientId}
											onChange={(event) => onClientIdChange?.(event.currentTarget.value)}
										/>
									) : (
										<Box>
											<Text size="xs" c="dimmed" mb={4}>
												{t("oauthAppsClientId")}
											</Text>
											<Code style={{ display: "block", overflowWrap: "anywhere" }}>{clientId}</Code>
										</Box>
									)}
									<TextInput
										label={t("oauthAppsName")}
										value={name}
										onChange={(event) => onNameChange(event.currentTarget.value)}
										required
									/>
									<Textarea
										label={t("oauthAppsRedirectUris")}
										description={t("oauthAppsRedirectUrisHint")}
										value={redirectUrisText}
										onChange={(event) => onRedirectUrisChange(event.currentTarget.value)}
										minRows={3}
										autosize
										required
									/>
								</Stack>
							</Accordion.Panel>
						</Accordion.Item>
						<Accordion.Item value="scopes">
							<Accordion.Control>{t("oauthAppsScopes")}</Accordion.Control>
							<Accordion.Panel>
								<Stack gap="xs">
									<Text size="xs" c="dimmed">
										{t("oauthAppsScopesHint")}
									</Text>
									{OAUTH_APP_AVAILABLE_SCOPES.map((scope) => (
										<Checkbox
											key={scope}
											label={scopeLabel(scope, t)}
											description={scope}
											checked={scopes.includes(scope)}
											onChange={() =>
												onScopesChange(
													scopes.includes(scope)
														? scopes.filter((item) => item !== scope)
														: [...scopes, scope],
												)
											}
										/>
									))}
								</Stack>
							</Accordion.Panel>
						</Accordion.Item>
						<Accordion.Item value="policy">
							<Accordion.Control>{t("oauthAppsPolicySection")}</Accordion.Control>
							<Accordion.Panel>
								<PolicyFields policy={policy} onChange={onPolicyChange} />
							</Accordion.Panel>
						</Accordion.Item>
					</Accordion>
				</Stack>
			</ScrollArea>
			<Group
				justify="flex-end"
				gap="xs"
				pt="md"
				mt="md"
				style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
			>
				<Button variant="default" onClick={onCancel}>
					{t("cancel", { ns: "common", defaultValue: "Cancel" })}
				</Button>
				<Button onClick={onSubmit} loading={loading}>
					{mode === "create" ? t("oauthAppsCreate") : t("oauthAppsSave")}
				</Button>
			</Group>
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
	const deviceAccessGroupLabel = (group: (typeof DEVICE_ACCESS_GROUPS)[number]) =>
		t(`oauthAppsPolicyDeviceAccess${group[0].toUpperCase()}${group.slice(1)}`);
	const deviceOperationLevelLabel = (level: DeviceOperationLevel) =>
		t(`oauthAppsPolicyDeviceAccessLevel${level[0].toUpperCase()}${level.slice(1)}`);
	const messageDetailLabel = (level: OAuthAppMessageDetail) =>
		t(`oauthAppsPolicyMessageDetail${level[0].toUpperCase()}${level.slice(1)}`);
	const messageDetailDescription = (level: OAuthAppMessageDetail) =>
		t(`oauthAppsPolicyMessageDetail${level[0].toUpperCase()}${level.slice(1)}Desc`);
	const updateDeviceAccess = (
		group: (typeof DEVICE_ACCESS_GROUPS)[number],
		value: string | null,
	) => {
		if (!value) return;
		onChange({
			...policy,
			deviceAccess: { ...policy.deviceAccess, [group]: value as DeviceOperationLevel },
		});
	};
	return (
		<Stack gap="sm">
			<Group justify="flex-end">
				<Button
					size="compact-xs"
					variant="subtle"
					onClick={() => onChange(createDefaultOAuthAppPolicy())}
				>
					{t("oauthAppsPolicyRestoreDefaults")}
				</Button>
			</Group>
			<Text size="xs" c="dimmed">
				{t("oauthAppsPolicyDescription")}
			</Text>
			<Select
				label={t("oauthAppsPolicyDefaultPermissionMode")}
				description={t("oauthAppsPolicyDefaultPermissionModeDesc")}
				value={policy.defaultPermissionMode}
				data={PERMISSION_MODES.map((mode) => ({ value: mode, label: permissionModeLabel(mode) }))}
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
						onChange={(event) =>
							onChange({
								...policy,
								allowedPermissionModes: event.currentTarget.checked
									? [...new Set([...policy.allowedPermissionModes, mode])]
									: policy.allowedPermissionModes.filter((allowed) => allowed !== mode),
							})
						}
					/>
				))}
			</Stack>
			<Select
				label={t("oauthAppsPolicySystemPromptMode")}
				description={t("oauthAppsPolicySystemPromptModeDesc")}
				value={policy.systemPromptMode}
				data={[
					{ value: "managed", label: t("oauthAppsPolicySystemPromptModeManaged") },
					{ value: "append", label: t("oauthAppsPolicySystemPromptModeAppend") },
				]}
				onChange={(value) =>
					value && onChange({ ...policy, systemPromptMode: value as OAuthAppSystemPromptMode })
				}
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
			<Select
				label={t("oauthAppsPolicyMessageDetail")}
				description={t("oauthAppsPolicyMessageDetailDesc")}
				value={policy.messageDetail}
				data={MESSAGE_DETAIL_LEVELS.map((level) => ({
					value: level,
					label: messageDetailLabel(level),
				}))}
				onChange={(value) =>
					value && onChange({ ...policy, messageDetail: value as OAuthAppMessageDetail })
				}
				allowDeselect={false}
			/>
			<Text size="xs" c={policy.messageDetail === "full" ? "orange" : "dimmed"} mt={-8}>
				{messageDetailDescription(policy.messageDetail)}
			</Text>
			<Alert
				color="red"
				variant="light"
				icon={<IconAlertTriangle size={18} />}
				title={t("oauthAppsPolicyDeviceAccessTitle")}
			>
				<Stack gap="sm">
					<Text size="xs">{t("oauthAppsPolicyDeviceAccessDesc")}</Text>
					{DEVICE_ACCESS_GROUPS.map((group) => (
						<Select
							key={group}
							label={deviceAccessGroupLabel(group)}
							value={policy.deviceAccess[group]}
							data={DEVICE_OPERATION_LEVELS.map((level) => ({
								value: level,
								label: deviceOperationLevelLabel(level),
							}))}
							onChange={(value) => updateDeviceAccess(group, value)}
							allowDeselect={false}
						/>
					))}
				</Stack>
			</Alert>
		</Stack>
	);
}

function PolicySummary({
	policy,
	t,
}: {
	policy: OAuthAppPolicy;
	t: (key: string, options?: Record<string, unknown>) => string;
}) {
	const permissionModeLabel = (mode: OAuthAppPermissionMode) =>
		mode === "readOnly"
			? t("oauthAppsPolicyPermissionModeReadOnly")
			: t("oauthAppsPolicyPermissionModeDontAsk");
	const systemPromptLabel =
		policy.systemPromptMode === "managed"
			? t("oauthAppsPolicySystemPromptModeManaged")
			: t("oauthAppsPolicySystemPromptModeAppend");
	const deviceAccessGroupLabel = (group: (typeof DEVICE_ACCESS_GROUPS)[number]) =>
		t(`oauthAppsPolicyDeviceAccess${group[0].toUpperCase()}${group.slice(1)}`);
	const deviceOperationLevelLabel = (level: DeviceOperationLevel) =>
		t(`oauthAppsPolicyDeviceAccessLevel${level[0].toUpperCase()}${level.slice(1)}`);
	const messageDetailLabel = (level: OAuthAppMessageDetail) =>
		t(`oauthAppsPolicyMessageDetail${level[0].toUpperCase()}${level.slice(1)}`);
	return (
		<Stack gap={4}>
			<Text size="xs">{permissionModeLabel(policy.defaultPermissionMode)}</Text>
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
			<Group gap={4}>
				{DEVICE_ACCESS_GROUPS.map((group) => {
					const level = policy.deviceAccess[group];
					return (
						<Badge
							key={group}
							size="xs"
							color={level === "readWrite" ? "red" : level === "readOnly" ? "yellow" : "gray"}
							variant="light"
						>
							{deviceAccessGroupLabel(group)} · {deviceOperationLevelLabel(level)}
						</Badge>
					);
				})}
				<Badge
					size="xs"
					color={
						policy.messageDetail === "full"
							? "red"
							: policy.messageDetail === "summary"
								? "yellow"
								: "gray"
					}
					variant="light"
				>
					{t("oauthAppsPolicyMessageDetail")} · {messageDetailLabel(policy.messageDetail)}
				</Badge>
			</Group>
		</Stack>
	);
}

function scopeLabel(scope: string, t: (key: string, options?: Record<string, unknown>) => string) {
	const keyByScope: Record<string, string> = {
		"project.read": "oauthAppsScopeProjectRead",
		"device.read": "oauthAppsScopeDeviceRead",
		"device.provision": "oauthAppsScopeDeviceProvision",
		"device.rotate": "oauthAppsScopeDeviceRotate",
		"narrator.read": "oauthAppsScopeNarratorRead",
		"event.subscribe": "oauthAppsScopeEventSubscribe",
		"narrator.provision": "oauthAppsScopeNarratorProvision",
		"narrator.send_message": "oauthAppsScopeNarratorMessage",
		"narrator.interrupt": "oauthAppsScopeNarratorInterrupt",
		"message.summary.read": "oauthAppsScopeMessageSummaryRead",
		"message.content.read": "oauthAppsScopeMessageContentRead",
	};
	const key = keyByScope[scope];
	return key ? t(key) : scope;
}

function splitLines(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function downloadOAuthAppManifest(manifest: OAuthAppManifest): void {
	const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = `${manifest.clientId.replace(/[^A-Za-z0-9._-]+/g, "-") || "oauth-client"}.json`;
	anchor.click();
	URL.revokeObjectURL(url);
}
