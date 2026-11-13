/**
 * Top of the sidebar: brand row (collapses the sidebar; notifications and workspaces on
 * the right), a status row that only appears when something needs saying, "Search" and
 * "New session". Collapsed shows the left part of the same rows (NavHoverPanel).
 *
 * These used to live in the page header. The header is gone on desktop, so everything
 * global sits here, in the column the reader already scans.
 */

import { Group, Kbd, NavLink, Stack, Text, Tooltip } from "@mantine/core";
import { IconEdit, IconSearch } from "@tabler/icons-react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
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
 * The label of the two action rows at the top: the same text as a session row's title,
 * so "Search" and "New session" have the session rows' height and read as the first rows
 * of the same list rather than as a separate block of bigger buttons. The shortcut sits
 * right after the word and shows on hover only (nav-collapsed.css); touch gets none, a
 * keyboard hint means nothing without a keyboard.
 */
function NavRowLabelWithHint({ hint, children }: { hint?: string; children: ReactNode }) {
	return (
		<Group gap={8} wrap="nowrap">
			<Text size="sm" truncate>
				{children}
			</Text>
			{hint && (
				// `lh={1}`: a Kbd at the body line height is taller than the label and would
				// make this row 2px taller than the session rows.
				<Kbd size="xs" lh={1} className="nf-nav-row-kbd">
					{hint}
				</Kbd>
			)}
		</Group>
	);
}

const SEARCH_SHORTCUT_LABEL = IS_MAC ? "⌘K" : "Ctrl K";
const NEW_SESSION_SHORTCUT_LABEL = IS_MAC ? "⌃`" : "Ctrl `";

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
			label={
				<NavRowLabelWithHint hint={isTouch ? undefined : SEARCH_SHORTCUT_LABEL}>
					{t("search")}
				</NavRowLabelWithHint>
			}
			active={pathname === "/search"}
			leftSection={<IconSearch size={16} />}
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
 * Room between the brand (or the status row) and "Search", on top of the stack's 6px.
 * Below "New session" nothing is added: the list's own pinned divider is the seam.
 */
const NAV_ACTIONS_GAP_ABOVE = 6;
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
	const isTouch = useMatchMedia(TOUCH_POINTER_MEDIA_QUERY);
	return (
		<NavLink
			label={
				<NavRowLabelWithHint hint={isTouch ? undefined : NEW_SESSION_SHORTCUT_LABEL}>
					{t("newSession")}
				</NavRowLabelWithHint>
			}
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

/** Cmd/Ctrl+K: the search page, with the cursor in its box (already there: just focuses it). */
function isSearchShortcut(e: KeyboardEvent): boolean {
	return (
		e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey && (IS_MAC ? e.metaKey : e.ctrlKey)
	);
}

/**
 * Ctrl+` (on Mac too: Cmd+` switches the app's windows): a new session. By physical key,
 * so layouts where that key types something else still match.
 */
function isNewSessionShortcut(e: KeyboardEvent): boolean {
	return e.code === "Backquote" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
}

/** From anywhere, editors and the composer included: neither has another use for them. */
function useNavShortcuts() {
	const navigate = useNavigate();
	const search = useSearchTarget();
	const searchRef = useRef(search);
	searchRef.current = search;
	const onSearchPage = useRouterState({
		select: (state) => state.location.pathname === "/search",
	});
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (isSearchShortcut(e)) {
				e.preventDefault();
				requestSearchPageFocus();
				// On the page: keep its query and filters, only take the cursor there.
				if (!onSearchPage) navigate({ to: "/search", search: searchRef.current });
				return;
			}
			if (isNewSessionShortcut(e)) {
				e.preventDefault();
				requestDashboardComposerFocus();
				navigate({ to: "/" });
			}
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
	useNavShortcuts();
	const brandRowRef = useRef<HTMLDivElement>(null);
	const brandRef = useRef<HTMLDivElement>(null);
	const brandScale = useCollapsedBrandScale(brandRef);
	const isMobile = useMobileViewport();
	const isTouch = useMatchMedia(TOUCH_POINTER_MEDIA_QUERY);
	// One layout, collapsed or not: collapsed clips every row to its icon (NavHoverPanel,
	// nav-collapsed.css), so the icons stay where they are and the rest appears in place
	// once it opens.
	return (
		<Stack gap={6}>
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
					disabled={isMobile}
				>
					<Group gap={6} wrap="nowrap" style={{ flexShrink: 1, minWidth: 0 }}>
						<BrandTitle
							ref={brandRef}
							order={4}
							// Narrow windows own a drawer, not the desktop collapse preference.
							onClick={isMobile ? onNavigate : onToggleCollapsed}
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
						<NavVersionLink />
					</Group>
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
			{/* Spaced off the brand, then packed like the session rows they lead into. */}
			<Stack gap={0} mt={NAV_ACTIONS_GAP_ABOVE}>
				<NavSearchLink onNavigate={onNavigate} />
				<NewSessionLink onNavigate={onNavigate} />
			</Stack>
		</Stack>
	);
}

/**
 * The running version, right of the brand: just the release (`v0.9.11`), with the build's
 * commit in the tooltip. Opens Settings → About. Hidden while collapsed, like the bell.
 */
function NavVersionLink() {
	const { t } = useTranslation("nav");
	const full = __APP_VERSION__;
	const release = full.split("+")[0] ?? full;
	return (
		<Tooltip label={`${t("version")} v${full}`} position="bottom" openDelay={400}>
			<Text
				component={Link}
				to="/settings/about"
				size="xs"
				c="dimmed"
				truncate
				className="nf-nav-expanded-only"
				data-nav-version
				// Never stretch: the blank space between the brand and the icons has to stay
				// draggable (a link is `no-drag` in the WCO title bar). It may still shrink, so
				// a narrow sidebar truncates it instead of pushing the icons out.
				style={{ flexShrink: 1, minWidth: 0, textDecoration: "none" }}
			>
				v{release}
			</Text>
		</Tooltip>
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
