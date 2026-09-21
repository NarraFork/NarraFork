import { MOBILE_TOOLBAR_VISIBLE_LIMIT } from "@shared/narrator-toolbar";
import {
	type Dispatch,
	type ReactNode,
	type RefObject,
	type SetStateAction,
	useCallback,
	useMemo,
	useState,
} from "react";
import type { NarratorToolbarEntry } from "../../../hooks/narrator-toolbar-layout";
import { useNarratorHeaderToolbarCapacity } from "../../../hooks/useNarratorHeaderToolbarCapacity";
import { useNarratorToolbarLayout } from "../../../hooks/useNarratorToolbarLayout";
import {
	PluginContributionOptions,
	type PluginContributionPick,
} from "../../plugins/PluginContributionPicker";
import type { NarratorDockContextValue } from "../dock/NarratorDockContext";
import { PathRulesPopover } from "../interaction/PathRulesPopover";
import { NarratorLodOptions } from "../lod/NarratorLodMenu";
import type { RenderLod } from "../lod/RenderLodCtx";
import type { MobileToolPanelKind } from "../MobileToolPanelHost";
import { ExecutionDeviceOptions } from "../model/ExecutionDeviceMenu";
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
	narratorId: string;
	headerHostCapabilities: readonly NarratorToolbarHost[];
	// Per-entry availability inputs.
	dock: NarratorDockContextValue | null;
	/**
	 * Whether the git panel can resolve a workspace for this narrator (ready
	 * state + read capability). Replaces the old `!!chapterId` gate now that
	 * standalone narrators can also have a Git workspace.
	 */
	gitWorkspaceAvailable: boolean;
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
	/** Header candidates before width measurement; HeaderToolbar applies capacity locally. */
	toolbarSurfacedDefs: readonly NarratorToolbarItemDef[];
	/** Menu-zone entries (not bottom); HeaderToolbar merges width-collapsed entries. */
	toolbarTuckedDefs: readonly NarratorToolbarItemDef[];
	toolbarBottomDefs: readonly NarratorToolbarItemDef[];
	toolbarOverlays: ReactNode;
	saveToolbarLayout: (entries: NarratorToolbarEntry[]) => void;
	toolbarEntryActive: (id: NarratorToolbarId) => boolean;
	activateToolbarEntry: (id: string) => void;
	renderToolbarInlineOptions: (id: string, close: () => void) => ReactNode;
}

/**
 * Width-capacity partition for the header row only. Kept OUT of the panel-level
 * controller: capacity changes when icons collapse/expand, and that state must
 * re-render HeaderToolbar — not the whole NarratorPanel (message list, dock, WS).
 */
export function useHeaderToolbarCapacityPartition({
	surfacedDefs,
	tuckedDefs,
	headerRowRef,
	headerToolbarRef,
	headerLeadingRef,
	hostOwnsTitle,
	isWorkspacePreview,
	isMobileViewport,
}: {
	surfacedDefs: readonly NarratorToolbarItemDef[];
	tuckedDefs: readonly NarratorToolbarItemDef[];
	headerRowRef: RefObject<HTMLDivElement | null>;
	headerToolbarRef: RefObject<HTMLDivElement | null>;
	headerLeadingRef: RefObject<HTMLDivElement | null>;
	hostOwnsTitle: boolean;
	isWorkspacePreview: boolean;
	isMobileViewport: boolean;
}): {
	toolbarVisibleDefs: readonly NarratorToolbarItemDef[];
	toolbarHiddenDefs: readonly NarratorToolbarItemDef[];
	toolbarNoRoomIds: readonly string[];
} {
	const headerTitleSlotMinWidth = useMemo(() => {
		if (hostOwnsTitle || isWorkspacePreview) return 0;
		return HEADER_TITLE_MIN_WIDTH_PX + 2 * 18 + 2 * 4;
	}, [hostOwnsTitle, isWorkspacePreview]);

	const headerCapacity = useNarratorHeaderToolbarCapacity({
		rowRef: headerRowRef,
		toolbarRef: headerToolbarRef,
		leadingRef: headerLeadingRef,
		titleSlotMinWidth: headerTitleSlotMinWidth,
		maxWidthFraction: null,
		itemCount: surfacedDefs.length,
		maxCapacity: isMobileViewport ? MOBILE_TOOLBAR_VISIBLE_LIMIT : null,
		enabled: !isWorkspacePreview,
	});

	const headerVisibleLimit =
		headerCapacity ?? (isMobileViewport ? MOBILE_TOOLBAR_VISIBLE_LIMIT : null);
	const headerSelection = useMemo(
		() => selectHeaderToolbarEntries(surfacedDefs, headerVisibleLimit),
		[surfacedDefs, headerVisibleLimit],
	);
	const toolbarHiddenDefs = useMemo(
		() => [...headerSelection.hidden, ...tuckedDefs],
		[headerSelection.hidden, tuckedDefs],
	);
	const toolbarNoRoomIds = useMemo(
		() => headerSelection.hidden.map((def) => def.id as string),
		[headerSelection.hidden],
	);

	return {
		toolbarVisibleDefs: headerSelection.visible,
		toolbarHiddenDefs,
		toolbarNoRoomIds,
	};
}

/**
 * Shared controller for header/bottom activation and saved layout. Capacity is
 * NOT here — see {@link useHeaderToolbarCapacityPartition}. Dialogs opened from
 * menus live in `toolbarOverlays`, mounted outside those menus.
 */
export function useHeaderToolbar(options: UseHeaderToolbarOptions): UseHeaderToolbarResult {
	const {
		narratorId,
		headerHostCapabilities,
		dock,
		gitWorkspaceAvailable,
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

	const [pathRulesOpened, setPathRulesOpened] = useState(false);
	const closePathRules = useCallback(() => setPathRulesOpened(false), []);

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
					// Chapter or standalone, the git panel is offered whenever a
					// workspace resolves with read capability for this narrator.
					return gitWorkspaceAvailable;
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
			gitWorkspaceAvailable,
			browserSessionsSupported,
			executionDevicesQuery.data?.devices.length,
			dock,
		],
	);

	const {
		entries: toolbarEntries,
		visible: toolbarSurfacedDefs,
		overflow: toolbarTuckedDefs,
		bottom: toolbarBottomDefs,
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
				case "path-rules":
					setPathRulesOpened(true);
					return;
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

	return useMemo(
		() => ({
			toolbarEntries,
			toolbarSurfacedDefs,
			toolbarTuckedDefs,
			toolbarBottomDefs,
			toolbarOverlays: (
				<PathRulesPopover
					narratorId={narratorId}
					t={t}
					controlled={{ opened: pathRulesOpened, onClose: closePathRules }}
				/>
			),
			saveToolbarLayout,
			toolbarEntryActive,
			activateToolbarEntry,
			renderToolbarInlineOptions,
		}),
		[
			toolbarEntries,
			toolbarSurfacedDefs,
			toolbarTuckedDefs,
			toolbarBottomDefs,
			narratorId,
			t,
			pathRulesOpened,
			closePathRules,
			saveToolbarLayout,
			toolbarEntryActive,
			activateToolbarEntry,
			renderToolbarInlineOptions,
		],
	);
}
