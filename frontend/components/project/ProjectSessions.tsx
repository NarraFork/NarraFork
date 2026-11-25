/**
 * The project page's 「会话」 (R2): three tabs — 进行中, 全部 and 我的 — each with its count. 进行中
 * shows the running and waiting sessions as the home page's cards with their latest tool calls
 * (`RunningCards`), then the ones changed in the last 7 days as compact rows under 「最近 7 天」;
 * 全部 and 我的 are compact rows: the status dot (the session colours), the title, what a running
 * one is doing now, who owns it and when it last changed. Team coordinators are on the team cards and workers are not
 * sessions of the project page: the server leaves both out. Keyset pages, 「加载更多」.
 */
import { useProjectSessions } from "@frontend/hooks/useProjectOverview";
import { formatSmartTime } from "@frontend/lib/format";
import { Alert, Box, Button, Group, Loader, SimpleGrid, Stack, Tabs, Text } from "@mantine/core";
import {
	PROJECT_RUNNING_CARDS_SHOWN,
	PROJECT_SESSION_COUNT_CAP,
	PROJECT_SESSION_VIEWS,
	type ProjectSessionRow,
	type ProjectSessionView,
} from "@shared/project-overview";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	MAX_ACTIVITY_SUBSCRIPTIONS,
	SESSION_CARD_GRID_COLS,
	SessionCard,
} from "../dashboard/DashboardSessions";
import { toSession } from "../dashboard/dashboard-sessions";
import { useNarratorActivity } from "../dashboard/useNarratorActivity";
import { MONO, StatusDot, TABULAR } from "../teams/team-page-ui";
import { UserAvatar } from "../UserAvatar";
import { sessionCountLabel, sessionLine, sessionSections, sessionTone } from "./project-page-model";

const AMBER_TEXT = "light-dark(var(--mantine-color-yellow-9), var(--mantine-color-yellow-4))";

function LineText({ row }: { row: ProjectSessionRow }) {
	const { t } = useTranslation("projects");
	const line = sessionLine(row);
	if (!line) return null;
	return (
		<>
			<Text
				component="span"
				inherit
				fw={line.tone === "amber" ? 600 : undefined}
				style={line.tone === "amber" ? { color: AMBER_TEXT } : undefined}
			>
				{line.tool
					? t(`teams.page.row.tools.${line.values.tool}`, {
							defaultValue: String(line.values.tool),
						})
					: t(`teams.page.row.${line.key}`, line.values)}
			</Text>
			{line.detail && (
				<>
					{" · "}
					<Text component="span" inherit style={MONO}>
						{line.detail}
					</Text>
				</>
			)}
		</>
	);
}

function Owner({ row }: { row: ProjectSessionRow }) {
	if (!row.owner) return null;
	return (
		<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
			<UserAvatar
				username={row.owner.username}
				avatarColor={row.owner.avatarColor}
				avatarImageId={row.owner.avatarImageId}
				userId={row.owner.userId}
				size={18}
				showTooltip={false}
			/>
			<Text size="sm" c="dimmed" truncate>
				{row.owner.username}
			</Text>
		</Group>
	);
}

function SessionRow({ row, phone }: { row: ProjectSessionRow; phone: boolean }) {
	const line = sessionLine(row);
	const title = row.title || row.id;
	return (
		<Link
			to="/narrators/$narratorId"
			params={{ narratorId: row.id }}
			style={{ textDecoration: "none", color: "inherit", display: "block" }}
			data-testid="project-session-row"
			data-session-id={row.id}
			data-status={row.status}
		>
			<Box
				className="nf-project-session-row"
				px={8}
				py={phone ? 8 : 10}
				style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
			>
				{phone ? (
					<Group gap={10} wrap="nowrap" align="flex-start">
						<Box pt={6}>
							<StatusDot tone={sessionTone(row.status)} />
						</Box>
						<Stack gap={1} style={{ flex: 1, minWidth: 0 }}>
							<Text size="sm" fw={500} truncate>
								{title}
							</Text>
							<Text size="xs" c="dimmed" truncate>
								<LineText row={row} />
								{line && row.owner && " · "}
								{row.owner?.username}
							</Text>
						</Stack>
						<Text size="xs" c="dimmed" style={{ ...TABULAR, flexShrink: 0 }} title={row.updatedAt}>
							{formatSmartTime(row.updatedAt)}
						</Text>
					</Group>
				) : (
					<Group gap="md" wrap="nowrap">
						<StatusDot tone={sessionTone(row.status)} />
						<Text size="sm" fw={500} truncate style={{ flex: "1 1 30%", minWidth: 0 }}>
							{title}
						</Text>
						<Text size="sm" c="dimmed" truncate style={{ flex: "1 1 42%", minWidth: 0 }}>
							<LineText row={row} />
						</Text>
						<Box style={{ flex: "0 0 140px", minWidth: 0 }}>
							<Owner row={row} />
						</Box>
						<Text
							size="sm"
							c="dimmed"
							ta="right"
							style={{ ...TABULAR, flex: "0 0 120px" }}
							title={row.updatedAt}
						>
							{formatSmartTime(row.updatedAt)}
						</Text>
					</Group>
				)}
			</Box>
		</Link>
	);
}

/**
 * 进行中's running and waiting sessions as the home page's cards (`SessionCard`, the same grid),
 * each with its latest tool calls from the live activity subscription (`useNarratorActivity`,
 * one `activity` subscription for the cards shown). At most {@link PROJECT_RUNNING_CARDS_SHOWN}
 * cards before 「显示全部」, and never more than the dashboard's subscription cap, so a project
 * with many running sessions stays bounded.
 */
function RunningCards({ rows }: { rows: readonly ProjectSessionRow[] }) {
	const { t } = useTranslation("projects");
	const [all, setAll] = useState(false);
	const shown = rows.slice(0, all ? MAX_ACTIVITY_SUBSCRIPTIONS : PROJECT_RUNNING_CARDS_SHOWN);
	const activity = useNarratorActivity(shown.map((row) => row.id));
	return (
		<Stack gap="xs" data-testid="project-running-cards">
			<SimpleGrid cols={SESSION_CARD_GRID_COLS} spacing="sm">
				{shown.map((row) => {
					const live = activity.get(row.id);
					return (
						<SessionCard
							key={row.id}
							session={toSession(
								{
									id: row.id,
									title: row.title,
									cwd: row.cwd,
									status: row.status,
									substatus: row.substatus,
									updatedAt: row.updatedAt,
								},
								live,
							)}
							activity={live}
						/>
					);
				})}
			</SimpleGrid>
			{rows.length > shown.length && !all && (
				<Box>
					<Button
						size="xs"
						variant="subtle"
						onClick={() => setAll(true)}
						data-testid="project-running-show-all"
					>
						{t("page.sessions.showAll", { count: rows.length })}
					</Button>
				</Box>
			)}
		</Stack>
	);
}

const ROW_HOVER_CSS = `.nf-project-session-row:hover { background: var(--mantine-color-default-hover); }`;

export function ProjectSessions({ projectId, phone }: { projectId: string; phone: boolean }) {
	const { t } = useTranslation("projects");
	const [view, setView] = useState<ProjectSessionView>("active");
	const sessions = useProjectSessions(projectId, view);
	// The first page carries every tab's count; keep the last ones seen while a tab loads.
	const lastCounts = useRef<Record<ProjectSessionView, number> | null>(null);
	const firstCounts = sessions.data?.pages[0]?.counts ?? null;
	if (firstCounts) lastCounts.current = firstCounts;
	const counts = firstCounts ?? lastCounts.current;
	const rows = sessions.data?.pages.flatMap((page) => page.items) ?? [];
	const sections = sessionSections(rows, view);
	return (
		<Stack gap="xs" data-testid="project-sessions">
			<style>{ROW_HOVER_CSS}</style>
			<Text fw={700} size="lg">
				{t("compatibility.sessions")}
			</Text>
			<Tabs
				value={view}
				onChange={(value) => value && setView(value as ProjectSessionView)}
				variant="default"
			>
				<Tabs.List>
					{PROJECT_SESSION_VIEWS.map((key) => (
						<Tabs.Tab key={key} value={key} data-testid="project-sessions-tab" data-view={key}>
							<Group gap={6} wrap="nowrap">
								<span>{t(`page.sessions.views.${key}`)}</span>
								<Text component="span" size="sm" c="dimmed" style={TABULAR}>
									{sessionCountLabel(counts?.[key], PROJECT_SESSION_COUNT_CAP)}
								</Text>
							</Group>
						</Tabs.Tab>
					))}
				</Tabs.List>
			</Tabs>
			{sessions.isLoading && <Loader size="sm" />}
			{sessions.isError && <Alert color="red">{t("compatibility.sessionsUnavailable")}</Alert>}
			{sessions.isSuccess && sections.length === 0 && (
				<Text size="sm" c="dimmed" py="sm">
					{t(`page.sessions.empty.${view}`)}
				</Text>
			)}
			<Stack gap={0}>
				{sections.map((section) =>
					section.key === "running" ? (
						<Box key={section.key} pt={6} pb={4}>
							<RunningCards rows={section.rows} />
						</Box>
					) : (
						<Box key={section.key}>
							{section.key === "recent" && (
								<Text
									size="xs"
									c="dimmed"
									px={8}
									pt={12}
									pb={6}
									data-testid="project-sessions-recent"
								>
									{t("page.sessions.recent")}
								</Text>
							)}
							{section.rows.map((row) => (
								<SessionRow key={row.id} row={row} phone={phone} />
							))}
						</Box>
					),
				)}
			</Stack>
			{sessions.hasNextPage && (
				<Box>
					<Button
						size="xs"
						variant="subtle"
						loading={sessions.isFetchingNextPage}
						onClick={() => void sessions.fetchNextPage()}
					>
						{t("compatibility.loadMore")}
					</Button>
				</Box>
			)}
		</Stack>
	);
}
