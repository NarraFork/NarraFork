import { ActionIcon, Group, Indicator, Tooltip } from "@mantine/core";
import { IconFlask, IconX } from "@tabler/icons-react";
import type { ReactNode, RefObject } from "react";
import type { NarratorToolbarEntry } from "../../../hooks/narrator-toolbar-layout";
import {
	type PluginContributionPick,
	PluginContributionPicker,
} from "../../plugins/PluginContributionPicker";
import type { NarratorDockContextValue } from "../dock/NarratorDockContext";
import { ExecutionDeviceMenu } from "../ExecutionDeviceMenu";
import { NarratorLodMenu } from "../NarratorLodMenu";
import { NarratorToolbarOverflowMenu } from "../NarratorToolbarOverflowMenu";
import { HEADER_TOOLBAR_FIXED_ATTR } from "../narrator-header-toolbar-capacity";
import {
	type NarratorToolbarBadgeCounts,
	resolveNarratorToolbarBadge,
} from "../narrator-toolbar-badges";
import type {
	NarratorToolbarHost,
	NarratorToolbarId,
	NarratorToolbarItemDef,
} from "../narrator-toolbar-items";
import type { RenderLod } from "../RenderLodCtx";

// biome-ignore lint/suspicious/noExplicitAny: react-query result passthrough from NarratorPanel.
type QueryLike = any;
// biome-ignore lint/suspicious/noExplicitAny: react-query mutation passthrough from NarratorPanel.
type MutationLike = any;

export interface HeaderToolbarProps {
	/** Width-measurement anchor for the capacity ResizeObserver in NarratorPanel. */
	headerToolbarRef: RefObject<HTMLDivElement | null>;
	/** Entries surfaced on the row (set by registry, ordered by layout, capped by width). */
	toolbarVisibleDefs: readonly NarratorToolbarItemDef[];
	toolbarBadgeCounts: NarratorToolbarBadgeCounts;
	/** Full flat layout (both zones) for the overflow drag list. */
	toolbarEntries: readonly NarratorToolbarEntry[];
	/** Entries not on the row (tucked or collapsed for width). */
	toolbarHiddenDefs: readonly NarratorToolbarItemDef[];
	/** Ids above the divider the row could not fit (marked in the overflow menu). */
	toolbarNoRoomIds: readonly string[];
	headerHostCapabilities: readonly NarratorToolbarHost[];
	/** Whether an entry's panel is currently open (drives active styling). */
	toolbarEntryActive: (id: NarratorToolbarId) => boolean;
	activateToolbarEntry: (id: string) => void;
	saveToolbarLayout: (entries: NarratorToolbarEntry[]) => void;
	renderToolbarInlineOptions: (id: string, close: () => void) => ReactNode;
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
		toolbarVisibleDefs,
		toolbarBadgeCounts,
		toolbarEntries,
		toolbarHiddenDefs,
		toolbarNoRoomIds,
		headerHostCapabilities,
		toolbarEntryActive,
		activateToolbarEntry,
		saveToolbarLayout,
		renderToolbarInlineOptions,
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
