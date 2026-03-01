import { Affix, Button, Loader, Stack, Title, Transition } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CustomModelsSection } from "../../components/providers/CustomModelsSection";
import { OpenAIProvidersSection } from "../../components/providers/OpenAIProvidersSection";
import { ensurePrefix, type OpenAIProviderState } from "../../components/providers/types";
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";
import { type ModelOption, modelValue } from "../../lib/constants";

export const Route = createFileRoute("/admin/providers")({
	component: ProvidersPage,
});

function ProvidersPage() {
	const { data: user } = useCurrentUser();
	const navigate = useNavigate();
	const { t } = useTranslation("settings");
	const qc = useQueryClient();

	const { data: settings, isLoading } = useQuery({
		queryKey: ["admin", "settings"],
		queryFn: api.getSettings,
		enabled: user?.role === "admin",
	});

	// OpenAI providers state
	const [openaiProviders, setOpenaiProviders] = useState<OpenAIProviderState[]>([]);
	const [providersInitialized, setProvidersInitialized] = useState(false);

	// Hidden models state
	const [hiddenModels, setHiddenModels] = useState<string[]>([]);
	const [hiddenInitialized, setHiddenInitialized] = useState(false);

	// Custom models state
	const [customModels, setCustomModels] = useState<
		Array<{ value: string; label: string; provider?: string }>
	>([]);
	const [customInitialized, setCustomInitialized] = useState(false);

	// Server snapshot for dirty detection
	const serverSnapshot = useRef({
		openaiProviders: [] as OpenAIProviderState[],
		hiddenModels: [] as string[],
		customModels: [] as Array<{ value: string; label: string; provider?: string }>,
	});

	// Sync providers from settings
	useEffect(() => {
		if (settings && !providersInitialized) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const providers = (settings.openaiProviders ?? []).map((p: any) => ({
				id: p.id ?? "",
				name: p.name ?? "",
				prefix: p.prefix ?? "openai",
				apiKey: p.apiKey ?? "",
				baseUrl: p.baseUrl ?? "",
				defaultModel: p.defaultModel ?? "",
				apiMode: p.apiMode ?? "responses",
				codexAccountId: p.codexAccountId ?? "",
			}));
			setOpenaiProviders(providers);
			serverSnapshot.current.openaiProviders = providers;
			setProvidersInitialized(true);
		}
	}, [settings, providersInitialized]);

	// Sync hidden models from settings
	useEffect(() => {
		if (settings && !hiddenInitialized) {
			const hidden = (settings.agent?.hiddenModels ?? []).map((v: string) => ensurePrefix(v));
			setHiddenModels(hidden);
			serverSnapshot.current.hiddenModels = hidden;
			setHiddenInitialized(true);
		}
	}, [settings, hiddenInitialized]);

	// Sync custom models from settings
	useEffect(() => {
		if (settings && !customInitialized) {
			const custom = (settings.agent?.customModels ?? []).map(
				(m: { value: string; label: string; provider?: string }) => ({
					...m,
					value: m.value.includes(":") ? m.value : modelValue(m.provider ?? "openai", m.value),
				}),
			);
			setCustomModels(custom);
			serverSnapshot.current.customModels = custom;
			setCustomInitialized(true);
		}
	}, [settings, customInitialized]);

	const updateMutation = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: () => {
			serverSnapshot.current = {
				openaiProviders: [...openaiProviders],
				hiddenModels: [...hiddenModels],
				customModels: [...customModels],
			};
			setProvidersInitialized(true);
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
		},
	});

	const isDirty = useMemo(() => {
		if (!providersInitialized || !hiddenInitialized || !customInitialized) return false;
		const s = serverSnapshot.current;
		return (
			JSON.stringify(openaiProviders) !== JSON.stringify(s.openaiProviders) ||
			JSON.stringify(hiddenModels) !== JSON.stringify(s.hiddenModels) ||
			JSON.stringify(customModels) !== JSON.stringify(s.customModels)
		);
	}, [
		providersInitialized,
		hiddenInitialized,
		customInitialized,
		openaiProviders,
		hiddenModels,
		customModels,
	]);

	const [highlight, setHighlight] = useState(false);
	useEffect(() => {
		if (isDirty) {
			setHighlight(true);
			const timer = setTimeout(() => setHighlight(false), 1500);
			return () => clearTimeout(timer);
		}
	}, [isDirty]);

	const handleSave = useCallback(() => {
		updateMutation.mutate({
			openaiProviders,
			agent: { hiddenModels, customModels },
		});
	}, [updateMutation, openaiProviders, hiddenModels, customModels]);

	const toggleHidden = useCallback((modelVal: string) => {
		setHiddenModels((prev) =>
			prev.includes(modelVal) ? prev.filter((id) => id !== modelVal) : [...prev, modelVal],
		);
	}, []);

	// Redirect non-admin users
	if (user && user.role !== "admin") {
		navigate({ to: "/" });
		return null;
	}

	if (isLoading) return <Loader />;

	// Build OpenAI models from per-provider grouped data
	const openaiModelsGrouped: Array<{
		providerId: string;
		providerName: string;
		models: Array<{ id: string }>;
	}> = settings?.openaiModelsGrouped ?? [];

	const serverProviders: Array<{ id: string; prefix?: string; name?: string }> =
		settings?.openaiProviders ?? [];

	const providerPrefixMap: Record<string, string> = {};
	for (const p of serverProviders) {
		providerPrefixMap[p.id] = p.prefix ?? "openai";
	}

	const providerModelsMap: Record<string, ModelOption[]> = {};
	for (const group of openaiModelsGrouped) {
		const prefix = providerPrefixMap[group.providerId] ?? "openai";
		providerModelsMap[group.providerId] = group.models.map((m) => ({
			value: `${prefix}:${m.id}`,
			label: m.id,
			provider: prefix,
		}));
	}

	// Provider prefix options for custom model add
	const prefixOptions = [
		...serverProviders.map((p) => ({
			value: p.prefix ?? "openai",
			label: p.name ?? p.prefix ?? "openai",
		})),
	];
	const seenPrefixes = new Set<string>();
	const uniquePrefixOptions = prefixOptions.filter((o) => {
		if (seenPrefixes.has(o.value)) return false;
		seenPrefixes.add(o.value);
		return true;
	});

	return (
		<>
			<Stack>
				<Title order={2}>{t("providersTitle")}</Title>

					settings={settings}
					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
				/>

				<OpenAIProvidersSection
					providers={openaiProviders}
					onProvidersChange={setOpenaiProviders}
					providerModelsMap={providerModelsMap}
					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
				/>

				<CustomModelsSection
					customModels={customModels}
					onCustomModelsChange={setCustomModels}
					hiddenModels={hiddenModels}
					onToggleHidden={toggleHidden}
					prefixOptions={uniquePrefixOptions}
				/>
			</Stack>

			<Affix position={{ bottom: 24, right: 24 }}>
				<Transition transition="slide-up" mounted={isDirty}>
					{(styles) => (
						<Button
							onClick={handleSave}
							loading={updateMutation.isPending}
							size="md"
							style={{
								...styles,
								boxShadow: "0 4px 14px rgba(0, 0, 0, 0.25)",
								animation: highlight ? "providersPulse 1.5s ease" : undefined,
							}}
						>
							{t("unsavedSave")}
						</Button>
					)}
				</Transition>
			</Affix>

			<style>{`
			@keyframes providersPulse {
				0% { box-shadow: 0 0 0 0 var(--mantine-color-indigo-5); }
				40% { box-shadow: 0 0 0 10px transparent; }
				100% { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25); }
			}
		`}</style>
		</>
	);
}
