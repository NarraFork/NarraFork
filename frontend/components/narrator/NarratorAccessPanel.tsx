/**
 * NarratorAccessPanel.tsx — who can see and drive one narrator.
 *
 * Two NESTED audience levels plus the per-person list:
 *   - visibility:    the broad READ audience (private / project / everyone);
 *   - writeAudience: the broad WRITE audience, always a subset of the read audience;
 *   - people:        explicit per-user grants, read or write.
 *
 * The second control's options are constrained by the first, because driving a session
 * presupposes seeing it — you cannot let everyone drive something only the project can
 * open. Forbidden options are DISABLED rather than hidden: hiding them would read as
 * "this product cannot do that", while a disabled option with a reason points at the
 * control that has to change first.
 *
 * Setting the read audience alone still does not hand over the ability to drive — that
 * remains a separate, deliberate step, and the write hints spell out the consequence
 * (approving commands, editing files) rather than leaving it to be discovered.
 *
 * Only the owner and admins can change anything; everyone else sees the state
 * read-only. Narrators created before access control have no owner, so the panel
 * says so instead of offering controls that would fail. A subagent has no access
 * state of its own — it follows its main session — so the panel explains that and
 * links there instead of rendering controls that cannot take effect.
 *
 * The user picker is backed by `/api/chat/directory` — the one endpoint a non-admin
 * may use to look up usernames. `/api/admin/users` stays admin-only.
 */

import {
	ActionIcon,
	Alert,
	Anchor,
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
import { NARRATOR_WRITE_AUDIENCES, WRITE_AUDIENCE_BY_VISIBILITY } from "@shared/narrator-access";
import {
	IconInfoCircle,
	IconLock,
	IconSearch,
	IconTrash,
	IconUsers,
	IconWorld,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatDirectory } from "../../hooks/useChat";
import { useNarratorAccess, useNarratorAccessMutations } from "../../hooks/useNarratorAccess";
import type {
	NarratorGrantAccess,
	NarratorVisibility,
	NarratorWriteAudience,
} from "../../lib/api/types";
import { UserAvatar } from "../UserAvatar";

export interface NarratorAccessPanelProps {
	narratorId: string;
}

/** Icon per write tier, mirroring the visibility control so the levels read as parallel. */
const WRITE_AUDIENCE_ICONS: Record<NarratorWriteAudience, ReactNode> = {
	owner: <IconLock size={13} />,
	project: <IconUsers size={13} />,
	public: <IconWorld size={13} />,
};

/** Translation-key suffix per tier. Separate from the value so keys stay readable. */
const TIER_LABEL_KEY: Record<NarratorWriteAudience, string> = {
	owner: "Owner",
	project: "Project",
	public: "Public",
};

export function NarratorAccessPanel({ narratorId }: NarratorAccessPanelProps) {
	const { t } = useTranslation("narrator");
	const access = useNarratorAccess(narratorId);
	const { setVisibility, setWriteAudience, grant, updateGrant, revokeGrant } =
		useNarratorAccessMutations(narratorId);

	const [query, setQuery] = useState("");
	// Debounced: the directory query scans usernames, so one request per keystroke
	// would be wasteful for no added responsiveness.
	const [debouncedQuery] = useDebouncedValue(query, 250);
	const [pendingAccess, setPendingAccess] = useState<NarratorGrantAccess>("read");
	const directory = useChatDirectory(debouncedQuery, !!access.data?.canManage);

	const canManage = access.data?.canManage ?? false;
	// Which write tiers the current read audience permits — the same table the server
	// validates against, so the UI cannot offer something that would 400.
	const allowedWriteAudiences =
		WRITE_AUDIENCE_BY_VISIBILITY[access.data?.visibility ?? "private"] ?? [];
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

	// A subagent's access is decided by its main session. Showing the (frozen) controls
	// here would invite changes that silently do nothing.
	if (access.data.isDelegated) {
		return (
			<Stack gap="md" role="region" aria-label={t("access.panelLabel")}>
				<Alert color="blue" icon={<IconInfoCircle size={16} />}>
					{t("access.delegatedNotice")}
				</Alert>
				{access.data.delegatesToNarratorId ? (
					<Anchor component={Link} to={`/narrators/${access.data.delegatesToNarratorId}`} size="sm">
						{t("access.delegatedLink")}
					</Anchor>
				) : null}
			</Stack>
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

			<Stack gap={6}>
				<Text size="sm" fw={500}>
					{t("access.writeAudienceTitle")}
				</Text>
				<SegmentedControl
					aria-label={t("access.writeAudienceTitle")}
					value={access.data.writeAudience}
					onChange={(value) => setWriteAudience.mutate(value as NarratorWriteAudience)}
					disabled={!canManage || setWriteAudience.isPending}
					data={NARRATOR_WRITE_AUDIENCES.map((tier) => {
						const permitted = allowedWriteAudiences.includes(tier);
						const label = (
							<Group key={tier} gap={4} justify="center" wrap="nowrap">
								{WRITE_AUDIENCE_ICONS[tier]}
								<span>{t(`access.writeAudience${TIER_LABEL_KEY[tier]}`)}</span>
							</Group>
						);
						return {
							value: tier,
							// A forbidden tier stays visible but disabled, and the tooltip says
							// which control has to change first — hiding it would read as "the
							// product cannot do this".
							label: permitted ? (
								label
							) : (
								<Tooltip key={tier} label={t(`access.writeAudienceBlocked.${tier}`)} withArrow>
									<Box style={{ opacity: 0.45, cursor: "not-allowed" }}>{label}</Box>
								</Tooltip>
							),
							disabled: !permitted,
						};
					})}
				/>
				<Text size="xs" c={access.data.writeAudience === "owner" ? "dimmed" : "orange"}>
					{t(`access.writeAudienceHint.${access.data.writeAudience}`)}
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
