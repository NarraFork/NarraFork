import { ActionIcon, Badge, Box, CloseButton, Group, Menu, Text, TextInput } from "@mantine/core";
import {
	IconCheck,
	IconInfoCircle,
	IconPencil,
	IconRefresh,
	IconSearch,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AGG_MODEL_PREFIX, type ModelOption, parseAggModelValue } from "../../lib/constants";

/**
 * The provider-grouped model list rendered inside a narrator's model menu.
 *
 * Group headers can carry an action: the Default/Summary groups get an edit
 * pencil that opens the global model picker, and a NUG provider group gets a
 * refresh button that re-fetches that gateway's catalog (which is also what
 * clears a stale "temporarily unavailable" flag).
 */
export function ModelMenuItems({
	allModels,
	currentModel,
	totalCostUsd,
	onSelect,
	onShowPrice,
	label,
	providerLabels,
	onEditDefaultModel,
	onEditSummaryModel,
	nugProviderIdByPrefix,
	onRefreshProviderModels,
	refreshingProviderId,
	onPickerOpened,
}: {
	allModels: ModelOption[];
	currentModel: string | null | undefined;
	totalCostUsd: number | null | undefined;
	onSelect: (model: string) => void;
	onShowPrice?: (model: ModelOption) => void;
	label?: string;
	/** Provider prefix → display name, used to label provider groups. */
	providerLabels?: Record<string, string>;
	/** When provided, an edit button on the "Default" group opens the global default model picker. */
	onEditDefaultModel?: () => void;
	/** When provided, an edit button on the "Summary" group opens the global summary model picker. */
	onEditSummaryModel?: () => void;
	/**
	 * Provider prefix → NUG provider id. Groups are keyed by prefix, but the
	 * refresh endpoint is keyed by provider id, so the mapping is what makes a
	 * group header able to refresh the right gateway.
	 */
	nugProviderIdByPrefix?: Record<string, string>;
	/** When provided together with a mapped provider id, the group header shows a refresh button. */
	onRefreshProviderModels?: (providerId: string) => void;
	/** Provider id whose refresh is in flight, used to show the spinner. */
	refreshingProviderId?: string | null;
	/**
	 * Called once when the menu opens. The dropdown only mounts this component
	 * while open, so mounting *is* the open event. Used to kick off an
	 * opportunistic model-catalog refresh, which is what clears a stale
	 * "temporarily unavailable" flag without the user hunting for the refresh
	 * button.
	 */
	onPickerOpened?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [filter, setFilter] = useState("");
	const filterInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const id = window.setTimeout(() => filterInputRef.current?.focus({ preventScroll: true }));
		return () => window.clearTimeout(id);
	}, []);
	// Fire once per open. `onPickerOpened` is deliberately read through a ref so an
	// unstable inline callback cannot re-trigger the refresh on every render.
	const onPickerOpenedRef = useRef(onPickerOpened);
	onPickerOpenedRef.current = onPickerOpened;
	useEffect(() => {
		onPickerOpenedRef.current?.();
	}, []);
	const groups = new Map<string, ModelOption[]>();
	for (const m of allModels) {
		const prov = m.provider ?? "unknown";
		if (!groups.has(prov)) groups.set(prov, []);
		groups.get(prov)?.push(m);
	}
	const provLabels: Record<string, string> = {
		openai: "OpenAI",
		...providerLabels,
		__default__: t("modelGroupDefault"),
		__summary__: t("modelGroupSummary"),
		__agg__: t("modelGroupAggregations"),
	};
	const entries = [...groups.entries()];
	const normalizedFilter = filter.trim().toLowerCase();
	const filteredEntries = normalizedFilter
		? entries
				.map(([prov, models]) => {
					const providerLabel = provLabels[prov] ?? prov;
					const filteredModels = models.filter((m) => {
						const haystack = [
							m.label,
							m.value,
							m.provider ?? "",
							providerLabel,
							m.rateMultiplier != null ? String(m.rateMultiplier) : "",
						]
							.join(" ")
							.toLowerCase();
						return haystack.includes(normalizedFilter);
					});
					return [prov, filteredModels] as const;
				})
				.filter(([, models]) => models.length > 0)
		: entries;
	// For aggregation selection check: parse current model to see if it's an aggregation
	const currentAgg = currentModel ? parseAggModelValue(currentModel) : null;
	return (
		<>
			{totalCostUsd != null && totalCostUsd > 0 && (
				<>
					<Menu.Label ta="right">${totalCostUsd.toFixed(4)}</Menu.Label>
					<Menu.Divider />
				</>
			)}
			{label && <Menu.Label>{label}</Menu.Label>}
			{filteredEntries.length === 0 ? (
				<Text c="dimmed" p="xs" size="xs">
					{t("noModelMatches")}
				</Text>
			) : (
				filteredEntries.map(([prov, models], gi) => {
					const isDefaultGroup = prov === "__default__";
					const isSummaryGroup = prov === "__summary__";
					const editHandler = isDefaultGroup
						? onEditDefaultModel
						: isSummaryGroup
							? onEditSummaryModel
							: undefined;
					const refreshProviderId = onRefreshProviderModels
						? nugProviderIdByPrefix?.[prov]
						: undefined;
					const headerAction = editHandler ? (
						<ActionIcon
							component="div"
							role="button"
							tabIndex={0}
							variant="subtle"
							color="gray"
							size="sm"
							aria-label={isDefaultGroup ? t("editDefaultModel") : t("editSummaryModel")}
							title={isDefaultGroup ? t("editDefaultModel") : t("editSummaryModel")}
							onClick={(e) => {
								e.stopPropagation();
								e.preventDefault();
								editHandler();
							}}
						>
							<IconPencil size={12} />
						</ActionIcon>
					) : refreshProviderId ? (
						<ActionIcon
							component="div"
							role="button"
							tabIndex={0}
							variant="subtle"
							color="gray"
							size="sm"
							loading={refreshingProviderId === refreshProviderId}
							aria-label={t("refreshProviderModels")}
							title={t("refreshProviderModels")}
							onClick={(e) => {
								e.stopPropagation();
								e.preventDefault();
								onRefreshProviderModels?.(refreshProviderId);
							}}
						>
							<IconRefresh size={12} />
						</ActionIcon>
					) : null;
					return (
						<span key={prov}>
							{gi > 0 && <Menu.Divider />}
							{headerAction ? (
								<Menu.Label
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										gap: 4,
									}}
								>
									<span>{provLabels[prov] ?? prov}</span>
									{headerAction}
								</Menu.Label>
							) : (
								<Menu.Label>{provLabels[prov] ?? prov}</Menu.Label>
							)}
							{models.map((m) => {
								// For aggregation items, check if the current model's aggId matches
								const isAggItem = m.provider === "__agg__";
								const aggId = isAggItem ? m.value.slice(AGG_MODEL_PREFIX.length) : null;
								const selected = isAggItem ? currentAgg?.aggId === aggId : currentModel === m.value;
								return (
									<Menu.Item
										key={m.value}
										onClick={() => onSelect(m.value)}
										rightSection={
											<Group gap={4} wrap="nowrap">
												{m.available === false && (
													<Badge size="xs" variant="light" color="yellow">
														{t("modelTemporarilyUnavailable")}
													</Badge>
												)}
												{m.rateMultiplier != null && (
													<Badge size="xs" variant="outline" color="gray">
														×{m.rateMultiplier}
													</Badge>
												)}
												{m.pricing && (
													<ActionIcon
														component="div"
														role="button"
														tabIndex={0}
														variant="subtle"
														color="gray"
														size="sm"
														aria-label={t("viewModelPrice")}
														onClick={(e) => {
															e.stopPropagation();
															e.preventDefault();
															onShowPrice?.(m);
														}}
													>
														<IconInfoCircle size={14} />
													</ActionIcon>
												)}
												<IconCheck
													size={14}
													style={{ visibility: selected ? "visible" : "hidden" }}
												/>
											</Group>
										}
										fw={selected ? 600 : 400}
										c={m.available === false ? "dimmed" : undefined}
									>
										{m.label}
									</Menu.Item>
								);
							})}
						</span>
					);
				})
			)}
			<Menu.Divider />
			<Box
				p={4}
				style={{
					position: "sticky",
					bottom: 0,
					zIndex: 2,
					background: "var(--mantine-color-body)",
				}}
				onClick={(e) => e.stopPropagation()}
			>
				<TextInput
					ref={filterInputRef}
					leftSection={<IconSearch size={14} />}
					onChange={(e) => setFilter(e.currentTarget.value)}
					onKeyDown={(e) => e.stopPropagation()}
					placeholder={t("modelFilterPlaceholder")}
					rightSection={
						filter ? (
							<CloseButton
								aria-label={t("clearModelFilter")}
								onClick={(e) => {
									e.stopPropagation();
									setFilter("");
								}}
								size="xs"
							/>
						) : undefined
					}
					size="xs"
					value={filter}
				/>
			</Box>
		</>
	);
}
