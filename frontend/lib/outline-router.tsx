/**
 * The outline routes as a host of the outline surface: outline targets become URLs. Only the
 * routes use this; the surface itself stays router-free (`components/outline/outline-nav.tsx`).
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import type { OutlineLinkProps, OutlineTarget } from "../components/outline/outline-nav";
import { type OutlinePanelState, outlinePanelTarget } from "./outline-panel";
import type { OutlineBlockSearch } from "./outline-view";

function blockSearch(to: Extract<OutlineTarget, { kind: "block" }>): OutlineBlockSearch {
	return {
		...(to.asOf !== undefined ? { asOf: to.asOf } : {}),
		...(to.view && to.view !== "facts" ? { view: to.view } : {}),
	};
}

/** Link renderer for the routed surface: a real anchor with the target's URL. */
export function outlineRouterLink({ to, ...rest }: OutlineLinkProps) {
	if (to.kind === "home") return <Link {...rest} to="/outline" />;
	if (to.kind === "space") {
		return <Link {...rest} to="/outline/$spaceId" params={{ spaceId: to.spaceId }} />;
	}
	return (
		<Link
			{...rest}
			to="/outline/$spaceId/$blockId"
			params={{ spaceId: to.spaceId, blockId: to.blockId }}
			search={blockSearch(to)}
		/>
	);
}

/** `onNavigate` for the routed surface: every change is a history entry. */
export function useOutlineRouterNavigate(): (to: OutlineTarget) => void {
	const navigate = useNavigate();
	return useCallback(
		(to: OutlineTarget) => {
			if (to.kind === "home") void navigate({ to: "/outline" });
			else if (to.kind === "space") {
				void navigate({ to: "/outline/$spaceId", params: { spaceId: to.spaceId } });
			} else {
				void navigate({
					to: "/outline/$spaceId/$blockId",
					params: { spaceId: to.spaceId, blockId: to.blockId },
					search: blockSearch(to),
				});
			}
		},
		[navigate],
	);
}

/** Leave for the outline page of a panel's state ("open in outline page"). */
export function useOpenOutlinePage(): (state: OutlinePanelState) => void {
	const navigate = useOutlineRouterNavigate();
	return useCallback((state: OutlinePanelState) => navigate(outlinePanelTarget(state)), [navigate]);
}
