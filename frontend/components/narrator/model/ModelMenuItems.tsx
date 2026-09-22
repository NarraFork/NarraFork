import { ActionIcon, Badge, Box, CloseButton, Group, Menu, Text, TextInput } from "@mantine/core";
import {
	IconAlertTriangle,
	IconCheck,
	IconDotsVertical,
	IconInfoCircle,
	IconPencil,
	IconRefresh,
	IconSearch,
} from "@tabler/icons-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	AGG_MODEL_PREFIX,
	buildAggModelValue,
	type ModelAggregation,
	type ModelOption,
	parseAggModelValue,
} from "../../../lib/constants";
import {
	canAssignGlobalModelRole,
	centerModelMenuSelection,
	modelMenuSelection,
} from "./model-menu-selection";

/**
 * The provider-grouped model list rendered inside a narrator's model menu.
 *
 * Group headers can carry an action: the Default/Summary groups get an edit
 * pencil that opens the global model picker, and a NUG provider group gets a
 * refresh button that re-fetches that gateway's catalog (which is also what
 * clears a stale "temporarily unavailable" flag).
 *
 * Each settable model row also gets a three-dot control that expands the
 * global-role actions (default / summary) inline below the row. Inline expansion
 * rather than a nested Menu on purpose: Mantine v7 has no Menu.Sub, and a
 * Menu/Popover nested inside this dropdown is unreliable (the outer menu
 * intercepts the trigger) — same reasoning as CompactMenuSub.
 */
export function ModelMenuItems({
	allModels,
	aggregations = [],
	opened = true,
	currentModel,
	totalCostUsd,
	onSelect,
	onShowPrice,
	label,
	providerLabels,
	onEditDefaultModel,
	onEditSummaryModel,
	onSetAsDefaultModel,
	onSetAsSummaryModel,
	defaultModelValue,
	summaryModelValue,
	nugProviderIdByPrefix,
	onRefreshProviderModels,
	refreshingProviderId,
	onPickerOpened,
}: {
	allModels: ModelOption[];
	aggregations?: ModelAggregation[];
	/** Also tracks quick reopen before the exit transition has unmounted the dropdown. */
	opened?: boolean;
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
	 * When provided together with a settable model value, each model row gets a
	 * three-dot menu that can promote that model to the instance default.
	 */
	onSetAsDefaultModel?: (model: string) => void;
	/**
	 * When provided together with a settable model value, each model row gets a
	 * three-dot menu that can promote that model to the instance summary slot.
	 */
	onSetAsSummaryModel?: (model: string) => void;
	/** Current instance default model, used to mark the three-dot menu action. */
	defaultModelValue?: string | null;
	/** Current instance summary model, used to mark the three-dot menu action. */
	summaryModelValue?: string | null;
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
	 * Called once when the menu opens. Used to kick off an
	 * opportunistic model-catalog refresh, which is what clears a stale
	 * "temporarily unavailable" flag without the user hunting for the refresh
	 * button.
	 */
	onPickerOpened?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: ts } = useTranslation("settings");
	const selection = modelMenuSelection(currentModel, aggregations);
	const selectedItemRef = useRef<HTMLButtonElement>(null);
	const footerRef = useRef<HTMLDivElement>(null);
	const [filter, setFilter] = useState("");
	/** Model value whose three-dot global-role actions are currently expanded. */
	const [actionsModelValue, setActionsModelValue] = useState<string | null>(null);
	// Never recenter on search or catalog refresh, including during the exit transition.
	useEffect(() => {
		if (!opened) {
			setFilter("");
			setActionsModelValue(null);
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			const item = selectedItemRef.current;
			const container = item?.closest<HTMLElement>("[data-model-menu-scroll]");
			if (container && item) {
				centerModelMenuSelection(container, item, footerRef.current?.offsetHeight ?? 0);
			}
		});
		return () => window.cancelAnimationFrame(frame);
	}, [opened]);
	const filterInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!opened) return;
		const id = window.setTimeout(() => filterInputRef.current?.focus({ preventScroll: true }));
		return () => window.clearTimeout(id);
	}, [opened]);
	// Fire once per open. `onPickerOpened` is deliberately read through a ref so an
	// unstable inline callback cannot re-trigger the refresh on every render.
	const onPickerOpenedRef = useRef(onPickerOpened);
	onPickerOpenedRef.current = onPickerOpened;
	useEffect(() => {
		if (opened) onPickerOpenedRef.current?.();
	}, [opened]);
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
								const selected = isAggItem
									? currentAgg?.aggId === aggId
									: selection.value === m.value;
								const showMembers = isAggItem && selected && selection.members.length > 0;
								// Three-dot actions only on top-level rows that can actually occupy a
								// global slot. Meta sentinels would make the slot circular.
								// A delisted-but-pinned model must not offer "set as default/summary" —
								// that would just re-affirm the dead pin. Offer the role pickers instead.
								const isCatalogMissing = m.catalogMissing === true;
								const showActionsToggle =
									(canAssignGlobalModelRole(m.value) &&
										!!(onSetAsDefaultModel || onSetAsSummaryModel) &&
										!isCatalogMissing) ||
									(isCatalogMissing && !!(onEditDefaultModel || onEditSummaryModel));
								const actionsOpen = showActionsToggle && actionsModelValue === m.value;
								const globalRoleActions: Array<{
									key: "default" | "summary";
									label: string;
									current: boolean;
									onSelect: () => void;
								}> = [];
								if (isCatalogMissing) {
									if (onEditDefaultModel) {
										globalRoleActions.push({
											key: "default",
											label: t("editDefaultModel"),
											current: !!defaultModelValue && defaultModelValue === m.value,
											onSelect: () => onEditDefaultModel(),
										});
									}
									if (onEditSummaryModel) {
										globalRoleActions.push({
											key: "summary",
											label: t("editSummaryModel"),
											current: !!summaryModelValue && summaryModelValue === m.value,
											onSelect: () => onEditSummaryModel(),
										});
									}
								} else if (showActionsToggle) {
									if (onSetAsDefaultModel) {
										globalRoleActions.push({
											key: "default",
											label: t("setAsDefaultModel"),
											current: !!defaultModelValue && defaultModelValue === m.value,
											onSelect: () => onSetAsDefaultModel(m.value),
										});
									}
									if (onSetAsSummaryModel) {
										globalRoleActions.push({
											key: "summary",
											label: t("setAsSummaryModel"),
											current: !!summaryModelValue && summaryModelValue === m.value,
											onSelect: () => onSetAsSummaryModel(m.value),
										});
									}
								}
								const catalogMissingHint = isCatalogMissing
									? m.pinnedAs?.length
										? t("modelCatalogMissingHint", {
												roles: m.pinnedAs
													.map((role) =>
														role === "default" ? ts("defaultModel") : ts("summaryModel"),
													)
													.join(" / "),
											})
										: t("modelCatalogMissingHintGeneric")
									: null;
								return (
									<Fragment key={m.value}>
										<Menu.Item
											ref={
												selection.targetValue === m.value &&
												(!showMembers || !!currentAgg?.pinnedModel)
													? selectedItemRef
													: undefined
											}
											onClick={() => onSelect(m.value)}
											rightSection={
												<Group gap={4} wrap="nowrap">
													{isCatalogMissing && (
														<Badge size="xs" variant="light" color="orange">
															{t("modelCatalogMissing")}
														</Badge>
													)}
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
													{onShowPrice && !m.value.startsWith(AGG_MODEL_PREFIX) && (
														<ActionIcon
															component="div"
															role="button"
															tabIndex={0}
															variant="subtle"
															color="gray"
															size="sm"
															aria-label={ts("catalog.details")}
															onClick={(e) => {
																e.stopPropagation();
																e.preventDefault();
																const actualValue =
																	m.provider === "__default__"
																		? defaultModelValue
																		: m.provider === "__summary__"
																			? summaryModelValue
																			: m.value;
																onShowPrice?.(actualValue ? { ...m, value: actualValue } : m);
															}}
															onKeyDown={(event) => {
																if (event.key !== "Enter" && event.key !== " ") return;
																event.preventDefault();
																event.stopPropagation();
																event.currentTarget.click();
															}}
														>
															<IconInfoCircle size={14} />
														</ActionIcon>
													)}
													<IconCheck
														size={14}
														style={{ visibility: selected ? "visible" : "hidden" }}
													/>
													{showActionsToggle && (
														<ActionIcon
															component="div"
															role="button"
															tabIndex={0}
															variant="subtle"
															color="gray"
															size="sm"
															aria-label={t("modelActions")}
															aria-expanded={actionsOpen}
															title={t("modelActions")}
															onClick={(e) => {
																e.stopPropagation();
																e.preventDefault();
																setActionsModelValue((prev) => (prev === m.value ? null : m.value));
															}}
														>
															<IconDotsVertical size={14} />
														</ActionIcon>
													)}
												</Group>
											}
											fw={selected ? 600 : 400}
											c={m.available === false || isCatalogMissing ? "dimmed" : undefined}
										>
											<Box>
												<Text size="sm" inherit>
													{m.label}
												</Text>
												{catalogMissingHint && (
													<Group gap={4} wrap="nowrap" mt={2} align="flex-start">
														<IconAlertTriangle size={12} color="var(--mantine-color-orange-6)" />
														<Text size="xs" c="orange" lh={1.3}>
															{catalogMissingHint}
														</Text>
													</Group>
												)}
											</Box>
										</Menu.Item>
										{actionsOpen && globalRoleActions.length > 0 && (
											<Box onClick={(e) => e.stopPropagation()} data-model-role-actions={m.value}>
												{globalRoleActions.map((action) => (
													<Menu.Item
														key={action.key}
														rightSection={action.current ? <IconCheck size={14} /> : undefined}
														styles={{
															itemLabel: {
																width: "100%",
																textAlign: "right",
															},
														}}
														onClick={(e) => {
															e.stopPropagation();
															e.preventDefault();
															action.onSelect();
															setActionsModelValue(null);
														}}
													>
														{action.label}
													</Menu.Item>
												))}
											</Box>
										)}
										{showMembers &&
											aggId &&
											[undefined, ...selection.members].map((member) => {
												const value = buildAggModelValue(aggId, member);
												const memberSelected = value === selection.value;
												const prefix = member?.split(":")[0] ?? "";
												const providerLabel = provLabels[prefix] ?? prefix;
												const memberLabel = member
													? (allModels.find((option) => option.value === member)?.label ??
														member.slice(prefix.length + 1))
													: "";
												return (
													<Menu.Item
														key={value}
														ref={memberSelected ? selectedItemRef : undefined}
														pl="xl"
														fw={memberSelected ? 600 : 400}
														onClick={() => onSelect(value)}
														rightSection={
															<IconCheck
																size={14}
																style={{ visibility: memberSelected ? "visible" : "hidden" }}
															/>
														}
													>
														<Text
															size="sm"
															style={{ overflowWrap: "anywhere", whiteSpace: "normal" }}
														>
															{member ? `${providerLabel} · ${memberLabel}` : ts("aggAutoLabel")}
														</Text>
													</Menu.Item>
												);
											})}
									</Fragment>
								);
							})}
						</span>
					);
				})
			)}
			<Menu.Divider />
			<Box
				ref={footerRef}
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
