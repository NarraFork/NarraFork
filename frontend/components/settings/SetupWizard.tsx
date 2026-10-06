import {
	Badge,
	Box,
	Button,
	type ComboboxItemGroup,
	Group,
	ScrollArea,
	SegmentedControl,
	Select,
	Stack,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDebouncedCallback } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
	IconArrowLeft,
	IconArrowRight,
	IconCheck,
	IconNetwork,
	IconRocket,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AUTO_LAN_HOST } from "../../../shared/server-host";
import { useAllModels } from "../../hooks/useModels";
import { useUpdateUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { FOLLOW_DEFAULT_MODEL, FOLLOW_SUMMARY_MODEL } from "../../lib/constants";
import { PathInput } from "../common/PathInput";
import { DependencyStatus } from "./DependencyStatus";

const TOTAL_STEPS = 6;

const SETUP_WIZARD_SETTINGS_QUERY_GC_TIME_MS = 60_000;
const MODEL_SELECT_OPTION_LIMIT = 100;

type ModelComboboxItem = string | { value: string; label: string };
type ModelComboboxItemGroup = ComboboxItemGroup<ModelComboboxItem, string>;

export function countConfiguredProviders(
	settingsData: Record<string, unknown> | undefined,
): number {
	if (!settingsData) return 0;
	// biome-ignore lint/suspicious/noExplicitAny: settings response is a dynamic API entity
	const settings = settingsData as any;
	const disabledPrefixes = new Set<string>(settings.agent?.disabledProviders ?? []);
	const configured = new Set<string>();
	const addCredentialProviders = (
		kind: string,
		providers: Array<Record<string, unknown>>,
		credentialKey: "apiKey" | "accessToken",
		requireBaseUrl = false,
	) => {
		for (const provider of providers) {
			const prefix = String(provider.prefix ?? "");
			if (provider.disabled || disabledPrefixes.has(prefix)) continue;
			if (!String(provider[credentialKey] ?? "").trim()) continue;
			if (requireBaseUrl && !String(provider.baseUrl ?? "").trim()) continue;
			configured.add(`${kind}:${String(provider.id ?? prefix)}`);
		}
	};

	const customApiProviders = Array.isArray(settings.customApiProviders)
		? settings.customApiProviders
		: [];
	if (customApiProviders.length > 0) {
		addCredentialProviders("custom", customApiProviders, "apiKey");
	} else {
		addCredentialProviders("openai", settings.openaiProviders ?? [], "apiKey");
		addCredentialProviders("anthropic", settings.anthropicProviders ?? [], "apiKey");
		addCredentialProviders("gemini", settings.geminiProviders ?? [], "apiKey");
	}
	addCredentialProviders("nug", settings.nugProviders ?? [], "apiKey", true);
	if (settings.codexAvailable && !disabledPrefixes.has("codex")) configured.add("codex");
	return configured.size;
}

/**
 * Wizard step order. Everything a delegated Setup Assistant narrator needs to
 * actually run comes BEFORE the dependency step:
 *
 *  - `provider`: a provider key is the one thing the user must supply themselves.
 *  - `basic`: the default/summary models. Delegation creates a narrator whose
 *    model is `settings.agent.defaultModel`; with that still unset the narrator
 *    would be spawned against whatever the resolver falls back to, which is not
 *    a provider the user configured. Choosing the models first is what makes the
 *    delegated install run on a real, user-chosen model.
 *
 * Dependencies come last of the three because they are the only part that can be
 * handed to an agent, so gating on them first blocked first-time users on an
 * install step they could have delegated.
 */
export const WIZARD_STEPS = [
	"welcome",
	"provider",
	"basic",
	"deps",
	"network",
	"complete",
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

export function wizardStepIndex(step: WizardStep): number {
	return WIZARD_STEPS.indexOf(step);
}

/**
 * Which gate (if any) blocks "Next" on the current step.
 *
 * Providers and models are hard gates: nothing downstream — including delegated
 * dependency installation, which spawns a narrator on the default model — works
 * without them. Dependencies are deliberately NOT gated, so a user can move on
 * and let the Setup Assistant finish the job later.
 */
export function wizardNextBlockedReasonKey(state: {
	step: number;
	providerCount: number;
	basicStepValid: boolean;
}): "wizardProviderRequired" | "wizardModelsRequired" | null {
	if (state.step === wizardStepIndex("provider") && state.providerCount === 0) {
		return "wizardProviderRequired";
	}
	if (state.step === wizardStepIndex("basic") && !state.basicStepValid) {
		return "wizardModelsRequired";
	}
	return null;
}

export function resolveWizardNetworkMode(
	host: string,
	lanAddresses: readonly string[],
): "local" | "lan" | "open" {
	if (host === "0.0.0.0") return "open";
	if (host === AUTO_LAN_HOST || lanAddresses.includes(host)) return "lan";
	return "local";
}

export function wizardNetworkModeToHost(mode: string): string {
	if (mode === "open") return "0.0.0.0";
	if (mode === "lan") return AUTO_LAN_HOST;
	return "localhost";
}

export async function persistSetupWizardBeforeNetworkChange<T>(
	pendingNetworkHost: string | null,
	persistCompletion: () => Promise<unknown>,
	persistNetworkHost: (host: string) => Promise<T>,
): Promise<T | undefined> {
	await persistCompletion();
	if (pendingNetworkHost === null) return undefined;
	return persistNetworkHost(pendingNetworkHost);
}

interface SetupWizardProps {
	initialStep?: number;
	onClose: () => void;
}

export function SetupWizard({ initialStep, onClose }: SetupWizardProps) {
	const { t } = useTranslation("settings");
	const [step, setStep] = useState(0);
	const [pendingNetworkHost, setPendingNetworkHost] = useState<string | null>(null);
	const [finishing, setFinishing] = useState(false);
	const updatePrefs = useUpdateUserPreferences();

	// Jump to a specific step when initialStep changes (e.g. from beta-trial page)
	useEffect(() => {
		if (initialStep != null) {
			setStep(initialStep);
		}
	}, [initialStep]);

	const finish = async () => {
		setFinishing(true);
		try {
			const data = await persistSetupWizardBeforeNetworkChange(
				pendingNetworkHost,
				() => updatePrefs.mutateAsync({ setupWizardCompleted: true }),
				(host) => api.updateSettings({ server: { host } }),
			);
			setStep(0);
			onClose();

			const resp = data as
				| {
						serverRestarting?: boolean;
						manualRestartRequired?: boolean;
						newUrl?: string;
				  }
				| undefined;
			if (resp?.serverRestarting && resp.newUrl) {
				setTimeout(() => {
					window.location.href = resp.newUrl as string;
				}, 1000);
			} else if (resp?.manualRestartRequired) {
				notifications.show({
					message: t("serverRestartRequired"),
					color: "yellow",
				});
			}
		} catch (error) {
			notifications.show({
				message: error instanceof Error ? error.message : String(error),
				color: "red",
			});
		} finally {
			setFinishing(false);
		}
	};

	// --- Provider readiness (shared between ProviderStep gate and BasicSettingsStep gate) ---
	// Credentials are the source of truth. A configured provider must count even before
	// its model catalog has ever been refreshed (or when the cache is temporarily empty).
	const { settingsData } = useAllModels();
	const providerCount = useMemo(
		() => countConfiguredProviders(settingsData as Record<string, unknown> | undefined),
		[settingsData],
	);

	// Track whether both models are set in BasicSettingsStep
	const [basicStepValid, setBasicStepValid] = useState(false);

	const blockedReasonKey = wizardNextBlockedReasonKey({ step, providerCount, basicStepValid });
	const isNextDisabled = () => blockedReasonKey !== null;
	const nextDisabledReason = () => (blockedReasonKey ? t(blockedReasonKey) : undefined);

	const nextButton = (
		<Button
			rightSection={<IconArrowRight size={16} />}
			onClick={() => setStep((s) => s + 1)}
			disabled={isNextDisabled()}
		>
			{t("wizardNext")}
		</Button>
	);

	return (
		<Stack h="100%" gap={0} style={{ overflow: "hidden" }}>
			<Box
				px="md"
				py="sm"
				style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
			>
				<Title order={4} mb="sm">
					{t("wizardTitle")}
				</Title>
				<StepIndicator current={step} total={TOTAL_STEPS} />
			</Box>

			<ScrollArea style={{ flex: 1, minHeight: 0 }}>
				<Box p="md">
					{step === wizardStepIndex("welcome") && <WelcomeStep />}
					{step === wizardStepIndex("provider") && <ProviderStep providerCount={providerCount} />}
					{step === wizardStepIndex("deps") && <DepsStep onDelegated={onClose} />}
					{step === wizardStepIndex("basic") && (
						<BasicSettingsStep onValidChange={setBasicStepValid} />
					)}
					{step === wizardStepIndex("network") && (
						<NetworkStep pendingHost={pendingNetworkHost} onHostChange={setPendingNetworkHost} />
					)}
					{step === wizardStepIndex("complete") && <CompleteStep />}
				</Box>
			</ScrollArea>

			<Group
				justify="space-between"
				wrap="nowrap"
				p="md"
				style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
			>
				<Box>
					{step > 0 && (
						<Button
							variant="default"
							leftSection={<IconArrowLeft size={16} />}
							onClick={() => setStep((s) => s - 1)}
						>
							{t("wizardPrev")}
						</Button>
					)}
				</Box>
				<Box>
					{step < TOTAL_STEPS - 1 ? (
						isNextDisabled() ? (
							<Tooltip label={nextDisabledReason()} withArrow>
								<span>{nextButton}</span>
							</Tooltip>
						) : (
							nextButton
						)
					) : (
						<Button
							color="green"
							rightSection={<IconCheck size={16} />}
							onClick={finish}
							loading={finishing}
						>
							{t("wizardFinish")}
						</Button>
					)}
				</Box>
			</Group>
		</Stack>
	);
}

function StepIndicator({ current, total }: { current: number; total: number }) {
	const { t } = useTranslation("settings");
	return (
		<Group justify="center" gap="xs">
			{WIZARD_STEPS.map((key, i) => (
				<Box
					key={key}
					w={i === current ? 24 : 8}
					h={8}
					style={{
						borderRadius: 4,
						backgroundColor:
							i === current
								? "var(--mantine-color-indigo-6)"
								: i < current
									? "var(--mantine-color-indigo-3)"
									: "var(--mantine-color-dark-4)",
						transition: "all 200ms ease",
					}}
				/>
			))}
			<Text size="xs" c="dimmed" ml="xs">
				{t("wizardStep", { current: current + 1, total })}
			</Text>
		</Group>
	);
}

function WelcomeStep() {
	const { t } = useTranslation("settings");
	return (
		<Stack align="center" justify="center" gap="lg" py="xl">
			<IconRocket size={48} color="var(--mantine-color-indigo-6)" />
			<Title order={3} ta="center">
				{t("wizardWelcomeTitle")}
			</Title>
			<Text size="sm" c="dimmed" ta="center" maw={420}>
				{t("wizardWelcomeDesc")}
			</Text>
		</Stack>
	);
}

/**
 * Dependency step. Intentionally not gated: the user may skip it and either
 * install later or let a Setup Assistant narrator do it. `onDelegated` closes
 * the wizard so the newly created narrator can be opened.
 */
function DepsStep({ onDelegated }: { onDelegated: () => void }) {
	const { t } = useTranslation("settings");
	return (
		<Stack gap="sm">
			<Text size="sm" c="dimmed">
				{t("wizardDepsDesc")}
			</Text>
			<Text size="xs" c="dimmed">
				{t("wizardDepsOptionalHint")}
			</Text>
			<DependencyStatus onDelegated={onDelegated} />
		</Stack>
	);
}

function ProviderStep({ providerCount }: { providerCount: number }) {
	const { t } = useTranslation("settings");
	const navigate = useNavigate();

	const handleGoToProviders = () => {
		navigate({ to: "/settings/providers" });
	};

	return (
		<Stack gap="md">
			<Text size="sm" c="dimmed">
				{t("wizardProviderDesc")}
			</Text>
			<Group>
				{providerCount > 0 ? (
					<Badge color="green" size="lg" variant="light">
						{t("wizardProviderConfigured", { count: providerCount })}
					</Badge>
				) : (
					<Badge color="orange" size="lg" variant="light">
						{t("wizardProviderNone")}
					</Badge>
				)}
			</Group>
			{providerCount === 0 && (
				<Text size="xs" c="orange">
					{t("wizardProviderRequired")}
				</Text>
			)}
			<Group>
				<Button variant="light" onClick={handleGoToProviders}>
					{t("wizardProviderGoToAdmin")}
				</Button>
			</Group>
		</Stack>
	);
}

function BasicSettingsStep({ onValidChange }: { onValidChange: (valid: boolean) => void }) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		gcTime: SETUP_WIZARD_SETTINGS_QUERY_GC_TIME_MS,
	});
	const { groupedModels, visibleModels } = useAllModels();
	// Default model selector: exclude "follow default" (self-reference) and
	// "follow summary" (circular, since summary follows default).
	const groupedModelsWithoutFollowDefault = useMemo(
		() =>
			groupedModels.filter(
				(g) =>
					!(g as ModelComboboxItemGroup).items?.some?.((i) => {
						const v = typeof i === "string" ? i : i.value;
						return v === FOLLOW_DEFAULT_MODEL || v === FOLLOW_SUMMARY_MODEL;
					}),
			),
		[groupedModels],
	);
	// Summary model selector: exclude "follow summary" (self-reference).
	const groupedModelsWithoutFollowSummary = useMemo(
		() =>
			groupedModels.filter(
				(g) =>
					!(g as ModelComboboxItemGroup).items?.some?.(
						(i) => (typeof i === "string" ? i : i.value) === FOLLOW_SUMMARY_MODEL,
					),
			),
		[groupedModels],
	);

	// Validate initial model values — clear if the model's provider isn't configured
	const availableValues = useMemo(
		() => new Set(visibleModels.map((m) => m.value)),
		[visibleModels],
	);
	const validatedDefault =
		settings?.agent?.defaultModel && availableValues.has(settings.agent.defaultModel)
			? settings.agent.defaultModel
			: "";
	const validatedSummary =
		settings?.agent?.summaryModel && availableValues.has(settings.agent.summaryModel)
			? settings.agent.summaryModel
			: "";

	const [projectDir, setProjectDir] = useState(settings?.paths?.defaultProjectDir ?? "");
	const [defaultModel, setDefaultModel] = useState(validatedDefault);
	const [summaryModel, setSummaryModel] = useState(validatedSummary);

	// Sync validated values when async data loads (useState only captures initial render)
	const syncedRef = useRef(false);
	useEffect(() => {
		if (syncedRef.current || availableValues.size === 0 || !settings) return;
		syncedRef.current = true;
		setDefaultModel(validatedDefault);
		setSummaryModel(validatedSummary);
	}, [availableValues.size, validatedDefault, validatedSummary, settings]);

	const save = useMutation({
		mutationFn: (data: Record<string, unknown>) => api.updateSettings(data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
	});

	const debouncedSaveDir = useDebouncedCallback((path: string) => {
		save.mutate({
			paths: { defaultProjectDir: path },
			agent: {
				...(defaultModel ? { defaultModel } : {}),
				...(summaryModel ? { summaryModel } : {}),
			},
		});
	}, 500);

	const handleDirChange = (path: string) => {
		setProjectDir(path);
		debouncedSaveDir(path);
	};

	// Report validity to parent
	useEffect(() => {
		onValidChange(!!defaultModel && !!summaryModel);
	}, [defaultModel, summaryModel, onValidChange]);

	return (
		<Stack gap="md">
			<Text size="sm" c="dimmed">
				{t("wizardBasicDesc")}
			</Text>
			<PathInput label={t("defaultProjectDir")} value={projectDir} onChange={handleDirChange} />
			<Select
				label={t("defaultModel")}
				placeholder={t("wizardSelectModel")}
				data={groupedModelsWithoutFollowDefault}
				searchable
				limit={MODEL_SELECT_OPTION_LIMIT}
				value={defaultModel}
				onChange={(v) => {
					const val = v ?? "";
					setDefaultModel(val);
					save.mutate({
						paths: { defaultProjectDir: projectDir },
						agent: {
							...(val ? { defaultModel: val } : {}),
							...(summaryModel ? { summaryModel } : {}),
						},
					});
				}}
			/>
			<Select
				label={t("summaryModel")}
				description={t("wizardSummaryModelDesc")}
				placeholder={t("wizardSelectModel")}
				data={groupedModelsWithoutFollowSummary}
				searchable
				limit={MODEL_SELECT_OPTION_LIMIT}
				value={summaryModel}
				onChange={(v) => {
					const val = v ?? "";
					setSummaryModel(val);
					save.mutate({
						paths: { defaultProjectDir: projectDir },
						agent: {
							...(defaultModel ? { defaultModel } : {}),
							...(val ? { summaryModel: val } : {}),
						},
					});
				}}
			/>
			{(!defaultModel || !summaryModel) && (
				<Text size="xs" c="orange">
					{t("wizardModelsRequired")}
				</Text>
			)}
		</Stack>
	);
}

function NetworkStep({
	pendingHost,
	onHostChange,
}: {
	pendingHost: string | null;
	onHostChange: (host: string) => void;
}) {
	const { t } = useTranslation("settings");
	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		gcTime: SETUP_WIZARD_SETTINGS_QUERY_GC_TIME_MS,
	});

	const currentHost = settings?.server?.host ?? "localhost";
	const selectedHost = pendingHost ?? currentHost;
	const lanAddresses: string[] = (settings as { lanAddresses?: string[] })?.lanAddresses ?? [];
	const firstLan = lanAddresses[0];

	const mode = resolveWizardNetworkMode(selectedHost, lanAddresses);

	const handleChange = (value: string) => {
		onHostChange(wizardNetworkModeToHost(value));
	};

	const segmentData = [
		{ label: t("wizardNetworkLocal"), value: "local" },
		{ label: t("wizardNetworkLan"), value: "lan" },
		{ label: t("wizardNetworkOpen"), value: "open" },
	];

	const descKey =
		mode === "open"
			? "wizardNetworkOpenDesc"
			: mode === "lan"
				? "wizardNetworkLanDesc"
				: "wizardNetworkLocalDesc";

	return (
		<Stack gap="md">
			<Stack align="center" gap="xs" pt="sm">
				<IconNetwork size={36} color="var(--mantine-color-indigo-6)" />
			</Stack>
			<Text size="sm" c="dimmed" ta="center">
				{t("wizardNetworkDesc")}
			</Text>
			<SegmentedControl fullWidth value={mode} onChange={handleChange} data={segmentData} />
			<Text size="xs" c="dimmed">
				{t(descKey)}
			</Text>
			{mode === "lan" && firstLan && (
				<Text size="xs" c="dimmed">
					{t("wizardNetworkLanAddress", { ip: firstLan })}
				</Text>
			)}
			<Text size="xs" c="orange">
				{t("wizardNetworkRestartHint")}
			</Text>
		</Stack>
	);
}

function CompleteStep() {
	const { t } = useTranslation("settings");
	return (
		<Stack align="center" justify="center" gap="lg" py="xl">
			<IconCheck size={48} color="var(--mantine-color-green-6)" />
			<Title order={3} ta="center">
				{t("wizardCompleteTitle")}
			</Title>
			<Text size="sm" c="dimmed" ta="center" maw={420}>
				{t("wizardCompleteDesc")}
			</Text>
		</Stack>
	);
}
