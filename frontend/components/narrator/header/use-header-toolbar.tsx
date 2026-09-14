import { MOBILE_TOOLBAR_VISIBLE_LIMIT } from "@shared/narrator-toolbar";
import {
	type Dispatch,
	type ReactNode,
	type RefObject,
	type SetStateAction,
	useCallback,
	useMemo,
} from "react";
import type { NarratorToolbarEntry } from "../../../hooks/narrator-toolbar-layout";
import { useNarratorHeaderToolbarCapacity } from "../../../hooks/useNarratorHeaderToolbarCapacity";
import { useNarratorToolbarLayout } from "../../../hooks/useNarratorToolbarLayout";
import {
	PluginContributionOptions,
	type PluginContributionPick,
} from "../../plugins/PluginContributionPicker";
import type { NarratorDockContextValue } from "../dock/NarratorDockContext";
import { ExecutionDeviceOptions } from "../model/ExecutionDeviceMenu";
import { NarratorLodOptions } from "../lod/NarratorLodMenu";
import type { RenderLod } from "../lod/RenderLodCtx";
import type { MobileToolPanelKind } from "../MobileToolPanelHost";
import {
	HEADER_TITLE_MIN_WIDTH_PX,
	selectHeaderToolbarEntries,
} from "./narrator-header-toolbar-capacity";
import type {
	NarratorToolbarHost,
	NarratorToolbarId,
	NarratorToolbarItemDef,
} from "./narrator-toolbar-items";

// biome-ignore lint/suspicious/noExplicitAny: react-query result passthrough from NarratorPanel.
type QueryLike = any;
// biome-ignore lint/suspicious/noExplicitAny: react-query mutation passthrough from NarratorPanel.
type MutationLike = any;

export interface UseHeaderToolbarOptions {
	// Layout measurement anchors.
	headerRowRef: RefObject<HTMLDivElement | null>;
	headerToolbarRef: RefObject<HTMLDivElement | null>;
	headerLeadingRef: RefObject<HTMLDivElement | null>;
	headerHostCapabilities: readonly NarratorToolbarHost[];
	hostOwnsTitle: boolean;
	isWorkspacePreview: boolean;
	isMobileViewport: boolean;

	// Per-entry availability inputs.
	dock: NarratorDockContextValue | null;
	chapterId: string | null | undefined;
	tasksSupported: boolean;
	tasksButtonEnabled: boolean;
	specToolAvailable: boolean;
	terminalToolAvailable: boolean;
	onOpenTerminalPanel: (() => void) | undefined;
	browserSessionsSupported: boolean | undefined;
	executionDevicesQuery: QueryLike;

	// Active-state inputs.
	mobileTasksOpen: boolean;
	mobileToolPanel: MobileToolPanelKind | null;
	fileModDrawerOpened: boolean;
	detailsOpened: boolean;
	terminalToolOpened: boolean;
	specToolOpened: boolean;

	// Activation actions.
	setMobileTasksOpen: Dispatch<SetStateAction<boolean>>;
	setMobileToolPanel: Dispatch<SetStateAction<MobileToolPanelKind | null>>;
	setFileModDrawerOpened: Dispatch<SetStateAction<boolean>>;
	toggleDetails: () => void;
	toggleTerminalTool: () => void;
	toggleSpecTool: () => void;

	// Inline options (self-contained entries).
	updateExecutionDeviceMutation: MutationLike;
	renderLod: RenderLod;
	renderLodIsDefault: boolean;
	handleSelectLod: (lod: RenderLod) => void;
	setAsDefault: () => void;
	openPluginPanel: (pick: PluginContributionPick) => void;
	t: (key: string, opts?: Record<string, unknown>) => string;
}

export interface UseHeaderToolbarResult {
	toolbarEntries: readonly NarratorToolbarEntry[];
	toolbarVisibleDefs: readonly NarratorToolbarItemDef[];
	toolbarHiddenDefs: readonly NarratorToolbarItemDef[];
	toolbarNoRoomIds: readonly string[];
	saveToolbarLayout: (entries: NarratorToolbarEntry[]) => void;
	toolbarEntryActive: (id: NarratorToolbarId) => boolean;
	activateToolbarEntry: (id: string) => void;
	renderToolbarInlineOptions: (id: string, close: () => void) => ReactNode;
}

/**
 * The header tool row's logic, co-located with {@link HeaderToolbar}: which
 * registry entries are available for this narrator, the width-measured
 * layout/capacity partition (surfaced vs overflow), whether each entry's panel is
 * open, how activating an entry routes (dock panel vs mobile drawer fallback), and
 * the inline options the overflow menu expands for the self-contained entries.
 *
 * Extracted verbatim from NarratorPanel and now driven from HeaderToolbar; the
 * panel passes only the raw capability / active-state / action inputs instead of
 * the pre-computed toolbar props.
 */
export function useHeaderToolbar(options: UseHeaderToolbarOptions): UseHeaderToolbarResult {
	const {
		headerRowRef,
		headerToolbarRef,
		headerLeadingRef,
		headerHostCapabilities,
		hostOwnsTitle,
		isWorkspacePreview,
		isMobileViewport,
		dock,
		chapterId,
		tasksSupported,
		tasksButtonEnabled,
		specToolAvailable,
		terminalToolAvailable,
		onOpenTerminalPanel,
		browserSessionsSupported,
		executionDevicesQuery,
		mobileTasksOpen,
		mobileToolPanel,
		fileModDrawerOpened,
		detailsOpened,
		terminalToolOpened,
		specToolOpened,
		setMobileTasksOpen,
		setMobileToolPanel,
		setFileModDrawerOpened,
		toggleDetails,
		toggleTerminalTool,
		toggleSpecTool,
		updateExecutionDeviceMutation,
		renderLod,
		renderLodIsDefault,
		handleSelectLod,
		setAsDefault,
		openPluginPanel,
		t,
	} = options;

	const toolbarEntryEnabled = useCallback(
		(id: NarratorToolbarId): boolean => {
			switch (id) {
				case "tasks":
					return tasksSupported && tasksButtonEnabled;
				case "spec":
					return specToolAvailable;
				case "terminal":
					// Same condition as `terminalActionAvailable` further down, inlined so
					// this hook does not depend on a value defined after the early return.
					return terminalToolAvailable || !!onOpenTerminalPanel;
				case "git":
					// The git panel needs a chapter; a standalone narrator has none.
					return !!chapterId;
				case "browser":
					return browserSessionsSupported !== false;
				case "device":
					// Only meaningful with at least one remote device — otherwise "local"
					// is the only choice and the control is decoration.
					return (executionDevicesQuery.data?.devices.length ?? 0) > 0;
				case "plugins":
					return !!dock;
				default:
					return true;
			}
		},
		[
			tasksSupported,
			tasksButtonEnabled,
			specToolAvailable,
			terminalToolAvailable,
			onOpenTerminalPanel,
			chapterId,
			browserSessionsSupported,
			executionDevicesQuery.data?.devices.length,
			dock,
		],
	);

	const {
		entries: toolbarEntries,
		visible: toolbarSurfacedDefs,
		overflow: toolbarTuckedDefs,
		saveLayout: saveToolbarLayout,
	} = useNarratorToolbarLayout({
		// Uncapped on purpose: the cap depends on how many entries are SURFACEABLE,
		// which is what this partition computes. Capping here would make the count
		// fed to the measurement depend on the measurement's own result.
		visibleLimit: null,
		hostCapabilities: headerHostCapabilities,
		// Per-narrator availability is applied INSIDE the partition (before the cap),
		// so a capped row back-fills past disabled entries instead of showing fewer
		// buttons than the cap allows.
		entryEnabled: toolbarEntryEnabled,
	});

	/**
	 * Width the title keeps before any entry collapses. Zero when the host draws
	 * the title itself (a graph node), so the entries may claim that space —
	 * previously the only way to stop the icon row from crushing the title was to
	 * hide the title entirely, which is what `hostOwnsTitle` was doing.
	 */
	const headerTitleSlotMinWidth = useMemo(() => {
		if (hostOwnsTitle || isWorkspacePreview) return 0;
		// Plus the pencil / sparkles pair beside the title (ActionIcon size="xs" =
		// 18px each, gap 4).
		return HEADER_TITLE_MIN_WIDTH_PX + 2 * 18 + 2 * 4;
	}, [hostOwnsTitle, isWorkspacePreview]);

	const headerCapacity = useNarratorHeaderToolbarCapacity({
		rowRef: headerRowRef,
		toolbarRef: headerToolbarRef,
		leadingRef: headerLeadingRef,
		titleSlotMinWidth: headerTitleSlotMinWidth,
		itemCount: toolbarSurfacedDefs.length,
		// The measurement may not save a phone from itself: at ~360px a readable
		// title plus two entries is the honest maximum, whatever the arithmetic says.
		maxCapacity: isMobileViewport ? MOBILE_TOOLBAR_VISIBLE_LIMIT : null,
		enabled: !isWorkspacePreview,
	});

	/**
	 * `null` capacity = no successful measurement yet (first frame, no
	 * ResizeObserver). Falling back to the mobile cap / "show everything" keeps the
	 * previous behaviour rather than briefly emptying the row.
	 */
	const headerVisibleLimit =
		headerCapacity ?? (isMobileViewport ? MOBILE_TOOLBAR_VISIBLE_LIMIT : null);
	const headerSelection = useMemo(
		() => selectHeaderToolbarEntries(toolbarSurfacedDefs, headerVisibleLimit),
		[toolbarSurfacedDefs, headerVisibleLimit],
	);
	const toolbarVisibleDefs = headerSelection.visible;
	/**
	 * Everything not on the row: entries collapsed for width, plus the ones the
	 * reader tucked away. Layout order is preserved so the menu reads as a
	 * continuation of the row. This is also what the overflow button's aggregate
	 * badge counts — without it, an entry collapsed for width would take its unread
	 * count off screen with no trace.
	 */
	const toolbarHiddenDefs = useMemo(
		() => [...headerSelection.hidden, ...toolbarTuckedDefs],
		[headerSelection.hidden, toolbarTuckedDefs],
	);
	/** Ids collapsed for width — the menu marks these so "shown in header" stays honest. */
	const toolbarNoRoomIds = useMemo(
		() => headerSelection.hidden.map((def) => def.id as string),
		[headerSelection.hidden],
	);

	/** Whether an entry's panel is currently open (drives the active styling). */
	const toolbarEntryActive = useCallback(
		(id: NarratorToolbarId): boolean => {
			switch (id) {
				case "tasks":
					return dock ? dock.openToolTypes.has("tasks") : mobileTasksOpen;
				case "filemod":
					return fileModDrawerOpened;
				case "details":
					return detailsOpened;
				case "terminal":
					return terminalToolOpened;
				case "spec":
					return specToolOpened;
				case "git":
					return dock?.openToolTypes.has("git") ?? false;
				case "search":
					return dock ? dock.openToolTypes.has("search") : mobileToolPanel === "search";
				case "browser":
					return dock ? dock.openToolTypes.has("browser") : mobileToolPanel === "browser";
				case "userchat":
					return dock ? dock.openToolTypes.has("userchat") : mobileToolPanel === "userchat";
				case "filetree":
					return dock?.openToolTypes.has("filetree") ?? false;
				default:
					return false;
			}
		},
		[
			dock,
			mobileTasksOpen,
			fileModDrawerOpened,
			detailsOpened,
			terminalToolOpened,
			specToolOpened,
			mobileToolPanel,
		],
	);

	/**
	 * Activate an entry, preferring the dock panel and falling back to a drawer.
	 *
	 * The fallback is the whole point: on mobile `dock` is null, so git / search /
	 * browser / discussion route into `MobileToolPanelHost` instead of silently
	 * doing nothing.
	 */
	const activateToolbarEntry = useCallback(
		(id: string) => {
			switch (id) {
				case "tasks":
					if (dock) dock.toggleToolPanel("tasks");
					else setMobileTasksOpen((v) => !v);
					return;
				case "filemod":
					setFileModDrawerOpened((v: boolean) => !v);
					return;
				case "details":
					toggleDetails();
					return;
				case "terminal":
					(onOpenTerminalPanel ?? toggleTerminalTool)();
					return;
				case "spec":
					toggleSpecTool();
					return;
				case "git":
				case "search":
				case "browser":
				case "userchat":
					if (dock) dock.toggleToolPanel(id);
					else {
						const kind = id as MobileToolPanelKind;
						setMobileToolPanel((current) => (current === kind ? null : kind));
					}
					return;
				case "filetree":
					dock?.toggleToolPanel("filetree");
					return;
				// Dock-only (registry `hosts: ["dock"]`): the panel exists to sit beside the
				// transcript while a slider moves, so there is no drawer fallback to offer.
				case "appearance":
					dock?.toggleToolPanel("appearance");
					return;
				default:
					return;
			}
		},
		[
			dock,
			setMobileTasksOpen,
			setMobileToolPanel,
			setFileModDrawerOpened,
			toggleDetails,
			onOpenTerminalPanel,
			toggleTerminalTool,
			toggleSpecTool,
		],
	);

	/**
	 * Options the overflow menu expands inline for a self-contained control.
	 *
	 * These three render their own Menu in the header, so there is nothing for
	 * `activateToolbarEntry` to toggle. Before this, the menu listed them as a dead
	 * row labelled "header only" — and on a phone the header keeps two icons while
	 * everything else lives in that menu, so the detail level and the execution
	 * device had NO reachable entry point at all. Returning the same option rows the
	 * header's dropdown uses keeps the two surfaces in step by construction.
	 *
	 * Every id whose registry entry is `selfContained` must be handled here; an
	 * unhandled one silently reverts to the informational row.
	 */
	const renderToolbarInlineOptions = useCallback(
		(id: string, close: () => void): ReactNode => {
			switch (id) {
				case "device":
					return (
						<ExecutionDeviceOptions
							label={t("executionDeviceSelector")}
							localLabel={t("executionTargetLocal")}
							offlineLabel={t("executionDeviceOffline")}
							devices={executionDevicesQuery.data?.devices ?? []}
							currentDeviceId={executionDevicesQuery.data?.defaultDeviceId ?? "local"}
							onSelect={(deviceId) => {
								close();
								updateExecutionDeviceMutation.mutate(deviceId);
							}}
							withLabel={false}
						/>
					);
				case "lodlevel":
					return (
						<NarratorLodOptions
							lod={renderLod}
							isDefault={renderLodIsDefault}
							onSelectLod={(next) => {
								close();
								handleSelectLod(next);
							}}
							onSetAsDefault={() => {
								close();
								setAsDefault();
							}}
							withLabel={false}
						/>
					);
				case "plugins":
					return (
						<PluginContributionOptions
							onPick={(pick) => {
								close();
								openPluginPanel(pick);
							}}
						/>
					);
				default:
					return null;
			}
		},
		[
			t,
			executionDevicesQuery.data,
			updateExecutionDeviceMutation,
			renderLod,
			renderLodIsDefault,
			handleSelectLod,
			setAsDefault,
			openPluginPanel,
		],
	);

	return {
		toolbarEntries,
		toolbarVisibleDefs,
		toolbarHiddenDefs,
		toolbarNoRoomIds,
		saveToolbarLayout,
		toolbarEntryActive,
		activateToolbarEntry,
		renderToolbarInlineOptions,
	};
}
