import {
	ActionIcon,
	Alert,
	Button,
	Card,
	Divider,
	Group,
	Loader,
	PasswordInput,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconKey, IconPlus, IconTrash } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/ConfirmDialogProvider";
import { useAuthConfig, useCurrentUser, useUpdateAuthConfig } from "../../hooks/useAuth";
import type { AdminOidcProvider } from "../../lib/api";

export const Route = createFileRoute("/settings/authentication")({
	component: SettingsAuthenticationPage,
});

/** Local editable shape: scopes / domains held as comma-separated strings. */
interface ProviderDraft {
	/** Stable local key for React list rendering (not persisted). */
	key: string;
	id: string;
	name: string;
	issuer: string;
	clientId: string;
	clientSecret: string;
	scopes: string;
	allowedEmailDomains: string;
	allowSignup: boolean;
	enabled: boolean;
	/** True for providers loaded from the server (secret arrives masked). */
	existing: boolean;
}

function toDraft(p: AdminOidcProvider): ProviderDraft {
	return {
		key: crypto.randomUUID(),
		id: p.id,
		name: p.name,
		issuer: p.issuer,
		clientId: p.clientId,
		clientSecret: p.clientSecret ?? "",
		scopes: (p.scopes ?? []).join(", "),
		allowedEmailDomains: (p.allowedEmailDomains ?? []).join(", "),
		allowSignup: p.allowSignup ?? false,
		enabled: p.enabled ?? true,
		existing: true,
	};
}

function splitList(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function SettingsAuthenticationPage() {
	const { t } = useTranslation("settings");
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const { data, isLoading } = useAuthConfig(isAdmin);
	const update = useUpdateAuthConfig();
	const confirm = useConfirmDialog();

	const [providers, setProviders] = useState<ProviderDraft[]>([]);
	const [rpID, setRpID] = useState("");
	const [rpName, setRpName] = useState("");
	const [origins, setOrigins] = useState("");
	const [error, setError] = useState("");

	useEffect(() => {
		if (!data) return;
		setProviders(data.oidcProviders.map(toDraft));
		setRpID(data.webauthn?.rpID ?? "");
		setRpName(data.webauthn?.rpName ?? "");
		setOrigins((data.webauthn?.origins ?? []).join(", "));
	}, [data]);

	if (!isAdmin) return null;
	if (isLoading) return <Loader />;

	const patchProvider = (index: number, patch: Partial<ProviderDraft>) => {
		setProviders((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
	};

	const addProvider = () => {
		setProviders((prev) => [
			...prev,
			{
				key: crypto.randomUUID(),
				id: "",
				name: "",
				issuer: "",
				clientId: "",
				clientSecret: "",
				scopes: "openid, profile, email",
				allowedEmailDomains: "",
				allowSignup: false,
				enabled: true,
				existing: false,
			},
		]);
	};

	const removeProvider = async (index: number) => {
		if (await confirm({ message: t("ssoProviderDeleteConfirm"), confirmColor: "red" })) {
			setProviders((prev) => prev.filter((_, i) => i !== index));
		}
	};

	const validate = (): string | null => {
		const ids = new Set<string>();
		for (const p of providers) {
			if (!p.id.trim() || !p.name.trim() || !p.issuer.trim() || !p.clientId.trim()) {
				return t("ssoValidationRequired");
			}
			if (!/^[a-z0-9][a-z0-9_-]*$/.test(p.id.trim())) return t("ssoValidationId");
			if (!/^https?:\/\//.test(p.issuer.trim())) return t("ssoValidationIssuer");
			// A brand-new provider must include a client secret.
			if (!p.existing && !p.clientSecret.trim()) return t("ssoValidationSecret");
			if (ids.has(p.id.trim())) return t("ssoValidationDuplicate");
			ids.add(p.id.trim());
		}
		return null;
	};

	const handleSave = async () => {
		setError("");
		const validationError = validate();
		if (validationError) {
			setError(validationError);
			return;
		}
		try {
			await update.mutateAsync({
				oidcProviders: providers.map((p) => ({
					id: p.id.trim(),
					name: p.name.trim(),
					issuer: p.issuer.trim(),
					clientId: p.clientId.trim(),
					// Omit empty secret so the server keeps the stored value.
					clientSecret: p.clientSecret.trim() || undefined,
					scopes: splitList(p.scopes),
					allowedEmailDomains: splitList(p.allowedEmailDomains),
					allowSignup: p.allowSignup,
					enabled: p.enabled,
				})),
				webauthn: {
					rpID: rpID.trim() || undefined,
					rpName: rpName.trim() || undefined,
					origins: splitList(origins),
				},
			});
			notifications.show({ color: "green", message: t("authConfigSaved") });
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		} catch (e: any) {
			setError(e?.message || t("authConfigSaveFailed"));
		}
	};

	return (
		<Stack>
			<Title order={3}>{t("authenticationSection")}</Title>

			{error && <Alert color="red">{error}</Alert>}

			{/* === SSO / OIDC === */}
			<Card withBorder padding="lg">
				<Group justify="space-between" align="center">
					<Group gap="xs">
						<IconKey size={22} />
						<Text fw={600}>{t("ssoProvidersTitle")}</Text>
					</Group>
					<Button
						size="compact-sm"
						variant="light"
						leftSection={<IconPlus size={16} />}
						onClick={addProvider}
					>
						{t("ssoAddProvider")}
					</Button>
				</Group>
				<Text size="sm" c="dimmed" mt={4}>
					{t("ssoProvidersDescription")}
				</Text>

				{providers.length === 0 ? (
					<Text size="sm" c="dimmed" mt="md">
						{t("ssoNoProviders")}
					</Text>
				) : (
					<Stack mt="md" gap="lg">
						{providers.map((p, i) => (
							<Card key={p.key} withBorder padding="md" bg="var(--mantine-color-default)">
								<Stack gap="sm">
									<Group justify="space-between">
										<Switch
											label={t("ssoEnabled")}
											checked={p.enabled}
											onChange={(e) => patchProvider(i, { enabled: e.currentTarget.checked })}
										/>
										<ActionIcon color="red" variant="subtle" onClick={() => removeProvider(i)}>
											<IconTrash size={16} />
										</ActionIcon>
									</Group>
									<Group grow>
										<TextInput
											label={t("ssoFieldId")}
											placeholder="corp-okta"
											value={p.id}
											onChange={(e) => patchProvider(i, { id: e.currentTarget.value })}
											disabled={p.existing}
										/>
										<TextInput
											label={t("ssoFieldName")}
											placeholder="Company SSO"
											value={p.name}
											onChange={(e) => patchProvider(i, { name: e.currentTarget.value })}
										/>
									</Group>
									<TextInput
										label={t("ssoFieldIssuer")}
										placeholder="https://idp.example.com"
										value={p.issuer}
										onChange={(e) => patchProvider(i, { issuer: e.currentTarget.value })}
									/>
									<Group grow>
										<TextInput
											label={t("ssoFieldClientId")}
											value={p.clientId}
											onChange={(e) => patchProvider(i, { clientId: e.currentTarget.value })}
										/>
										<PasswordInput
											label={t("ssoFieldClientSecret")}
											placeholder={p.existing ? t("ssoSecretKeep") : ""}
											value={p.clientSecret}
											onChange={(e) => patchProvider(i, { clientSecret: e.currentTarget.value })}
										/>
									</Group>
									<TextInput
										label={t("ssoFieldScopes")}
										description={t("ssoFieldScopesHint")}
										value={p.scopes}
										onChange={(e) => patchProvider(i, { scopes: e.currentTarget.value })}
									/>
									<TextInput
										label={t("ssoFieldDomains")}
										description={t("ssoFieldDomainsHint")}
										placeholder="example.com, corp.example.com"
										value={p.allowedEmailDomains}
										onChange={(e) =>
											patchProvider(i, { allowedEmailDomains: e.currentTarget.value })
										}
									/>
									<Switch
										label={t("ssoAllowSignup")}
										description={t("ssoAllowSignupHint")}
										checked={p.allowSignup}
										onChange={(e) => patchProvider(i, { allowSignup: e.currentTarget.checked })}
									/>
								</Stack>
							</Card>
						))}
					</Stack>
				)}
			</Card>

			{/* === WebAuthn / passkey RP === */}
			<Card withBorder padding="lg">
				<Text fw={600}>{t("webauthnTitle")}</Text>
				<Text size="sm" c="dimmed" mt={4}>
					{t("webauthnDescription")}
				</Text>
				<Stack gap="sm" mt="md">
					<Group grow>
						<TextInput
							label={t("webauthnRpId")}
							description={t("webauthnRpIdHint")}
							placeholder="narrafork.example.com"
							value={rpID}
							onChange={(e) => setRpID(e.currentTarget.value)}
						/>
						<TextInput
							label={t("webauthnRpName")}
							placeholder="NarraFork"
							value={rpName}
							onChange={(e) => setRpName(e.currentTarget.value)}
						/>
					</Group>
					<TextInput
						label={t("webauthnOrigins")}
						description={t("webauthnOriginsHint")}
						placeholder="https://narrafork.example.com"
						value={origins}
						onChange={(e) => setOrigins(e.currentTarget.value)}
					/>
				</Stack>
			</Card>

			<Divider />
			<Group justify="flex-end">
				<Button onClick={handleSave} loading={update.isPending}>
					{t("authConfigSave")}
				</Button>
			</Group>
		</Stack>
	);
}
