/**
 * Outline home: search across every readable space (drawn as a tree of the matches with what
 * they are under, in the tree's place while a query is typed; a match is then shown in the tree
 * itself), and the whole outline as one connected tree
 * (`tree/OutlineTree.tsx`): the pages visited recently in this browser, my space, the projects
 * and their sessions, each opened in place. The reader's personal space is created on the first
 * visit. Router-free: links go through the host's renderer (`outline-nav.tsx`), so the
 * outline route and a dock panel show the same home.
 */
import { Box, Stack, Text, TextInput, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { OutlineSearchTree } from "./tree/OutlineSearchTree";
import { OutlineTree } from "./tree/OutlineTree";
import type { TreeLocateTarget } from "./tree/tree-locate";

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
	const searching = debounced.trim() !== "" && query.trim() !== "";
	// A match chosen in the search: the search goes, and the tree shows the match where it is.
	const [locate, setLocate] = useState<TreeLocateTarget | null>(null);

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
					onKeyDown={(event) => {
						if (event.key === "Escape" && query !== "") setQuery("");
					}}
					data-testid="outline-search-input"
				/>
			</Box>

			{/* The search drawn as a tree: the matches with what they are under (readability F). */}
			{searching && (
				<OutlineSearchTree
					query={debounced}
					spaceId={null}
					onLocate={(target) => {
						setQuery("");
						setLocate(target);
					}}
				/>
			)}
			{/* The whole outline as one tree (readability E): my space, projects, their sessions.
			    Kept while a search is drawn in its place, so it comes back as it was. */}
			<OutlineTree root={TREE_ROOT} host={host} locate={locate} hidden={searching} />
		</Stack>
	);
}
