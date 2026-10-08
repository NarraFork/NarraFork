import { Group, Menu, Text } from "@mantine/core";
import { IconBrandGithub } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useNarratorGitIdentity, useSetNarratorGitIdentity } from "../../hooks/useGitIdentities";

/**
 * Value standing in for "no pick". Menu radio items need a string, and an empty
 * one reads as "nothing selected"; identity ids are nanoids and cannot collide.
 */
const FOLLOW_DEFAULT = "__follow_default__";

/**
 * The "git commit identity" submenu on a narrator panel's tab.
 *
 * Lists the CALLER's identities and their pick for this narrator. The pick is
 * stored per (user × narrator) on the server, so two people driving the same
 * narrator each choose their own and neither sees the other's — this menu is only
 * the surface for that personal setting.
 *
 * Split out of `SurfaceTab` so the tab wrapper stays about tabs: the wrapper owns
 * the context-menu chrome, this owns the identity list and its writes.
 */
export function NarratorGitIdentityMenu({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation("common");
	const { data, isLoading } = useNarratorGitIdentity(narratorId);
	const setPick = useSetNarratorGitIdentity(narratorId);
	const identities = data?.identities ?? [];
	const selectedId = data?.selectedId ?? null;
	const defaultIdentity = identities.find((identity) => identity.isDefault);

	return (
		<Menu.Sub>
			<Menu.Sub.Target>
				<Menu.Sub.Item leftSection={<IconBrandGithub size={14} />}>
					{t("dockTabs.gitIdentity")}
				</Menu.Sub.Item>
			</Menu.Sub.Target>
			<Menu.Sub.Dropdown>
				{isLoading ? (
					<Menu.Item disabled>{t("loading")}</Menu.Item>
				) : identities.length === 0 ? (
					// Nothing to choose: with no identities their commits inherit the host
					// git config. Say where identities come from instead of showing an
					// empty list that looks broken.
					<Menu.Item disabled>{t("dockTabs.gitIdentityUnconfigured")}</Menu.Item>
				) : (
					<Menu.RadioGroup
						value={selectedId ?? FOLLOW_DEFAULT}
						onChange={(value) => setPick.mutate(value === FOLLOW_DEFAULT ? null : value)}
					>
						<Menu.RadioItem value={FOLLOW_DEFAULT}>
							{defaultIdentity
								? t("dockTabs.gitIdentityFollowDefault", { name: defaultIdentity.name })
								: t("dockTabs.gitIdentityFollowDefaultPlain")}
						</Menu.RadioItem>
						<Menu.Divider />
						{identities.map((identity) => (
							<Menu.RadioItem key={identity.id} value={identity.id}>
								<Group gap="xs" wrap="nowrap">
									<span>{identity.name}</span>
									<Text span size="xs" c="dimmed">
										{identity.email}
									</Text>
								</Group>
							</Menu.RadioItem>
						))}
					</Menu.RadioGroup>
				)}
			</Menu.Sub.Dropdown>
		</Menu.Sub>
	);
}
