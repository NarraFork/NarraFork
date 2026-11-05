/**
 * Top of the sidebar: brand row (collapses the sidebar; notifications and workspaces on
 * the right), a status row that only appears when something needs saying, "Search" and
 * "New session". Collapsed shows the left part of the same rows (NavHoverPanel).
 *
 * These used to live in the page header. The header is gone on desktop, so everything
 * global sits here, in the column the reader already scans.
 */

import { Group, Kbd, NavLink, Stack, Tooltip } from "@mantine/core";
import { IconEdit, IconSearch } from "@tabler/icons-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useMobileViewport } from "../../hooks/useMobileViewport";
import { requestDashboardComposerFocus } from "../../lib/dashboard-composer-focus";
import { requestSearchPageFocus } from "../../lib/search-page-focus";
import { TOUCH_POINTER_MEDIA_QUERY, useMatchMedia } from "../../lib/use-match-media";
import { BrandTitle } from "../common/BrandTitle";
import { NotificationBell } from "../notifications/NotificationBell";
import { HeaderPullToRefresh } from "./HeaderPullToRefresh";
import { useNavRender } from "./nav-render-context";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

/**
 * Apple keyboards say ⌘, everything else Ctrl. `userAgentData.platform` where the browser
 * has it; `navigator.platform` (deprecated, still everywhere) otherwise.
 */
const IS_MAC = (() => {
	if (typeof navigator === "undefined") return false;
	const platform =
		(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
		navigator.platform ??
		"";
	return /mac|iphone|ipad/i.test(platform);
})();

/** The search page, scoped to the project page the reader is on, if any. */
function useSearchTarget() {
	const projectId = useRouterState({
		select: (state) => state.location.pathname.match(/^\/projects\/([^/]+)/)?.[1],
	});
	return projectId ? { project: decodeURIComponent(projectId) } : {};
}

/**
 * Goes to the search page and puts the cursor in its box. A row like "New session": the
 * box itself lives on the page, where there is room for it and its filters.
 */
export function NavSearchLink({ onNavigate }: { onNavigate?: () => void }) {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const search = useSearchTarget();
	const isTouch = useMatchMedia(TOUCH_POINTER_MEDIA_QUERY);
	return (
		<NavLink
			label={t("search")}
			active={pathname === "/search"}
			leftSection={<IconSearch size={16} />}
			// A keyboard hint means nothing without a keyboard.
			rightSection={
				isTouch ? undefined : (
					<Kbd size="xs" style={{ opacity: 0.7 }}>
						{IS_MAC ? "⌘K" : "Ctrl K"}
					</Kbd>
				)
			}
			onClick={() => {
				requestSearchPageFocus();
				navigate({ to: "/search", search });
				onNavigate?.();
			}}
			aria-label={t("search")}
		/>
	);
}

/**
 * The brand row's fixed height: the badges, the workspace button and the bell all fit
 * in it, so nothing below moves when one of them appears.
 */
const NAV_BRAND_ROW_HEIGHT = 32;
/**
 * Width the brand shrinks into when collapsed: the 72px column less 8px each side. It
 * sits at x = 20 (16px navbar padding + the row's 4px), so nav-collapsed.css also
 * shifts it 12px left, onto x = 8.
 */
const NAV_COLLAPSED_BRAND_ROOM_PX = 56;

/** Goes to the home page and puts the cursor in its composer. */
export function NewSessionLink({ onNavigate }: { onNavigate?: () => void }) {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	return (
		<NavLink
			label={t("newSession")}
			active={pathname === "/"}
			leftSection={<IconEdit size={16} />}
			onClick={() => {
				requestDashboardComposerFocus();
				navigate({ to: "/" });
				onNavigate?.();
			}}
			aria-label={t("newSession")}
		/>
	);
}

/**
 * ⌘K / Ctrl+K from anywhere, editors included: there is no other binding for it. Goes
 * to the search page with the cursor in its box (already there: just focuses it).
 */
function useSearchShortcut() {
	const navigate = useNavigate();
	const search = useSearchTarget();
	const searchRef = useRef(search);
	searchRef.current = search;
	const onSearchPage = useRouterState({
		select: (state) => state.location.pathname === "/search",
	});
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() !== "k" || e.shiftKey || e.altKey) return;
			if (!(IS_MAC ? e.metaKey : e.ctrlKey)) return;
			e.preventDefault();
			requestSearchPageFocus();
			// On the page: keep its query and filters, only take the cursor there.
			if (!onSearchPage) navigate({ to: "/search", search: searchRef.current });
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [navigate, onSearchPage]);
}

export function NavTopSection({
	onToggleCollapsed,
	statusBadges,
	onNavigate,
}: {
	onToggleCollapsed: () => void;
	/** Maintenance / update / evidence badges; each renders null when idle. */
	statusBadges: ReactNode;
	onNavigate?: () => void;
}) {
	const { t } = useTranslation("nav");
	const { storedCollapsed } = useNavRender();
	useSearchShortcut();
	const brandRowRef = useRef<HTMLDivElement>(null);
	const brandRef = useRef<HTMLDivElement>(null);
	const brandScale = useCollapsedBrandScale(brandRef);
	const isMobile = useMobileViewport();
	const isTouch = useMatchMedia(TOUCH_POINTER_MEDIA_QUERY);
	// One layout, collapsed or not: collapsed clips every row to its icon (NavHoverPanel,
	// nav-collapsed.css), so the icons stay where they are and the rest appears in place
	// once it opens.
	return (
		<Stack gap={6} mb={6}>
			<Group
				ref={brandRowRef}
				justify="space-between"
				wrap="nowrap"
				gap={4}
				className="nf-nav-brand-row"
				px={4}
				h={NAV_BRAND_ROW_HEIGHT}
				pos="relative"
			>
				{/* Phones: pull down here to reload the app (the header row it lived on is
				    gone; this is the drawer's top edge, which never scrolls). */}
				<HeaderPullToRefresh targetRef={brandRowRef} enabled={isMobile && isTouch} />
				<Tooltip
					label={t(storedCollapsed ? "expandSidebar" : "collapseSidebar")}
					position="right"
					openDelay={400}
				>
					<BrandTitle
						ref={brandRef}
						order={4}
						onClick={onToggleCollapsed}
						className="nf-nav-brand"
						style={{
							cursor: "pointer",
							userSelect: "none",
							minWidth: 0,
							flexShrink: 0,
							// Collapsed: the name and its attribution line shrink together to fit
							// the column (nav-collapsed.css). A transform, so the row keeps its height.
							"--nf-nav-brand-scale": brandScale,
						}}
					/>
				</Tooltip>
				<Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }} className="nf-nav-expanded-only">
					<WorkspaceSwitcher />
					<NotificationBell />
				</Group>
			</Group>
			{/* Collapses to nothing when every badge renders null (see nav-collapsed.css). */}
			<Group gap={6} wrap="wrap" px={4} className="nf-nav-status-row">
				{statusBadges}
			</Group>
			<NavSearchLink onNavigate={onNavigate} />
			<NewSessionLink onNavigate={onNavigate} />
		</Stack>
	);
}

/**
 * How far the brand shrinks to fit the collapsed column: its natural width against the
 * room left of the column's right margin. 1 when it already fits.
 */
function useCollapsedBrandScale(ref: RefObject<HTMLDivElement | null>): number {
	const [scale, setScale] = useState(1);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () => {
			const width = el.offsetWidth;
			setScale(width > 0 ? Math.min(1, NAV_COLLAPSED_BRAND_ROOM_PX / width) : 1);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref]);
	return scale;
}
