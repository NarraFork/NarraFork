import {
	ActionIcon,
	Avatar,
	Box,
	Button,
	Group,
	Indicator,
	Loader,
	Menu,
	NativeSelect,
	Popover,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { IconLock, IconLockOpen, IconShield, IconTerminal } from "@tabler/icons-react";
import type React from "react";
import {
	AGG_MODEL_PREFIX,
	FOLLOW_DEFAULT_MODEL,
	type ModelOption,
	parseAggModelValue,
	statusRegistry,
} from "../../../lib/constants";
import { TruncatedText } from "../../common/TruncatedText";
import { UserAvatar } from "../../UserAvatar";
import { CodexQuotaIndicator } from "../CodexQuotaIndicator";
import { ModelMenuItems } from "../ModelMenuItems";
import {
	BackgroundTasksStatusButton,
	NarratorStatusBar,
	NarratorStatusToolbar,
	type NarratorStatusToolbarAction,
} from "../NarratorStatusToolbar";
import { PERM_MODE_ICONS, PERM_MODES } from "../narrator-panel-types";
import type {
	getNarratorStatusBarDisplay,
	planNarratorWorkIndicator,
} from "../narrator-status-bar";
import { InlineOverrideActions } from "./InlineOverrideActions";
import { PathRulesPopover } from "./PathRulesPopover";
import { PermissionMenuContent } from "./PermissionMenuContent";
import { ReasoningEffortMenuItems } from "./ReasoningEffortMenuItems";
import type {
	BooleanOverride,
	DangerReflectionLevel,
	DangerReflectionOverride,
} from "./reflection-types";
import { TurnElapsedTime } from "./TurnElapsedTime";

type ReasoningEffortValue = "none" | "low" | "medium" | "high" | "xhigh" | "max";
type StatusBarDisplay = ReturnType<typeof getNarratorStatusBarDisplay>;
type WorkIndicatorPlan = ReturnType<typeof planNarratorWorkIndicator>;

// Options for the permission-mode NativeSelect trigger. Derived from the shared
// PERM_MODES so the label keys stay in lockstep with the menu items.
const PERM_MODE_DATA = PERM_MODES.map((m) => ({ value: m, label: `perm_${m}` }));

interface ViewerInfo {
	userId: string;
	username: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
}

interface CompactFailureInfo {
	error?: string | null;
}

export interface NarratorInteractionStatusBarProps {
	// Layout / identity
	narratorId: string;
	/** The narrator object (read-only display of model/permissionMode/etc.). */
	narrator: {
		model?: string | null;
		permissionMode?: string | null;
		totalCostUsd?: number | null;
		isAskInPassing?: boolean | null;
		chapterId?: string | null;
	};
	ownsHorizontalSafeArea?: boolean;
	borderTop?: string;
	isWorkspacePreview: boolean;
	compact?: boolean;
	isMobileViewport: boolean;

	workIndicator: {
		show: boolean;
		color: string;
		text: string;
		plan: WorkIndicatorPlan;
		statusBarDisplay: StatusBarDisplay;
		isRetrying: boolean;
		isCompacting: boolean;
		currentSpecTask: unknown;
		compactingMarkerMessageId: string | null;
		compactFailure: CompactFailureInfo | null;
		compactProgressFragment: string;
		turnElapsedText: string | null;
		turnStartedAtLabel: string | null;
		onOpenSpecTool: () => void;
		onScrollToMessageTarget: (opts: {
			domIds: string[];
			targetIds: string[];
			highlightId: string;
		}) => void;
	};

	queue: {
		positionValue: number | null;
		depthValue: number | null;
		messageValue: string | null;
	};

	tasks: {
		supported: boolean;
		buttonEnabled: boolean;
		runningCount: number;
		onOpenPanel: () => void;
	};

	model: {
		allModels: ModelOption[];
		// biome-ignore lint/suspicious/noExplicitAny: aggregation/provider-label shapes come straight from NarratorPanel.
		aggregations: any;
		// biome-ignore lint/suspicious/noExplicitAny: provider label map passthrough.
		providerLabels: any;
		defaultModelValue: string;
		menuOpenDesktop: boolean;
		setMenuOpenDesktop: (o: boolean) => void;
		menuOpenMobile: boolean;
		setMenuOpenMobile: (o: boolean) => void;
		priceModel: ModelOption | null;
		setPriceModel: (m: ModelOption | null) => void;
		// biome-ignore lint/suspicious/noExplicitAny: refresh props are spread verbatim onto ModelMenuItems.
		refreshProps: any;
		// biome-ignore lint/suspicious/noExplicitAny: mutation object passthrough from useUpdateModel.
		mutation: any;
		onEditDefaultModel: () => void;
		onEditSummaryModel: () => void;
	};

	reasoning: {
		supported: boolean;
		displayed: string;
		options: readonly ReasoningEffortValue[];
		followsDefault: boolean;
		// biome-ignore lint/suspicious/noExplicitAny: mutation object passthrough.
		mutation: any;
		onFollowDefault: () => void;
		onSetAsDefault: () => void;
	};

	permission: {
		availableModes: string[];
		unavailableReason?: string;
		// biome-ignore lint/suspicious/noExplicitAny: mutation object passthrough.
		mutation: any;
		hasPlanTrait: boolean;
		togglePlanMode: () => void;
		planModePending: boolean;
		planModeSupported: boolean;
		planModeUnsupportedReason?: string;
		planReflection: {
			supported: boolean;
			override: BooleanOverride;
			effective: boolean;
			global: boolean;
			onChange: (value: BooleanOverride) => void;
			onFollowDefault: () => void;
			onSetAsDefault: () => void;
		};
		dangerReflection: {
			supported: boolean;
			override: DangerReflectionOverride;
			effectiveLevel: DangerReflectionLevel;
			globalLevel: DangerReflectionLevel;
			onChange: (value: DangerReflectionOverride) => void;
			onFollowDefault: () => void;
			onSetAsDefault: () => void;
		};
		reflectionSettingsDisabled: boolean;
	};

	codexControls: {
		supportsCodexControls: boolean;
		isBuiltInCodexModel: boolean;
		renderFastModeControl: (position: "top-end" | "bottom-end") => React.ReactNode;
	};

	quota: {
		balance: string | null;
		detailsText: string | null;
		detailsOpened: boolean;
		setDetailsOpened: (updater: boolean | ((o: boolean) => boolean)) => void;
		hasDetailsPopover: boolean;
		onCancelDetailsClose: () => void;
		onScheduleDetailsClose: () => void;
		shouldShowNugRechargeButton: boolean;
		shouldShowNugRechargeInQuotaDetails: boolean;
		onOpenNugRecharge: () => void;
	};

	relaxedPlan: {
		enabled: boolean;
		forced: boolean;
		// biome-ignore lint/suspicious/noExplicitAny: mutation object passthrough.
		mutation: any;
	};

	terminal: {
		toolAvailable: boolean;
		toolOpened: boolean;
		activeCount: number;
		onOpenPanel?: () => void;
		onToggle: () => void;
	};

	promote: {
		show: boolean;
		pending: boolean;
		onPromote: () => void;
	};

	viewers: ViewerInfo[];
	currentUser: { role?: string | null } | null;

	mobile: {
		actions: NarratorStatusToolbarAction[];
		measurementKey: string;
	};

	contextIndicator: React.ReactNode;

	/** narrator translation fn (namespace "narrator"). */
	t: (key: string, opts?: Record<string, unknown>) => string;
	/** terminal translation fn (namespace "terminal"). */
	tt: (key: string) => string;
}

export function NarratorInteractionStatusBar(props: NarratorInteractionStatusBarProps) {
	const {
		narrator,
		narratorId,
		isWorkspacePreview,
		compact,
		isMobileViewport,
		workIndicator,
		tasks,
		model,
		reasoning,
		permission,
		codexControls,
		quota,
		relaxedPlan,
		terminal,
		promote,
		viewers,
		currentUser,
		mobile,
		contextIndicator,
		t,
		tt,
	} = props;

	return (
		<NarratorStatusBar
			ownsHorizontalSafeArea={props.ownsHorizontalSafeArea}
			borderTop={props.borderTop}
		>
			{workIndicator.show && !isWorkspacePreview ? (
				<UnstyledButtonWorkIndicator {...props} />
			) : (
				<Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
					<Box
						w={8}
						h={8}
						style={{
							borderRadius: "50%",
							backgroundColor: statusRegistry.accentVar(workIndicator.statusBarDisplay, "filled"),
							flexShrink: 0,
						}}
					/>
					<TruncatedText size="xs" c="dimmed" text={t(workIndicator.statusBarDisplay.labelKey)} />
					{tasks.supported && tasks.buttonEnabled && (
						<BackgroundTasksStatusButton
							runningCount={tasks.runningCount}
							onOpen={tasks.onOpenPanel}
						/>
					)}
					{workIndicator.compactFailure && !workIndicator.isCompacting && (
						<Text
							size="xs"
							c="red"
							style={{ flexShrink: 0 }}
							title={workIndicator.compactFailure.error || undefined}
						>
							· {t("compactFailed")}
						</Text>
					)}
					{workIndicator.turnElapsedText && !isWorkspacePreview && (
						<TurnElapsedTime
							text={`· ${t("lastTurnDuration", { duration: workIndicator.turnElapsedText })}`}
							startedAtLabel={workIndicator.turnStartedAtLabel}
							isMobile={isMobileViewport}
						/>
					)}
				</Group>
			)}
			{workIndicator.show && !isWorkspacePreview && workIndicator.turnElapsedText && (
				<TurnElapsedTime
					text={workIndicator.turnElapsedText}
					startedAtLabel={workIndicator.turnStartedAtLabel}
					isMobile={isMobileViewport}
				/>
			)}

			{isWorkspacePreview ? (
				<Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
					{contextIndicator}
				</Group>
			) : (
				<>
					{/* Model & Permission selectors */}
					<Group gap={6} wrap="nowrap" style={{ flexShrink: 1, minWidth: 0 }}>
						{/* Viewers */}
						{viewers.length > 1 && (
							<Tooltip label={`${t("viewingNow")}: ${viewers.map((v) => v.username).join(", ")}`}>
								<Avatar.Group spacing="xs">
									{viewers.slice(0, 3).map((v) => (
										<UserAvatar
											key={v.userId}
											username={v.username}
											avatarColor={v.avatarColor}
											avatarImageId={v.avatarImageId}
											userId={v.userId}
											size={22}
											showTooltip={false}
										/>
									))}
									{viewers.length > 3 && (
										<Avatar size={22} radius="xl">
											+{viewers.length - 3}
										</Avatar>
									)}
								</Avatar.Group>
							</Tooltip>
						)}
						{contextIndicator}
						<CodexQuotaIndicator
							enabled={codexControls.isBuiltInCodexModel && !isWorkspacePreview}
							isAdmin={currentUser?.role === "admin"}
							compact={isMobileViewport}
						/>
						{/* Generic gateway/API quota balance */}
						{quota.balance != null &&
							(quota.hasDetailsPopover ? (
								<Popover
									opened={quota.detailsOpened}
									onChange={quota.setDetailsOpened}
									position="top"
									withArrow
									withinPortal
									shadow="md"
								>
									<Popover.Target>
										<UnstyledButton
											onClick={(event) => {
												event.stopPropagation();
												quota.onCancelDetailsClose();
												quota.setDetailsOpened((opened) => !opened);
											}}
											onPointerEnter={() => {
												if (!isMobileViewport) {
													quota.onCancelDetailsClose();
													quota.setDetailsOpened(true);
												}
											}}
											onPointerLeave={() => {
												if (!isMobileViewport) quota.onScheduleDetailsClose();
											}}
											style={{ flexShrink: 0, maxWidth: 120 }}
										>
											<Text
												size="xs"
												c="dimmed"
												style={{
													cursor: "pointer",
													maxWidth: 120,
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
												}}
											>
												{quota.balance}
											</Text>
										</UnstyledButton>
									</Popover.Target>
									<Popover.Dropdown
										maw={360}
										onPointerEnter={() => {
											if (!isMobileViewport) quota.onCancelDetailsClose();
										}}
										onPointerLeave={() => {
											if (!isMobileViewport) quota.onScheduleDetailsClose();
										}}
									>
										<Stack gap={6}>
											{quota.detailsText && (
												<Text
													size="xs"
													style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
												>
													{quota.detailsText}
												</Text>
											)}
											{quota.shouldShowNugRechargeInQuotaDetails && (
												<Button
													size="compact-xs"
													variant="light"
													onClick={() => {
														quota.setDetailsOpened(false);
														quota.onOpenNugRecharge();
													}}
												>
													{t("recharge.open")}
												</Button>
											)}
										</Stack>
									</Popover.Dropdown>
								</Popover>
							) : (
								// No details popover here, so the clipped balance needs its own
								// hover/tap reveal.
								<TruncatedText
									size="xs"
									c="dimmed"
									text={quota.balance}
									style={{ flexShrink: 0, maxWidth: 120 }}
								/>
							))}
						{quota.shouldShowNugRechargeButton && (
							<Button size="compact-xs" variant="subtle" onClick={quota.onOpenNugRecharge}>
								{t("recharge.open")}
							</Button>
						)}
						{/* Desktop selects */}
						{!compact && (
							<Group gap={6} wrap="nowrap" visibleFrom="sm">
								<Tooltip label={t("modelTooltip")}>
									<Menu
										position="top-end"
										opened={model.menuOpenDesktop}
										onChange={(o) => {
											// Don't let the price popup's outside-click close the menu.
											if (!o && model.priceModel != null) return;
											model.setMenuOpenDesktop(o);
										}}
									>
										<Menu.Target>
											<NativeSelect
												size="xs"
												// The menu renders the full catalog; the trigger only needs
												// the selected option so native sizing ignores longer models.
												data={model.allModels
													.filter((m) => {
														const raw = narrator.model ?? FOLLOW_DEFAULT_MODEL;
														const agg = parseAggModelValue(raw);
														return m.value === (agg ? `${AGG_MODEL_PREFIX}${agg.aggId}` : raw);
													})
													.map((m) => ({
														value: m.value,
														label:
															m.value === FOLLOW_DEFAULT_MODEL
																? t("followDefault", { model: model.defaultModelValue })
																: m.provider === "__agg__"
																	? `⚡ ${m.label}`
																	: m.provider
																		? `${m.provider}:${m.label}`
																		: m.label,
													}))}
												value={(() => {
													const raw = narrator.model ?? FOLLOW_DEFAULT_MODEL;
													const agg = parseAggModelValue(raw);
													// For pinned aggregation, map back to the base agg value
													if (agg) return `${AGG_MODEL_PREFIX}${agg.aggId}`;
													return raw;
												})()}
												onChange={() => {}}
												onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
												style={{ pointerEvents: "auto" }}
											/>
										</Menu.Target>
										<Menu.Dropdown
											data-model-menu-scroll
											style={{ maxHeight: "60vh", overflowY: "auto" }}
										>
											<ModelMenuItems
												opened={model.menuOpenDesktop}
												aggregations={model.aggregations}
												allModels={model.allModels}
												currentModel={narrator.model}
												totalCostUsd={narrator.totalCostUsd}
												onSelect={(v) => model.mutation.mutate({ id: narratorId, model: v })}
												onShowPrice={model.setPriceModel}
												providerLabels={model.providerLabels}
												onEditDefaultModel={model.onEditDefaultModel}
												onEditSummaryModel={model.onEditSummaryModel}
												{...model.refreshProps}
											/>
										</Menu.Dropdown>
									</Menu>
								</Tooltip>

								{/* Reasoning Effort (Codex + Anthropic providers) */}
								{reasoning.supported && (
									<Menu position="top-end">
										<Menu.Target>
											<NativeSelect
												size="xs"
												data={[
													{
														value: reasoning.displayed,
														label: t(`reasoning_${reasoning.displayed}`),
													},
												]}
												value={reasoning.displayed}
												onChange={() => {}}
												onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
												style={{ pointerEvents: "auto" }}
											/>
										</Menu.Target>
										<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
											<ReasoningEffortMenuItems
												currentEffort={reasoning.displayed}
												options={reasoning.options}
												onSelect={(e) =>
													reasoning.mutation.mutate({ id: narratorId, reasoningEffort: e })
												}
												t={t}
											/>
											{!reasoning.followsDefault && (
												<Box px="sm" py={4} onClick={(event) => event.stopPropagation()}>
													<InlineOverrideActions
														visible
														disabled={reasoning.mutation.isPending}
														onFollowDefault={reasoning.onFollowDefault}
														onSetAsDefault={reasoning.onSetAsDefault}
														t={t}
													/>
												</Box>
											)}
										</Menu.Dropdown>
									</Menu>
								)}
								{/* Fast Mode toggle (only for Codex-mode providers) */}
								{codexControls.supportsCodexControls &&
									!isMobileViewport &&
									codexControls.renderFastModeControl("top-end")}
								<Tooltip
									label={
										narrator.isAskInPassing ? t("askInPassing_readOnlyHint") : t("permissionMode")
									}
								>
									{narrator.isAskInPassing ? (
										<NativeSelect
											size="xs"
											leftSection={PERM_MODE_ICONS.readOnly ?? <IconShield size={14} />}
											data={[{ value: "readOnly", label: t("perm_readOnly") }]}
											value="readOnly"
											onChange={() => {}}
											disabled
											style={{ pointerEvents: "auto", opacity: 0.6 }}
										/>
									) : (
										<Menu position="top-end">
											<Menu.Target>
												<NativeSelect
													size="xs"
													leftSection={
														PERM_MODE_ICONS[narrator.permissionMode ?? "default"] ?? (
															<IconShield size={14} />
														)
													}
													data={PERM_MODE_DATA.map((d) => ({
														value: d.value,
														label: t(d.label),
													}))}
													value={narrator.permissionMode ?? "default"}
													onChange={() => {}}
													onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
													style={{ pointerEvents: "auto" }}
												/>
											</Menu.Target>
											<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
												<PermissionMenuContent
													currentMode={narrator.permissionMode ?? "default"}
													availablePermissionModes={permission.availableModes}
													permissionModesUnavailableReason={permission.unavailableReason}
													onSelectPermissionMode={(m) =>
														permission.mutation.mutate({ id: narratorId, permissionMode: m })
													}
													t={t}
													hasPlanTrait={permission.hasPlanTrait}
													onTogglePlanMode={permission.togglePlanMode}
													planModePending={permission.planModePending}
													planModeSupported={permission.planModeSupported}
													planModeUnsupportedReason={permission.planModeUnsupportedReason}
													showPlanReflectionAutoApproveToggle={
														permission.planReflection.supported &&
														((narrator.permissionMode ?? "default") === "acceptEdits" ||
															(narrator.permissionMode ?? "default") === "bypassPermissions")
													}
													planReflectionAutoApproveOverride={permission.planReflection.override}
													planReflectionAutoApproveEffective={permission.planReflection.effective}
													planReflectionAutoApproveGlobal={permission.planReflection.global}
													onPlanReflectionAutoApproveChange={permission.planReflection.onChange}
													onFollowDefaultPlanReflection={permission.planReflection.onFollowDefault}
													onSetPlanReflectionAsDefault={permission.planReflection.onSetAsDefault}
													showDangerReflectionToggle={permission.dangerReflection.supported}
													dangerReflectionOverride={permission.dangerReflection.override}
													dangerReflectionEffectiveLevel={
														permission.dangerReflection.effectiveLevel
													}
													dangerReflectionGlobalLevel={permission.dangerReflection.globalLevel}
													onDangerReflectionChange={permission.dangerReflection.onChange}
													onFollowDefaultDangerReflection={
														permission.dangerReflection.onFollowDefault
													}
													onSetDangerReflectionAsDefault={
														permission.dangerReflection.onSetAsDefault
													}
													reflectionSettingsDisabled={permission.reflectionSettingsDisabled}
												/>
											</Menu.Dropdown>
										</Menu>
									)}
								</Tooltip>
								{promote.show && (
									<Tooltip
										label={
											narrator.chapterId ? t("promote_chapter_hint") : t("promote_standalone_hint")
										}
									>
										<Button
											size="xs"
											variant="light"
											color="teal"
											loading={promote.pending}
											onClick={promote.onPromote}
										>
											{t("promote")}
										</Button>
									</Tooltip>
								)}
								<PathRulesPopover narratorId={narratorId} t={t} />
								{/* Relaxed Plan toggle (only visible in plan mode) */}
								{permission.hasPlanTrait && (
									<Tooltip
										label={
											relaxedPlan.forced
												? t("relaxed_plan_forced_tooltip")
												: t("relaxed_plan_tooltip")
										}
									>
										<ActionIcon
											variant="subtle"
											color={relaxedPlan.enabled ? "teal" : "gray"}
											size="sm"
											aria-label={t("relaxed_plan")}
											disabled={relaxedPlan.forced || relaxedPlan.mutation.isPending}
											onClick={() =>
												relaxedPlan.mutation.mutate({
													id: narratorId,
													relaxedPlan: !relaxedPlan.enabled,
												})
											}
										>
											{relaxedPlan.enabled ? <IconLockOpen size={16} /> : <IconLock size={16} />}
										</ActionIcon>
									</Tooltip>
								)}
								{(terminal.toolAvailable || terminal.onOpenPanel) && (
									<Tooltip
										label={
											terminal.onOpenPanel
												? tt("openTerminal")
												: terminal.toolOpened
													? tt("closeTerminal")
													: tt("openTerminal")
										}
									>
										<Indicator
											inline
											label={terminal.activeCount}
											size={14}
											disabled={terminal.activeCount === 0}
											offset={2}
											color="blue"
											style={{
												height: "var(--ai-size-sm)",
												display: "flex",
												alignItems: "center",
											}}
										>
											<ActionIcon
												variant="subtle"
												color={terminal.toolOpened ? "blue" : "gray"}
												size="sm"
												aria-label={
													terminal.onOpenPanel
														? tt("openTerminal")
														: terminal.toolOpened
															? tt("closeTerminal")
															: tt("openTerminal")
												}
												onClick={terminal.onOpenPanel ?? terminal.onToggle}
											>
												<IconTerminal size={16} />
											</ActionIcon>
										</Indicator>
									</Tooltip>
								)}
							</Group>
						)}
						{/* Mobile: model & permission */}
						<Box
							style={{ minWidth: 0, width: "100%" }}
							{...(compact ? {} : { hiddenFrom: "sm" as const })}
						>
							<NarratorStatusToolbar
								leading={
									<>
										<Tooltip label={t("modelTooltip")}>
											<Menu
												position="bottom-end"
												withinPortal
												opened={model.menuOpenMobile}
												onChange={(o) => {
													if (!o && model.priceModel != null) return;
													model.setMenuOpenMobile(o);
												}}
											>
												<Menu.Target>
													<ActionIcon
														variant="subtle"
														color="gray"
														size="sm"
														aria-label={t("modelTooltip")}
													>
														<Text size="xs" fw={600}>
															{(() => {
																if (narrator.model === FOLLOW_DEFAULT_MODEL || !narrator.model)
																	return "D";
																const m = model.allModels.find((x) => x.value === narrator.model);
																// charAt(0) is safe on empty strings ("" → ""); fall back to "?"
																// so an empty label never produces `undefined.toUpperCase()`.
																return (
																	(m?.label || narrator.model || "?").charAt(0).toUpperCase() || "?"
																);
															})()}
														</Text>
													</ActionIcon>
												</Menu.Target>
												<Menu.Dropdown
													data-model-menu-scroll
													style={{ maxHeight: "60vh", overflowY: "auto" }}
												>
													<ModelMenuItems
														opened={model.menuOpenMobile}
														aggregations={model.aggregations}
														allModels={model.allModels}
														currentModel={narrator.model}
														totalCostUsd={narrator.totalCostUsd}
														onSelect={(v) => model.mutation.mutate({ id: narratorId, model: v })}
														onShowPrice={model.setPriceModel}
														label={t("modelTooltip")}
														providerLabels={model.providerLabels}
														onEditDefaultModel={model.onEditDefaultModel}
														onEditSummaryModel={model.onEditSummaryModel}
														{...model.refreshProps}
													/>
												</Menu.Dropdown>
											</Menu>
										</Tooltip>

										{/* Reasoning Effort (Codex + Anthropic providers) - Mobile */}
										{reasoning.supported && (
											<Menu position="bottom-end" withinPortal>
												<Menu.Target>
													<ActionIcon
														variant="subtle"
														color="gray"
														size="sm"
														aria-label={t("reasoningEffort")}
													>
														<Text size="xs" fw={600}>
															{(() => {
																const effortMap = {
																	none: "O",
																	low: "L",
																	medium: "M",
																	high: "H",
																	xhigh: "X",
																	max: "MX",
																};
																return (
																	effortMap[reasoning.displayed as keyof typeof effortMap] ?? "A"
																);
															})()}
														</Text>
													</ActionIcon>
												</Menu.Target>
												<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
													<ReasoningEffortMenuItems
														currentEffort={reasoning.displayed}
														options={reasoning.options}
														onSelect={(e) =>
															reasoning.mutation.mutate({ id: narratorId, reasoningEffort: e })
														}
														t={t}
													/>
													{!reasoning.followsDefault && (
														<Box px="sm" py={4} onClick={(event) => event.stopPropagation()}>
															<InlineOverrideActions
																visible
																disabled={reasoning.mutation.isPending}
																onFollowDefault={reasoning.onFollowDefault}
																onSetAsDefault={reasoning.onSetAsDefault}
																t={t}
															/>
														</Box>
													)}
												</Menu.Dropdown>
											</Menu>
										)}
										{/* Fast Mode toggle (only for Codex-mode providers) - Mobile */}
										{codexControls.supportsCodexControls &&
											(compact || isMobileViewport) &&
											codexControls.renderFastModeControl("bottom-end")}
										<Tooltip
											label={
												narrator.isAskInPassing
													? t("askInPassing_readOnlyHint")
													: t("permissionMode")
											}
										>
											{narrator.isAskInPassing ? (
												<ActionIcon
													variant="subtle"
													color="gray"
													size="sm"
													aria-label={t("askInPassing_readOnlyHint")}
													disabled
													style={{ opacity: 0.6 }}
												>
													{PERM_MODE_ICONS.readOnly ?? <IconShield size={16} />}
												</ActionIcon>
											) : (
												<Menu position="bottom-end" withinPortal>
													<Menu.Target>
														<ActionIcon
															variant="subtle"
															color="gray"
															size="sm"
															aria-label={t("permissionMode")}
														>
															{PERM_MODE_ICONS[narrator.permissionMode ?? "default"] ?? (
																<IconShield size={16} />
															)}
														</ActionIcon>
													</Menu.Target>
													<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
														<PermissionMenuContent
															currentMode={narrator.permissionMode ?? "default"}
															availablePermissionModes={permission.availableModes}
															permissionModesUnavailableReason={permission.unavailableReason}
															onSelectPermissionMode={(m) =>
																permission.mutation.mutate({ id: narratorId, permissionMode: m })
															}
															t={t}
															hasPlanTrait={permission.hasPlanTrait}
															onTogglePlanMode={permission.togglePlanMode}
															planModePending={permission.planModePending}
															planModeSupported={permission.planModeSupported}
															planModeUnsupportedReason={permission.planModeUnsupportedReason}
															showPlanReflectionAutoApproveToggle={
																permission.planReflection.supported &&
																((narrator.permissionMode ?? "default") === "acceptEdits" ||
																	(narrator.permissionMode ?? "default") === "bypassPermissions")
															}
															planReflectionAutoApproveOverride={permission.planReflection.override}
															planReflectionAutoApproveEffective={
																permission.planReflection.effective
															}
															planReflectionAutoApproveGlobal={permission.planReflection.global}
															onPlanReflectionAutoApproveChange={permission.planReflection.onChange}
															onFollowDefaultPlanReflection={
																permission.planReflection.onFollowDefault
															}
															onSetPlanReflectionAsDefault={
																permission.planReflection.onSetAsDefault
															}
															showDangerReflectionToggle={permission.dangerReflection.supported}
															dangerReflectionOverride={permission.dangerReflection.override}
															dangerReflectionEffectiveLevel={
																permission.dangerReflection.effectiveLevel
															}
															dangerReflectionGlobalLevel={permission.dangerReflection.globalLevel}
															onDangerReflectionChange={permission.dangerReflection.onChange}
															onFollowDefaultDangerReflection={
																permission.dangerReflection.onFollowDefault
															}
															onSetDangerReflectionAsDefault={
																permission.dangerReflection.onSetAsDefault
															}
															reflectionSettingsDisabled={permission.reflectionSettingsDisabled}
														/>
													</Menu.Dropdown>
												</Menu>
											)}
										</Tooltip>
									</>
								}
								actions={mobile.actions}
								moreLabel={t("moreActions")}
								measurementKey={mobile.measurementKey}
							/>
						</Box>
					</Group>
				</>
			)}
		</NarratorStatusBar>
	);
}

/**
 * The "working" left segment: a clickable work indicator (spinner + current task
 * text + queue/compaction suffixes). Split out only to keep the main component's
 * JSX flatter; it reads the same grouped props.
 */
function UnstyledButtonWorkIndicator(props: NarratorInteractionStatusBarProps) {
	const { workIndicator, queue, t } = props;
	return (
		<UnstyledButton
			disabled={
				workIndicator.isRetrying || (!workIndicator.currentSpecTask && !workIndicator.isCompacting)
			}
			onClick={() => {
				if (workIndicator.isRetrying) return;
				if (workIndicator.isCompacting) {
					if (!workIndicator.compactingMarkerMessageId) return;
					void workIndicator.onScrollToMessageTarget({
						domIds: [`msg-${workIndicator.compactingMarkerMessageId}`],
						targetIds: [workIndicator.compactingMarkerMessageId],
						highlightId: workIndicator.compactingMarkerMessageId,
					});
					return;
				}
				if (!workIndicator.currentSpecTask) return;
				// Task state lives in the Dynamic Spec (spec://tasks.json); open the
				// Spec panel instead of jumping to a (now-removed) todo tool call.
				workIndicator.onOpenSpecTool();
			}}
			style={{ minWidth: 0, flex: 1 }}
		>
			<Group gap={6} wrap="nowrap">
				<Loader size={14} color={workIndicator.color} style={{ flexShrink: 0 }} />
				{/* The current task text can be long (spec task titles especially), so
				    reveal the full string on hover/tap when the row clips it. */}
				<TruncatedText size="xs" c={workIndicator.color} text={workIndicator.text} />
				{((queue.positionValue != null && queue.positionValue > 0) || queue.messageValue) && (
					<Text size="xs" c="yellow" style={{ flexShrink: 0 }}>
						·{" "}
						{queue.messageValue ??
							t(
								queue.depthValue != null && queue.depthValue > 0
									? "queuePositionWithDepth"
									: "queuePosition",
								{ position: queue.positionValue, queueDepth: queue.depthValue },
							)}
					</Text>
				)}
				{workIndicator.plan.showBackgroundCompactSuffix && (
					<Text size="xs" c="orange" style={{ flexShrink: 0 }}>
						· {t("backgroundCompactingShort")} · {workIndicator.compactProgressFragment}
					</Text>
				)}
				{workIndicator.plan.showCompactFailureSuffix && (
					<Text
						size="xs"
						c="red"
						style={{ flexShrink: 0 }}
						title={workIndicator.compactFailure?.error || undefined}
					>
						· {t("compactFailed")}
					</Text>
				)}
			</Group>
		</UnstyledButton>
	);
}
