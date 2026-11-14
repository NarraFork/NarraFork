import {
	ActionIcon,
	Alert,
	Button,
	Card,
	Divider,
	Group,
	Loader,
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
import { IconKey, IconPlus, IconServer2, IconTrash } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/confirm-dialog-context";
import {
	useAuthConfig,
	useCurrentUser,
	useTestLdap,
	useUpdateAuthConfig,
} from "../../hooks/useAuth";
import type { AdminLdapConfig, AdminOidcProvider, LdapProbeResult } from "../../lib/api";

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

/** Local editable shape of the directory: numeric fields held as text. */
interface LdapDraft {
	enabled: boolean;
	url: string;
	startTls: boolean;
	tlsRejectUnauthorized: boolean;
	mode: "search" | "direct";
	bindDn: string;
	bindPassword: string;
	searchBase: string;
	searchScope: "sub" | "one" | "base";
	searchFilter: string;
	bindDnTemplate: string;
	usernameAttribute: string;
	emailAttribute: string;
	displayNameAttribute: string;
	connectTimeoutMs: number | string;
	timeoutMs: number | string;
}

function emptyLdapDraft(): LdapDraft {
	return {
		enabled: false,
		url: "",
		startTls: false,
		// Verification on by default: a directory that only presents a self-signed
		// certificate is the exception an operator opts into.
		tlsRejectUnauthorized: true,
		mode: "search",
		bindDn: "",
		bindPassword: "",
		searchBase: "",
		searchScope: "sub",
		searchFilter: "",
		bindDnTemplate: "",
		usernameAttribute: "",
		emailAttribute: "",
		displayNameAttribute: "",
		connectTimeoutMs: "",
		timeoutMs: "",
	};
}

function toLdapDraft(config: AdminLdapConfig | null | undefined): LdapDraft {
	if (!config) return emptyLdapDraft();
	return {
		enabled: config.enabled,
		url: config.url ?? "",
		startTls: config.startTls ?? false,
		tlsRejectUnauthorized: config.tlsRejectUnauthorized !== false,
		mode: config.mode ?? "search",
		bindDn: config.bindDn ?? "",
		bindPassword: config.bindPassword ?? "",
		searchBase: config.searchBase ?? "",
		searchScope: config.searchScope ?? "sub",
		searchFilter: config.searchFilter ?? "",
		bindDnTemplate: config.bindDnTemplate ?? "",
		usernameAttribute: config.usernameAttribute ?? "",
		emailAttribute: config.emailAttribute ?? "",
		displayNameAttribute: config.displayNameAttribute ?? "",
		connectTimeoutMs: config.connectTimeoutMs ?? "",
		timeoutMs: config.timeoutMs ?? "",
	};
}

function optionalInt(value: number | string): number | undefined {
	const parsed = typeof value === "number" ? value : Number.parseInt(value.trim(), 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalText(value: string): string | undefined {
	return value.trim() || undefined;
}

/**
 * Build the wire payload. `bindPassword` is omitted when empty so the server keeps the
 * stored one — the same contract as the OIDC client secret on this page.
 */
function toLdapPayload(draft: LdapDraft): AdminLdapConfig {
	const secure = draft.url.trim().toLowerCase().startsWith("ldaps://");
	return {
		enabled: draft.enabled,
		url: draft.url.trim(),
		// StartTLS has no meaning on an already-encrypted connection; normalizing here
		// keeps a stored config from depending on which URL it was saved with.
		startTls: secure ? false : draft.startTls,
		tlsRejectUnauthorized: draft.tlsRejectUnauthorized,
		mode: draft.mode,
		bindDn: optionalText(draft.bindDn),
		bindPassword: draft.bindPassword || undefined,
		searchBase: optionalText(draft.searchBase),
		searchScope: draft.searchScope,
		searchFilter: optionalText(draft.searchFilter),
		bindDnTemplate: optionalText(draft.bindDnTemplate),
		usernameAttribute: optionalText(draft.usernameAttribute),
		emailAttribute: optionalText(draft.emailAttribute),
		displayNameAttribute: optionalText(draft.displayNameAttribute),
		connectTimeoutMs: optionalInt(draft.connectTimeoutMs),
		timeoutMs: optionalInt(draft.timeoutMs),
	};
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
	const [ldap, setLdap] = useState<LdapDraft>(emptyLdapDraft);
	const [ldapTestUser, setLdapTestUser] = useState("");
	const [ldapTestPassword, setLdapTestPassword] = useState("");
	const [ldapProbe, setLdapProbe] = useState<LdapProbeResult | null>(null);
	const [error, setError] = useState("");
	const testLdap = useTestLdap();

	useEffect(() => {
		if (!data) return;
		setProviders(data.oidcProviders.map(toDraft));
		setRpID(data.webauthn?.rpID ?? "");
		setRpName(data.webauthn?.rpName ?? "");
		setOrigins((data.webauthn?.origins ?? []).join(", "));
		setLdap(toLdapDraft(data.ldap));
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
		// The server is the real gate (it validates the whole block); these two checks
		// just name the most common mistakes in the operator's own language.
		const ldapUrl = ldap.url.trim();
		if (ldap.enabled && !ldapUrl) return t("ldapValidationUrl");
		if (ldapUrl && !/^ldaps?:\/\//i.test(ldapUrl)) return t("ldapValidationUrl");
		if (ldap.enabled) {
			const template =
				ldap.mode === "search"
					? ldap.searchFilter.trim() || "(&(objectClass=person)(uid={username}))"
					: ldap.bindDnTemplate.trim();
			if (ldap.mode === "search" && !ldap.searchBase.trim()) return t("ldapValidationSearchBase");
			if (!template.includes("{username}")) return t("ldapValidationTemplate");
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
				ldap: toLdapPayload(ldap),
			});
			notifications.show({ color: "green", message: t("authConfigSaved") });
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		} catch (e: any) {
			setError(e?.message || t("authConfigSaveFailed"));
		}
	};

	/** Probe with the values currently in the form, saved or not. */
	const handleTestLdap = async () => {
		setError("");
		setLdapProbe(null);
		try {
			setLdapProbe(
				await testLdap.mutateAsync({
					config: toLdapPayload(ldap),
					username: ldapTestUser.trim() || undefined,
					password: ldapTestPassword || undefined,
				}),
			);
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		} catch (e: any) {
			setLdapProbe({
				stage: "config",
				ok: false,
				message: e?.message || t("authConfigSaveFailed"),
			});
		}
	};

	const patchLdap = (patch: Partial<LdapDraft>) => {
		setLdap((prev) => ({ ...prev, ...patch }));
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

			{/* === LDAP / Active Directory (credential provider) === */}
			<Card withBorder padding="lg">
				<Group gap="xs">
					<IconServer2 size={22} />
					<Text fw={600}>{t("ldapTitle")}</Text>
				</Group>
				<Text size="sm" c="dimmed" mt={4}>
					{t("ldapDescription")}
				</Text>

				<Stack gap="sm" mt="md">
					<Switch
						label={t("ldapEnabled")}
						description={t("ldapEnabledHint")}
						checked={ldap.enabled}
						onChange={(e) => patchLdap({ enabled: e.currentTarget.checked })}
					/>
					<TextInput
						label={t("ldapUrl")}
						description={t("ldapUrlHint")}
						placeholder="ldaps://dc1.corp.example.com:636"
						value={ldap.url}
						onChange={(e) => patchLdap({ url: e.currentTarget.value })}
					/>
					<Group grow align="flex-start">
						{ldap.url.trim().toLowerCase().startsWith("ldap://") ? (
							<Switch
								label={t("ldapStartTls")}
								description={t("ldapStartTlsHint")}
								checked={ldap.startTls}
								onChange={(e) => patchLdap({ startTls: e.currentTarget.checked })}
							/>
						) : (
							<div />
						)}
						<Switch
							label={t("ldapTrustSelfSigned")}
							description={t("ldapTrustSelfSignedHint")}
							checked={!ldap.tlsRejectUnauthorized}
							onChange={(e) => patchLdap({ tlsRejectUnauthorized: !e.currentTarget.checked })}
						/>
					</Group>

					<Select
						label={t("ldapMode")}
						description={t("ldapModeHint")}
						data={[
							{ value: "search", label: t("ldapModeSearch") },
							{ value: "direct", label: t("ldapModeDirect") },
						]}
						value={ldap.mode}
						allowDeselect={false}
						onChange={(value) => patchLdap({ mode: value === "direct" ? "direct" : "search" })}
					/>

					{ldap.mode === "search" ? (
						<>
							<Group grow align="flex-start">
								<TextInput
									label={t("ldapBindDn")}
									description={t("ldapBindDnHint")}
									placeholder="cn=narrafork,ou=services,dc=example,dc=com"
									value={ldap.bindDn}
									onChange={(e) => patchLdap({ bindDn: e.currentTarget.value })}
								/>
								<PasswordInput
									label={t("ldapBindPassword")}
									placeholder={t("ldapSecretKeep")}
									value={ldap.bindPassword}
									onChange={(e) => patchLdap({ bindPassword: e.currentTarget.value })}
								/>
							</Group>
							<Group grow align="flex-start">
								<TextInput
									label={t("ldapSearchBase")}
									placeholder="dc=example,dc=com"
									value={ldap.searchBase}
									onChange={(e) => patchLdap({ searchBase: e.currentTarget.value })}
								/>
								<Select
									label={t("ldapSearchScope")}
									data={[
										{ value: "sub", label: t("ldapSearchScopeSub") },
										{ value: "one", label: t("ldapSearchScopeOne") },
										{ value: "base", label: t("ldapSearchScopeBase") },
									]}
									value={ldap.searchScope}
									allowDeselect={false}
									onChange={(value) =>
										patchLdap({
											searchScope: value === "one" || value === "base" ? value : "sub",
										})
									}
								/>
							</Group>
							<TextInput
								label={t("ldapSearchFilter")}
								description={t("ldapSearchFilterHint")}
								placeholder="(&(objectClass=person)(uid={username}))"
								value={ldap.searchFilter}
								onChange={(e) => patchLdap({ searchFilter: e.currentTarget.value })}
							/>
						</>
					) : (
						<TextInput
							label={t("ldapBindDnTemplate")}
							description={t("ldapBindDnTemplateHint")}
							placeholder="uid={username},ou=people,dc=example,dc=com"
							value={ldap.bindDnTemplate}
							onChange={(e) => patchLdap({ bindDnTemplate: e.currentTarget.value })}
						/>
					)}

					<Group grow align="flex-start">
						<TextInput
							label={t("ldapUsernameAttribute")}
							description={t("ldapUsernameAttributeHint")}
							placeholder="uid"
							value={ldap.usernameAttribute}
							onChange={(e) => patchLdap({ usernameAttribute: e.currentTarget.value })}
						/>
						<TextInput
							label={t("ldapEmailAttribute")}
							placeholder="mail"
							value={ldap.emailAttribute}
							onChange={(e) => patchLdap({ emailAttribute: e.currentTarget.value })}
						/>
						<TextInput
							label={t("ldapDisplayNameAttribute")}
							placeholder="cn"
							value={ldap.displayNameAttribute}
							onChange={(e) => patchLdap({ displayNameAttribute: e.currentTarget.value })}
						/>
					</Group>

					<Group grow align="flex-start">
						<NumberInput
							label={t("ldapConnectTimeout")}
							description={t("ldapTimeoutHint")}
							min={1000}
							max={30000}
							step={500}
							placeholder="5000"
							value={ldap.connectTimeoutMs}
							onChange={(value) => patchLdap({ connectTimeoutMs: value })}
						/>
						<NumberInput
							label={t("ldapOperationTimeout")}
							description={t("ldapTimeoutHint")}
							min={1000}
							max={30000}
							step={500}
							placeholder="5000"
							value={ldap.timeoutMs}
							onChange={(value) => patchLdap({ timeoutMs: value })}
						/>
					</Group>

					<Divider label={t("ldapTestTitle")} labelPosition="left" />
					<Text size="xs" c="dimmed">
						{t("ldapTestHint")}
					</Text>
					<Group grow align="flex-end">
						<TextInput
							label={t("ldapTestUsername")}
							placeholder="alice"
							value={ldapTestUser}
							onChange={(e) => setLdapTestUser(e.currentTarget.value)}
							autoComplete="off"
						/>
						<PasswordInput
							label={t("ldapTestPassword")}
							value={ldapTestPassword}
							onChange={(e) => setLdapTestPassword(e.currentTarget.value)}
							autoComplete="new-password"
						/>
						<Button
							variant="light"
							onClick={handleTestLdap}
							loading={testLdap.isPending}
							style={{ alignSelf: "flex-end" }}
						>
							{t("ldapTestRun")}
						</Button>
					</Group>
					{ldapProbe && (
						<Alert color={ldapProbe.ok ? "green" : "red"} title={t(`ldapStage_${ldapProbe.stage}`)}>
							<Text size="sm">{ldapProbe.message}</Text>
							{ldapProbe.user && (
								<Text size="xs" mt={4} style={{ wordBreak: "break-all" }}>
									{ldapProbe.user.displayName
										? `${ldapProbe.user.displayName} · ${ldapProbe.user.id}`
										: ldapProbe.user.id}
									{` · ${ldapProbe.user.dn}`}
								</Text>
							)}
						</Alert>
					)}

					<Divider label={t("ldapPolicyTitle")} labelPosition="left" />
					<Stack gap={2}>
						<Text size="xs" c="dimmed">
							• {t("ldapPolicyBound")}
						</Text>
						<Text size="xs" c="dimmed">
							• {t("ldapPolicySameName")}
						</Text>
						<Text size="xs" c="dimmed">
							• {t("ldapPolicyCreate")}
						</Text>
						<Text size="xs" c="dimmed">
							• {t("ldapPolicyClosed")}
						</Text>
					</Stack>
				</Stack>
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
