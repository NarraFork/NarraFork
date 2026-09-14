import { ActionIcon, Group, Indicator, Tooltip } from "@mantine/core";
import { IconFlask, IconX } from "@tabler/icons-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
	type PluginContributionPick,
	PluginContributionPicker,
} from "../../plugins/PluginContributionPicker";
import type { NarratorDockContextValue } from "../dock/NarratorDockContext";
import { ExecutionDeviceMenu } from "../model/ExecutionDeviceMenu";
import { NarratorLodMenu } from "../lod/NarratorLodMenu";
import type { RenderLod } from "../lod/RenderLodCtx";
import type { MobileToolPanelKind } from "../MobileToolPanelHost";
import { NarratorToolbarOverflowMenu } from "./NarratorToolbarOverflowMenu";
import { HEADER_TOOLBAR_FIXED_ATTR } from "./narrator-header-toolbar-capacity";
import {
	type NarratorToolbarBadgeCounts,
	resolveNarratorToolbarBadge,
} from "./narrator-toolbar-badges";
import type { NarratorToolbarHost } from "./narrator-toolbar-items";
import { useHeaderToolbar } from "./use-header-toolbar";

// biome-ignore lint/suspicious/noExplicitAny: react-query result passthrough from NarratorPanel.
type QueryLike = any;
// biome-ignore lint/suspicious/noExplicitAny: react-query mutation passthrough from NarratorPanel.
type MutationLike = any;

export interface HeaderToolbarProps {
	// ── Layout measurement anchors (also read by the toolbar hook) ──
	/** Width-measurement anchor for the capacity ResizeObserver. */
	headerToolbarRef: RefObject<HTMLDivElement | null>;
	headerRowRef: RefObject<HTMLDivElement | null>;
	headerLeadingRef: RefObject<HTMLDivElement | null>;
	hostOwnsTitle: boolean;
	isWorkspacePreview: boolean;
	isMobileViewport: boolean;

	toolbarBadgeCounts: NarratorToolbarBadgeCounts;
	headerHostCapabilities: readonly NarratorToolbarHost[];

	// ── Per-entry availability inputs (drive which entries the row offers) ──
	chapterId: string | null | undefined;
	tasksSupported: boolean;
	tasksButtonEnabled: boolean;
	specToolAvailable: boolean;
	terminalToolAvailable: boolean;
	onOpenTerminalPanel: (() => void) | undefined;
	browserSessionsSupported: boolean | undefined;

	// ── Active-state inputs (drive active styling) ──
	mobileTasksOpen: boolean;
	mobileToolPanel: MobileToolPanelKind | null;
	fileModDrawerOpened: boolean;
	detailsOpened: boolean;
	terminalToolOpened: boolean;
	specToolOpened: boolean;

	// ── Activation actions ──
	setMobileTasksOpen: Dispatch<SetStateAction<boolean>>;
	setMobileToolPanel: Dispatch<SetStateAction<MobileToolPanelKind | null>>;
	setFileModDrawerOpened: Dispatch<SetStateAction<boolean>>;
	toggleDetails: () => void;
	toggleTerminalTool: () => void;
	toggleSpecTool: () => void;

	openArchiveConfirm: () => void;
	archiveMutation: MutationLike;
	// Device entry
	executionDevicesQuery: QueryLike;
	updateExecutionDeviceMutation: MutationLike;
	// LOD entry
	renderLod: RenderLod;
	renderLodIsDefault: boolean;
	handleSelectLod: (lod: RenderLod) => void;
	setAsDefault: () => void;
	// Plugins entry
	openPluginPanel: (pick: PluginContributionPick) => void;
	// Mock-stream debug entry
	dock: NarratorDockContextValue | null;
	mockStreamEnabled: boolean;
	/** Close-panel button; omit when the panel is not closeable. */
	onClose?: () => void;
	/** narrator translation fn (namespace "narrator"). */
	t: (key: string, opts?: Record<string, unknown>) => string;
}

/**
 * The header tool row: registry-driven entry buttons (with the device / LOD /
 * plugins self-contained entries), the debug mock-stream entry and the overflow
 * menu. Extracted verbatim from NarratorPanel; the layout/capacity/activation
 * logic stays there and feeds this component the already-decided defs and
 * handlers, so nothing about the measurement or ordering behaviour changes.
 */
export function HeaderToolbar(props: HeaderToolbarProps) {
	const {
		headerToolbarRef,
		toolbarBadgeCounts,
		headerHostCapabilities,
		openArchiveConfirm,
		archiveMutation,
		executionDevicesQuery,
		updateExecutionDeviceMutation,
		renderLod,
		renderLodIsDefault,
		handleSelectLod,
		setAsDefault,
		openPluginPanel,
		dock,
		mockStreamEnabled,
		onClose,
		t,
	} = props;

	// The toolbar's availability / layout / activation / inline-options logic lives
	// here now (co-located with the row it drives), fed the raw capability, active
	// state and action inputs the panel used to pre-compute into props.
	const {
		toolbarEntries,
		toolbarVisibleDefs,
		toolbarHiddenDefs,
		toolbarNoRoomIds,
		saveToolbarLayout,
		toolbarEntryActive,
		activateToolbarEntry,
		renderToolbarInlineOptions,
	} = useHeaderToolbar({
		headerRowRef: props.headerRowRef,
		headerToolbarRef,
		headerLeadingRef: props.headerLeadingRef,
		headerHostCapabilities,
		hostOwnsTitle: props.hostOwnsTitle,
		isWorkspacePreview: props.isWorkspacePreview,
		isMobileViewport: props.isMobileViewport,
		dock,
		chapterId: props.chapterId,
		tasksSupported: props.tasksSupported,
		tasksButtonEnabled: props.tasksButtonEnabled,
		specToolAvailable: props.specToolAvailable,
		terminalToolAvailable: props.terminalToolAvailable,
		onOpenTerminalPanel: props.onOpenTerminalPanel,
		browserSessionsSupported: props.browserSessionsSupported,
		executionDevicesQuery,
		mobileTasksOpen: props.mobileTasksOpen,
		mobileToolPanel: props.mobileToolPanel,
		fileModDrawerOpened: props.fileModDrawerOpened,
		detailsOpened: props.detailsOpened,
		terminalToolOpened: props.terminalToolOpened,
		specToolOpened: props.specToolOpened,
		setMobileTasksOpen: props.setMobileTasksOpen,
		setMobileToolPanel: props.setMobileToolPanel,
		setFileModDrawerOpened: props.setFileModDrawerOpened,
		toggleDetails: props.toggleDetails,
		toggleTerminalTool: props.toggleTerminalTool,
		toggleSpecTool: props.toggleSpecTool,
		updateExecutionDeviceMutation,
		renderLod,
		renderLodIsDefault,
		handleSelectLod,
		setAsDefault,
		openPluginPanel,
		t,
	});

	return (
		<Group ref={headerToolbarRef} gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
			{/*
			 * Registry-driven tool entries. The SET comes from the registry, the
			 * ORDER from the user's saved layout, and how many are surfaced from
			 * the measured width of this row (mobile additionally caps by count).
			 * Entries that do not fit move into the overflow menu instead of
			 * compressing the title, which is what the row used to do. Entries the
			 * host cannot present are absent from both lists rather than rendered
			 * disabled — but they stay in the layout, so they return on a surface
			 * that supports them.
			 */}
			{toolbarVisibleDefs.map((def) => {
				const Icon = def.icon;
				const badge = resolveNarratorToolbarBadge(def.badge, toolbarBadgeCounts);
				const active = toolbarEntryActive(def.id);
				const label = t(def.labelKey, { ns: def.namespace ?? "narrator" });

				// The device entry opens a list of targets rather than toggling a
				// panel, so it renders its own Menu instead of a toggle button.
				if (def.id === "device") {
					return (
						<ExecutionDeviceMenu
							key={def.id}
							label={t("executionDeviceSelector")}
							localLabel={t("executionTargetLocal")}
							offlineLabel={t("executionDeviceOffline")}
							devices={executionDevicesQuery.data?.devices ?? []}
							currentDeviceId={executionDevicesQuery.data?.defaultDeviceId ?? "local"}
							pending={updateExecutionDeviceMutation.isPending}
							onSelect={(deviceId) => updateExecutionDeviceMutation.mutate(deviceId)}
						/>
					);
				}

				if (def.id === "lodlevel") {
					return (
						<NarratorLodMenu
							key={def.id}
							lod={renderLod}
							isDefault={renderLodIsDefault}
							onSelectLod={handleSelectLod}
							onSetAsDefault={setAsDefault}
						/>
					);
				}

				if (def.id === "plugins") {
					return (
						<PluginContributionPicker
							key={def.id}
							onPick={openPluginPanel}
							surface="focus"
							trigger={
								<Tooltip label={label}>
									<ActionIcon size="sm" variant="subtle" color="gray" aria-label={label}>
										<Icon size={16} />
									</ActionIcon>
								</Tooltip>
							}
						/>
					);
				}

				const button = (
					<ActionIcon
						size="sm"
						variant={active ? "light" : "subtle"}
						color={active ? "indigo" : "gray"}
						aria-label={label}
						onClick={() => activateToolbarEntry(def.id)}
					>
						<Icon size={16} />
					</ActionIcon>
				);

				return (
					<Tooltip key={def.id} label={label}>
						{badge.count > 0 ? (
							<Indicator
								inline
								// Running work reads as a state, not a quantity, so it pulses
								// instead of printing a number (matches the old tasks button).
								size={badge.processing ? 8 : 14}
								offset={badge.processing ? 3 : 4}
								label={badge.processing ? undefined : badge.label}
								processing={badge.processing}
								color={badge.processing ? "blue" : "teal"}
								zIndex={1}
								style={{
									height: "var(--ai-size-sm)",
									display: "flex",
									alignItems: "center",
								}}
							>
								{button}
							</Indicator>
						) : (
							button
						)}
					</Tooltip>
				);
			})}
			{/* TEMPORARY mock-stream harness entry — see ./mock/README-REMOVAL.md.
			    Deliberately NOT in the registry: it is debug-only and due for
			    removal, so it must not occupy a persisted layout id. */}
			{dock && mockStreamEnabled && (
				<Tooltip label="Mock stream (debug)">
					<ActionIcon
						{...{ [HEADER_TOOLBAR_FIXED_ATTR]: "" }}
						size="sm"
						variant={dock.openToolTypes.has("mock") ? "light" : "subtle"}
						color={dock.openToolTypes.has("mock") ? "indigo" : "gray"}
						onClick={() => dock.toggleToolPanel("mock")}
					>
						<IconFlask size={16} />
					</ActionIcon>
				</Tooltip>
			)}
			{/*
			 * Overflow menu: lists everything not on the row (tucked by the user or
			 * collapsed for width), carries the aggregate badge so a hidden unread
			 * count is not lost, and owns the reorder UI. Archive lives at its
			 * bottom — a destructive action must not sit one mis-tap away from the
			 * panel toggles.
			 */}
			<NarratorToolbarOverflowMenu
				entries={toolbarEntries}
				hiddenDefs={toolbarHiddenDefs}
				noRoomIds={toolbarNoRoomIds}
				onSaveLayout={saveToolbarLayout}
				hostCapabilities={headerHostCapabilities}
				badgeCounts={toolbarBadgeCounts}
				onActivate={activateToolbarEntry}
				renderInlineOptions={renderToolbarInlineOptions}
				onArchive={openArchiveConfirm}
				archiveLoading={archiveMutation.isPending}
			/>
			{onClose && (
				<Tooltip label={t("closePanel")}>
					<ActionIcon
						{...{ [HEADER_TOOLBAR_FIXED_ATTR]: "" }}
						size="sm"
						variant="subtle"
						color="red"
						onClick={onClose}
					>
						<IconX size={16} />
					</ActionIcon>
				</Tooltip>
			)}
		</Group>
	);
}
