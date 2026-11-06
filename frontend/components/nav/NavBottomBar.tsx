/**
 * Bottom of the sidebar: `[avatar] [icons…] [⋯]`.
 *
 * The icons are every destination that is not a session: all sessions, the customisable
 * entries the user keeps visible, and settings. Names are tooltips, unread counts are a
 * dot. Icons that do not fit the width go into "⋯", which also holds the entries the user
 * tucked away and the layout customisation. Sessions get all the height this saves.
 *
 * Collapsed, only the avatar shows; the rest appears, in place, once the sidebar opens.
 */

import { ActionIcon, Group, Indicator, Tooltip } from "@mantine/core";
import { IconListDetails, IconSettings } from "@tabler/icons-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { type ComponentType, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NavLayoutEntry } from "../../hooks/useNavLayout";
import { type NavOverflowLink, NavOverflowMenu } from "./NavOverflowMenu";
import { NavUserMenu } from "./NavUserMenu";
import {
	NAV_BOTTOM_GAP_PX,
	NAV_BOTTOM_ICON_PX,
	navBottomFitCount,
	splitNavBottomItems,
} from "./nav-bottom-bar-logic";
import { CUSTOMIZABLE_NAV_ITEMS, type NavItemDef } from "./nav-items";
import { useNavBadges } from "./use-nav-badges";

/** Avatar (28) + "⋯" (28) + the gaps around them. */
const RESERVED_PX = 28 + 28 + 2 * 8;
/** Fixed, so the session list above ends at the same line collapsed or not. */
const NAV_BOTTOM_BAR_HEIGHT = 44;

interface BarItem extends NavOverflowLink {
	icon: ComponentType<{ size?: number | string }>;
	activePrefix?: string;
	badge?: NavItemDef["badge"];
}

const DEF_BY_ID = new Map(CUSTOMIZABLE_NAV_ITEMS.map((def) => [def.id, def]));

function BarIcon({
	item,
	label,
	badgeCount,
}: {
	item: BarItem;
	label: string;
	badgeCount: number;
}) {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const active = pathname.startsWith(item.activePrefix ?? item.to);
	const Icon = item.icon;
	return (
		<Tooltip label={label} position="top" withArrow>
			<ActionIcon
				component={Link}
				to={item.to}
				size={NAV_BOTTOM_ICON_PX}
				variant={active ? "light" : "subtle"}
				color={active ? undefined : "gray"}
				aria-label={label}
				data-nav-bottom-item={item.id}
			>
				<Indicator size={7} color="indigo" offset={2} withBorder disabled={badgeCount <= 0}>
					<Icon size={18} />
				</Indicator>
			</ActionIcon>
		</Tooltip>
	);
}

export function NavBottomBar({
	entries,
	visibleItems,
	onSaveLayout,
	onLogout,
}: {
	/** Full persisted layout (with the divider), for the "⋯" customisation. */
	entries: NavLayoutEntry[];
	/** Customisable entries the user keeps visible, in order. */
	visibleItems: { id: string }[];
	onSaveLayout: (entries: NavLayoutEntry[]) => void;
	onLogout: () => void;
}) {
	const { t } = useTranslation("nav");
	const resolveBadge = useNavBadges();

	const items = useMemo<BarItem[]>(() => {
		const custom: BarItem[] = [];
		for (const { id } of visibleItems) {
			const def = DEF_BY_ID.get(id as NavItemDef["id"]);
			if (!def) continue;
			custom.push({
				id: def.id,
				labelKey: def.labelKey,
				to: def.to,
				icon: def.icon,
				activePrefix: def.activePrefix ?? def.to,
				badge: def.badge,
			});
		}
		return [
			{
				id: "all-sessions",
				labelKey: "allSessions",
				to: "/narrators",
				icon: IconListDetails,
				activePrefix: "/narrators",
			},
			...custom,
			{ id: "settings", labelKey: "settings", to: "/settings", icon: IconSettings },
		];
	}, [visibleItems]);

	// Collapsed, the bar keeps its expanded width (NavHoverPanel), so this is the same
	// count either way and opening the sidebar never reshuffles the icons.
	const barRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = barRef.current;
		if (!el) return;
		setWidth(el.clientWidth);
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setWidth(el.clientWidth));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const fit =
		width > 0
			? navBottomFitCount({ width, reservedPx: RESERVED_PX, itemCount: items.length })
			: items.length;
	const { shown, overflow } = splitNavBottomItems(items, fit);

	return (
		<Group
			ref={barRef}
			gap={8}
			wrap="nowrap"
			mt={4}
			// 6 puts the 28px avatar's centre on the row icons' column (x = 36).
			px={6}
			h={NAV_BOTTOM_BAR_HEIGHT}
			justify="space-between"
			data-nav-bottom-bar
			className="nf-nav-bottom-bar"
			style={{ borderTop: "1px solid var(--mantine-color-default-border)", flexShrink: 0 }}
		>
			<NavUserMenu onLogout={onLogout} />
			{/* Past the collapsed width; shown once the sidebar opens (nav-collapsed.css). */}
			<Group
				gap={NAV_BOTTOM_GAP_PX}
				wrap="nowrap"
				style={{ flex: 1, minWidth: 0 }}
				justify="center"
				className="nf-nav-expanded-only"
			>
				{shown.map((item) => (
					<BarIcon
						key={item.id}
						item={item}
						label={t(item.labelKey)}
						badgeCount={resolveBadge(item.badge).count}
					/>
				))}
			</Group>
			<div className="nf-nav-expanded-only" style={{ display: "flex", flexShrink: 0 }}>
				<NavOverflowMenu entries={entries} onSaveLayout={onSaveLayout} overflowLinks={overflow} />
			</div>
		</Group>
	);
}
