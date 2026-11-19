/**
 * The team's people (docs/PROJECT_TEAMS-PLAN.md §二.1, §二.12; M1): who is a member (write access
 * on the coordinator: speaks in the conversation, approves and answers) and who an onlooker (read
 * access), with when each member last spoke. There is no team membership of its own: the owner
 * (or an admin) grants and revokes access with the coordinator's ordinary sharing panel, shown
 * here below the list.
 */
import { useNarratorAccess } from "@frontend/hooks/useNarratorAccess";
import { useTeamMembers } from "@frontend/hooks/useTeams";
import { formatSmartTime } from "@frontend/lib/format";
import { Alert, Badge, Divider, Group, Loader, Stack, Text } from "@mantine/core";
import type { TeamMember } from "@shared/project-teams";
import { lazy, Suspense, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { UserAvatar } from "../UserAvatar";
import { audienceNotes } from "./team-page-model";

// The sharing panel carries the user picker and public-share manager: loaded only when shown.
const NarratorAccessPanel = lazy(() =>
	import("../narrator/details/NarratorAccessPanel").then((module) => ({
		default: module.NarratorAccessPanel,
	})),
);

export function TeamMemberRow({ member }: { member: TeamMember }) {
	const { t } = useTranslation("projects");
	return (
		<Group
			gap="xs"
			wrap="nowrap"
			data-testid="team-member"
			data-user-id={member.userId}
			data-role={member.role}
		>
			<UserAvatar
				username={member.username}
				avatarColor={member.avatarColor}
				avatarImageId={member.avatarImageId}
				userId={member.userId}
				size={28}
			/>
			<Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
				<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
					<Text size="sm" fw={500} truncate>
						{member.username}
					</Text>
					{member.owner && (
						<Badge size="xs" variant="light" color="gray" tt="none" style={{ flexShrink: 0 }}>
							{t("teams.members.owner")}
						</Badge>
					)}
				</Group>
				{member.role === "member" && (
					<Text size="xs" c="dimmed" truncate title={member.lastSpokeAt ?? undefined}>
						{member.lastSpokeAt
							? t("teams.members.lastSpoke", { time: formatSmartTime(member.lastSpokeAt) })
							: t("teams.members.noRecentMessage")}
					</Text>
				)}
			</Stack>
			<Badge
				size="sm"
				variant="light"
				color={member.role === "member" ? "indigo" : "gray"}
				tt="none"
				style={{ flexShrink: 0 }}
			>
				{t(`teams.members.role.${member.role}`)}
			</Badge>
		</Group>
	);
}

export function TeamMembersPanel({
	projectId,
	teamId,
	enabled = true,
}: {
	projectId: string;
	teamId: string;
	enabled?: boolean;
}) {
	const { t } = useTranslation("projects");
	const members = useTeamMembers(projectId, teamId, enabled);
	const canManage = members.data?.canManage === true;
	// A change made in the sharing panel (or anywhere else) refreshes the list.
	const access = useNarratorAccess(teamId, enabled && canManage);
	const seen = useRef(access.dataUpdatedAt);
	const refetch = members.refetch;
	useEffect(() => {
		if (!access.dataUpdatedAt || access.dataUpdatedAt === seen.current) return;
		seen.current = access.dataUpdatedAt;
		void refetch();
	}, [access.dataUpdatedAt, refetch]);

	const data = members.data;
	const memberRows = data?.members.filter((member) => member.role === "member") ?? [];
	const onlookerRows = data?.members.filter((member) => member.role === "onlooker") ?? [];
	return (
		<Stack gap="sm" data-testid="team-members">
			<Text size="xs" c="dimmed">
				{t("teams.members.explain")}
			</Text>
			{members.isLoading && <Loader size="sm" />}
			{members.isError && <Alert color="red">{t("teams.members.loadFailed")}</Alert>}
			{data && (
				<>
					<Text size="xs" fw={600}>
						{t("teams.members.membersHeading", { count: memberRows.length })}
					</Text>
					{memberRows.map((member) => (
						<TeamMemberRow key={member.userId} member={member} />
					))}
					<Text size="xs" fw={600}>
						{t("teams.members.onlookersHeading", { count: onlookerRows.length })}
					</Text>
					{onlookerRows.length === 0 && (
						<Text size="xs" c="dimmed">
							{t("teams.members.noOnlookers")}
						</Text>
					)}
					{onlookerRows.map((member) => (
						<TeamMemberRow key={member.userId} member={member} />
					))}
					{audienceNotes(data.visibility, data.writeAudience).map((note) => (
						<Text key={note} size="xs" c="dimmed" data-testid="team-members-audience">
							{t(`teams.members.audience.${note}`)}
						</Text>
					))}
					{data.more && (
						<Text size="xs" c="dimmed">
							{t("teams.members.more")}
						</Text>
					)}
					<Divider />
					{canManage ? (
						<Stack gap="xs" data-testid="team-members-manage">
							<Text size="sm" fw={600}>
								{t("teams.members.manageHeading")}
							</Text>
							<Text size="xs" c="dimmed">
								{t("teams.members.manageExplain")}
							</Text>
							<Suspense fallback={<Loader size="sm" />}>
								<NarratorAccessPanel narratorId={teamId} />
							</Suspense>
						</Stack>
					) : (
						<Text size="xs" c="dimmed" data-testid="team-members-manage-hint">
							{t("teams.members.onlyOwnerManages")}
						</Text>
					)}
				</>
			)}
		</Stack>
	);
}
