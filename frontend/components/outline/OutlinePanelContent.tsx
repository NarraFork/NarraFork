/**
 * An outline place inside a dock panel (or a drawer, or a detached window): the router-free view
 * with in-place navigation.
 *
 * Everything the view navigates — focus, breadcrumbs, the view switch, the timeline, a page of
 * the space's list — becomes new panel state through `onChange`; the URL never changes. Links
 * are real anchors to the outline page (middle-click and "open in new tab" still work), a plain
 * click navigates in place, and Ctrl/Cmd-click opens a new panel through `onOpenNew`. The page
 * the focus is on is written back once loaded, so a restored layout knows its panels' identity.
 * The title of what loaded goes to `onTitle` for the tab and is not stored (`null` when nothing
 * could be read: the tab goes back to the generic name).
 */
import type { OutlineSpaceDetail } from "@shared/outline-api";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { type OutlineHrefTarget, outlineTargetHref } from "../../lib/outline-href";
import { isOpenClick, wantsNewPanel } from "../../lib/outline-opener";
import {
	type OutlinePanelState,
	outlinePanelStateFor,
	outlinePanelTarget,
	outlinePanelTitle,
} from "../../lib/outline-panel";
import type { OutlineSurfaceLoaded } from "./OutlineSurface";
import { OutlineView } from "./OutlineView";
import type { OutlineLinkProps, OutlineTarget } from "./outline-nav";

export interface OutlinePanelContentProps {
	state: OutlinePanelState;
	/** New state: a navigation inside the panel, or what was learned on load. */
	onChange: (next: OutlinePanelState) => void;
	/** Ctrl/Cmd-click on a link: open it in a new panel. Absent: navigate in place. */
	onOpenNew?: (next: OutlinePanelState) => void;
	/** What loaded is called this (`null`: nothing could be read). For the tab; not stored. */
	onTitle?: (title: string | null) => void;
	/** The host's controls in the page's toolbar. */
	actions?: ReactNode;
}

/** The href target of a surface target (the facts view is the default and left out). */
export function hrefTargetOf(to: OutlineTarget): OutlineHrefTarget {
	if (to.kind !== "block") return to;
	return {
		kind: "block",
		spaceId: to.spaceId,
		blockId: to.blockId,
		...(to.view === "all" ? { view: "all" as const } : {}),
		...(to.asOf !== undefined ? { asOf: to.asOf } : {}),
	};
}

export function OutlinePanelContent({
	state,
	onChange,
	onOpenNew,
	onTitle,
	actions,
}: OutlinePanelContentProps) {
	const { t } = useTranslation("outline");
	const stateRef = useRef(state);
	stateRef.current = state;
	const handlers = useRef({ onChange, onOpenNew, onTitle });
	handlers.current = { onChange, onOpenNew, onTitle };

	const { spaceId, blockId, view, asOf } = state;
	const target = useMemo(
		() => outlinePanelTarget({ spaceId, blockId, view, asOf }),
		[spaceId, blockId, view, asOf],
	);

	const navigate = useCallback((to: OutlineTarget) => {
		handlers.current.onChange(outlinePanelStateFor(to, stateRef.current));
	}, []);

	const renderLink = useCallback(({ to, onClick, ...rest }: OutlineLinkProps) => {
		const go = (event: MouseEvent<HTMLAnchorElement>) => {
			onClick?.(event);
			if (!isOpenClick(event)) return;
			event.preventDefault();
			const next = outlinePanelStateFor(to, stateRef.current);
			const openNew = handlers.current.onOpenNew;
			if (wantsNewPanel(event) && openNew) openNew(next);
			else handlers.current.onChange(next);
		};
		return <a {...rest} href={outlineTargetHref(hrefTargetOf(to))} onClick={go} />;
	}, []);

	const onLoaded = useCallback((info: OutlineSurfaceLoaded) => {
		const current = stateRef.current;
		if (current.spaceId !== info.spaceId || current.blockId !== info.rootId) return;
		handlers.current.onTitle?.(outlinePanelTitle(info.title || info.address) ?? null);
		if (current.pageId === info.pageId) return;
		handlers.current.onChange({ ...current, pageId: info.pageId });
	}, []);

	const onSpaceLoaded = useCallback((space: OutlineSpaceDetail, name: string) => {
		const current = stateRef.current;
		if (current.spaceId !== space.id || current.blockId) return;
		handlers.current.onTitle?.(outlinePanelTitle(name) ?? null);
	}, []);

	const onMissing = useCallback(() => handlers.current.onTitle?.(null), []);

	// The home has nothing to load: name it at once.
	const homeTitle = t("title");
	const isHome = target.kind === "home";
	useEffect(() => {
		if (isHome) handlers.current.onTitle?.(homeTitle);
	}, [isHome, homeTitle]);

	return (
		<OutlineView
			target={target}
			onNavigate={navigate}
			renderLink={renderLink}
			layout="panel"
			onLoaded={onLoaded}
			onSpaceLoaded={onSpaceLoaded}
			onMissing={onMissing}
			actions={actions}
		/>
	);
}
