import {
	Alert,
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Paper,
	Select,
	Stack,
	Text,
} from "@mantine/core";
import { providerSettingsFieldVisibility } from "@shared/provider-settings";
import {
	IconAlertTriangle,
	IconCheck,
	IconExternalLink,
	IconPlayerPlay,
	IconRefresh,
	IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { usePluginProviderConfig } from "../../hooks/usePlugins";
import { ApiError } from "../../lib/api/client";
import {
	type ProviderSettingsExtensionView,
	type ProviderSettingsTarget,
	providerSettingsApi,
	providerSettingsKeys,
} from "../../lib/api/provider-settings";
import { useConfirmDialog } from "../common/confirm-dialog-context";
import type { JsonValue } from "../plugins-admin/config-schema";
import { PluginConfigForm } from "../plugins-admin/PluginConfigForm";
import {
	buildProviderSettingsSave,
	localizedContributionCaptions,
	localizeProviderSettingsSchema,
	providerSettingsConfigViewForForm,
	providerSettingsLocale,
} from "./provider-settings-form";

interface PluginProviderIdentity {
	pluginId: string;
	contributionId: string;
	providerInstanceId?: string;
}

export interface ProviderSettingsExtensionsProps {
	target?: ProviderSettingsTarget;
	pluginProvider?: PluginProviderIdentity;
	coreDirty?: boolean;
}

function isFullConfig(config: ProviderSettingsExtensionView["config"]): config is NonNullable<
	ProviderSettingsExtensionView["config"]
> & {
	schemaFingerprint: string;
	bindingRevision: string;
	secrets: Record<string, { isSet: boolean }>;
	values: Record<string, string | number | boolean>;
} {
	return Boolean(
		config && "schemaFingerprint" in config && "bindingRevision" in config && "secrets" in config,
	);
}

function statusColor(status: string | undefined): string {
	switch (status) {
		case "ready":
			return "green";
		case "dormant":
			return "yellow";
		case "schema-mismatch":
		case "binding-changed":
			return "red";
		default:
			return "gray";
	}
}

function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof ApiError) {
		const code = typeof error.data?.code === "string" ? error.data.code : undefined;
		if (code) return `${fallback} (${code})`;
		return error.message || fallback;
	}
	return error instanceof Error ? error.message : fallback;
}

export function ProviderSettingsExtensions({
	target,
	pluginProvider,
	coreDirty = false,
}: ProviderSettingsExtensionsProps) {
	const { t, i18n } = useTranslation("plugins");
	const { data: user } = useCurrentUser();
	const queryClient = useQueryClient();
	const confirm = useConfirmDialog();
	const locale = providerSettingsLocale(i18n.resolvedLanguage);
	const [error, setError] = useState<string>();

	// The existing executable-provider config endpoint is the authoritative source for the
	// registered instance id. Never substitute the user-editable prefix for this identity.
	const providerConfigQuery = usePluginProviderConfig(pluginProvider?.pluginId ?? "", {
		enabled: Boolean(
			pluginProvider && user?.role === "admin" && !coreDirty && !pluginProvider.providerInstanceId,
		),
	});
	const resolvedTarget = useMemo<ProviderSettingsTarget | undefined>(() => {
		if (target) return target;
		if (!pluginProvider) return undefined;
		const instanceId =
			pluginProvider.providerInstanceId ??
			providerConfigQuery.data?.providers.find(
				(provider) => provider.contributionId === pluginProvider.contributionId,
			)?.providerInstanceId;
		return instanceId ? { kind: "executable-plugin", id: instanceId } : undefined;
	}, [pluginProvider, providerConfigQuery.data, target]);

	const listQuery = useQuery({
		queryKey: resolvedTarget
			? providerSettingsKeys.list(resolvedTarget)
			: ["provider-settings", "pending"],
		queryFn: ({ signal }) =>
			providerSettingsApi.list(resolvedTarget as ProviderSettingsTarget, { signal }),
		enabled: Boolean(resolvedTarget),
		staleTime: 30_000,
		gcTime: 60_000,
		retry: false,
	});

	if (!resolvedTarget && pluginProvider) return null;
	if (!resolvedTarget) return null;
	if (listQuery.isError) {
		return (
			<Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />}>
				{errorMessage(listQuery.error, t("providerSettings.loadError"))}
			</Alert>
		);
	}
	if (listQuery.isLoading || !listQuery.data?.extensions.length) return null;

	const isAdmin = user?.role === "admin";
	const canWriteTarget = isAdmin && !coreDirty;
	const targetKey = `${resolvedTarget.kind}:${resolvedTarget.id}`;

	return (
		<Stack gap="md" data-testid="provider-settings-extensions">
			<Divider />
			<Stack gap={4}>
				<Text fw={500} size="sm">
					{t("providerSettings.title")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("providerSettings.description")}
				</Text>
			</Stack>
			{coreDirty && (
				<Alert color="yellow" variant="light">
					{t("providerSettings.unsavedCore")}
				</Alert>
			)}
			{listQuery.data.extensions.map((extension) => (
				<ProviderSettingsExtension
					key={`${targetKey}:${extension.pluginId}:${extension.contributionId}`}
					extension={extension}
					target={resolvedTarget}
					locale={locale}
					canWrite={canWriteTarget}
					isAdmin={isAdmin}
					queryKey={providerSettingsKeys.list(resolvedTarget)}
					onError={setError}
					error={error}
					confirm={confirm}
					queryClient={queryClient}
				/>
			))}
		</Stack>
	);
}

function ProviderSettingsExtension({
	extension,
	target,
	locale,
	canWrite,
	isAdmin,
	queryKey,
	onError,
	error,
	confirm,
	queryClient,
}: {
	extension: ProviderSettingsExtensionView;
	target: ProviderSettingsTarget;
	locale: "en" | "zh-CN";
	canWrite: boolean;
	isAdmin: boolean;
	queryKey: readonly unknown[];
	onError: (message: string | undefined) => void;
	error?: string;
	confirm: ReturnType<typeof useConfirmDialog>;
	queryClient: ReturnType<typeof useQueryClient>;
}) {
	const { t } = useTranslation("plugins");
	const [actionText, setActionText] = useState<string>();
	const [draftDirty, setDraftDirty] = useState(false);
	const adminConfig =
		isAdmin && extension.declaration && isFullConfig(extension.config)
			? extension.config
			: undefined;
	const disabled =
		extension.unavailable ||
		extension.pluginState !== "enabled" ||
		extension.compatible === false ||
		extension.target?.disabled ||
		extension.target?.available === false;
	const readOnly = !canWrite || disabled || !adminConfig || !extension.declaration;
	const captions = extension.declaration
		? localizedContributionCaptions(extension.declaration, locale)
		: { title: extension.title ?? extension.contributionId };
	const status = adminConfig?.status ?? extension.config?.status;
	const [showRetained, setShowRetained] = useState(false);
	const [retainedCursor, setRetainedCursor] = useState<string>();
	const [retainedId, setRetainedId] = useState<string | null>(null);
	const retainedKey = [
		...queryKey,
		extension.pluginId,
		extension.contributionId,
		"retained",
		retainedCursor,
	] as const;
	const retainedQuery = useQuery({
		queryKey: retainedKey,
		queryFn: () =>
			providerSettingsApi.retained(
				target,
				extension.pluginId,
				extension.contributionId,
				retainedCursor,
			),
		enabled: showRetained && canWrite && !!adminConfig,
		retry: false,
	});
	const retained = retainedQuery.data?.items.find((item) => item.targetId === retainedId);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const confirmationKey = JSON.stringify([
		canWrite,
		draftDirty,
		adminConfig?.revision,
		adminConfig?.bindingRevision,
		adminConfig?.schemaFingerprint,
		retainedId,
		retained?.revision,
	]);
	const writeGuard = useRef({ key: confirmationKey, allowed: canWrite });
	if (writeGuard.current.key !== confirmationKey)
		writeGuard.current = { key: confirmationKey, allowed: canWrite };
	const assertConfirmation = (guard: typeof writeGuard.current) => {
		if (!alive.current || guard !== writeGuard.current || !guard.allowed)
			throw Error(t("providerSettings.unsavedCore"));
	};
	const moveMutation = useMutation({
		mutationFn: (guard: typeof writeGuard.current) => {
			assertConfirmation(guard);
			if (!retained || !adminConfig) throw Error(t("providerSettings.retainedSelect"));
			return providerSettingsApi.rebind(target, extension.pluginId, extension.contributionId, {
				expectedRevision: adminConfig.revision,
				schemaFingerprint: adminConfig.schemaFingerprint,
				expectedBindingRevision: adminConfig.bindingRevision,
				source: { targetId: retained.targetId, expectedRevision: retained.revision },
			});
		},
		onSuccess: () => {
			setShowRetained(false);
			setRetainedId(null);
			void queryClient.invalidateQueries({ queryKey });
		},
		onError: (caught) => onError(errorMessage(caught, t("providerSettings.rebindError"))),
	});
	const handleMove = async () => {
		if (!retained || !canWrite || draftDirty) return;
		const guard = writeGuard.current;
		if (
			await confirm({
				title: t("providerSettings.rebindTitle"),
				message: t("providerSettings.moveMessage", {
					source: retained.targetId,
					target: target.id,
				}),
				confirmLabel: t("providerSettings.rebind"),
			})
		)
			if (alive.current && guard === writeGuard.current && guard.allowed)
				moveMutation.mutate(guard);
	};

	const saveMutation = useMutation({
		mutationFn: (submitted: Record<string, JsonValue>) => {
			if (!adminConfig || !extension.declaration)
				throw new Error("Provider settings schema unavailable");
			return providerSettingsApi.save(
				target,
				extension.pluginId,
				extension.contributionId,
				buildProviderSettingsSave(extension.declaration, adminConfig, submitted),
			);
		},
		onSuccess: () => {
			onError(undefined);
			void queryClient.invalidateQueries({ queryKey });
		},
		onError: (caught) => onError(errorMessage(caught, t("providerSettings.saveError"))),
	});
	const deleteMutation = useMutation({
		mutationFn: (guard: typeof writeGuard.current) => {
			assertConfirmation(guard);
			return providerSettingsApi.remove(
				target,
				extension.pluginId,
				extension.contributionId,
				adminConfig?.revision ?? 0,
			);
		},
		onSuccess: () => void queryClient.invalidateQueries({ queryKey }),
		onError: (caught) => onError(errorMessage(caught, t("providerSettings.deleteError"))),
	});
	const actionMutation = useMutation({
		mutationFn: () =>
			providerSettingsApi.action(target, extension.pluginId, extension.contributionId),
		onSuccess: (result) => setActionText(result.text),
		onError: (caught) => onError(errorMessage(caught, t("providerSettings.actionError"))),
	});
	const rebindMutation = useMutation({
		mutationFn: (guard: typeof writeGuard.current) => {
			assertConfirmation(guard);
			if (!adminConfig) throw new Error("Provider settings binding unavailable");
			return providerSettingsApi.rebind(target, extension.pluginId, extension.contributionId, {
				expectedRevision: adminConfig.revision,
				schemaFingerprint: adminConfig.schemaFingerprint,
				expectedBindingRevision: adminConfig.bindingRevision,
			});
		},
		onSuccess: () => void queryClient.invalidateQueries({ queryKey }),
		onError: (caught) => onError(errorMessage(caught, t("providerSettings.rebindError"))),
	});

	const handleDelete = async () => {
		if (!adminConfig || !canWrite) return;
		const guard = writeGuard.current;
		const confirmed = await confirm({
			title: t("providerSettings.deleteTitle"),
			message: t("providerSettings.deleteMessage"),
			confirmLabel: t("providerSettings.delete"),
			confirmColor: "red",
		});
		if (confirmed && alive.current && guard === writeGuard.current && guard.allowed)
			deleteMutation.mutate(guard);
	};
	const handleRebind = async () => {
		if (!adminConfig || !canWrite) return;
		const guard = writeGuard.current;
		const confirmed = await confirm({
			title: t("providerSettings.rebindTitle"),
			message: t("providerSettings.rebindMessage"),
			confirmLabel: t("providerSettings.rebind"),
		});
		if (confirmed && alive.current && guard === writeGuard.current && guard.allowed)
			rebindMutation.mutate(guard);
	};

	return (
		<Paper
			withBorder
			p="md"
			radius="sm"
			data-testid={`provider-settings-${extension.contributionId}`}
		>
			<Stack gap="sm">
				<Group justify="space-between" align="flex-start" wrap="wrap">
					<Box>
						<Text fw={600}>{captions.title}</Text>
						{captions.description ? (
							<Text size="xs" c="dimmed">
								{captions.description}
							</Text>
						) : null}
					</Box>
					<Group gap="xs">
						<Badge variant="light" color="gray">
							{extension.pluginId}
						</Badge>
						{status ? (
							<Badge variant="light" color={statusColor(status)}>
								{t(`providerSettings.status.${status}`)}
							</Badge>
						) : null}
					</Group>
				</Group>

				{extension.unavailable ? (
					<Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />}>
						{t("providerSettings.unavailable")}
					</Alert>
				) : null}
				{disabled && !extension.unavailable ? (
					<Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />}>
						{t("providerSettings.readOnly")}
					</Alert>
				) : null}
				{status === "schema-mismatch" ? (
					<Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />}>
						{t("providerSettings.schemaMismatch")}
					</Alert>
				) : null}
				{status === "binding-changed" ? (
					<Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />}>
						{t("providerSettings.bindingChanged")}
					</Alert>
				) : null}
				{status === "dormant" ? (
					<Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />}>
						{t("providerSettings.dormant")}
					</Alert>
				) : null}

				{adminConfig && extension.declaration ? (
					<PluginConfigForm
						schema={localizeProviderSettingsSchema(extension.declaration, locale)}
						view={providerSettingsConfigViewForForm(extension.declaration, adminConfig)}
						disabled={readOnly || status === "dormant" || status === "schema-mismatch"}
						submitting={saveMutation.isPending}
						onDirtyChange={setDraftDirty}
						resetKey={adminConfig.revision}
						submitError={
							(saveMutation.error &&
								errorMessage(saveMutation.error, t("providerSettings.saveError"))) ||
							error
						}
						onSubmit={(submitted) => saveMutation.mutate(submitted)}
					/>
				) : extension.config?.values ? (
					<Stack gap={4}>
						{Object.entries(extension.config.values)
							.filter(([name]) => {
								const field = extension.declaration?.configSchema.properties[name];
								return (
									!extension.declaration ||
									(field && providerSettingsFieldVisibility(field) === "public")
								);
							})
							.map(([name, value]) => (
								<Group key={name} justify="space-between" gap="md" wrap="nowrap">
									<Text size="sm" c="dimmed">
										{name}
									</Text>
									<Text size="sm" ta="right">
										{String(value)}
									</Text>
								</Group>
							))}
					</Stack>
				) : null}

				{canWrite && adminConfig ? (
					<Stack gap="xs">
						<Button
							variant="subtle"
							size="compact-xs"
							onClick={() => setShowRetained((value) => !value)}
						>
							{t("providerSettings.retained")}
						</Button>
						{showRetained ? (
							<>
								{retainedQuery.isError ? (
									<Alert color="red">{t("providerSettings.loadError")}</Alert>
								) : null}
								<Select
									label={t("providerSettings.retainedSelect")}
									data={(retainedQuery.data?.items ?? []).map((item) => ({
										value: item.targetId,
										label: item.targetId,
									}))}
									value={retainedId}
									onChange={setRetainedId}
									searchable
									clearable
									disabled={retainedQuery.isFetching || moveMutation.isPending}
									nothingFoundMessage={t("providerSettings.retainedEmpty")}
								/>
								<Group>
									<Button
										size="compact-xs"
										loading={moveMutation.isPending}
										disabled={!retained || draftDirty || saveMutation.isPending}
										onClick={() => void handleMove()}
									>
										{t("providerSettings.rebind")}
									</Button>
									{retainedQuery.data?.nextCursor ? (
										<Button
											size="compact-xs"
											variant="subtle"
											onClick={() => {
												setRetainedCursor(retainedQuery.data?.nextCursor ?? undefined);
												setRetainedId(null);
											}}
										>
											{t("providerSettings.retainedNext")}
										</Button>
									) : null}
								</Group>
							</>
						) : null}
					</Stack>
				) : null}
				{actionText ? (
					<Alert variant="light" color="green" icon={<IconCheck size={16} />}>
						{actionText}
					</Alert>
				) : null}
				{error ? (
					<Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />}>
						{error}
						<Button
							size="compact-xs"
							variant="subtle"
							leftSection={<IconRefresh size={14} />}
							onClick={() => {
								onError(undefined);
								void queryClient.invalidateQueries({ queryKey });
							}}
						>
							{t("providerSettings.reload")}
						</Button>
					</Alert>
				) : null}
				<Group justify="space-between" wrap="wrap">
					<Button
						component={Link}
						to="/settings/plugins/$pluginId"
						params={{ pluginId: extension.pluginId }}
						variant="subtle"
						size="compact-xs"
						leftSection={<IconExternalLink size={14} />}
					>
						{t("providerSettings.managePlugin")}
					</Button>
					<Group gap="xs">
						{extension.declaration?.action && canWrite && !disabled ? (
							<Button
								size="compact-xs"
								variant="light"
								leftSection={<IconPlayerPlay size={14} />}
								loading={actionMutation.isPending}
								disabled={draftDirty || status !== "ready"}
								title={draftDirty ? t("providerSettings.unsavedExtension") : undefined}
								onClick={() => actionMutation.mutate()}
							>
								{t("providerSettings.runAction")}
							</Button>
						) : null}
						{status === "dormant" && canWrite && adminConfig ? (
							<Button
								size="compact-xs"
								variant="light"
								loading={rebindMutation.isPending}
								onClick={() => void handleRebind()}
							>
								{t("providerSettings.rebind")}
							</Button>
						) : null}
						{canWrite && adminConfig ? (
							<Button
								size="compact-xs"
								variant="subtle"
								color="red"
								leftSection={<IconTrash size={14} />}
								loading={deleteMutation.isPending}
								onClick={() => void handleDelete()}
							>
								{t("providerSettings.delete")}
							</Button>
						) : null}
					</Group>
				</Group>
			</Stack>
		</Paper>
	);
}
