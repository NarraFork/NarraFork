/**
 * NarratorAccessPanel.tsx — who can see and drive one narrator.
 *
 * Two controls, matching the two halves of the model:
 *   - visibility: the broad READ audience (private / project / everyone);
 *   - people:     explicit per-user grants, read or write.
 *
 * Only the owner and admins can change anything; everyone else sees the state
 * read-only. Narrators created before access control have no owner, so the panel
 * says so instead of offering controls that would fail.
 *
 * The user picker is backed by `/api/chat/directory` — the one endpoint a non-admin
 * may use to look up usernames. `/api/admin/users` stays admin-only.
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
import {
	IconInfoCircle,
	IconLock,
	IconSearch,
	IconTrash,
	IconUsers,
	IconWorld,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatDirectory } from "../../hooks/useChat";
import { useNarratorAccess, useNarratorAccessMutations } from "../../hooks/useNarratorAccess";
import type { NarratorGrantAccess, NarratorVisibility } from "../../lib/api/types";
import { UserAvatar } from "../UserAvatar";

export interface NarratorAccessPanelProps {
	narratorId: string;
}

export function NarratorAccessPanel({ narratorId }: NarratorAccessPanelProps) {
	const { t } = useTranslation("narrator");
	const access = useNarratorAccess(narratorId);
	const { setVisibility, grant, updateGrant, revokeGrant } = useNarratorAccessMutations(narratorId);

	const [query, setQuery] = useState("");
	// Debounced: the directory query scans usernames, so one request per keystroke
	// would be wasteful for no added responsiveness.
	const [debouncedQuery] = useDebouncedValue(query, 250);
	const [pendingAccess, setPendingAccess] = useState<NarratorGrantAccess>("read");
	const directory = useChatDirectory(debouncedQuery, !!access.data?.canManage);

	const canManage = access.data?.canManage ?? false;
	const grants = access.data?.grants ?? [];
	const grantedUserIds = useMemo(() => new Set(grants.map((g) => g.userId)), [grants]);

	// Already-shared users and the owner are filtered out: offering them again would
	// only produce a "skipped"/"failed" response.
	const candidates = (directory.data ?? []).filter(
		(user) => !grantedUserIds.has(user.id) && user.id !== access.data?.owner?.userId,
	);

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
					onChange={(value) => setVisibility.mutate(value as NarratorVisibility)}
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
							value: "project",
							label: (
								<Group gap={4} justify="center" wrap="nowrap">
									<IconUsers size={13} />
									<span>{t("access.visibilityProject")}</span>
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
						{t("access.peopleTitle")}
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

				{grants.length === 0 ? (
					<Text size="xs" c="dimmed">
						{t("access.noGrants")}
					</Text>
				) : (
					<Stack gap={4}>
						{grants.map((entry) => (
							<Group key={entry.id} justify="space-between" wrap="nowrap">
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
											value={entry.access}
											onChange={(value) =>
												value &&
												updateGrant.mutate({
													grantId: entry.id,
													access: value as NarratorGrantAccess,
												})
											}
											data={[
												{ value: "read", label: t("access.levelRead") },
												{ value: "write", label: t("access.levelWrite") },
											]}
											allowDeselect={false}
										/>
									) : (
										<Badge size="sm" variant="light">
											{entry.access === "write" ? t("access.levelWrite") : t("access.levelRead")}
										</Badge>
									)}
									{canManage ? (
										<Tooltip label={t("access.revoke")}>
											<ActionIcon
												size="sm"
												variant="subtle"
												color="red"
												aria-label={t("access.revokeUser", {
													username: entry.username ?? entry.userId,
												})}
												onClick={() => revokeGrant.mutate(entry.id)}
												loading={revokeGrant.isPending}
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
						{t("access.shareTitle")}
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
							value={pendingAccess}
							onChange={(value) => value && setPendingAccess(value as NarratorGrantAccess)}
							data={[
								{ value: "read", label: t("access.levelRead") },
								{ value: "write", label: t("access.levelWrite") },
							]}
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
									loading={grant.isPending}
									onClick={() => grant.mutate({ userIds: [user.id], access: pendingAccess })}
								>
									{t("access.share")}
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
