/**
 * Header row for a directory group in the sidebar's recent-tab list.
 *
 * The row states the working directory ONCE for every narrator inside it, which is the
 * entire saving of directory mode: member rows below render with their subtitle hidden.
 *
 * While collapsed it must still report what is happening inside, otherwise the mode would
 * hide state — a narrator blocked on a permission prompt in a folded group would look the
 * same as an idle one. `aggregateDirectoryStatus` supplies that summary, and the counts
 * stay live because the WS subscription (`RecentTabsWSProvider`) is independent of how
 * rows are rendered.
 */

import { aggregateDirectoryStatus } from "@frontend/hooks/recent-tab-directory-groups";
import type { RecentTab } from "@frontend/hooks/recent-tabs-utils";
import { Badge, Group, NavLink, Text, Tooltip } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconFolder, IconFolderOpen } from "@tabler/icons-react";
import { useMemo } from "react";

export interface RecentTabDirectoryRowProps {
	path: string;
	label: string;
	/** Member tabs. Named `tabs` rather than `children` so it is not mistaken for JSX content. */
	tabs: RecentTab[];
	collapsed: boolean;
	/** True when any member is the tab for the page currently open. */
	active: boolean;
	onToggle: (path: string) => void;
	/** When true and active, drop the top radius so the row meets the nav item above. */
	connectTop?: boolean;
	t: (key: string, opts?: Record<string, unknown>) => string;
}

export function RecentTabDirectoryRow({
	path,
	label,
	tabs,
	collapsed,
	active,
	onToggle,
	connectTop,
	t,
}: RecentTabDirectoryRowProps) {
	const summary = useMemo(() => aggregateDirectoryStatus(tabs), [tabs]);
	const Chevron = collapsed ? IconChevronRight : IconChevronDown;
	const FolderIcon = collapsed ? IconFolder : IconFolderOpen;

	return (
		<div data-tab-sort-id={`dir:${path}`} style={{ overflow: "hidden" }}>
			<NavLink
				// NavLink defaults to an <a> without href, which is not a focusable
				// element — the collapse toggle would be mouse-only. A real button gets
				// Tab focus and Enter/Space activation for free, matching the tab rows
				// above (SortableTabItem renders NavLink over a router link target).
				component="button"
				type="button"
				active={active}
				onClick={() => onToggle(path)}
				aria-expanded={!collapsed}
				aria-label={t(collapsed ? "expandDirectory" : "collapseDirectory", { path })}
				label={
					<Group gap={4} wrap="nowrap" style={{ overflow: "hidden" }}>
						<Text size="sm" fw={500} truncate>
							{label}
						</Text>
					</Group>
				}
				description={
					<Text
						size="xs"
						c="dimmed"
						truncate
						// Same `rtl` trick the narrator rows use for cwd: long paths keep their
						// tail (the part that identifies the directory) instead of their root.
						style={{ direction: "rtl", textAlign: "left" }}
					>
						{path}
					</Text>
				}
				leftSection={
					<Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
						<Chevron size={12} style={{ opacity: 0.6 }} />
						<FolderIcon size={16} color={collapsed ? summary.accentColor : undefined} />
					</Group>
				}
				rightSection={
					<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
						{/* Counts are only shown while collapsed: expanded, each member row shows
						    its own state, and repeating it on the header is noise. */}
						{collapsed && summary.attentionCount > 0 && (
							<Tooltip
								label={t("directoryAttentionCount", { count: summary.attentionCount })}
								withArrow
								position="right"
							>
								<Badge size="xs" circle color="yellow" variant="filled">
									{summary.attentionCount}
								</Badge>
							</Tooltip>
						)}
						{collapsed && summary.workingCount > 0 && (
							<Tooltip
								label={t("directoryWorkingCount", { count: summary.workingCount })}
								withArrow
								position="right"
							>
								<Badge size="xs" circle color="blue" variant="filled">
									{summary.workingCount}
								</Badge>
							</Tooltip>
						)}
						<Tooltip
							label={t("directoryNarratorCount", { count: tabs.length })}
							withArrow
							position="right"
						>
							<Text size="xs" c="dimmed" lh={1}>
								{tabs.length}
							</Text>
						</Tooltip>
					</Group>
				}
				styles={{
					root: {
						cursor: "pointer",
						...(connectTop && active ? { borderTopLeftRadius: 0, borderTopRightRadius: 0 } : {}),
					},
					label: { overflow: "hidden" },
				}}
			/>
		</div>
	);
}
