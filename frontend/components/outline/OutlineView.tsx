/**
 * Any outline place as one router-free view: the home, a space's pages, or a page (the surface).
 * The outline routes host it for their URLs; a dock panel hosts it for its params, so a panel
 * opened on a space (from a session's menu) can go to one of its pages and back without leaving
 * the panel.
 */
import { Box } from "@mantine/core";
import type { OutlineSpaceDetail } from "@shared/outline-api";
import type { ReactNode } from "react";
import { OutlineGate } from "./OutlineGate";
import { OutlineHome } from "./OutlineHome";
import { OutlineSpaceHome } from "./OutlineSpaceHome";
import { OutlineSurface, type OutlineSurfaceLoaded } from "./OutlineSurface";
import { type OutlineLinkRenderer, OutlineNavProvider, type OutlineTarget } from "./outline-nav";

export interface OutlineViewProps {
	target: OutlineTarget;
	onNavigate: (to: OutlineTarget) => void;
	renderLink?: OutlineLinkRenderer;
	layout?: "page" | "panel";
	compact?: boolean;
	/** A page loaded (see `OutlineSurface`). */
	onLoaded?: (info: OutlineSurfaceLoaded) => void;
	/** A space's page list loaded. */
	onSpaceLoaded?: (space: OutlineSpaceDetail, name: string) => void;
	/** The page or space could not be read (missing, or no access). */
	onMissing?: () => void;
	/** The host's controls in the page's toolbar (or beside the space's badges). */
	actions?: ReactNode;
}

export function OutlineView({
	target,
	onNavigate,
	renderLink,
	layout = "page",
	compact,
	onLoaded,
	onSpaceLoaded,
	onMissing,
	actions,
}: OutlineViewProps) {
	if (target.kind === "block") {
		return (
			<OutlineSurface
				spaceId={target.spaceId}
				blockId={target.blockId}
				view={target.view}
				asOf={target.asOf}
				onNavigate={onNavigate}
				renderLink={renderLink}
				layout={layout}
				compact={compact}
				onLoaded={onLoaded}
				onMissing={onMissing}
				actions={actions}
			/>
		);
	}
	const body =
		target.kind === "space" ? (
			<OutlineSpaceHome
				spaceId={target.spaceId}
				onLoaded={onSpaceLoaded}
				onMissing={onMissing}
				actions={actions}
			/>
		) : (
			<OutlineHome />
		);
	return (
		<OutlineNavProvider onNavigate={onNavigate} renderLink={renderLink}>
			<OutlineGate>
				{layout === "panel" ? (
					<Box h="100%" p="sm" style={{ overflowY: "auto", minWidth: 0 }}>
						{body}
					</Box>
				) : (
					body
				)}
			</OutlineGate>
		</OutlineNavProvider>
	);
}
