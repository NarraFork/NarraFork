/**
 * Tearing a panel out by dragging its DOCKVIEW TAB (as opposed to its panel
 * header) onto the canvas.
 *
 * These are two different drag technologies, which is why this module exists at
 * all:
 *
 *  - a panel header drag is pointer-driven and flows through our `panel-drag`
 *    singleton, so the canvas simply subscribes to it;
 *  - a dockview tab drag is HTML5 native drag-and-drop (`dragstart` / `dragover`
 *    / `drop`). None of that reaches a pointer-event listener, so the canvas has
 *    to act as a real native drop target instead.
 *
 * Two dead ends, recorded so they are not re-attempted:
 *
 *  - `onWillDragPanel` / `onWillDragGroup` are only fired when dockview's
 *    `advancedDnDService` module is present, and this version ships the
 *    `IAdvancedDnDService` INTERFACE with no implementation. The hooks can never
 *    fire, so subscribing to them is dead code.
 *  - `dndStrategy: 'pointer'` makes dockview drive tab drags with pointer events,
 *    but they are dockview's OWN pointer events — they still never reach our
 *    singleton — and it costs cross-window drag plus the native drag image.
 *
 * The one thing native DnD does give us is identity: dockview publishes the
 * dragged panel through the exported `getPanelData()` for the whole drag, so the
 * canvas can learn what is being dragged without touching any tab component
 * (`DockviewDefaultTab` belongs to dockview-react and cannot be modified).
 */

import { filePanelResourceId } from "../../narrator/panels/panel-kind";
import { isToolEditReference } from "../../narrator/tool-call/tool-edit-reference";
import { type DetachablePanelKind, isDetachablePanelKind } from "./detachable";
import { getChapterDock, getSurfaceChapterId, listSurfaceIds } from "./dock-registry";

/**
 * The panel identity + owning chapter behind an in-flight tab drag, once resolved
 * against the live docks.
 */
export interface TabDetachSubject {
	/** Chapter that owns the panel's persistence. */
	chapterId: string;
	/**
	 * The surface currently holding it — a chapter's dock or a detached node. Needed
	 * separately from `chapterId` because one chapter can own several surfaces, and
	 * closing the source panel requires naming the right one.
	 */
	surfaceId: string;
	/** Live dockview panel id, used to close the source panel. */
	panelId: string;
	kind: DetachablePanelKind;
	/** Resource identity for multi-instance kinds (subagent narrator, file path). */
	resourceId?: string;
	/** Panel-local loading state, intentionally separate from resource identity. */
	largeFileConfirmed?: boolean;
}

/**
 * Read a panel's kind and resource identity out of its dockview params.
 *
 * Deliberately NOT parsed out of `panelId`. Its `ndock-<kind>` shape is an
 * implementation detail of `dockPanelId()`, and reading it here would turn that
 * string format into an implicit cross-module contract that breaks silently if the
 * prefix ever changes. `params` is the same source the panel adapters read.
 */
export function readPanelSubject(
	params: unknown,
): Pick<TabDetachSubject, "kind" | "resourceId" | "largeFileConfirmed"> | null {
	if (!params || typeof params !== "object") return null;
	const p = params as {
		panelType?: unknown;
		subagentNarratorId?: unknown;
		filePath?: unknown;
		fileNarratorId?: unknown;
		deviceId?: unknown;
		referenceOrigin?: unknown;
		largeFileConfirmed?: unknown;
		toolEdit?: unknown;
	};
	if (!isDetachablePanelKind(p.panelType)) return null;
	const kind = p.panelType;
	// Reject corrupt historical identity instead of silently detaching a live file.
	if (kind === "file" && p.toolEdit !== undefined && !isToolEditReference(p.toolEdit)) return null;
	// Multi-instance kinds carry the identity needed to rebuild the same panel
	// elsewhere; singletons leave it unset.
	const resourceId =
		kind === "subagent" && typeof p.subagentNarratorId === "string"
			? p.subagentNarratorId
			: kind === "file" && typeof p.filePath === "string"
				? filePanelResourceId(
						p.filePath,
						typeof p.deviceId === "string" ? p.deviceId : "local",
						p.referenceOrigin === true,
						isToolEditReference(p.toolEdit) ? p.toolEdit : undefined,
						typeof p.fileNarratorId === "string" ? p.fileNarratorId : undefined,
					)
				: undefined;
	return {
		kind,
		...(resourceId ? { resourceId } : {}),
		...(kind === "file" && p.largeFileConfirmed === true ? { largeFileConfirmed: true } : {}),
	};
}

/**
 * Find which mounted surface owns `panelId`, and describe the panel.
 *
 * The owner cannot come from the drag itself: dockview's `PanelTransfer` carries a
 * `viewId`, but that is dockview's own component id — our `surfaceId` is never
 * passed to `DockviewReact`, so the two are unrelated. Nor can it come from the
 * panel's params, which only carry `chapterId` for some kinds (it is optional on
 * narrator-bound panels and absent entirely on subagent / file ones).
 *
 * So every mounted surface is asked whether it holds the panel. Both kinds are
 * candidates — an expanded chapter's dock and a detached canvas node — because a
 * tab can be dragged out of either.
 */
export function resolveTabDetachSubject(
	panelId: string | null | undefined,
): TabDetachSubject | null {
	if (!panelId) return null;
	for (const surfaceId of listSurfaceIds()) {
		const panel = getChapterDock(surfaceId)?.apiRef.current?.getPanel(panelId);
		if (!panel) continue;
		const chapterId = getSurfaceChapterId(surfaceId);
		if (!chapterId) return null;
		const subject = readPanelSubject(panel.params);
		if (!subject) return null; // found it, but it may not be detached
		return { chapterId, surfaceId, panelId, ...subject };
	}
	return null;
}
