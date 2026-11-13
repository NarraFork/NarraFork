/**
 * One outline space, as the connected outline focused on it (readability E): where it hangs
 * (outline › its project › it), then its pages and, a project, its sessions, each opened in
 * place (`tree/OutlineTree.tsx`), and search within it. Router-free like the surface, so the
 * outline route and a dock panel (opened from a session's menu, on the session) show the same.
 */
import {
	Alert,
	Anchor,
	Badge,
	Breadcrumbs,
	Group,
	Loader,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import type { OutlineSpaceDetail } from "@shared/outline-api";
import { IconSearch } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineSearch, useOutlineSpace } from "../../hooks/useOutline";
import { ApiError } from "../../lib/api";
import classes from "./Outline.module.css";
import { useOutlineSpaceName } from "./OutlineSpaceName";
import { OutlineLink, outlineBlockTarget } from "./outline-nav";
import { OutlineTree } from "./tree/OutlineTree";

export function OutlineSpaceHome({
	spaceId,
	onLoaded,
	onMissing,
	actions,
	host = "page",
}: {
	spaceId: string;
	/** The outline page or a dock panel (each keeps its own open nodes of the tree). */
	host?: "page" | "panel";
	/** Told the space once it has loaded (a dock panel names its tab after it). */
	onLoaded?: (space: OutlineSpaceDetail, name: string) => void;
	/** The space could not be read (it does not exist, or the person may not read it). */
	onMissing?: () => void;
	/** The host's own controls, beside the space's badges. */
	actions?: React.ReactNode;
}) {
	const { t } = useTranslation("outline");
	const spaceName = useOutlineSpaceName();
	const space = useOutlineSpace(spaceId);
	const [query, setQuery] = useState("");
	const [debounced] = useDebouncedValue(query, 250);
	const search = useOutlineSearch(debounced, spaceId, space.isSuccess);
	const detail = space.data?.space;
	const name = detail ? spaceName(detail) : "";
	useEffect(() => {
		if (detail && onLoaded) onLoaded(detail, name);
	}, [detail, name, onLoaded]);
	const missing = space.error instanceof ApiError && space.error.status === 404;
	useEffect(() => {
		if (missing) onMissing?.();
	}, [missing, onMissing]);

	if (space.isLoading) return <Loader size="sm" />;
	if (space.isError || !detail) {
		return (
			<Alert color={missing ? "gray" : "red"} variant="light">
				{t(missing ? "notFound" : "loadFailed")}
			</Alert>
		);
	}

	return (
		<Stack gap="md" data-testid="outline-space-home">
			<Breadcrumbs separatorMargin={4}>
				<Anchor size="sm" renderRoot={(props) => <OutlineLink {...props} to={{ kind: "home" }} />}>
					{t("title")}
				</Anchor>
				{detail.parent && (
					<Anchor
						size="sm"
						data-testid="outline-crumb-project"
						renderRoot={(props) => (
							<OutlineLink
								{...props}
								to={{ kind: "space", spaceId: detail.parent?.spaceId ?? detail.id }}
							/>
						)}
					>
						{detail.parent.label ?? t("space.projectUnnamed")}
					</Anchor>
				)}
				<Text size="sm" fw={500} className={classes.crumb}>
					{name}
				</Text>
			</Breadcrumbs>
			<Group justify="space-between" wrap="wrap" gap="xs">
				<Title order={3} className={classes.rootTitle}>
					{name}
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
					{actions}
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
						<OutlineLink
							key={hit.blockId}
							to={outlineBlockTarget(hit.spaceId, hit.blockId)}
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
						</OutlineLink>
					))}
				</Stack>
			) : (
				<OutlineTree root={{ kind: "space", space: detail }} host={host} />
			)}
		</Stack>
	);
}
