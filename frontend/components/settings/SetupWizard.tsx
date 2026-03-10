import {
	Badge,
	Box,
	Button,
	Group,
	Modal,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	IconArrowLeft,
	IconArrowRight,
	IconCheck,
	IconPlayerSkipForward,
	IconRocket,
	IconWand,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllModels } from "../../hooks/useModels";
import { useUpdateUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { DependencyStatus } from "./DependencyStatus";

const TOTAL_STEPS = 5;

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
	const updatePrefs = useUpdateUserPreferences();

	// Jump to a specific step when initialStep changes (e.g. from beta-trial page)
	useEffect(() => {
		if (initialStep != null && opened) {
			setStep(initialStep);
		}
	}, [initialStep, opened]);

	const finish = () => {
		updatePrefs.mutate({ setupWizardCompleted: true });
		setStep(0);
		onClose();
	};

	return (
		<>
			<Modal
				opened={opened}
				onClose={finish}
				title={t("wizardTitle")}
				size="lg"
				centered
				closeOnClickOutside={false}
			>
				<Stack gap="md">
					<StepIndicator current={step} total={TOTAL_STEPS} />

					<Box mih={260}>
						{step === 0 && <WelcomeStep />}
						{step === 1 && <DepsStep />}
						{step === 2 && <ProviderStep onMinimize={onMinimize} />}
						{step === 3 && <BasicSettingsStep />}
						{step === 4 && <CompleteStep />}
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
							<Button
								variant="subtle"
								color="gray"
								leftSection={<IconPlayerSkipForward size={16} />}
								onClick={finish}
							>
								{t("wizardSkip")}
							</Button>
							{step < TOTAL_STEPS - 1 ? (
								<Button
									rightSection={<IconArrowRight size={16} />}
									onClick={() => setStep((s) => s + 1)}
								>
									{t("wizardNext")}
								</Button>
							) : (
								<Button color="green" rightSection={<IconCheck size={16} />} onClick={finish}>
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
					zIndex: 1000,
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

const STEP_KEYS = ["welcome", "deps", "provider", "basic", "complete"];

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

function ProviderStep({ onMinimize }: { onMinimize: () => void }) {
	const { t } = useTranslation("settings");
	const navigate = useNavigate();
	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
	});

	const providerCount =
		(settings?.openaiProviders?.filter((p: { apiKey?: string }) => p.apiKey)?.length ?? 0) +
		(settings?.anthropicProviders?.filter((p: { apiKey?: string }) => p.apiKey)?.length ?? 0) +
			(p: { apiKey?: string; baseUrl?: string }) => p.apiKey && p.baseUrl,
		)?.length ?? 0) +
		(settings?.codexAvailable ? 1 : 0);

	const handleGoToProviders = () => {
		onMinimize();
		navigate({ to: "/admin/providers" });
	};

	const handleGoToBetaTrial = () => {
		onMinimize();
		navigate({ to: "/admin/beta-trial" });
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
			<Group>
				<Button variant="light" onClick={handleGoToProviders}>
					{t("wizardProviderGoToAdmin")}
				</Button>
				<Button
					variant="gradient"
					gradient={{ from: "grape", to: "orange", deg: 135 }}
					onClick={handleGoToBetaTrial}
				>
					{t("betaTrialButton")}
				</Button>
			</Group>
		</Stack>
	);
}

function BasicSettingsStep() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
	});
	const { groupedModels } = useAllModels();

	const [projectDir, setProjectDir] = useState(settings?.paths?.defaultProjectDir ?? "");
	const [defaultModel, setDefaultModel] = useState(
	);

	const save = useMutation({
		mutationFn: (data: Record<string, unknown>) => api.updateSettings(data),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
	});

	const handleBlur = () => {
		save.mutate({
			paths: { defaultProjectDir: projectDir },
			agent: { defaultModel },
		});
	};

	return (
		<Stack gap="md">
			<Text size="sm" c="dimmed">
				{t("wizardBasicDesc")}
			</Text>
			<TextInput
				label={t("defaultProjectDir")}
				value={projectDir}
				onChange={(e) => setProjectDir(e.currentTarget.value)}
				onBlur={handleBlur}
			/>
			<Select
				label={t("defaultModel")}
				data={groupedModels}
				searchable
				value={defaultModel}
				onChange={(v) => {
					setDefaultModel(val);
					save.mutate({
						paths: { defaultProjectDir: projectDir },
						agent: { defaultModel: val },
					});
				}}
			/>
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
