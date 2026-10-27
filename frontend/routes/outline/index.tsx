/**
 * Outline home: search across every readable space, the pages visited recently in this
 * browser, and the spaces the reader can open. The reader's personal space is created on the
 * first visit.
 */
import {
	Alert,
	Badge,
	Box,
	Button,
	Container,
	Group,
	Loader,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import type { OutlineSpaceKind, OutlineSpaceSummary } from "@shared/outline-api";
import { IconFolder, IconMessages, IconSearch, IconUser } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import classes from "../../components/outline/Outline.module.css";
import { OutlineGate } from "../../components/outline/OutlineGate";
import { useOutlineSpaceName } from "../../components/outline/OutlineSpaceName";
import {
	useEnsurePersonalOutlineSpace,
	useOutlineSearch,
	useOutlineSpaces,
} from "../../hooks/useOutline";
import { formatSmartTime } from "../../lib/format";
import { readOutlineRecents } from "../../lib/outline-recents";

export const Route = createFileRoute("/outline/")({ component: OutlineHomeRoute });

function OutlineHomeRoute() {
	return (
		<Container size="lg" py="md" px={0}>
			<OutlineGate>
				<OutlineHome />
			</OutlineGate>
		</Container>
	);
}

const KIND_ORDER: Record<OutlineSpaceKind, number> = { personal: 0, project: 1, session: 2 };
const KIND_ICON = { personal: IconUser, project: IconFolder, session: IconMessages } as const;

function SpaceCard({ space }: { space: OutlineSpaceSummary }) {
	const { t } = useTranslation("outline");
	const spaceName = useOutlineSpaceName();
	const Icon = KIND_ICON[space.kind];
	return (
		<Link
			to="/outline/$spaceId"
			params={{ spaceId: space.id }}
			className={classes.listItem}
			style={{ border: "1px solid var(--mantine-color-default-border)" }}
		>
			<Group gap="xs" wrap="nowrap">
				<Icon size={16} style={{ flexShrink: 0 }} />
				<Text size="sm" fw={500} className={classes.ellipsis}>
					{spaceName(space)}
				</Text>
			</Group>
			<Group gap={6} mt={4}>
				<Badge size="xs" variant="light" color="gray" tt="none">
					{t(`space.kind.${space.kind}`)}
				</Badge>
				{space.orphaned && (
					<Badge size="xs" variant="light" color="orange" tt="none">
						{t("space.orphaned")}
					</Badge>
				)}
				<Text size="xs" c="dimmed">
					{t("space.commits", { count: space.lastSeq })}
				</Text>
			</Group>
		</Link>
	);
}

function OutlineHome() {
	const { t } = useTranslation("outline");
	const { mutate: ensurePersonal } = useEnsurePersonalOutlineSpace();
	const ensured = useRef(false);
	useEffect(() => {
		if (ensured.current) return;
		ensured.current = true;
		ensurePersonal();
	}, [ensurePersonal]);
	const spaces = useOutlineSpaces(true);
	const [query, setQuery] = useState("");
	const [debounced] = useDebouncedValue(query, 250);
	const search = useOutlineSearch(debounced, null, true);
	const recents = useMemo(() => readOutlineRecents(), []);
	const sorted = useMemo(
		() =>
			(spaces.data?.pages.flatMap((page) => page.spaces) ?? []).sort(
				(a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
			),
		[spaces.data],
	);

	return (
		<Stack gap="lg">
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
							<Link
								key={hit.blockId}
								to="/outline/$spaceId/$blockId"
								params={{ spaceId: hit.spaceId, blockId: hit.blockId }}
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
							</Link>
						))}
					</Stack>
				)}
			</Box>

			<Stack gap="xs">
				<Title order={4}>{t("home.recent")}</Title>
				{recents.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("home.noRecent")}
					</Text>
				) : (
					<Stack gap={2}>
						{recents.map((recent) => (
							<Link
								key={recent.blockId}
								to="/outline/$spaceId/$blockId"
								params={{ spaceId: recent.spaceId, blockId: recent.blockId }}
								className={classes.listItem}
							>
								<Group justify="space-between" wrap="nowrap" gap="xs">
									<Text size="sm" className={classes.ellipsis}>
										{recent.title}
									</Text>
									<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
										{formatSmartTime(new Date(recent.visitedAt).toISOString())}
									</Text>
								</Group>
							</Link>
						))}
					</Stack>
				)}
			</Stack>

			<Stack gap="xs">
				<Title order={4}>{t("home.spaces")}</Title>
				{spaces.isLoading && <Loader size="sm" />}
				{spaces.isError && (
					<Alert color="red" variant="light">
						{t("loadFailed")}
					</Alert>
				)}
				{spaces.isSuccess && sorted.length === 0 && (
					<Text size="sm" c="dimmed">
						{t("home.noSpaces")}
					</Text>
				)}
				<SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="xs">
					{sorted.map((space) => (
						<SpaceCard key={space.id} space={space} />
					))}
				</SimpleGrid>
				{spaces.hasNextPage && (
					<Button
						variant="light"
						loading={spaces.isFetchingNextPage}
						onClick={() => void spaces.fetchNextPage()}
					>
						{t("loadMore")}
					</Button>
				)}
			</Stack>
		</Stack>
	);
}
