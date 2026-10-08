import { Collapse, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconBrandGithub, IconCheck, IconChevronDown } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorGitIdentity, useSetNarratorGitIdentity } from "../../hooks/useGitIdentities";

/**
 * The "Git commit identity" entry in a narrator tab's context menu.
 *
 * Lists the CALLER's identities plus their pick for this narrator. The pick is stored per
 * (user × narrator) on the server, so two people driving the same narrator each choose their
 * own and neither sees the other's — this entry is only the surface for that personal setting.
 *
 * The surrounding menu is a plain Paper + Stack rather than a Mantine `Menu`, so the second
 * level expands in place instead of flying out: the same pattern `CompactMenuSub` uses, for
 * the same reason (there is no `Menu` context to nest a submenu in).
 */
export function TabGitIdentityMenu({
	narratorId,
	onClose,
}: {
	narratorId: string;
	onClose: () => void;
}) {
	const { t } = useTranslation("common");
	const [expanded, setExpanded] = useState(false);
	// Queried only once the section is opened: a right-click that never reaches this entry
	// should not cost a request, and the answer cannot be stale in a way that matters here.
	const { data, isLoading } = useNarratorGitIdentity(expanded ? narratorId : null);
	const setPick = useSetNarratorGitIdentity(narratorId);
	const identities = data?.identities ?? [];
	const selectedId = data?.selectedId ?? null;
	const defaultIdentity = identities.find((identity) => identity.isDefault);

	const choose = (identityId: string | null) => {
		setPick.mutate(identityId);
		onClose();
	};

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
				onClick={() => setExpanded((open) => !open)}
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
								() => choose(null),
								defaultIdentity
									? t("dockTabs.gitIdentityFollowDefault", { name: defaultIdentity.name })
									: t("dockTabs.gitIdentityFollowDefaultPlain"),
							)}
							{identities.map((identity) =>
								row(
									selectedId === identity.id,
									() => choose(identity.id),
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
