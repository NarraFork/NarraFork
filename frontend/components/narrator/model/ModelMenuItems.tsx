import {
	ActionIcon,
	Badge,
	Box,
	CloseButton,
	Group,
	Menu,
	Text,
	TextInput,
	Tooltip,
	useMenuContext,
} from "@mantine/core";
import type { SubagentModelInheritance } from "@shared/model-inheritance";
import {
	IconAlertTriangle,
	IconCheck,
	IconDotsVertical,
	IconPencil,
	IconRefresh,
	IconSearch,
	IconSettings,
} from "@tabler/icons-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	AGG_MODEL_PREFIX,
	buildAggModelValue,
	FOLLOW_PARENT_MODEL,
	type ModelAggregation,
	type ModelOption,
	parseAggModelValue,
} from "../../../lib/constants";
import { modelInheritanceLabel } from "./model-inheritance-label";
import {
	canAssignGlobalModelRole,
	centerModelMenuSelection,
	modelMenuSelection,
	modelProviderPrefix,
	orderModelGroupEntries,
	shouldAutoFocusModelFilter,
} from "./model-menu-selection";
import { QuotaWindowBars } from "./QuotaWindowBars";
import type { ProviderHeaderActions } from "./use-model-menu-refresh-props";
import type { ProviderQuotaBadge } from "./use-opencode-provider-badges";
import type { ProviderBalanceBadge } from "./use-provider-balance-badges";

/** Model-menu meta groups; they are not providers, so they get no provider actions. */
const META_GROUPS = new Set(["__default__", "__summary__", "__agg__", "unknown"]);

/**
 * The provider-grouped model list rendered inside a narrator's model menu.
 *
 * Group headers can carry actions: the Default/Summary groups get an edit
 * pencil that opens the global model picker. A provider group shows, right to
 * left, a settings shortcut, a catalog refresh button (for NUG this is also what
 * clears a stale "temporarily unavailable" flag), its pay-as-you-go balance and
 * its subscription allowance bars.
 *
 * Each model row also gets a three-dot control that expands its actions inline
 * below the row: model details (metadata and prices) and the global-role
 * actions (default / summary). Inline expansion
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
	providerBadges,
	providerBalances,
	onEditDefaultModel,
	onEditSummaryModel,
	onSetAsDefaultModel,
	onSetAsSummaryModel,
	defaultModelValue,
	summaryModelValue,
	providerActions,
	onOpenProviderSettings,
	onPickerOpened,
	canFollowParent = false,
	inheritance,
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
	/**
	 * Provider prefix → a small status badge for the group header, e.g. what is
	 * left of an OpenCode Go plan allowance. `tooltip` explains the badge.
	 */
	providerBadges?: Record<string, ProviderQuotaBadge>;
	/** Provider prefix → pay-as-you-go balance shown in the group header. */
	providerBalances?: Record<string, ProviderBalanceBadge>;
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
	/** Provider prefix → header actions (catalog refresh). */
	providerActions?: Record<string, ProviderHeaderActions>;
	/** When provided, every provider group header gets a button to its settings page. */
	onOpenProviderSettings?: (prefix: string) => void;
	/**
	 * Called once when the menu opens. Used to kick off an
	 * opportunistic model-catalog refresh, which is what clears a stale
	 * "temporarily unavailable" flag without the user hunting for the refresh
	 * button.
	 */
	onPickerOpened?: () => void;
	/**
	 * Subagents only: show "Follow parent" as a selectable entry, so a manual pin
	 * can be undone. Otherwise it only appears as the current-state label.
	 */
	canFollowParent?: boolean;
	/**
	 * What a `__parent__` selection actually resolved to on the latest run. Rendered
	 * inside the follow-parent group exactly like the resolved Default/Summary rows:
	 * provider prefix line + model label, plus a warning line on pool fallback.
	 */
	inheritance?: SubagentModelInheritance | null;
}) {
	const { t } = useTranslation("narrator");
	const { t: ts } = useTranslation("settings");
	const menu = useMenuContext();
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
		if (!opened || !shouldAutoFocusModelFilter()) return;
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
	// Default, Summary, and Aggregations stay pinned at the top. Every provider
	// group is sorted alphabetically by its display label.
	const entries = orderModelGroupEntries([...groups.entries()], (prov) => provLabels[prov] ?? prov);
	const normalizedFilter = filter.trim().toLowerCase();
	const filteredEntries = normalizedFilter
		? entries
				.map(([prov, models]) => {
					const providerLabel = provLabels[prov] ?? prov;
					const filteredModels = models.filter((m) => {
						const roleTargetValue =
							m.provider === "__default__"
								? defaultModelValue
								: m.provider === "__summary__"
									? summaryModelValue
									: null;
						const haystack = [
							m.label,
							m.value,
							m.provider ?? "",
							providerLabel,
							roleTargetValue ?? "",
							modelProviderPrefix(roleTargetValue) ?? "",
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
	// Follow-parent group: resolved exactly like the Default/Summary role rows —
	// provider prefix line + resolved model label, plus a fallback warning.
	const followsParent = currentModel === FOLLOW_PARENT_MODEL;
	const inheritanceInfo = followsParent ? modelInheritanceLabel(inheritance, t) : null;
	const followModel = followsParent && inheritance ? inheritance.model : null;
	const followModelLabel = followModel
		? (allModels.find((o) => o.value === followModel)?.label ?? followModel)
		: null;
	const followModelPrefix = modelProviderPrefix(followModel);
	return (
		<>
			{/* Inheritance is a current-state group, not a catalog model or a global role. */}
			{(followsParent || canFollowParent) && (
				<span>
					<Menu.Label>{t("followParent")}</Menu.Label>
					<Menu.Item
						ref={followsParent ? selectedItemRef : undefined}
						rightSection={
							<IconCheck size={14} style={{ visibility: followsParent ? "visible" : "hidden" }} />
						}
						fw={followsParent ? 600 : 400}
						onClick={() => {
							// Already following: this row is the current state, re-selecting is a no-op.
							if (!followsParent) onSelect(FOLLOW_PARENT_MODEL);
						}}
					>
						{followModelLabel ? (
							<Box>
								{followModelPrefix && (
									<Text size="xs" c="dimmed" lh={1.3}>
										{followModelPrefix}
									</Text>
								)}
								<Text size="sm" inherit>
									{followModelLabel}
								</Text>
								{inheritanceInfo?.fallback && inheritanceInfo.reason && (
									<Group gap={4} wrap="nowrap" mt={2} align="flex-start">
										<IconAlertTriangle size={12} color="var(--mantine-color-orange-6)" />
										<Text size="xs" c="orange" lh={1.3}>
											{inheritanceInfo.reason}
										</Text>
									</Group>
								)}
							</Box>
						) : (
							t("followParent")
						)}
					</Menu.Item>
					<Menu.Divider />
				</span>
			)}
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
					const isProviderGroup = !META_GROUPS.has(prov);
					const actions = isProviderGroup ? providerActions?.[prov] : undefined;
					const headerIcon = (props: {
						key: string;
						label: string;
						onClick: () => void;
						loading?: boolean;
						icon: React.ReactNode;
					}) => (
						<ActionIcon
							key={props.key}
							component="div"
							role="button"
							tabIndex={0}
							variant="subtle"
							color="gray"
							size="sm"
							loading={props.loading}
							aria-label={props.label}
							title={props.label}
							onClick={(e) => {
								e.stopPropagation();
								e.preventDefault();
								props.onClick();
							}}
							onKeyDown={(event) => {
								if (event.key !== "Enter" && event.key !== " ") return;
								event.preventDefault();
								event.stopPropagation();
								event.currentTarget.click();
							}}
						>
							{props.icon}
						</ActionIcon>
					);
					const headerActions: React.ReactNode[] = [];
					if (editHandler) {
						headerActions.push(
							headerIcon({
								key: "edit",
								label: isDefaultGroup ? t("editDefaultModel") : t("editSummaryModel"),
								onClick: editHandler,
								icon: <IconPencil size={12} />,
							}),
						);
					}
					if (actions?.onRefresh) {
						const onRefresh = actions.onRefresh;
						headerActions.push(
							headerIcon({
								key: "refresh",
								label: t("refreshProviderModels"),
								onClick: onRefresh,
								loading: actions.refreshing,
								icon: <IconRefresh size={12} />,
							}),
						);
					}
					if (isProviderGroup && onOpenProviderSettings) {
						headerActions.push(
							headerIcon({
								key: "settings",
								label: t("openProviderSettings"),
								onClick: () => {
									// Leaving for the settings page: don't leave the dropdown open behind.
									menu.closeDropdown();
									onOpenProviderSettings(prov);
								},
								icon: <IconSettings size={12} />,
							}),
						);
					}
					return (
						<span key={prov}>
							{gi > 0 && <Menu.Divider />}
							{(() => {
								const badgeInfo = providerBadges?.[prov];
								const badge = badgeInfo ? (
									<Tooltip
										label={badgeInfo.tooltip}
										disabled={!badgeInfo.tooltip}
										multiline
										withinPortal
										style={{ whiteSpace: "pre-line" }}
									>
										{badgeInfo.bars && badgeInfo.bars.length > 0 ? (
											<span
												role="img"
												aria-label={badgeInfo.text}
												style={{ display: "inline-flex", flexShrink: 0 }}
											>
												<QuotaWindowBars bars={badgeInfo.bars} size="xs" stale={badgeInfo.stale} />
											</span>
										) : (
											<Badge
												size="xs"
												variant="light"
												color={badgeInfo.color}
												style={{ textTransform: "none", flexShrink: 0 }}
											>
												{badgeInfo.text}
											</Badge>
										)}
									</Tooltip>
								) : null;
								const balanceInfo = isProviderGroup ? providerBalances?.[prov] : undefined;
								const balance = balanceInfo ? (
									<Tooltip
										label={balanceInfo.tooltip}
										disabled={!balanceInfo.tooltip}
										multiline
										withinPortal
										maw={360}
										style={{ whiteSpace: "pre-line" }}
									>
										<Text
											span
											size="xs"
											c="dimmed"
											data-provider-balance={prov}
											style={{
												maxWidth: 140,
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap",
												opacity: balanceInfo.stale ? 0.6 : undefined,
												textTransform: "none",
												fontWeight: 400,
											}}
										>
											{balanceInfo.text}
										</Text>
									</Tooltip>
								) : null;
								if (headerActions.length === 0 && !badge && !balance) {
									return <Menu.Label>{provLabels[prov] ?? prov}</Menu.Label>;
								}
								return (
									<Menu.Label
										style={{
											display: "flex",
											alignItems: "center",
											justifyContent: "space-between",
											gap: 4,
										}}
									>
										<span
											style={{
												minWidth: 0,
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap",
											}}
										>
											{provLabels[prov] ?? prov}
										</span>
										<Group gap={4} wrap="nowrap" style={{ minWidth: 0, flexShrink: 0 }}>
											{badge}
											{balance}
											{headerActions}
										</Group>
									</Menu.Label>
								);
							})()}
							{models.map((m) => {
								// For aggregation items, check if the current model's aggId matches
								const isAggItem = m.provider === "__agg__";
								const aggId = isAggItem ? m.value.slice(AGG_MODEL_PREFIX.length) : null;
								const selected = isAggItem
									? currentAgg?.aggId === aggId
									: selection.value === m.value;
								// Default/Summary rows sit under a role header, not a provider group,
								// so surface the resolved target's provider prefix as a small line.
								const roleTargetValue =
									m.provider === "__default__"
										? defaultModelValue
										: m.provider === "__summary__"
											? summaryModelValue
											: null;
								const roleProviderPrefix = modelProviderPrefix(roleTargetValue);
								const showMembers = isAggItem && selected && selection.members.length > 0;
								// Three-dot actions only on top-level rows that can actually occupy a
								// global slot. Meta sentinels would make the slot circular.
								// A delisted-but-pinned model must not offer "set as default/summary" —
								// that would just re-affirm the dead pin. Offer the role pickers instead.
								const isCatalogMissing = m.catalogMissing === true;
								const canAssignRole =
									canAssignGlobalModelRole(m.value) &&
									!!(onSetAsDefaultModel || onSetAsSummaryModel) &&
									!isCatalogMissing;
								const rowActions: Array<{
									key: "details" | "default" | "summary";
									label: string;
									current: boolean;
									onSelect: () => void;
								}> = [];
								if (onShowPrice && !m.value.startsWith(AGG_MODEL_PREFIX)) {
									rowActions.push({
										key: "details",
										label: ts("catalog.details"),
										current: false,
										onSelect: () => {
											const actualValue =
												m.provider === "__default__"
													? defaultModelValue
													: m.provider === "__summary__"
														? summaryModelValue
														: m.value;
											onShowPrice(actualValue ? { ...m, value: actualValue } : m);
										},
									});
								}
								if (isCatalogMissing) {
									if (onEditDefaultModel) {
										rowActions.push({
											key: "default",
											label: t("editDefaultModel"),
											current: !!defaultModelValue && defaultModelValue === m.value,
											onSelect: () => onEditDefaultModel(),
										});
									}
									if (onEditSummaryModel) {
										rowActions.push({
											key: "summary",
											label: t("editSummaryModel"),
											current: !!summaryModelValue && summaryModelValue === m.value,
											onSelect: () => onEditSummaryModel(),
										});
									}
								} else if (canAssignRole) {
									if (onSetAsDefaultModel) {
										rowActions.push({
											key: "default",
											label: t("setAsDefaultModel"),
											current: !!defaultModelValue && defaultModelValue === m.value,
											onSelect: () => onSetAsDefaultModel(m.value),
										});
									}
									if (onSetAsSummaryModel) {
										rowActions.push({
											key: "summary",
											label: t("setAsSummaryModel"),
											current: !!summaryModelValue && summaryModelValue === m.value,
											onSelect: () => onSetAsSummaryModel(m.value),
										});
									}
								}
								const showActionsToggle = rowActions.length > 0;
								const actionsOpen = showActionsToggle && actionsModelValue === m.value;
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
												{roleProviderPrefix && (
													<Text size="xs" c="dimmed" lh={1.3}>
														{roleProviderPrefix}
													</Text>
												)}
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
										{actionsOpen && (
											<Box onClick={(e) => e.stopPropagation()} data-model-role-actions={m.value}>
												{rowActions.map((action) => (
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
