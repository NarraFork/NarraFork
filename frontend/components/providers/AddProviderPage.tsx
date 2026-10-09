import {
	Alert,
	Badge,
	Box,
	Button,
	Group,
	PasswordInput,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { IconArrowLeft, IconSearch } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../lib/api";
import classes from "./AddProviderPage.module.css";
import { useTokenDanceAdd } from "./provider-add-context";
import {
	type AddProviderDraft,
	draftFromPreset,
	isValidProviderDraft,
	sanitizeProviderPrefix,
	updateDraftConnection,
} from "./provider-add-draft";
import {
	getConnectionFamily,
	getInitialConnectionSelection,
	getPopularProviderPresets,
	type ProviderBilling,
	type ProviderCluster,
	type ProviderConnectionSelection,
	type ProviderRegion,
	resolveProviderConnection,
} from "./provider-connection-presets";
import {
	type AddProviderType,
	getProviderPresetName,
	PROVIDER_PRESETS,
	type ProviderPreset,
	searchProviderPresets,
} from "./provider-presets";

const PROTOCOL_KEYS: Record<AddProviderType, string> = {
	"anthropic-messages": "addProviderAnthropicMessages",
	"openai-responses": "addProviderOpenAIResponses",
	"completions-compatible": "addProviderCompletions",
	"gemini-compatible": "addProviderGemini",
	nug: "addProviderNug",
};

export function AddProviderPage({
	onClose,
	onAdd,
}: {
	onClose: () => void;
	onAdd: (draft: AddProviderDraft) => void | Promise<void>;
}) {
	const { t, i18n } = useTranslation("settings");
	const tokenDance = useTokenDanceAdd();
	const restoredRef = useRef(false);
	const locallyEditedRef = useRef(false);
	useEffect(() => {
		const restored = tokenDance?.restoredAddPage;
		if (!restored || restoredRef.current || locallyEditedRef.current) return;
		restoredRef.current = true;
		setQuery(String(restored.query ?? ""));
		setCategory(restored.category === "all" ? "all" : "popular");
		setPreset(PROVIDER_PRESETS.find((p) => p.id === restored.presetId) ?? null);
		setDraft((restored.draft as AddProviderDraft | null) ?? null);
		setConnectionSelection(
			(restored.connectionSelection as ProviderConnectionSelection | null) ?? null,
		);
		setShowConfig(!!restored.showConfig);
		tokenDance?.consumeRestoredAddPage?.();
	}, [tokenDance?.restoredAddPage, tokenDance?.consumeRestoredAddPage]);
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState<"popular" | "all">("popular");
	const [connectionSelection, setConnectionSelection] =
		useState<ProviderConnectionSelection | null>(null);
	const [preset, setPreset] = useState<ProviderPreset | null>(null);
	const [draft, setDraft] = useState<AddProviderDraft | null>(null);
	const [showConfig, setShowConfig] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const submittingRef = useRef(false);
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const catalogRef = useRef<HTMLElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		// Move focus out of the hidden catalog without opening the mobile keyboard.
		if (!preset) return;
		if (showConfig) headingRef.current?.focus();
		else catalogRef.current?.focus();
	}, [showConfig, preset]);
	const presets = useMemo(
		() =>
			category === "popular" && !query.trim()
				? getPopularProviderPresets()
				: searchProviderPresets(query, t),
		[category, query, t],
	);
	const connection =
		preset && connectionSelection
			? resolveProviderConnection(preset, connectionSelection)
			: preset
				? { preset }
				: null;
	const activePreset = connection?.preset ?? null;
	const protocolOptions = activePreset
		? (Object.keys(activePreset.endpoints) as AddProviderType[])
		: [];
	const requiresCluster =
		preset &&
		getConnectionFamily(preset.id) === "mimo" &&
		connectionSelection?.region === "international" &&
		connectionSelection.billing === "token-plan";
	const choose = (next: ProviderPreset) => {
		if (submittingRef.current) return;
		locallyEditedRef.current = true;
		setSubmitError(null);
		if (next.category === "platform-login") {
			setPreset(next);
			setShowConfig(true);
			return;
		}
		const selection = getConnectionFamily(next.id)
			? getInitialConnectionSelection(next.id, i18n.resolvedLanguage ?? i18n.language)
			: null;
		const resolved = selection
			? resolveProviderConnection(next, selection)
			: { preset: next, userAgentMode: undefined };
		setPreset(next);
		setConnectionSelection(selection);
		setDraft((prev) => ({
			...draftFromPreset({ ...(resolved?.preset ?? next), name: getProviderPresetName(next, t) }),
			apiKey: prev?.apiKey ?? "",
			...(resolved?.userAgentMode ? { userAgentMode: resolved.userAgentMode } : {}),
		}));
		setShowConfig(true);
	};
	const changeConnection = (selection: ProviderConnectionSelection) => {
		if (!preset || submittingRef.current) return;
		setSubmitError(null);
		const resolved = resolveProviderConnection(preset, selection);
		setConnectionSelection(selection);
		setDraft((prev) =>
			prev ? updateDraftConnection(prev, resolved?.preset ?? null, resolved?.userAgentMode) : prev,
		);
	};
	const chooseCustom = (protocol: AddProviderType) =>
		choose({
			id: `custom-${protocol}`,
			name: t(PROTOCOL_KEYS[protocol]),
			defaultProtocol: protocol,
			endpoints: {
				[protocol]:
					protocol === "gemini-compatible"
						? "https://generativelanguage.googleapis.com/v1beta"
						: "",
			},
		});
	const update = (values: Partial<AddProviderDraft>) => {
		if (submittingRef.current) return;
		locallyEditedRef.current = true;
		setSubmitError(null);
		setDraft((prev) => (prev ? { ...prev, ...values } : prev));
	};
	const submit = async () => {
		if (submittingRef.current || !activePreset || !draft || !isValidProviderDraft(draft)) return;
		submittingRef.current = true;
		setSubmitting(true);
		setSubmitError(null);
		try {
			await onAdd(draft);
		} catch (error) {
			if (mountedRef.current)
				setSubmitError(
					error instanceof Error && error.message ? error.message : t("addProviderSaveFailed"),
				);
		} finally {
			submittingRef.current = false;
			if (mountedRef.current) setSubmitting(false);
		}
	};

	return (
		<Stack gap="md" className={classes.page}>
			<Group gap="sm">
				<Button
					variant="subtle"
					leftSection={<IconArrowLeft size={16} />}
					onClick={onClose}
					disabled={submitting}
				>
					{t("addProviderCancel")}
				</Button>
				<Title order={2}>{t("addProvider")}</Title>
			</Group>
			<fieldset
				disabled={submitting}
				className={classes.layout}
				data-config={showConfig || undefined}
			>
				<section
					ref={catalogRef}
					tabIndex={-1}
					className={classes.catalog}
					aria-label={t("addProviderCatalog")}
				>
					<Stack gap="sm" p="md">
						<TextInput
							label={t("addProviderSearch")}
							placeholder={t("addProviderSearchPlaceholder")}
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
							leftSection={<IconSearch size={16} />}
						/>
						<Group gap="xs" grow>
							{(["popular", "all"] as const).map((value) => (
								<Button
									key={value}
									variant={category === value ? "light" : "subtle"}
									size="xs"
									aria-pressed={category === value}
									onClick={() => setCategory(value)}
								>
									{t(value === "popular" ? "addProviderCategoryPopular" : "addProviderCategoryAll")}
								</Button>
							))}
						</Group>
						<Text fw={600} size="sm">
							{t(
								query.trim()
									? "addProviderSearch"
									: category === "popular"
										? "addProviderCategoryPopular"
										: "addProviderCategoryAll",
							)}{" "}
							· {presets.length}
						</Text>
						<div className={classes.catalogList}>
							{presets.length === 0 && (
								<Text c="dimmed" size="sm">
									{t("addProviderNoResults")}
								</Text>
							)}
							{presets.map((item) => (
								<UnstyledButton
									key={item.id}
									data-provider-preset={item.id}
									className={classes.preset}
									data-selected={preset?.id === item.id || undefined}
									onClick={() => choose(item)}
									aria-pressed={preset?.id === item.id}
								>
									<Text fw={600}>{getProviderPresetName(item, t)}</Text>
									<Group gap={4} mt={4}>
										{(Object.keys(item.endpoints) as AddProviderType[]).map((protocol) => (
											<Badge key={protocol} size="xs" variant="light">
												{t(PROTOCOL_KEYS[protocol])}
											</Badge>
										))}
									</Group>
								</UnstyledButton>
							))}
						</div>
						<Text fw={600} size="sm">
							{t("addProviderCustom")}
						</Text>
						<Group gap="xs">
							{(Object.keys(PROTOCOL_KEYS) as AddProviderType[]).map((protocol) => (
								<Button
									key={protocol}
									variant="light"
									size="xs"
									onClick={() => chooseCustom(protocol)}
								>
									{t(PROTOCOL_KEYS[protocol])}
								</Button>
							))}
						</Group>
					</Stack>
				</section>
				<section className={classes.configuration} aria-label={t("addProviderConfigure")}>
					{preset?.category === "platform-login" ? (
						<Stack p="md">
							<Title order={3}>TokenDance</Title>
							<Text>{t("tokendance.loginDescription")}</Text>
							{submitError && <Alert color="red">{submitError}</Alert>}
							<Button
								loading={submitting}
								disabled={submitting || !tokenDance}
								onClick={() => {
									if (submittingRef.current || !tokenDance) return;
									submittingRef.current = true;
									setSubmitting(true);
									setSubmitError(null);
									void tokenDance
										.login({
											query,
											category,
											presetId: preset.id,
											draft,
											connectionSelection,
											showConfig,
										})
										.catch((cause) => {
											if (!mountedRef.current) return;
											// Never render raw errors: they may contain unsaved credentials or URLs.
											if (!(cause instanceof ApiError)) {
												setSubmitError(t("tokendance.loginStartClientFailed"));
												return;
											}
											const key =
												cause.data?.code === "TOKENDANCE_PREFIX_CONFLICT"
													? "tokendance.prefixConflict"
													: cause.data?.code === "TOKENDANCE_CALLBACK_INVALID"
														? "tokendance.loginCallbackInvalid"
														: cause.status === 404
															? "tokendance.loginBackendUnavailable"
															: "tokendance.loginStartFailed";
											setSubmitError(t(key, { status: cause.status }));
										})
										.finally(() => {
											submittingRef.current = false;
											if (mountedRef.current) setSubmitting(false);
										});
								}}
							>
								{t("tokendance.login")}
							</Button>
							<Button variant="subtle" disabled={submitting} onClick={() => setShowConfig(false)}>
								{t("addProviderBack")}
							</Button>
						</Stack>
					) : draft ? (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void submit();
							}}
						>
							<Stack gap="md" p="md">
								<Button
									className={classes.back}
									variant="subtle"
									leftSection={<IconArrowLeft size={16} />}
									onClick={() => setShowConfig(false)}
								>
									{t("addProviderBack")}
								</Button>
								<Title ref={headingRef} tabIndex={-1} order={3}>
									{t("addProviderConfigure")}
								</Title>
								<TextInput
									required
									label={t("addProviderName")}
									value={draft.name}
									onChange={(event) => update({ name: event.currentTarget.value })}
								/>
								{connectionSelection && (
									<Group grow align="flex-start">
										<Select
											required
											allowDeselect={false}
											label={t("addProviderRegion")}
											value={connectionSelection.region}
											data={[
												{ value: "china", label: t("addProviderRegionChina") },
												{ value: "international", label: t("addProviderRegionInternational") },
											]}
											onChange={(value) => {
												if (value && value !== connectionSelection.region)
													changeConnection({
														...connectionSelection,
														region: value as ProviderRegion,
														cluster: undefined,
													});
											}}
										/>
										<Select
											required
											allowDeselect={false}
											label={t("addProviderBilling")}
											value={connectionSelection.billing}
											data={[
												{ value: "payg", label: t("addProviderBillingPayg") },
												{ value: "token-plan", label: t("addProviderBillingTokenPlan") },
											]}
											onChange={(value) => {
												if (value && value !== connectionSelection.billing)
													changeConnection({
														...connectionSelection,
														billing: value as ProviderBilling,
														cluster: undefined,
													});
											}}
										/>
									</Group>
								)}
								{requiresCluster && connectionSelection && (
									<Select
										required
										allowDeselect={false}
										label={t("addProviderCluster")}
										placeholder={t("addProviderClusterPlaceholder")}
										value={connectionSelection.cluster ?? null}
										data={[
											{ value: "sgp", label: t("addProviderClusterSgp") },
											{ value: "ams", label: t("addProviderClusterAms") },
										]}
										onChange={(value) => {
											if (value && value !== connectionSelection.cluster)
												changeConnection({
													...connectionSelection,
													cluster: value as ProviderCluster,
												});
										}}
									/>
								)}
								<Select
									required
									disabled={!activePreset}
									allowDeselect={false}
									label={t("addProviderProtocol")}
									value={activePreset ? draft.protocol : null}
									data={protocolOptions.map((value) => ({ value, label: t(PROTOCOL_KEYS[value]) }))}
									onChange={(value) => {
										if (value && activePreset)
											update({
												protocol: value as AddProviderType,
												baseUrl: activePreset.endpoints[value as AddProviderType] ?? "",
											});
									}}
								/>
								<TextInput
									required
									label={t("addProviderBaseUrl")}
									placeholder="https://api.example.com/v1"
									value={draft.baseUrl}
									onChange={(event) => update({ baseUrl: event.currentTarget.value })}
									type="url"
									autoCapitalize="none"
									spellCheck={false}
								/>
								<PasswordInput
									label={t("addProviderApiKey")}
									description={
										connectionSelection?.billing === "token-plan"
											? t("addProviderTokenPlanHint")
											: undefined
									}
									value={draft.apiKey}
									onChange={(event) => update({ apiKey: event.currentTarget.value })}
									autoComplete="off"
								/>
								<TextInput
									label={t("providerPrefix")}
									placeholder={t("addProviderPrefixAuto")}
									value={draft.prefix}
									onChange={(event) =>
										update({ prefix: sanitizeProviderPrefix(event.currentTarget.value) })
									}
									autoCapitalize="none"
									spellCheck={false}
								/>
								{submitError && (
									<Alert color="red" role="alert" title={t("addProviderSaveFailed")}>
										{submitError}
									</Alert>
								)}
								<Group justify="flex-end" className={classes.actions}>
									<Button
										type="submit"
										loading={submitting}
										disabled={submitting || !activePreset || !isValidProviderDraft(draft)}
									>
										{t("addProviderContinue")}
									</Button>
								</Group>
							</Stack>
						</form>
					) : (
						<Box p="xl">
							<Text c="dimmed">{t("addProviderChoose")}</Text>
						</Box>
					)}
				</section>
			</fieldset>
		</Stack>
	);
}
