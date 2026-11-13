import type { GitIdentity } from "@frontend/lib/api/auth";
import { Collapse, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconBrandGithub, IconCheck, IconChevronDown } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { followIdentityKind } from "../narrator/details/git-identity-follow-label";

/**
 * The "Git commit identity" submenu shared by a narrator tab and a sidebar folder.
 *
 * Both surfaces list the CALLER's identities and their pick for that one object; only the
 * object behind the pick differs (narrator vs folder), so the menu itself is one component
 * and the two wrappers only supply the data.
 *
 * The surrounding menu is a plain Paper + Stack rather than a Mantine `Menu`, so the second
 * level expands in place instead of flying out: the same pattern `CompactMenuSub` uses, for
 * the same reason (there is no `Menu` context to nest a submenu in).
 */
export function GitIdentityMenuList({
	identities,
	selectedId,
	followIdentity,
	isLoading,
	expanded,
	onToggle,
	onChoose,
}: {
	identities: GitIdentity[];
	/** The pick for this object, or null when it follows the default. */
	selectedId: string | null;
	/** 会话没有 pick 时跟随的文件夹身份；文件夹菜单自己就是被跟随者，不传。 */
	followIdentity?: GitIdentity | null;
	isLoading: boolean;
	/** 展开状态由外层持有，好让数据查询等到真正打开子菜单才发。 */
	expanded: boolean;
	onToggle: () => void;
	/** null clears the pick. */
	onChoose: (identityId: string | null) => void;
}) {
	const { t } = useTranslation("common");
	const defaultIdentity = identities.find((identity) => identity.isDefault);

	const row = (selected: boolean, onClick: () => void, label: string, detail?: string) => (
		<UnstyledButton key={label} px="xs" py={4} onClick={onClick} style={{ borderRadius: 4 }}>
			<Group gap={8} wrap="nowrap">
				{/* A fixed slot keeps labels aligned whether or not this row is the current pick. */}
				{selected ? <IconCheck size={14} /> : <span style={{ width: 14 }} />}
				<Text size="sm">{label}</Text>
				{detail && (
					<Text size="xs" c="dimmed">
						{detail}
					</Text>
				)}
			</Group>
		</UnstyledButton>
	);

	return (
		<>
			<UnstyledButton
				px="xs"
				py={4}
				aria-expanded={expanded}
				onClick={onToggle}
				style={{ borderRadius: 4 }}
			>
				<Group gap={8} wrap="nowrap">
					<IconBrandGithub size={14} />
					<Text size="sm">{t("dockTabs.gitIdentity")}</Text>
					<IconChevronDown
						size={14}
						style={{
							marginLeft: "auto",
							transform: expanded ? "rotate(180deg)" : undefined,
							transition: "transform 150ms ease",
						}}
					/>
				</Group>
			</UnstyledButton>
			<Collapse expanded={expanded}>
				<Stack gap={2} pl="md">
					{isLoading ? (
						<Text size="xs" c="dimmed" px="xs" py={4}>
							{t("loading")}
						</Text>
					) : identities.length === 0 ? (
						<Text size="xs" c="dimmed" px="xs" py={4}>
							{t("dockTabs.gitIdentityUnconfigured")}
						</Text>
					) : (
						<>
							{row(
								selectedId === null,
								() => onChoose(null),
								followIdentityKind(followIdentity, defaultIdentity) === "folder"
									? t("dockTabs.gitIdentityFollowFolder", { name: followIdentity?.name })
									: defaultIdentity
										? t("dockTabs.gitIdentityFollowDefault", { name: defaultIdentity.name })
										: t("dockTabs.gitIdentityFollowDefaultPlain"),
							)}
							{identities.map((identity) =>
								row(
									selectedId === identity.id,
									() => onChoose(identity.id),
									identity.name,
									identity.email,
								),
							)}
						</>
					)}
				</Stack>
			</Collapse>
		</>
	);
}
