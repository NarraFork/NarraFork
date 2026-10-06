/**
 * ProjectAccessPanel.tsx — who may reach a project, and at what tier.
 *
 * Mirrors `NarratorAccessPanel` deliberately: the two panels answer the same question
 * at different levels, and the project gate sits ABOVE narrator sharing (both must
 * pass), so a user comparing them should not have to learn two layouts.
 *
 * Three differences follow from the model rather than from taste:
 *   - three tiers (read / write / manage) instead of two, because managing membership
 *     is itself a delegable capability;
 *   - visibility is private/public only — a project has no "project" scope to inherit;
 *   - changing someone's tier re-posts them at the new tier, since the batch endpoint
 *     replaces whatever tier they held. There is no separate per-member PATCH.
 *
 * Only the owner, a manager or an admin may change anything; a write member works in
 * the project but does not decide who else may. Everyone else sees it read-only.
 *
 * The user picker is backed by `/api/chat/directory` — the one endpoint a non-admin
 * may use to look up usernames.
 */

import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Group,
	Loader,
	SegmentedControl,
	Select,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconInfoCircle, IconLock, IconSearch, IconTrash, IconWorld } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatDirectory } from "../../hooks/useChat";
import { useProjectAccess, useProjectAccessMutations } from "../../hooks/useProjectAccess";
import type { ProjectRole, ProjectVisibility } from "../../lib/api/types";
import { UserAvatar } from "../UserAvatar";

export interface ProjectAccessPanelProps {
	projectId: string;
}

export function ProjectAccessPanel({ projectId }: ProjectAccessPanelProps) {
	const { t } = useTranslation("projects");
	const access = useProjectAccess(projectId);
	const { setVisibility, addMembers, removeMember } = useProjectAccessMutations(projectId);

	const [query, setQuery] = useState("");
	// Debounced: the directory query scans usernames, so one request per keystroke
	// would be wasteful for no added responsiveness.
	const [debouncedQuery] = useDebouncedValue(query, 250);
	const [pendingRole, setPendingRole] = useState<ProjectRole>("read");
	const directory = useChatDirectory(debouncedQuery, !!access.data?.canManage);

	const canManage = access.data?.canManage ?? false;
	const members = access.data?.members ?? [];
	const memberUserIds = useMemo(() => new Set(members.map((m) => m.userId)), [members]);

	// Existing members and the owner are filtered out of the picker: the owner cannot be
	// added as a member, and an existing member's tier is changed inline instead.
	const candidates = (directory.data ?? []).filter(
		(user) => !memberUserIds.has(user.id) && user.id !== access.data?.owner?.userId,
	);

	const roleLabel = (role: ProjectRole): string =>
		({
			read: t("access.roleRead"),
			write: t("access.roleWrite"),
			manage: t("access.roleManage"),
		})[role];

	const roleOptions = [
		{ value: "read", label: roleLabel("read") },
		{ value: "write", label: roleLabel("write") },
		{ value: "manage", label: roleLabel("manage") },
	];

	if (access.isLoading) {
		return (
			<Group justify="center" py="md">
				<Loader size="sm" />
			</Group>
		);
	}
	if (!access.data) {
		return (
			<Alert color="gray" icon={<IconInfoCircle size={16} />}>
				{t("access.unavailable")}
			</Alert>
		);
	}

	return (
		<Stack gap="md" role="region" aria-label={t("access.panelLabel")}>
			<Stack gap={6}>
				<Text size="sm" fw={500}>
					{t("access.visibilityTitle")}
				</Text>
				<SegmentedControl
					aria-label={t("access.visibilityTitle")}
					value={access.data.visibility}
					onChange={(value) => setVisibility.mutate(value as ProjectVisibility)}
					disabled={!canManage || setVisibility.isPending}
					data={[
						{
							value: "private",
							label: (
								<Group gap={4} justify="center" wrap="nowrap">
									<IconLock size={13} />
									<span>{t("access.visibilityPrivate")}</span>
								</Group>
							),
						},
						{
							value: "public",
							label: (
								<Group gap={4} justify="center" wrap="nowrap">
									<IconWorld size={13} />
									<span>{t("access.visibilityPublic")}</span>
								</Group>
							),
						},
					]}
				/>
				<Text size="xs" c="dimmed">
					{t(`access.visibilityHint.${access.data.visibility}`)}
				</Text>
			</Stack>

			{!access.data.owner ? (
				<Alert color="yellow" icon={<IconInfoCircle size={16} />}>
					{t("access.noOwner")}
				</Alert>
			) : null}

			<Stack gap={6}>
				<Group justify="space-between">
					<Text size="sm" fw={500}>
						{t("access.membersTitle")}
					</Text>
					{access.data.owner ? (
						<Group gap={6} wrap="nowrap">
							<UserAvatar
								userId={access.data.owner.userId}
								username={access.data.owner.username ?? ""}
								avatarColor={access.data.owner.avatarColor}
								avatarImageId={access.data.owner.avatarImageId}
								size={20}
							/>
							<Text size="xs" c="dimmed">
								{t("access.ownerLabel", { username: access.data.owner.username ?? "" })}
							</Text>
						</Group>
					) : null}
				</Group>

				{members.length === 0 ? (
					<Text size="xs" c="dimmed">
						{t("access.noMembers")}
					</Text>
				) : (
					<Stack gap={4}>
						{members.map((entry) => (
							<Group key={entry.grantId} justify="space-between" wrap="nowrap">
								<Group gap={6} wrap="nowrap">
									<UserAvatar
										userId={entry.userId}
										username={entry.username ?? ""}
										avatarColor={entry.avatarColor}
										avatarImageId={entry.avatarImageId}
										size={20}
									/>
									<Text size="sm">{entry.username ?? entry.userId}</Text>
								</Group>
								<Group gap={4} wrap="nowrap">
									{canManage ? (
										<Select
											size="xs"
											w={110}
											aria-label={t("access.roleForUser", {
												username: entry.username ?? entry.userId,
											})}
											value={entry.role}
											onChange={(value) =>
												value &&
												value !== entry.role &&
												// Re-posting replaces their existing tier — the batch endpoint keeps
												// exactly one grant row per member.
												addMembers.mutate({
													userIds: [entry.userId],
													role: value as ProjectRole,
												})
											}
											data={roleOptions}
											allowDeselect={false}
										/>
									) : (
										<Badge size="sm" variant="light">
											{roleLabel(entry.role)}
										</Badge>
									)}
									{canManage ? (
										<Tooltip label={t("access.removeMember")}>
											<ActionIcon
												size="sm"
												variant="subtle"
												color="red"
												aria-label={t("access.removeUser", {
													username: entry.username ?? entry.userId,
												})}
												onClick={() => removeMember.mutate(entry.userId)}
												loading={removeMember.isPending}
											>
												<IconTrash size={14} />
											</ActionIcon>
										</Tooltip>
									) : null}
								</Group>
							</Group>
						))}
					</Stack>
				)}
			</Stack>

			{canManage ? (
				<Stack gap={6}>
					<Text size="sm" fw={500}>
						{t("access.addTitle")}
					</Text>
					<Group gap="xs" wrap="nowrap">
						<TextInput
							flex={1}
							size="xs"
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
							placeholder={t("access.searchUsers")}
							leftSection={<IconSearch size={13} />}
						/>
						<Select
							size="xs"
							w={110}
							value={pendingRole}
							onChange={(value) => value && setPendingRole(value as ProjectRole)}
							data={roleOptions}
							allowDeselect={false}
						/>
					</Group>
					{directory.isLoading ? (
						<Group justify="center" py="xs">
							<Loader size="xs" />
						</Group>
					) : null}
					{!directory.isLoading && candidates.length === 0 ? (
						<Text size="xs" c="dimmed">
							{t("access.noUsersFound")}
						</Text>
					) : null}
					<Stack gap={2}>
						{candidates.map((user) => (
							<Group key={user.id} justify="space-between" wrap="nowrap">
								<Group gap={6} wrap="nowrap">
									<UserAvatar
										userId={user.id}
										username={user.username}
										avatarColor={user.avatarColor}
										avatarImageId={user.avatarImageId}
										size={20}
									/>
									<Text size="sm">{user.username}</Text>
								</Group>
								<Button
									size="compact-xs"
									variant="light"
									loading={addMembers.isPending}
									onClick={() => addMembers.mutate({ userIds: [user.id], role: pendingRole })}
								>
									{t("access.add")}
								</Button>
							</Group>
						))}
					</Stack>
				</Stack>
			) : (
				<Box>
					<Text size="xs" c="dimmed">
						{t("access.readOnlyNotice")}
					</Text>
				</Box>
			)}
		</Stack>
	);
}
