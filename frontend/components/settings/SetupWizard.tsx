import {
	Badge,
	Box,
	Button,
	type ComboboxItemGroup,
	Group,
	Modal,
	SegmentedControl,
	Select,
	Stack,
	Text,
	Title,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDebouncedCallback } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
	IconArrowLeft,
	IconArrowRight,
	IconCheck,
	IconNetwork,
	IconRocket,
	IconWand,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllModels } from "../../hooks/useModels";
import { useUpdateUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { FOLLOW_DEFAULT_MODEL, FOLLOW_SUMMARY_MODEL } from "../../lib/constants";
import { Z } from "../../lib/z-index";
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
	addCredentialProviders("cline", settings.clineProviders ?? [], "accessToken", true);
	if (settings.codexAvailable && !disabledPrefixes.has("codex")) configured.add("codex");
	return configured.size;
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

// Inject pulse keyframes once
if (typeof document !== "undefined" && !document.getElementById("wizard-fab-style")) {
	const style = document.createElement("style");
	style.id = "wizard-fab-style";
	style.textContent = `@keyframes wizard-fab-pulse {
		0%, 100% { box-shadow: 0 2px 12px rgba(0,0,0,0.35); }
		50% { box-shadow: 0 0 0 10px rgba(76,110,245,0.3), 0 2px 12px rgba(0,0,0,0.35); }
	}`;
	document.head.appendChild(style);
}

interface SetupWizardProps {
	opened: boolean;
	minimized: boolean;
	initialStep?: number;
	onClose: () => void;
	onMinimize: () => void;
	onRestore: () => void;
}

export function SetupWizard({
	opened,
	minimized,
	initialStep,
	onClose,
	onMinimize,
	onRestore,
}: SetupWizardProps) {
	const { t } = useTranslation("settings");
	const [step, setStep] = useState(0);
	const [pendingNetworkHost, setPendingNetworkHost] = useState<string | null>(null);
	const [finishing, setFinishing] = useState(false);
	const updatePrefs = useUpdateUserPreferences();

	// Jump to a specific step when initialStep changes (e.g. from beta-trial page)
	useEffect(() => {
		if (initialStep != null && opened) {
			setStep(initialStep);
		}
	}, [initialStep, opened]);

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

	// Determine if "Next" should be disabled for the current step
	const isNextDisabled = () => {
		if (step === 2) return providerCount === 0;
		if (step === 3) return !basicStepValid;
		return false;
	};

	// Tooltip for disabled next button
	const nextDisabledReason = () => {
		if (step === 2 && providerCount === 0) return t("wizardProviderRequired");
		if (step === 3 && !basicStepValid) return t("wizardModelsRequired");
		return undefined;
	};

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
		<>
			<Modal
				opened={opened}
				onClose={() => {}}
				title={t("wizardTitle")}
				size="lg"
				centered
				closeOnClickOutside={false}
				closeOnEscape={false}
				withCloseButton={false}
			>
				<Stack gap="md">
					<StepIndicator current={step} total={TOTAL_STEPS} />

					<Box mih={260}>
						{step === 0 && <WelcomeStep />}
						{step === 1 && <DepsStep />}
						{step === 2 && <ProviderStep onMinimize={onMinimize} providerCount={providerCount} />}
						{step === 3 && <BasicSettingsStep onValidChange={setBasicStepValid} />}
						{step === 4 && (
							<NetworkStep pendingHost={pendingNetworkHost} onHostChange={setPendingNetworkHost} />
						)}
						{step === 5 && <CompleteStep />}
					</Box>

					<Group justify="space-between">
						<Group>
							{step > 0 && (
								<Button
									variant="default"
									leftSection={<IconArrowLeft size={16} />}
									onClick={() => setStep((s) => s - 1)}
								>
									{t("wizardPrev")}
								</Button>
							)}
						</Group>
						<Group>
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
						</Group>
					</Group>
				</Stack>
			</Modal>

			{/* Floating restore button — flies from center to corner */}
			<WizardFab minimized={minimized} onRestore={onRestore} />
		</>
	);
}

/**
 * Floating action button that animates from screen center to bottom-left corner
 * when the wizard is minimized, then pulses to draw attention.
 */
function WizardFab({ minimized, onRestore }: { minimized: boolean; onRestore: () => void }) {
	const { t } = useTranslation("settings");
	// "hidden" → "center" (render at center, no transition) → "settling" (transition to corner) → "landed"
	const [phase, setPhase] = useState<"hidden" | "center" | "settling" | "landed">("hidden");
	const rafRef = useRef<number>(0);

	useEffect(() => {
		if (minimized) {
			// 1. Render at center (no transition)
			setPhase("center");
			// 2. Next frame: start transition to corner
			rafRef.current = requestAnimationFrame(() => {
				rafRef.current = requestAnimationFrame(() => {
					setPhase("settling");
				});
			});
		} else {
			setPhase("hidden");
		}
		return () => cancelAnimationFrame(rafRef.current);
	}, [minimized]);

	const handleTransitionEnd = () => {
		if (phase === "settling") setPhase("landed");
	};

	if (phase === "hidden") return null;

	const atCenter = phase === "center";
	const atCorner = phase === "settling" || phase === "landed";

	return (
		<Tooltip label={t("wizardRestore")} position="right" withArrow disabled={!atCorner}>
			<UnstyledButton
				onClick={onRestore}
				onTransitionEnd={handleTransitionEnd}
				style={{
					position: "fixed",
					zIndex: Z.toast,
					bottom: atCenter ? "calc(50% - 24px)" : 24,
					left: atCenter ? "calc(50% - 24px)" : 24,
					transform: atCenter ? "scale(1.4)" : "scale(1)",
					opacity: 1,
					transition: atCenter ? "none" : "all 0.6s ease-in-out",
					width: 48,
					height: 48,
					borderRadius: "50%",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					backgroundColor: "var(--mantine-color-indigo-6)",
					color: "white",
					boxShadow: "0 2px 12px rgba(0,0,0,0.35)",
					cursor: "pointer",
					animation: phase === "landed" ? "wizard-fab-pulse 1.5s ease-in-out 3" : undefined,
				}}
			>
				<IconWand size={22} />
			</UnstyledButton>
		</Tooltip>
	);
}

const STEP_KEYS = ["welcome", "deps", "provider", "basic", "network", "complete"];

function StepIndicator({ current, total }: { current: number; total: number }) {
	const { t } = useTranslation("settings");
	return (
		<Group justify="center" gap="xs">
			{STEP_KEYS.map((key, i) => (
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

function DepsStep() {
	const { t } = useTranslation("settings");
	return (
		<Stack gap="sm">
			<Text size="sm" c="dimmed">
				{t("wizardDepsDesc")}
			</Text>
			<DependencyStatus />
		</Stack>
	);
}

function ProviderStep({
	onMinimize,
	providerCount,
}: {
	onMinimize: () => void;
	providerCount: number;
}) {
	const { t } = useTranslation("settings");
	const navigate = useNavigate();

	const handleGoToProviders = () => {
		onMinimize();
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

	const resolveMode = useCallback(
		(host: string) => {
			if (host === "0.0.0.0") return "open";
			if (firstLan && host === firstLan) return "lan";
			return "local";
		},
		[firstLan],
	);

	const [mode, setMode] = useState<string>(resolveMode(selectedHost));

	// Sync mode from settings or a previously staged selection when the step remounts.
	useEffect(() => {
		setMode(resolveMode(selectedHost));
	}, [resolveMode, selectedHost]);

	const modeToHost = (value: string) => {
		if (value === "open") return "0.0.0.0";
		if (value === "lan" && firstLan) return firstLan;
		return "localhost";
	};

	const handleChange = (value: string) => {
		setMode(value);
		onHostChange(modeToHost(value));
	};

	const segmentData = [
		{ label: t("wizardNetworkLocal"), value: "local" },
		...(firstLan ? [{ label: t("wizardNetworkLan", { ip: firstLan }), value: "lan" }] : []),
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
