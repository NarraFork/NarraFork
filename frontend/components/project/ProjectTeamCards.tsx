/**
 * The project page's 「团队」 (R2): one card per active team — its name, the team page's status
 * sentence (`teamCardStatus`), how many items are in progress / ready / done, and an amber badge
 * with what waits for this member — then a dashed 「新团队」 card for project writers. Without
 * teams it is one line and a button. Teams are not available everywhere (PostgreSQL answers 503):
 * then the section is left out.
 */

import { useProjectTeamCards } from "@frontend/hooks/useProjectOverview";
import { teamsUnavailable } from "@frontend/hooks/useTeams";
import { formatSmartTime } from "@frontend/lib/format";
import {
	Alert,
	Badge,
	Box,
	Button,
	Group,
	Loader,
	SimpleGrid,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { TEAM_CARD_FINISHED_COUNT_CAP, type TeamCard } from "@shared/project-overview";
import { IconPlus, IconUsersGroup } from "@tabler/icons-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { cappedCount } from "../teams/team-page-model";
import {
	ATTENTION_COLOR,
	ATTENTION_TEXT,
	StatusDot,
	statusTone,
	TABULAR,
} from "../teams/team-page-ui";
import {
	liveTeamCards,
	teamCardBadge,
	teamCardNumbers,
	teamCardStatus,
} from "./project-page-model";

const CARD_STYLE = {
	display: "block",
	width: "100%",
	height: "100%",
	padding: "14px 16px",
	borderRadius: "var(--mantine-radius-md)",
	border: "1px solid var(--mantine-color-default-border)",
	background: "var(--mantine-color-default)",
} as const;

function Numbers({ team }: { team: TeamCard }) {
	const { t } = useTranslation("projects");
	const numbers = teamCardNumbers(team.card);
	return (
		<Group gap={22} mt={12} wrap="nowrap">
			{(["inProgress", "ready", "done"] as const).map((key) => (
				<Stack key={key} gap={0}>
					<Text fw={700} size="lg" style={TABULAR} data-testid={`team-card-${key}`}>
						{/* Finished items are counted up to 1,000 on the server: past it, 「999+」. */}
						{key === "done"
							? cappedCount(numbers.done, TEAM_CARD_FINISHED_COUNT_CAP)
							: numbers[key]}
					</Text>
					<Text size="xs" c="dimmed">
						{t(`page.teams.numbers.${key}`)}
					</Text>
				</Stack>
			))}
		</Group>
	);
}

function Status({ team }: { team: TeamCard }) {
	const { t } = useTranslation("projects");
	const status = teamCardStatus(team);
	if (!status) return null;
	const lastEvent = team.card?.lastEventAt;
	return (
		<Group gap={6} wrap="nowrap" mt={6} style={{ minWidth: 0 }} data-tone={status.tone}>
			<StatusDot tone={statusTone(status.tone)} />
			<Text size="xs" c="dimmed" truncate style={TABULAR} data-testid="team-card-status">
				{status.parts.map((part, index) => (
					<Fragment key={part.key}>
						{index > 0 && " · "}
						<Text
							component="span"
							inherit
							fw={part.key === "waitingYou" || part.key === "waitingYouMore" ? 600 : undefined}
							style={
								part.key === "waitingYou" || part.key === "waitingYouMore"
									? { color: ATTENTION_TEXT }
									: undefined
							}
						>
							{t(`teams.page.status.${part.key}`, { count: part.count ?? 0 })}
						</Text>
					</Fragment>
				))}
				{status.tone === "idle" &&
					lastEvent &&
					status.parts.some((part) => part.key === "done") &&
					` · ${formatSmartTime(lastEvent)}`}
			</Text>
		</Group>
	);
}

export function ProjectTeamCards({
	projectId,
	canCreate,
	onOpenTeam,
	onCreate,
}: {
	projectId: string;
	canCreate: boolean;
	onOpenTeam: (teamId: string) => void;
	onCreate: () => void;
}) {
	const { t } = useTranslation("projects");
	const teams = useProjectTeamCards(projectId);
	const rows = liveTeamCards(teams.data?.pages.flatMap((page) => page.teams) ?? []);
	if (teams.isError && teamsUnavailable(teams.error)) return null;
	return (
		<Stack gap="sm" data-testid="project-teams">
			<Group gap={8} wrap="nowrap">
				<Text fw={700} size="lg">
					{t("teams.title")}
				</Text>
				{rows.length > 0 && (
					<Text c="dimmed" style={TABULAR}>
						{teams.hasNextPage ? `${rows.length}+` : rows.length}
					</Text>
				)}
			</Group>
			{teams.isLoading && <Loader size="sm" />}
			{teams.isError && <Alert color="red">{t("teams.loadFailed")}</Alert>}
			{teams.isSuccess && rows.length === 0 && (
				<Group gap="sm" wrap="wrap" data-testid="project-teams-empty">
					<Text size="sm" c="dimmed">
						{t("page.teams.empty")}
					</Text>
					{canCreate && (
						<Button
							size="xs"
							variant="default"
							leftSection={<IconPlus size={14} aria-hidden />}
							onClick={onCreate}
							data-testid="new-team"
						>
							{t("page.newTeam")}
						</Button>
					)}
				</Group>
			)}
			{rows.length > 0 && (
				<SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 4 }} spacing="sm">
					{rows.map((team) => {
						const badge = teamCardBadge(team);
						return (
							<UnstyledButton
								key={team.id}
								onClick={() => onOpenTeam(team.id)}
								style={CARD_STYLE}
								data-testid="project-team-card"
								data-team-id={team.id}
							>
								<Group gap={8} wrap="nowrap" justify="space-between">
									<Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
										<IconUsersGroup size={16} aria-hidden style={{ flexShrink: 0, opacity: 0.7 }} />
										<Text fw={700} truncate>
											{team.name || team.id}
										</Text>
									</Group>
									{badge > 0 ? (
										<Badge
											size="sm"
											variant="filled"
											tt="none"
											style={{
												background: ATTENTION_COLOR,
												color: "var(--mantine-color-dark-9)",
												flexShrink: 0,
												...TABULAR,
											}}
											data-testid="team-card-waiting"
										>
											{t("page.waitingBadge", { count: badge })}
										</Badge>
									) : team.access === "read" ? (
										<Badge size="xs" variant="light" color="gray" tt="none">
											{t("teams.onlooker")}
										</Badge>
									) : null}
								</Group>
								<Status team={team} />
								<Numbers team={team} />
							</UnstyledButton>
						);
					})}
					{canCreate && (
						<UnstyledButton
							onClick={onCreate}
							data-testid="new-team"
							style={{
								...CARD_STYLE,
								background: "transparent",
								border: "1px dashed var(--mantine-color-default-border)",
								minHeight: 120,
							}}
						>
							<Stack gap={4} align="center" justify="center" h="100%">
								<IconPlus size={18} aria-hidden style={{ opacity: 0.6 }} />
								<Text size="sm" c="dimmed">
									{t("page.newTeam")}
								</Text>
								<Text size="xs" c="dimmed" ta="center">
									{t("page.teams.newHint")}
								</Text>
							</Stack>
						</UnstyledButton>
					)}
				</SimpleGrid>
			)}
			{teams.hasNextPage && (
				<Box>
					<Button
						size="xs"
						variant="subtle"
						loading={teams.isFetchingNextPage}
						onClick={() => void teams.fetchNextPage()}
					>
						{t("teams.loadMore")}
					</Button>
				</Box>
			)}
		</Stack>
	);
}
