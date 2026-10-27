/** One outline space: its pages in order, and search within it. */
import {
	Alert,
	Anchor,
	Badge,
	Breadcrumbs,
	Button,
	Container,
	Group,
	Loader,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import classes from "../../../components/outline/Outline.module.css";
import { OutlineTaskIcon } from "../../../components/outline/OutlineBlockTree";
import { OutlineGate } from "../../../components/outline/OutlineGate";
import { useOutlineSpaceName } from "../../../components/outline/OutlineSpaceName";
import { useOutlinePages, useOutlineSearch, useOutlineSpace } from "../../../hooks/useOutline";
import { ApiError } from "../../../lib/api";

export const Route = createFileRoute("/outline/$spaceId/")({ component: OutlineSpaceRoute });

function OutlineSpaceRoute() {
	return (
		<Container size="lg" py="md" px={0}>
			<OutlineGate>
				<OutlineSpace />
			</OutlineGate>
		</Container>
	);
}

function OutlineSpace() {
	const { spaceId } = Route.useParams();
	const { t } = useTranslation("outline");
	const spaceName = useOutlineSpaceName();
	const space = useOutlineSpace(spaceId);
	const pages = useOutlinePages(spaceId, space.isSuccess);
	const [query, setQuery] = useState("");
	const [debounced] = useDebouncedValue(query, 250);
	const search = useOutlineSearch(debounced, spaceId, space.isSuccess);

	if (space.isLoading) return <Loader size="sm" />;
	if (space.isError || !space.data) {
		const missing = space.error instanceof ApiError && space.error.status === 404;
		return (
			<Alert color={missing ? "gray" : "red"} variant="light">
				{t(missing ? "notFound" : "loadFailed")}
			</Alert>
		);
	}
	const detail = space.data.space;
	const allPages = pages.data?.pages.flatMap((page) => page.pages) ?? [];

	return (
		<Stack gap="md">
			<Breadcrumbs separatorMargin={4}>
				<Anchor component={Link} to="/outline" size="sm">
					{t("title")}
				</Anchor>
				<Text size="sm" fw={500} className={classes.crumb}>
					{spaceName(detail)}
				</Text>
			</Breadcrumbs>
			<Group justify="space-between" wrap="wrap" gap="xs">
				<Title order={3} className={classes.rootTitle}>
					{spaceName(detail)}
				</Title>
				<Group gap={6}>
					<Badge variant="light" color="gray" tt="none">
						{t(`space.kind.${detail.kind}`)}
					</Badge>
					{!detail.canWrite && (
						<Badge variant="light" color="gray" tt="none">
							{t("space.readOnly")}
						</Badge>
					)}
				</Group>
			</Group>

			<TextInput
				leftSection={<IconSearch size={16} />}
				placeholder={t("space.searchPlaceholder")}
				aria-label={t("space.searchPlaceholder")}
				value={query}
				onChange={(event) => setQuery(event.currentTarget.value)}
			/>
			{debounced.trim() ? (
				<Stack gap={2}>
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
							<Text size="sm" fw={500} className={classes.ellipsis}>
								{hit.title || hit.address}
							</Text>
							{hit.path.length > 0 && (
								<Text size="xs" c="dimmed" className={classes.ellipsis}>
									{hit.path.join(" › ")}
								</Text>
							)}
						</Link>
					))}
				</Stack>
			) : (
				<Stack gap={2}>
					<Title order={5}>{t("space.pages")}</Title>
					{pages.isLoading && <Loader size="sm" />}
					{pages.isError && (
						<Alert color="red" variant="light">
							{t("loadFailed")}
						</Alert>
					)}
					{pages.isSuccess && allPages.length === 0 && (
						<Text size="sm" c="dimmed">
							{t("space.noPages")}
						</Text>
					)}
					{allPages.map((page) => (
						<Link
							key={page.id}
							to="/outline/$spaceId/$blockId"
							params={{ spaceId, blockId: page.id }}
							className={classes.listItem}
						>
							<Group gap={6} wrap="nowrap">
								{page.isTask && <OutlineTaskIcon status="todo" />}
								<Text size="sm" className={classes.ellipsis}>
									{page.title || page.sid}
								</Text>
								{page.alias && (
									<Badge size="xs" variant="outline" color="gray" tt="none">
										{page.alias}
									</Badge>
								)}
							</Group>
						</Link>
					))}
					{pages.hasNextPage && (
						<Button
							variant="light"
							loading={pages.isFetchingNextPage}
							onClick={() => void pages.fetchNextPage()}
						>
							{t("loadMore")}
						</Button>
					)}
				</Stack>
			)}
		</Stack>
	);
}
