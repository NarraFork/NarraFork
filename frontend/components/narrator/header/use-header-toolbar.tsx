import {
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useCallback,
	useMemo,
	useState,
} from "react";
import type { NarratorToolbarEntry } from "../../../hooks/narrator-toolbar-layout";
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
	detailsOpened: boolean;
	terminalToolOpened: boolean;
	specToolOpened: boolean;

	// Activation actions.
	setMobileTasksOpen: Dispatch<SetStateAction<boolean>>;
	setMobileToolPanel: Dispatch<SetStateAction<MobileToolPanelKind | null>>;
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
	/** Entries the reader placed in the header zone (rendered on the row). */
	toolbarSurfacedDefs: readonly NarratorToolbarItemDef[];
	/** Menu-zone entries (not bottom). */
	toolbarTuckedDefs: readonly NarratorToolbarItemDef[];
	toolbarBottomDefs: readonly NarratorToolbarItemDef[];
	toolbarOverlays: ReactNode;
	saveToolbarLayout: (entries: NarratorToolbarEntry[]) => void;
	toolbarEntryActive: (id: NarratorToolbarId) => boolean;
	activateToolbarEntry: (id: string) => void;
	renderToolbarInlineOptions: (id: string, close: () => void) => ReactNode;
}

/**
 * Shared controller for header/bottom activation and saved layout.
 *
 * Header title width is pretext-measured in `header-title-width.ts`; the tool
 * row is simply the reader's surfaced zone. No DOM capacity partition.
 * Dialogs opened from menus live in `toolbarOverlays`, mounted outside those menus.
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
		detailsOpened,
		terminalToolOpened,
		specToolOpened,
		setMobileTasksOpen,
		setMobileToolPanel,
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
				case "details":
					return detailsOpened;
				case "terminal":
					return terminalToolOpened;
				case "spec":
					return specToolOpened;
				case "git":
					return dock ? dock.openToolTypes.has("git") : mobileToolPanel === "git";
				case "search":
					return dock ? dock.openToolTypes.has("search") : mobileToolPanel === "search";
				case "browser":
					return dock ? dock.openToolTypes.has("browser") : mobileToolPanel === "browser";
				case "userchat":
					return dock ? dock.openToolTypes.has("userchat") : mobileToolPanel === "userchat";
				case "filetree":
					return dock ? dock.openToolTypes.has("filetree") : mobileToolPanel === "filetree";
				default:
					return false;
			}
		},
		[dock, mobileTasksOpen, detailsOpened, terminalToolOpened, specToolOpened, mobileToolPanel],
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
				case "filetree":
					if (dock) dock.toggleToolPanel(id);
					else {
						const kind = id as MobileToolPanelKind;
						setMobileToolPanel((current) => (current === kind ? null : kind));
					}
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
	 * row labelled "header only" — and on a narrow row the header may keep only a
	 * couple of icons while everything else lives in that menu, so the detail level
	 * and the execution device had NO reachable entry point at all. Returning the
	 * same option rows the header's dropdown uses keeps the two surfaces in step by
	 * construction.
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
