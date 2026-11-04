/**
 * Bottom of the sidebar: `[avatar] [icons…] [⋯]`.
 *
 * The icons are every destination that is not a session: all sessions, the customisable
 * entries the user keeps visible, and settings. Names are tooltips, unread counts are a
 * dot. Icons that do not fit the width go into "⋯", which also holds the entries the user
 * tucked away and the layout customisation. Sessions get all the height this saves.
 *
 * Collapsed (60px) the same entries stack vertically instead.
 */

import { ActionIcon, Group, Indicator, Stack, Tooltip } from "@mantine/core";
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
	tooltipPosition,
}: {
	item: BarItem;
	label: string;
	badgeCount: number;
	tooltipPosition: "top" | "right";
}) {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const active = pathname.startsWith(item.activePrefix ?? item.to);
	const Icon = item.icon;
	return (
		<Tooltip label={label} position={tooltipPosition} withArrow>
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
	collapsed,
	entries,
	visibleItems,
	onSaveLayout,
	onLogout,
}: {
	collapsed: boolean;
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

	const barRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = barRef.current;
		if (!el || collapsed) return;
		setWidth(el.clientWidth);
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setWidth(el.clientWidth));
		observer.observe(el);
		return () => observer.disconnect();
	}, [collapsed]);

	const fit = collapsed
		? items.length
		: width > 0
			? navBottomFitCount({ width, reservedPx: RESERVED_PX, itemCount: items.length })
			: items.length;
	const { shown, overflow } = splitNavBottomItems(items, fit);
	const icons = shown.map((item) => (
		<BarIcon
			key={item.id}
			item={item}
			label={t(item.labelKey)}
			badgeCount={resolveBadge(item.badge).count}
			tooltipPosition={collapsed ? "right" : "top"}
		/>
	));
	const more = (
		<NavOverflowMenu
			entries={entries}
			onSaveLayout={onSaveLayout}
			navCollapsed={collapsed}
			overflowLinks={overflow}
		/>
	);

	if (collapsed) {
		return (
			<Stack gap={NAV_BOTTOM_GAP_PX} align="center" mt={4}>
				{icons}
				{more}
				<NavUserMenu onLogout={onLogout} navCollapsed />
			</Stack>
		);
	}
	return (
		<Group
			ref={barRef}
			gap={8}
			wrap="nowrap"
			mt={4}
			px={4}
			justify="space-between"
			data-nav-bottom-bar
			style={{ borderTop: "1px solid var(--mantine-color-default-border)", paddingTop: 6 }}
		>
			<NavUserMenu onLogout={onLogout} navCollapsed={false} />
			<Group
				gap={NAV_BOTTOM_GAP_PX}
				wrap="nowrap"
				style={{ flex: 1, minWidth: 0 }}
				justify="center"
			>
				{icons}
			</Group>
			{more}
		</Group>
	);
}
