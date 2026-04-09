import {
	ActionIcon,
	Badge,
	Button,
	Group,
	NumberInput,
	ScrollArea,
	Stack,
	Text,
	Textarea,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
	IconEye,
	IconEyeOff,
	IconLink,
	IconLogin,
	IconLogout,
	IconMinus,
	IconPlayerPlay,
	IconPlus,
	IconRefresh,
	IconSearch,
	IconStar,
	IconStarFilled,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type { CustomModelEntry } from "./InlineCustomModels";
import { InlineCustomModels } from "./InlineCustomModels";

interface ClineSectionProps {
	settings: Record<string, unknown> | undefined;
	hiddenModels: Set<string>;
	onToggleHidden: (modelVal: string) => void;
	customModels: CustomModelEntry[];
	onCustomModelsChange: (models: CustomModelEntry[]) => void;
	modelContextWindows: Record<string, number>;
	onContextWindowChange: (modelVal: string, size: number | null) => void;
	onTestModel?: (model: string) => void;
}

export const ClineSection = React.memo(function ClineSection({
	settings: settingsData,
	hiddenModels,
	onToggleHidden,
	customModels,
	onCustomModelsChange,
	modelContextWindows,
	onContextWindowChange,
	onTestModel,
}: ClineSectionProps) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const [refreshing, setRefreshing] = useState(false);
	const [callbackUrl, setCallbackUrl] = useState("");
	const [poolSearch, setPoolSearch] = useState("");
	const [debouncedSearch] = useDebouncedValue(poolSearch, 300);

	// Query cline auth status
	const { data: clineStatus, refetch: refetchStatus } = useQuery({
		queryKey: ["cline", "status"],
		queryFn: api.clineStatus,
		refetchInterval: (query) => {
			if (query.state.data?.pendingAuth) return 2000;
			return false;
		},
	});

	// Query balance (only when authenticated)
	const {
		data: balanceData,
		refetch: refetchBalance,
		isFetching: balanceFetching,
	} = useQuery({
		queryKey: ["cline", "balance"],
		queryFn: api.clineBalance,
		enabled: clineStatus?.authenticated === true,
		staleTime: 60_000,
	});

	// Query recommended/free models
	const { data: recommendedData } = useQuery({
		queryKey: ["cline", "recommended-models"],
		queryFn: api.clineRecommendedModels,
		staleTime: 30 * 60_000,
	});

	// Pool search
	const { data: poolData } = useQuery({
		queryKey: ["cline", "pool", "search", debouncedSearch],
		queryFn: () => api.clinePoolSearch(debouncedSearch, 100),
		enabled: debouncedSearch.length >= 2,
		staleTime: 60_000,
	});

	// Pool count
	const { data: poolCountData } = useQuery({
		queryKey: ["cline", "pool", "count"],
		queryFn: api.clinePoolCount,
		staleTime: 60_000,
	});

	// Login mutation
	const loginMutation = useMutation({
		mutationFn: () => api.clineBrowserAuth(),
		onSuccess: (data) => {
			window.open(data.authorizeUrl, "_blank");
			refetchStatus();
		},
		onError: () => {
			notifications.show({ color: "red", title: t("clineLoginError"), message: "" });
		},
	});

	// Logout mutation
	const logoutMutation = useMutation({
		mutationFn: api.clineLogout,
		onSuccess: () => {
			refetchStatus();
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
		},
	});

	// Import callback URL mutation
	const importCallbackMutation = useMutation({
		mutationFn: (url: string) => api.clineImportCallback(url),
		onSuccess: () => {
			setCallbackUrl("");
			refetchStatus();
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
			notifications.show({ color: "green", title: t("clineCallbackSuccess"), message: "" });
		},
		onError: () => {
			notifications.show({ color: "red", title: t("clineCallbackError"), message: "" });
		},
	});

	// Set enabled models mutation
	const setEnabledModelsMutation = useMutation({
		mutationFn: (models: string[]) => api.clineSetEnabledModels(models),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["admin", "settings"] });
			qc.invalidateQueries({ queryKey: ["settings"] });
		},
	});

	// Refresh model pool
	const handleRefreshModels = useCallback(async () => {
		setRefreshing(true);
		try {
			await api.clineRefreshModels();
			qc.invalidateQueries({ queryKey: ["cline", "pool"] });
		} catch {
			notifications.show({ color: "red", title: t("clineRefreshModelsError"), message: "" });
		} finally {
			setRefreshing(false);
		}
	}, [qc, t]);

	const isAuthenticated = clineStatus?.authenticated ?? false;
	const isPending = clineStatus?.pendingAuth ?? false;

	// Extract enabled models from settings
	const clineProviders: Array<{
		id: string;
		prefix?: string;
		name?: string;
		enabledModels?: string[];
	}> = (settingsData?.clineProviders as typeof clineProviders) ?? [];

	const firstPrefix = clineProviders[0]?.prefix ?? "cline";
	const enabledModels: string[] = clineProviders[0]?.enabledModels ?? [];
	const enabledSet = useMemo(() => new Set(enabledModels), [enabledModels]);

	// Build enabled model display list from settings (clineModelsGrouped has metadata)
	const clineModelsGrouped: Array<{
		providerId: string;
		providerName: string;
		models: Array<{ id: string; name?: string }>;
	}> = (settingsData?.clineModelsGrouped as typeof clineModelsGrouped) ?? [];

	const enabledModelsMeta = useMemo(() => {
		const map = new Map<string, { id: string; name?: string }>();
		for (const group of clineModelsGrouped) {
			for (const m of group.models) {
				map.set(m.id, m);
			}
		}
		return enabledModels.map((id) => map.get(id) ?? { id });
	}, [clineModelsGrouped, enabledModels]);

	const addModel = useCallback(
		(modelId: string) => {
			if (enabledSet.has(modelId)) return;
			setEnabledModelsMutation.mutate([...enabledModels, modelId]);
		},
		[enabledModels, enabledSet, setEnabledModelsMutation],
	);

	const removeModel = useCallback(
		(modelId: string) => {
			setEnabledModelsMutation.mutate(enabledModels.filter((id) => id !== modelId));
		},
		[enabledModels, setEnabledModelsMutation],
	);

	const poolCount = poolCountData?.count ?? 0;

	return (
		<Stack gap="md">
			{/* Auth status and actions */}
			<Group gap="sm">
				{isAuthenticated ? (
					<>
						<Text size="sm">{t("clineLoggedInAs", { email: clineStatus?.email ?? "" })}</Text>
						{balanceData && (
							<Group gap={4}>
								<Badge size="sm" variant="light" color="teal">
									{t("clineBalance", {
										balance: (balanceData.balance / 1_000_000).toFixed(2),
									})}
								</Badge>
								<ActionIcon
									size="sm"
									variant="subtle"
									loading={balanceFetching}
									onClick={() => refetchBalance()}
								>
									<IconRefresh size={14} />
								</ActionIcon>
							</Group>
						)}
						<Button
							size="xs"
							variant="light"
							color="red"
							leftSection={<IconLogout size={14} />}
							onClick={() => logoutMutation.mutate()}
							loading={logoutMutation.isPending}
						>
							{t("clineLogout")}
						</Button>
					</>
				) : (
					<Button
						size="xs"
						variant="light"
						leftSection={<IconLogin size={14} />}
						onClick={() => loginMutation.mutate()}
						loading={loginMutation.isPending || isPending}
					>
						{isPending ? t("clineLoginLoading") : t("clineLogin")}
					</Button>
				)}
			</Group>

			{/* Paste callback URL (for remote deployments) */}
			{!isAuthenticated && (
				<Stack gap={4}>
					<Text size="xs" c="dimmed">
						{t("clineCallbackUrlDesc")}
					</Text>
					<Group gap="xs" align="flex-end">
						<Textarea
							placeholder={t("clineCallbackUrlPlaceholder")}
							value={callbackUrl}
							onChange={(e) => setCallbackUrl(e.currentTarget.value)}
							style={{ flex: 1 }}
							size="xs"
							minRows={2}
							maxRows={4}
							autosize
						/>
						<Button
							size="xs"
							variant="light"
							leftSection={<IconLink size={14} />}
							onClick={() => importCallbackMutation.mutate(callbackUrl)}
							loading={importCallbackMutation.isPending}
							disabled={!callbackUrl.trim()}
						>
							{importCallbackMutation.isPending
								? t("clineCallbackImporting")
								: t("clineCallbackImport")}
						</Button>
					</Group>
				</Stack>
			)}

			{/* Recommended & Free models — with quick-add buttons */}
			{recommendedData &&
				(recommendedData.recommended.length > 0 || recommendedData.free.length > 0) && (
					<Stack gap="xs">
						{recommendedData.free.length > 0 && (
							<>
								<Group gap={4}>
									<IconStarFilled size={14} color="var(--mantine-color-green-6)" />
									<Text size="xs" fw={600}>
										{t("clineFreeModels")}
									</Text>
								</Group>
								{recommendedData.free.map((m) => (
									<Group key={m.id} gap="xs" pl="md">
										<Badge size="xs" color="green" variant="light">
											FREE
										</Badge>
										<Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>
											{m.id}
										</Text>
										{!enabledSet.has(m.id) ? (
											<Button size="compact-xs" variant="subtle" onClick={() => addModel(m.id)}>
												{t("clineAddRecommended")}
											</Button>
										) : (
											<Badge size="xs" variant="light" color="blue">
												{t("clineModelAdded")}
											</Badge>
										)}
									</Group>
								))}
							</>
						)}
						{recommendedData.recommended.length > 0 && (
							<>
								<Group gap={4}>
									<IconStar size={14} color="var(--mantine-color-yellow-6)" />
									<Text size="xs" fw={600}>
										{t("clineRecommendedModels")}
									</Text>
								</Group>
								{recommendedData.recommended.map((m) => (
									<Group key={m.id} gap="xs" pl="md">
										{m.tags.map((tag) => (
											<Badge key={tag} size="xs" variant="light">
												{tag}
											</Badge>
										))}
										<Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>
											{m.id}
										</Text>
										{!enabledSet.has(m.id) ? (
											<Button size="compact-xs" variant="subtle" onClick={() => addModel(m.id)}>
												{t("clineAddRecommended")}
											</Button>
										) : (
											<Badge size="xs" variant="light" color="blue">
												{t("clineModelAdded")}
											</Badge>
										)}
									</Group>
								))}
							</>
						)}
					</Stack>
				)}

			{/* Model pool: refresh + search */}
			<Stack gap="xs">
				<Group gap="xs">
					<Text size="sm" fw={600}>
						{t("clineModelPool")}
					</Text>
					<Button
						size="compact-xs"
						variant="light"
						leftSection={<IconRefresh size={12} />}
						loading={refreshing}
						onClick={handleRefreshModels}
					>
						{refreshing ? t("clineRefreshModelsLoading") : t("clineRefreshModels")}
					</Button>
					{poolCount > 0 && (
						<Text size="xs" c="dimmed">
							{t("clineModelPoolCount", { count: poolCount })}
						</Text>
					)}
				</Group>
				<Text size="xs" c="dimmed">
					{t("clineModelPoolDesc")}
				</Text>
				<TextInput
					placeholder={t("clineModelPoolSearch")}
					leftSection={<IconSearch size={14} />}
					value={poolSearch}
					onChange={(e) => setPoolSearch(e.currentTarget.value)}
					size="xs"
				/>
				{poolSearch.length >= 2 && poolData && (
					<ScrollArea.Autosize mah={240}>
						<Stack gap={2}>
							{poolData.models.length === 0 && (
								<Text size="xs" c="dimmed" ta="center" py="xs">
									{t("clineModelPoolNoResults")}
								</Text>
							)}
							{poolData.models.map((m) => {
								const isEnabled = enabledSet.has(m.id);
								return (
									<Group
										key={m.id}
										gap="xs"
										py={2}
										px="xs"
										style={{
											borderRadius: 4,
											background: isEnabled ? "var(--mantine-color-dark-6)" : undefined,
										}}
									>
										<Text
											size="xs"
											style={{
												fontFamily: "monospace",
												flex: 1,
												minWidth: 0,
											}}
											truncate
										>
											{m.id}
										</Text>
										{m.name && m.name !== m.id && (
											<Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0 }} truncate>
												{m.name}
											</Text>
										)}
										{m.contextLength && (
											<Text size="xs" c="dimmed">
												{Math.round(m.contextLength / 1000)}k
											</Text>
										)}
										<ActionIcon
											size="xs"
											variant={isEnabled ? "filled" : "light"}
											color={isEnabled ? "red" : "blue"}
											onClick={() => (isEnabled ? removeModel(m.id) : addModel(m.id))}
										>
											{isEnabled ? <IconMinus size={12} /> : <IconPlus size={12} />}
										</ActionIcon>
									</Group>
								);
							})}
							{poolData.total > poolData.models.length && (
								<Text size="xs" c="dimmed" ta="center" py="xs">
									+{poolData.total - poolData.models.length} more
								</Text>
							)}
						</Stack>
					</ScrollArea.Autosize>
				)}
				{poolSearch.length < 2 && poolCount === 0 && (
					<Text size="xs" c="dimmed">
						{t("clineModelPoolEmpty")}
					</Text>
				)}
			</Stack>

			{/* Enabled models list */}
			<Stack gap="xs">
				<Group gap="xs">
					<Text size="sm" fw={600}>
						{t("clineEnabledModels")}
					</Text>
					{enabledModels.length > 0 && (
						<Badge size="xs" variant="light">
							{t("clineEnabledModelsCount", {
								count: enabledModels.length,
							})}
						</Badge>
					)}
				</Group>
				{enabledModelsMeta.length === 0 && (
					<Text size="xs" c="dimmed">
						{t("clineEnabledModelsEmpty")}
					</Text>
				)}
				{enabledModelsMeta.map((m) => {
					const prefixed = `${firstPrefix}:${m.id}`;
					const isHidden = hiddenModels.has(prefixed);
					return (
						<Group key={m.id} gap="xs" wrap="wrap" style={isHidden ? { opacity: 0.5 } : undefined}>
							<Text
								size="xs"
								style={{
									fontFamily: "monospace",
									flex: 1,
									minWidth: 120,
								}}
								truncate
							>
								{prefixed}
							</Text>
							{m.name && m.name !== m.id && (
								<Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 80 }} truncate>
									{m.name}
								</Text>
							)}
							<NumberInput
								placeholder={t("contextWindowPlaceholder")}
								value={modelContextWindows[prefixed] || ""}
								onChange={(v) => onContextWindowChange(prefixed, typeof v === "number" ? v : null)}
								min={1}
								step={1000}
								suffix={` ${t("contextWindowSuffix")}`}
								w={180}
								size="xs"
							/>
							<Tooltip label={t("modelTestBtn")}>
								<ActionIcon variant="subtle" color="teal" onClick={() => onTestModel?.(prefixed)}>
									<IconPlayerPlay size={16} />
								</ActionIcon>
							</Tooltip>
							<ActionIcon
								variant="subtle"
								color={isHidden ? "gray" : "blue"}
								onClick={() => onToggleHidden(prefixed)}
							>
								{isHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
							</ActionIcon>
							<ActionIcon variant="subtle" color="red" onClick={() => removeModel(m.id)}>
								<IconMinus size={16} />
							</ActionIcon>
						</Group>
					);
				})}
			</Stack>

			<InlineCustomModels
				prefix={firstPrefix}
				customModels={customModels}
				onCustomModelsChange={onCustomModelsChange}
				hiddenModels={hiddenModels}
				onToggleHidden={onToggleHidden}
				modelContextWindows={modelContextWindows}
				onContextWindowChange={onContextWindowChange}
				onTestModel={onTestModel}
			/>
		</Stack>
	);
});
