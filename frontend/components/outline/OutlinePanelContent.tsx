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
 *
 * Back and forward: the panel never changes the URL, so the browser's history is not the panel's.
 * The panel keeps its own (every navigation inside it, at most `PANEL_HISTORY_MAX` entries, for as
 * long as the panel is mounted; not stored with the layout), shown as back and forward buttons on
 * the page's toolbar and bound to Mod-[ and Mod-] (`OutlineSurface`).
 *
 * The host shows a change a render or more later (a dock panel's parameters). Navigations in
 * quick succession — a focus and its return before that render — build on the newest state the
 * panel asked for, not on the props of a render that has not caught up: comparing with those
 * would drop the return as "no change", and the host would keep a focus the page left.
 */
import type { OutlineSpaceDetail } from "@shared/outline-api";
import {
	type MouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { type OutlineHrefTarget, outlineTargetHref } from "../../lib/outline-href";
import { isOpenClick, wantsNewPanel } from "../../lib/outline-opener";
import {
	type OutlinePanelState,
	outlinePanelStateFor,
	outlinePanelTarget,
	outlinePanelTitle,
	sameOutlinePanelState,
} from "../../lib/outline-panel";
import type { OutlineSurfaceHistory, OutlineSurfaceLoaded } from "./OutlineSurface";
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

/** Navigations a panel remembers for back and forward. */
export const PANEL_HISTORY_MAX = 50;

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
	// What the panel asked its host for and the host has not shown yet, oldest first. A shown
	// state settles the ones up to it; one the panel did not ask for (a restored layout, another
	// owner of the parameters) settles them all.
	const asked = useRef<OutlinePanelState[]>([]);
	const shown = useRef(state);
	if (!sameOutlinePanelState(shown.current, state)) {
		shown.current = state;
		const at = asked.current.findIndex((s) => sameOutlinePanelState(s, state));
		asked.current = at >= 0 ? asked.current.slice(at + 1) : [];
	}
	/** The newest state: the last one asked for, or the one shown. */
	const latest = useCallback(() => asked.current.at(-1) ?? stateRef.current, []);
	const ask = useCallback((next: OutlinePanelState) => {
		asked.current.push(next);
		handlers.current.onChange(next);
	}, []);

	const { spaceId, blockId, view, asOf } = state;
	const target = useMemo(
		() => outlinePanelTarget({ spaceId, blockId, view, asOf }),
		[spaceId, blockId, view, asOf],
	);

	// The panel's own history: states before (back) and after (forward) the current one.
	const past = useRef<OutlinePanelState[]>([]);
	const future = useRef<OutlinePanelState[]>([]);
	const [, bumpHistory] = useReducer((n: number) => n + 1, 0);
	const go = useCallback(
		(next: OutlinePanelState) => {
			const current = latest();
			if (sameOutlinePanelState(current, next)) return;
			past.current.push(current);
			if (past.current.length > PANEL_HISTORY_MAX) past.current.shift();
			future.current = [];
			bumpHistory();
			ask(next);
		},
		[latest, ask],
	);
	const back = useCallback(() => {
		const prev = past.current.pop();
		if (!prev) return;
		future.current.push(latest());
		bumpHistory();
		ask(prev);
	}, [latest, ask]);
	const forward = useCallback(() => {
		const next = future.current.pop();
		if (!next) return;
		past.current.push(latest());
		bumpHistory();
		ask(next);
	}, [latest, ask]);
	const history: OutlineSurfaceHistory = {
		canBack: past.current.length > 0,
		canForward: future.current.length > 0,
		back,
		forward,
	};

	const navigate = useCallback(
		(to: OutlineTarget) => go(outlinePanelStateFor(to, latest())),
		[go, latest],
	);

	const goRef = useRef(go);
	goRef.current = go;
	const renderLink = useCallback(
		({ to, onClick, ...rest }: OutlineLinkProps) => {
			const go = (event: MouseEvent<HTMLAnchorElement>) => {
				onClick?.(event);
				if (!isOpenClick(event)) return;
				event.preventDefault();
				const next = outlinePanelStateFor(to, latest());
				const openNew = handlers.current.onOpenNew;
				if (wantsNewPanel(event) && openNew) openNew(next);
				else goRef.current(next);
			};
			return <a {...rest} href={outlineTargetHref(hrefTargetOf(to))} onClick={go} />;
		},
		[latest],
	);

	const onLoaded = useCallback(
		(info: OutlineSurfaceLoaded) => {
			// A load of a state the panel already left (a newer one asked for) changes nothing.
			const current = latest();
			if (current.spaceId !== info.spaceId || current.blockId !== info.rootId) return;
			handlers.current.onTitle?.(outlinePanelTitle(info.title || info.address) ?? null);
			if (current.pageId === info.pageId) return;
			ask({ ...current, pageId: info.pageId });
		},
		[latest, ask],
	);

	const onSpaceLoaded = useCallback(
		(space: OutlineSpaceDetail, name: string) => {
			const current = latest();
			if (current.spaceId !== space.id || current.blockId) return;
			handlers.current.onTitle?.(outlinePanelTitle(name) ?? null);
		},
		[latest],
	);

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
			history={history}
		/>
	);
}
