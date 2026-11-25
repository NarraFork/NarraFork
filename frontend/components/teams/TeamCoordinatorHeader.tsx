/**
 * The coordinator column's header on the team page (the redesign R): one compact line —
 * 「协调者 · N 个会话在运行 · 完整会话 ↗」 — in place of the session toolbar, which the
 * coordinator's own session page keeps (the panel is mounted with `hideHeader`). The dot is the
 * coordinator's run status; the count comes from the team's live summary. With the toolbar went
 * the panel's 「连接断开」 badge, so the line shows it while the panel's socket is down, and a
 * click reconnects through the panel (`connection`, from its `onConnectionChange`).
 */
import type { NarratorPanelConnection } from "@frontend/components/narrator/narrator-panel-types";
import { Anchor, Badge, Group, Text, ThemeIcon } from "@mantine/core";
import type { TeamPageSummary } from "@shared/project-teams";
import { IconExternalLink, IconRobot } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { coordinatorLine } from "./team-page-model";
import { StatusDot, TABULAR } from "./team-page-ui";

const STATUS_TONE = {
	working: "blue",
	waiting: "amber",
	idle: "hollow",
	archived: "gray",
} as const;

export function TeamCoordinatorHeader({
	summary,
	onOpenCoordinatorSession,
	connection,
}: {
	summary: TeamPageSummary | undefined;
	/** The coordinator's own session page (its full toolbar). */
	onOpenCoordinatorSession?: () => void;
	/** The conversation panel's socket: 「连接断开」 while it is down, click to reconnect. */
	connection?: NarratorPanelConnection | null;
}) {
	const { t } = useTranslation("projects");
	const line = summary ? coordinatorLine(summary) : null;
	const status = summary?.coordinatorStatus;
	const tone =
		status === "working" || status === "waiting" || status === "archived"
			? STATUS_TONE[status]
			: STATUS_TONE.idle;
	return (
		<Group
			gap={8}
			wrap="nowrap"
			px="sm"
			py={8}
			style={{ minWidth: 0, borderBottom: "1px solid var(--mantine-color-default-border)" }}
			data-testid="team-coordinator-header"
		>
			<ThemeIcon size={22} radius="sm" variant="light" color="gray" aria-hidden>
				<IconRobot size={14} />
			</ThemeIcon>
			<Text size="sm" fw={700} style={{ flexShrink: 0 }}>
				{t("teams.page.coordinatorHeader.title")}
			</Text>
			{line && (
				<Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
					<StatusDot tone={tone} size={7} />
					<Text
						size="xs"
						c="dimmed"
						truncate
						style={TABULAR}
						data-testid="team-coordinator-line"
						data-kind={line.kind}
					>
						{line.kind === "running"
							? line.more
								? t("teams.page.coordinatorHeader.runningMore", { count: line.count })
								: t("teams.page.coordinatorHeader.running", { count: line.count })
							: t(`teams.page.coordinatorHeader.status.${line.status}`)}
					</Text>
				</Group>
			)}
			{!line && <Group style={{ flex: 1 }} />}
			{connection?.disconnected && (
				<Badge
					component="button"
					type="button"
					size="xs"
					variant="dot"
					color="red"
					onClick={connection.reconnect}
					title={t("teams.page.coordinatorHeader.reconnect")}
					style={{ cursor: "pointer", flexShrink: 0 }}
					data-testid="team-coordinator-disconnected"
				>
					{t("teams.page.coordinatorHeader.disconnected")}
				</Badge>
			)}
			{onOpenCoordinatorSession && (
				<Anchor
					component="button"
					type="button"
					size="xs"
					onClick={onOpenCoordinatorSession}
					style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}
					data-testid="team-coordinator-full-session"
				>
					{t("teams.page.coordinatorHeader.fullSession")}
					<IconExternalLink size={12} aria-hidden />
				</Anchor>
			)}
		</Group>
	);
}
