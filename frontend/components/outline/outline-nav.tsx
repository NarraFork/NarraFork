/**
 * Where outline links go, without a router. The outline surface (`OutlineSurface.tsx`) is hosted
 * by the outline route and, later, by dock panels; it never reads router params or calls the
 * router. Every link and every navigation inside it names an `OutlineTarget`, and the host
 * decides what that means: the route turns it into a URL (`lib/outline-router.tsx`), a dock
 * panel into new panel params.
 *
 * Links render through the host's link renderer, so a routed host keeps real anchors (open in
 * a new tab, copy the address). Without one, a link is an anchor that calls `onNavigate`.
 *
 * A few links leave the outline's places (a session, the reports page, the page a commit changed
 * through the reference route): `OutlineHrefLink` is a real anchor to the app path, which the host
 * opens on a plain click (`onNavigateHref`); without one the browser follows it.
 */
import type { OutlineViewMode } from "@shared/outline-api";
import {
	type AnchorHTMLAttributes,
	createContext,
	type MouseEvent,
	type ReactElement,
	type ReactNode,
	useContext,
	useMemo,
} from "react";
import { assetUrl } from "../../lib/base-path";

export type OutlineTarget =
	| { kind: "home" }
	| { kind: "space"; spaceId: string }
	| {
			kind: "block";
			spaceId: string;
			blockId: string;
			/** Absent means the facts view, the default. */
			view?: OutlineViewMode;
			/** Commit seq to show the page as of; absent for the current state. */
			asOf?: number;
	  };

/** An anchor's attributes, except where it goes: `to` says that. */
export type OutlineLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
	to: OutlineTarget;
};

export type OutlineLinkRenderer = (props: OutlineLinkProps) => ReactElement;

interface OutlineNav {
	navigate: (to: OutlineTarget) => void;
	renderLink: OutlineLinkRenderer | null;
	/** Open an app path (no mount prefix) that is no outline place; null: the browser does. */
	navigateHref: ((path: string) => void) | null;
}

const OutlineNavContext = createContext<OutlineNav>({
	navigate: () => {},
	renderLink: null,
	navigateHref: null,
});

export function OutlineNavProvider({
	onNavigate,
	renderLink,
	onNavigateHref,
	children,
}: {
	onNavigate: (to: OutlineTarget) => void;
	renderLink?: OutlineLinkRenderer;
	onNavigateHref?: (path: string) => void;
	children: ReactNode;
}) {
	const value = useMemo(
		() => ({
			navigate: onNavigate,
			renderLink: renderLink ?? null,
			navigateHref: onNavigateHref ?? null,
		}),
		[onNavigate, renderLink, onNavigateHref],
	);
	return <OutlineNavContext.Provider value={value}>{children}</OutlineNavContext.Provider>;
}

/** Navigate the surface's host (focus, breadcrumbs, view and time changes). */
export function useOutlineNavigate(): (to: OutlineTarget) => void {
	return useContext(OutlineNavContext).navigate;
}

/** A link to an outline target, rendered by the host. */
export function OutlineLink(props: OutlineLinkProps): ReactElement {
	const nav = useContext(OutlineNavContext);
	if (nav.renderLink) return nav.renderLink(props);
	const { to, onClick, ...rest } = props;
	// No router to make a URL: the address names the target in the fragment (harmless when
	// opened elsewhere), and a click navigates the host.
	return (
		<a
			{...rest}
			href={fragmentOf(to)}
			onClick={(event: MouseEvent<HTMLAnchorElement>) => {
				onClick?.(event);
				if (event.defaultPrevented) return;
				event.preventDefault();
				nav.navigate(to);
			}}
		/>
	);
}

export type OutlineHrefLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
	/** The app path, with its query, without the mount prefix. */
	path: string;
};

/**
 * A link to an app path that is no outline place: a real anchor (the mount prefix added), opened
 * by the host on a plain click; a modified click, or no host, is the browser's.
 */
export function OutlineHrefLink({ path, onClick, ...rest }: OutlineHrefLinkProps): ReactElement {
	const nav = useContext(OutlineNavContext);
	return (
		<a
			{...rest}
			href={assetUrl(path)}
			onClick={(event: MouseEvent<HTMLAnchorElement>) => {
				onClick?.(event);
				const modified =
					event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
				if (event.defaultPrevented || modified || !nav.navigateHref) return;
				event.preventDefault();
				nav.navigateHref(path);
			}}
		/>
	);
}

function fragmentOf(to: OutlineTarget): string {
	if (to.kind === "home") return "#outline";
	if (to.kind === "space") return `#outline/${encodeURIComponent(to.spaceId)}`;
	return `#outline/${encodeURIComponent(to.spaceId)}/${encodeURIComponent(to.blockId)}`;
}

/** The target of a block, keeping only meaningful view and time. */
export function outlineBlockTarget(
	spaceId: string,
	blockId: string,
	view?: OutlineViewMode,
	asOf?: number,
): OutlineTarget {
	return {
		kind: "block",
		spaceId,
		blockId,
		...(view && view !== "facts" ? { view } : {}),
		...(asOf !== undefined ? { asOf } : {}),
	};
}
