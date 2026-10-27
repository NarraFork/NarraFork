/**
 * Where outline links go, without a router. The outline surface (`OutlineSurface.tsx`) is hosted
 * by the outline route and, later, by dock panels; it never reads router params or calls the
 * router. Every link and every navigation inside it names an `OutlineTarget`, and the host
 * decides what that means: the route turns it into a URL (`lib/outline-router.tsx`), a dock
 * panel into new panel params.
 *
 * Links render through the host's link renderer, so a routed host keeps real anchors (open in
 * a new tab, copy the address). Without one, a link is an anchor that calls `onNavigate`.
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
}

const OutlineNavContext = createContext<OutlineNav>({ navigate: () => {}, renderLink: null });

export function OutlineNavProvider({
	onNavigate,
	renderLink,
	children,
}: {
	onNavigate: (to: OutlineTarget) => void;
	renderLink?: OutlineLinkRenderer;
	children: ReactNode;
}) {
	const value = useMemo(
		() => ({ navigate: onNavigate, renderLink: renderLink ?? null }),
		[onNavigate, renderLink],
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
