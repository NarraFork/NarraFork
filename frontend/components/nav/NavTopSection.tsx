/**
 * Top of the sidebar: brand row (collapses the sidebar; notifications and workspaces on
 * the right), a status row that only appears when something needs saying, the search box
 * and "New session".
 *
 * These used to live in the page header. The header is gone on desktop, so everything
 * global sits here, in the column the reader already scans.
 */

import { ActionIcon, Group, Kbd, NavLink, Stack, TextInput, Tooltip } from "@mantine/core";
import { IconEdit, IconSearch } from "@tabler/icons-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBranding } from "../../hooks/useBranding";
import { requestDashboardComposerFocus } from "../../lib/dashboard-composer-focus";
import { TOUCH_POINTER_MEDIA_QUERY, useMatchMedia } from "../../lib/use-match-media";
import { BrandTitle } from "../common/BrandTitle";
import { NotificationBell } from "../notifications/NotificationBell";
import {
	requestNavSearchFocus,
	subscribeNavSearchFocus,
	takeNavSearchFocusRequest,
	useNavRender,
} from "./nav-render-context";
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

/** Sidebar search: Enter opens `/search`, scoped to the current project page if any. */
export function NavSearchBox({ onSearched }: { onSearched?: () => void }) {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const isTouch = useMatchMedia(TOUCH_POINTER_MEDIA_QUERY);
	const projectId = useRouterState({
		select: (state) => state.location.pathname.match(/^\/projects\/([^/]+)/)?.[1],
	});

	// ⌘K / Ctrl+K (see `useNavSearchShortcut`) and the rail's search icon ask for focus;
	// the box may mount only after the rail opens, so it also takes a pending request.
	useEffect(() => {
		const take = () => {
			const input = inputRef.current;
			if (!input || !takeNavSearchFocusRequest()) return;
			input.focus();
			input.select();
		};
		take();
		return subscribeNavSearchFocus(take);
	}, []);

	const search = () => {
		const q = query.trim();
		if (!q) return;
		navigate({
			to: "/search",
			search: { q, ...(projectId ? { project: decodeURIComponent(projectId) } : {}) },
		});
		// The search page owns the query from here (it has its own box); leaving it here too
		// reads as a filter still applied to the sidebar.
		setQuery("");
		inputRef.current?.blur();
		onSearched?.();
	};

	return (
		<TextInput
			ref={inputRef}
			size="xs"
			placeholder={t("searchPlaceholder")}
			value={query}
			onChange={(e) => setQuery(e.currentTarget.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter" && !e.nativeEvent.isComposing) search();
				if (e.key === "Escape") e.currentTarget.blur();
			}}
			leftSection={<IconSearch size={14} />}
			// A keyboard hint means nothing without a keyboard.
			rightSection={isTouch ? undefined : <Kbd size="xs">{IS_MAC ? "⌘K" : "Ctrl K"}</Kbd>}
			rightSectionWidth={isTouch ? undefined : IS_MAC ? 36 : 52}
			rightSectionPointerEvents="none"
			aria-label={t("searchPlaceholder")}
		/>
	);
}

/** Goes to the home page and puts the cursor in its composer. */
export function NewSessionLink({
	collapsed,
	onNavigate,
}: {
	collapsed: boolean;
	onNavigate?: () => void;
}) {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	return (
		<Tooltip label={t("newSession")} position="right" disabled={!collapsed}>
			<NavLink
				label={collapsed ? undefined : t("newSession")}
				active={pathname === "/"}
				leftSection={<IconEdit size={16} />}
				onClick={() => {
					requestDashboardComposerFocus();
					navigate({ to: "/" });
					onNavigate?.();
				}}
				aria-label={t("newSession")}
			/>
		</Tooltip>
	);
}

/** ⌘K / Ctrl+K from anywhere, editors included: there is no other binding for it. */
function useNavSearchShortcut(openPanel: () => void) {
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() !== "k" || e.shiftKey || e.altKey) return;
			if (!(IS_MAC ? e.metaKey : e.ctrlKey)) return;
			e.preventDefault();
			openPanel();
			requestNavSearchFocus();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [openPanel]);
}

/** The brand's first letter, the rail's stand-in for the full name. */
function BrandMark({ onClick, label }: { onClick: () => void; label: string }) {
	const branding = useBranding();
	return (
		<Tooltip label={label} position="right">
			<ActionIcon
				variant="light"
				size={32}
				radius="md"
				onClick={onClick}
				aria-label={label}
				className="nf-nav-brand-mark"
			>
				<span style={{ fontWeight: 700, fontSize: 15 }}>{branding.name.slice(0, 1)}</span>
			</ActionIcon>
		</Tooltip>
	);
}

export function NavTopSection({
	onToggleCollapsed,
	statusBadges,
	onNavigate,
}: {
	onToggleCollapsed: () => void;
	/** Maintenance / update / evidence / output-speed badges; each renders null when idle. */
	statusBadges: ReactNode;
	onNavigate?: () => void;
}) {
	const { t } = useTranslation("nav");
	const { collapsed, storedCollapsed, openPanel } = useNavRender();
	useNavSearchShortcut(openPanel);

	if (collapsed) {
		return (
			<Stack gap={4} mb={6} align="center" className="nf-nav-brand-row">
				<BrandMark onClick={onToggleCollapsed} label={t("expandSidebar")} />
				<Tooltip label={t("searchPlaceholder")} position="right">
					<ActionIcon
						variant="subtle"
						color="gray"
						size={32}
						onClick={() => {
							openPanel();
							requestNavSearchFocus();
						}}
						aria-label={t("searchPlaceholder")}
					>
						<IconSearch size={18} />
					</ActionIcon>
				</Tooltip>
				<NewSessionLink collapsed onNavigate={onNavigate} />
				<NotificationBell />
				<WorkspaceSwitcher />
			</Stack>
		);
	}
	return (
		<Stack gap={6} mb={6}>
			<Group justify="space-between" wrap="nowrap" gap={4} className="nf-nav-brand-row" px={4}>
				<Tooltip
					label={t(storedCollapsed ? "expandSidebar" : "collapseSidebar")}
					position="right"
					openDelay={400}
				>
					<BrandTitle
						order={4}
						onClick={onToggleCollapsed}
						style={{ cursor: "pointer", userSelect: "none", minWidth: 0 }}
					/>
				</Tooltip>
				<Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
					<WorkspaceSwitcher />
					<NotificationBell />
				</Group>
			</Group>
			{/* Collapses to nothing when every badge renders null (see nav-collapsed.css). */}
			<Group gap={6} wrap="wrap" px={4} className="nf-nav-status-row">
				{statusBadges}
			</Group>
			<NavSearchBox onSearched={onNavigate} />
			<NewSessionLink collapsed={false} onNavigate={onNavigate} />
		</Stack>
	);
}
