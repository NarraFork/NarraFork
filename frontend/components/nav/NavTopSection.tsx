/**
 * Top of the sidebar: brand row (collapses the sidebar; notifications and workspaces on
 * the right), a status row that only appears when something needs saying, the search box
 * and "New session".
 *
 * These used to live in the page header. The header is gone on desktop, so everything
 * global sits here, in the column the reader already scans.
 */

import { Group, Kbd, NavLink, Stack, TextInput, Tooltip } from "@mantine/core";
import { IconEdit, IconSearch } from "@tabler/icons-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { requestDashboardComposerFocus } from "../../lib/dashboard-composer-focus";
import { BrandTitle } from "../common/BrandTitle";
import { NotificationBell } from "../notifications/NotificationBell";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

/** Sidebar search: Enter opens `/search`, scoped to the current project page if any. */
export function NavSearchBox({ onSearched }: { onSearched?: () => void }) {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const projectId = useRouterState({
		select: (state) => state.location.pathname.match(/^\/projects\/([^/]+)/)?.[1],
	});

	// ⌘K / Ctrl+K from anywhere, editors included: there is no other binding for it.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() !== "k" || e.shiftKey || e.altKey) return;
			if (!(IS_MAC ? e.metaKey : e.ctrlKey)) return;
			const input = inputRef.current;
			if (!input || input.offsetParent === null) return;
			e.preventDefault();
			input.focus();
			input.select();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const search = () => {
		const q = query.trim();
		if (!q) return;
		navigate({
			to: "/search",
			search: { q, ...(projectId ? { project: decodeURIComponent(projectId) } : {}) },
		});
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
			rightSection={<Kbd size="xs">{IS_MAC ? "⌘K" : "Ctrl K"}</Kbd>}
			rightSectionWidth={IS_MAC ? 36 : 52}
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

export function NavTopSection({
	collapsed,
	onToggleCollapsed,
	statusBadges,
	onNavigate,
}: {
	collapsed: boolean;
	onToggleCollapsed: () => void;
	/** Maintenance / update / evidence / output-speed badges; each renders null when idle. */
	statusBadges: ReactNode;
	onNavigate?: () => void;
}) {
	const { t } = useTranslation("nav");
	return (
		<Stack gap={6} mb={6}>
			<Group justify="space-between" wrap="nowrap" gap={4} className="nf-nav-brand-row" px={4}>
				<Tooltip
					label={t(collapsed ? "expandSidebar" : "collapseSidebar")}
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
			<NewSessionLink collapsed={collapsed} onNavigate={onNavigate} />
		</Stack>
	);
}
