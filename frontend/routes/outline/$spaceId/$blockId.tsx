/**
 * An outline page, or any block of one focused as a page: breadcrumbs, the block tree (facts
 * by default), a side panel with backlinks and history, and the timeline strip at the bottom.
 *
 * Everything that says what is shown lives in the URL: the focused block is the path, `asOf`
 * the commit the page is shown at, `view` the facts or all view. Browser back and forward
 * therefore walk focus and time. The view as of a commit is read-only; the current view follows
 * the page live through a page subscription. The page is laid out to leave room for the
 * editor and the mind map: the view area, a side panel and the timeline are separate parts.
 */
import {
	ActionIcon,
	Alert,
	Box,
	Button,
	Drawer,
	Group,
	Loader,
	SegmentedControl,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { titleOf } from "@shared/outline";
import type { OutlineViewMode } from "@shared/outline-api";
import { IconClock, IconLayoutSidebarRight } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import classes from "../../../components/outline/Outline.module.css";
import { OutlineBlockBody } from "../../../components/outline/OutlineBlockBody";
import { OutlineBlockTree, OutlineTaskIcon } from "../../../components/outline/OutlineBlockTree";
import { OutlineBreadcrumbs } from "../../../components/outline/OutlineBreadcrumbs";
import { OutlineGate } from "../../../components/outline/OutlineGate";
import { OutlineSidePanel } from "../../../components/outline/OutlineSidePanel";
import { OutlineTimeline } from "../../../components/outline/OutlineTimeline";
import { useOutlineBlock, useOutlinePageLive } from "../../../hooks/useOutline";
import { ApiError } from "../../../lib/api";
import { forgetOutlineRecent, recordOutlineRecent } from "../../../lib/outline-recents";
import { type OutlineBlockSearch, parseOutlineBlockSearch } from "../../../lib/outline-view";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "../../../lib/responsive";

export const Route = createFileRoute("/outline/$spaceId/$blockId")({
	component: OutlineBlockRoute,
	validateSearch: parseOutlineBlockSearch,
});

function OutlineBlockRoute() {
	return (
		<OutlineGate>
			<OutlineBlockPage />
		</OutlineGate>
	);
}

function OutlineBlockPage() {
	const { spaceId, blockId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { t } = useTranslation("outline");
	const mode: OutlineViewMode = search.view ?? "facts";
	const query = useOutlineBlock(spaceId, blockId, { asOf: search.asOf, view: mode });
	const view = query.data;
	useOutlinePageLive(view);

	const mobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const [sideOpen, setSideOpen] = useState<boolean | null>(null);
	const showSide = sideOpen ?? !mobile;
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	const toggle = useCallback((id: string) => {
		setCollapsed((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const setSearch = useCallback(
		(patch: Partial<OutlineBlockSearch>) =>
			void navigate({
				search: (previous: OutlineBlockSearch) => {
					const next = { ...previous, ...patch };
					if (next.asOf === undefined) delete next.asOf;
					if (next.view === "facts" || next.view === undefined) delete next.view;
					return next;
				},
			}),
		[navigate],
	);
	const linkSearch = useMemo<OutlineBlockSearch>(
		() => ({
			...(search.asOf !== undefined ? { asOf: search.asOf } : {}),
			...(search.view ? { view: search.view } : {}),
		}),
		[search.asOf, search.view],
	);

	const root = view?.blocks.find((block) => block.id === view.rootId);
	const rootTitle = root ? titleOf(root.content) || root.sid : "";

	// Remember pages actually opened (their current state), and forget ones that are gone.
	const missing = query.error instanceof ApiError && query.error.status === 404;
	useEffect(() => {
		if (view?.current && root) {
			recordOutlineRecent({ spaceId, blockId, title: rootTitle, visitedAt: Date.now() });
		}
	}, [view?.current, root, spaceId, blockId, rootTitle]);
	useEffect(() => {
		if (missing && search.asOf === undefined) forgetOutlineRecent(blockId);
	}, [missing, search.asOf, blockId]);

	if (query.isLoading) {
		return <Loader size="sm" />;
	}
	if (!view || !root) {
		return (
			<Alert color={missing ? "gray" : "red"} variant="light">
				{t(missing ? (search.asOf !== undefined ? "notAtTime" : "notFound") : "loadFailed")}
				{missing && search.asOf !== undefined && (
					<Button
						size="compact-xs"
						variant="subtle"
						ml="xs"
						onClick={() => setSearch({ asOf: undefined })}
					>
						{t("page.backToCurrent")}
					</Button>
				)}
			</Alert>
		);
	}

	const sidePanel = (
		<OutlineSidePanel
			view={view}
			search={linkSearch}
			onViewAt={(seq) => setSearch({ asOf: seq })}
		/>
	);

	return (
		<Box className={classes.page}>
			<div className={classes.toolbar}>
				<OutlineBreadcrumbs view={view} rootTitle={rootTitle} search={linkSearch} />
				<Group gap="xs" wrap="nowrap">
					<SegmentedControl
						size="xs"
						value={view.view}
						onChange={(value) => setSearch({ view: value as OutlineViewMode })}
						data={[
							{ value: "facts", label: t("page.view.facts") },
							{ value: "all", label: t("page.view.all") },
						]}
						aria-label={t("page.viewLabel")}
					/>
					<Tooltip label={t("page.sidePanel")}>
						<ActionIcon
							variant={showSide ? "light" : "subtle"}
							color="gray"
							aria-label={t("page.sidePanel")}
							aria-pressed={showSide}
							onClick={() => setSideOpen(!showSide)}
						>
							<IconLayoutSidebarRight size={18} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</div>

			{!view.current && (
				<Alert
					variant="light"
					color="indigo"
					icon={<IconClock size={16} />}
					py={6}
					styles={{ message: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } }}
				>
					<Text size="sm">{t("page.asOfBanner", { seq: view.seq })}</Text>
					<Button size="compact-xs" variant="light" onClick={() => setSearch({ asOf: undefined })}>
						{t("page.backToCurrent")}
					</Button>
				</Alert>
			)}
			{view.pageTruncated && (
				<Alert variant="light" color="yellow" py={6}>
					{t("page.truncated")}
				</Alert>
			)}

			<div className={`${classes.body} ${showSide && !mobile ? classes.bodyWithSide : ""}`}>
				<Box className={classes.main}>
					<Group gap={6} wrap="nowrap" align="flex-start" mb="xs">
						{root.task && <OutlineTaskIcon status={root.task.status} />}
						<Title order={3} className={classes.rootTitle}>
							{rootTitle}
						</Title>
					</Group>
					{root.content.trim() !== rootTitle && (
						<Box className={classes.content} mb="xs">
							<OutlineBlockBody content={root.content} />
						</Box>
					)}
					<OutlineBlockTree
						view={view}
						collapsed={collapsed}
						search={linkSearch}
						onToggle={toggle}
					/>
					{view.view === "facts" && view.hiddenByView > 0 && (
						<Text size="xs" c="dimmed" mt="sm">
							{t("page.processHidden", { count: view.hiddenByView })}{" "}
							<Button size="compact-xs" variant="subtle" onClick={() => setSearch({ view: "all" })}>
								{t("page.showAll")}
							</Button>
						</Text>
					)}
				</Box>
				{showSide && !mobile && <Box className={classes.side}>{sidePanel}</Box>}
			</div>

			<OutlineTimeline
				view={view}
				asOf={search.asOf}
				onSelect={(seq) => setSearch({ asOf: seq })}
			/>

			{mobile && (
				<Drawer
					opened={showSide}
					onClose={() => setSideOpen(false)}
					position="bottom"
					size="70%"
					title={rootTitle}
				>
					{sidePanel}
				</Drawer>
			)}
		</Box>
	);
}
