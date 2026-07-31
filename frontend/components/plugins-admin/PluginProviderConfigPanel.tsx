/**
 * Provider configuration panel for the plugin detail page.
 *
 * One card per provider the plugin contributes: prefix on top, then the schema-driven
 * config form. Both write through admin-only endpoints and both re-read the server's
 * view afterwards rather than patching the cache, because the server re-derives secret
 * status and is the only trustworthy source for it.
 *
 * The prefix is separated from the config form on purpose. It is not part of the
 * plugin's schema — it is a host-level namespace key shared with every other provider,
 * so it has its own endpoint, its own conflict semantics, and a warning about the
 * consequences of changing it.
 */

import { Alert, Badge, Button, Card, Group, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	usePluginProviderConfig,
	useUpdatePluginProviderConfig,
	useUpdatePluginProviderPrefix,
} from "../../hooks/usePlugins";
import { ApiError } from "../../lib/api";
import type { PluginProviderConfigView } from "../../lib/api/plugins";
import type { ConfigViewInput } from "./config-form-state";
import type { JsonValue, SchemaNode } from "./config-schema";
import { localizePluginError } from "./errors";
import { PluginConfigForm } from "./PluginConfigForm";

/**
 * Prefer the localized code-based message; fall back to the raw server message.
 *
 * Provider config rejections carry the schema path that failed, which the generic
 * localized string cannot express, so a validation error shows the server text verbatim.
 */
function errorText(error: unknown, t: TFunction<"plugins">): string {
	if (error instanceof ApiError && typeof error.data?.code === "string") {
		const code = error.data.code;
		if (code === "VALIDATION_ERROR" || code === "PROVIDER_CONFIG_INVALID") {
			return error.message;
		}
	}
	return localizePluginError(error, t);
}

/** Normalize the wire shape into what the form expects. */
function formViewFor(provider: PluginProviderConfigView): ConfigViewInput {
	return {
		config: provider.config as Record<string, JsonValue>,
		secretFields: provider.secretFields,
		secretsSet: provider.secretsSet,
	};
}

function schemaFor(provider: PluginProviderConfigView): SchemaNode | undefined {
	if (provider.configSchema === null) return undefined;
	if (typeof provider.configSchema === "boolean") return provider.configSchema;
	return provider.configSchema as SchemaNode;
}

function PrefixEditor({
	provider,
	pluginId,
}: {
	provider: PluginProviderConfigView;
	pluginId: string;
}) {
	const { t } = useTranslation("plugins");
	const mutation = useUpdatePluginProviderPrefix(pluginId);
	const [value, setValue] = useState(provider.providerPrefix);
	const [seeded, setSeeded] = useState(provider.providerPrefix);
	// Re-seed when the server value changes, so a successful save or an external change
	// is reflected instead of leaving the old text in the box.
	if (seeded !== provider.providerPrefix) {
		setSeeded(provider.providerPrefix);
		setValue(provider.providerPrefix);
	}

	const trimmed = value.trim();
	const dirty = trimmed !== provider.providerPrefix;
	// Mirrors the server rule; the registry re-checks it along with global conflicts.
	const invalid =
		trimmed.length === 0 ||
		trimmed.length > 32 ||
		/[:\s]/u.test(trimmed) ||
		[...trimmed].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 0x21 || codePoint > 0x7e;
		});

	return (
		<Stack gap="xs">
			<Group align="flex-end" gap="sm" wrap="nowrap">
				<TextInput
					style={{ flex: 1 }}
					label={t("admin.detail.config.prefixLabel")}
					description={t("admin.detail.config.prefixDescription")}
					value={value}
					onChange={(event) => setValue(event.currentTarget.value)}
					error={dirty && invalid ? t("admin.detail.config.prefixInvalid") : undefined}
				/>
				<Button
					variant="default"
					loading={mutation.isPending}
					disabled={!dirty || invalid}
					onClick={() =>
						mutation.mutate({
							providerInstanceId: provider.providerInstanceId,
							providerPrefix: trimmed,
						})
					}
				>
					{t("admin.detail.config.prefixSave")}
				</Button>
			</Group>
			{dirty ? (
				<Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />}>
					{t("admin.detail.config.prefixWarning")}
				</Alert>
			) : null}
			{mutation.isError ? (
				<Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />}>
					{errorText(mutation.error, t)}
				</Alert>
			) : null}
		</Stack>
	);
}

function ProviderCard({
	provider,
	pluginId,
}: {
	provider: PluginProviderConfigView;
	pluginId: string;
}) {
	const { t } = useTranslation("plugins");
	const mutation = useUpdatePluginProviderConfig(pluginId);

	return (
		<Card withBorder radius="md" padding="md">
			<Stack gap="md">
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Stack gap={2}>
						<Text fw={600}>{provider.displayName}</Text>
						<Text size="xs" c="dimmed">
							{provider.contributionId}
						</Text>
					</Stack>
					<Group gap="xs">
						{provider.secretsSet.length > 0 ? (
							<Tooltip label={provider.secretsSet.join(", ")} withArrow>
								<Badge size="sm" variant="light" color="teal">
									{t("admin.detail.config.secretsConfigured", {
										count: provider.secretsSet.length,
									})}
								</Badge>
							</Tooltip>
						) : null}
						<Badge size="sm" variant="light" color="gray">
							{provider.providerPrefix}
						</Badge>
					</Group>
				</Group>

				<PrefixEditor provider={provider} pluginId={pluginId} />

				<PluginConfigForm
					schema={schemaFor(provider)}
					view={formViewFor(provider)}
					submitting={mutation.isPending}
					submitError={mutation.isError ? errorText(mutation.error, t) : undefined}
					onSubmit={async (config) => {
						await mutation.mutateAsync({
							providerInstanceId: provider.providerInstanceId,
							config,
						});
					}}
				/>
			</Stack>
		</Card>
	);
}

export function PluginProviderConfigPanel({
	pluginId,
	enabled = true,
}: {
	pluginId: string;
	enabled?: boolean;
}) {
	const { t } = useTranslation("plugins");
	const query = usePluginProviderConfig(pluginId, { enabled });

	if (query.isLoading) {
		return (
			<Text size="sm" c="dimmed">
				{t("admin.detail.config.loading")}
			</Text>
		);
	}
	if (query.isError) {
		return (
			<Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />}>
				{errorText(query.error, t)}
			</Alert>
		);
	}

	const providers = query.data?.providers ?? [];
	if (providers.length === 0) {
		return (
			<Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />}>
				{t("admin.detail.config.empty")}
			</Alert>
		);
	}

	return (
		<Stack gap="md">
			{providers.map((provider) => (
				<ProviderCard key={provider.providerInstanceId} provider={provider} pluginId={pluginId} />
			))}
		</Stack>
	);
}
