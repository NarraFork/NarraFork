/**
 * Outline home: search across every readable space, then the whole outline as one connected tree
 * (`tree/OutlineTree.tsx`): the pages visited recently in this browser, my space, the projects
 * and their sessions, each opened in place. The reader's personal space is created on the first
 * visit. Router-free: links go through the host's renderer (`outline-nav.tsx`), so the
 * outline route and a dock panel show the same home.
 */
import { Alert, Badge, Box, Group, Loader, Stack, Text, TextInput, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineSearch } from "../../hooks/useOutline";
import classes from "./Outline.module.css";
import { OutlineLink, outlineBlockTarget } from "./outline-nav";
import { OutlineTree } from "./tree/OutlineTree";

const TREE_ROOT = { kind: "all" } as const;

/**
 * `header`: the host's entry above the title (the outline route's reports entry). `host`: the
 * outline page or a dock panel (each keeps its own open nodes of the tree).
 */
export function OutlineHome({
	header,
	host = "page",
}: {
	header?: ReactNode;
	host?: "page" | "panel";
} = {}) {
	const { t } = useTranslation("outline");
	const [query, setQuery] = useState("");
	const [debounced] = useDebouncedValue(query, 250);
	const search = useOutlineSearch(debounced, null, true);

	return (
		<Stack gap="lg">
			{header}
			<Stack gap={4}>
				<Title order={2}>{t("title")}</Title>
				<Text size="sm" c="dimmed">
					{t("subtitle")}
				</Text>
			</Stack>

			<Box>
				<TextInput
					leftSection={<IconSearch size={16} />}
					placeholder={t("home.searchPlaceholder")}
					aria-label={t("home.searchPlaceholder")}
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
				/>
				{debounced.trim() && (
					<Stack gap={2} mt="xs">
						{search.isFetching && !search.data && <Loader size="xs" />}
						{search.isError && (
							<Alert color="red" variant="light">
								{t("loadFailed")}
							</Alert>
						)}
						{search.data && search.data.hits.length === 0 && (
							<Text size="sm" c="dimmed">
								{t("home.noResults")}
							</Text>
						)}
						{search.data?.hits.map((hit) => (
							<OutlineLink
								key={hit.blockId}
								to={outlineBlockTarget(hit.spaceId, hit.blockId)}
								className={classes.listItem}
							>
								<Group gap={6} wrap="nowrap">
									<Text size="sm" fw={500} className={classes.ellipsis}>
										{hit.title || hit.address}
									</Text>
									{hit.process && (
										<Badge size="xs" variant="light" color="yellow" tt="none">
											{t("home.process")}
										</Badge>
									)}
								</Group>
								{hit.path.length > 0 && (
									<Text size="xs" c="dimmed" className={classes.ellipsis}>
										{hit.path.join(" › ")}
									</Text>
								)}
								{hit.snippet !== hit.title && (
									<Text size="xs" c="dimmed" lineClamp={2}>
										{hit.snippet}
									</Text>
								)}
							</OutlineLink>
						))}
					</Stack>
				)}
			</Box>

			{/* The whole outline as one tree (readability E): my space, projects, their sessions. */}
			<OutlineTree root={TREE_ROOT} host={host} />
		</Stack>
	);
}
