/**
 * One outline space, as the connected outline focused on it (readability E): where it hangs
 * (outline › its project › it), then its top-level blocks and, a project, its sessions, each
 * opened in place (`forest/OutlineForest.tsx`), and search within it, drawn as a tree of the matches. Router-free like the surface, so the
 * outline route and a dock panel (opened from a session's menu, on the session) show the same.
 */
import {
	Alert,
	Anchor,
	Badge,
	Breadcrumbs,
	Button,
	Group,
	Loader,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import type { OutlineSpaceDetail } from "@shared/outline-api";
import type { OutlineDiffKind } from "@shared/outline-restore-api";
import { IconHistory, IconSearch } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineSpace } from "../../hooks/useOutline";
import { ApiError } from "../../lib/api";
import { OutlineForest } from "./forest/OutlineForest";
import { OutlineHistoryBar } from "./history/OutlineHistoryBar";
import { OutlineRestoreModal, type OutlineRestoreTarget } from "./history/OutlineRestoreModal";
import classes from "./Outline.module.css";
import { useOutlineSpaceName } from "./OutlineSpaceName";
import { OutlineTimeline } from "./OutlineTimeline";
import { OutlineLink, outlineBlockTarget, useOutlineNavigate } from "./outline-nav";
import { ForestSwitcher } from "./QuickSwitcher";
import { OutlineSearchTree } from "./tree/OutlineSearchTree";
import type { TreeLocateTarget } from "./tree/tree-locate";

const NO_MARKS: ReadonlyMap<string, OutlineDiffKind> = new Map();

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
	const navigate = useOutlineNavigate();
	const space = useOutlineSpace(spaceId);
	const [query, setQuery] = useState("");
	const [debounced] = useDebouncedValue(query, 250);
	const searching = debounced.trim() !== "" && query.trim() !== "";
	const [locate, setLocate] = useState<TreeLocateTarget | null>(null);
	// The space's history: its timeline, and the whole space as of a point picked on it.
	const [historyOpen, setHistoryOpen] = useState(false);
	const [asOf, setAsOf] = useState<number | undefined>(undefined);
	const [diffMarks, setDiffMarks] = useState<ReadonlyMap<string, OutlineDiffKind>>(NO_MARKS);
	const backToNow = useCallback(() => setAsOf(undefined), []);
	// The whole space's restore dialog, its point captured as it opens (see `OutlineSurface`).
	const [restoring, setRestoring] = useState<OutlineRestoreTarget | null>(null);
	const detail = space.data?.space;
	const root = useMemo(
		() => (detail ? ({ kind: "space", space: detail } as const) : null),
		[detail],
	);
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
		<ForestSwitcher
			spaceId={spaceId}
			onPick={(hit) => navigate(outlineBlockTarget(hit.spaceId, hit.blockId))}
		>
			<Stack gap="md" data-testid="outline-space-home">
				<Breadcrumbs separatorMargin={4}>
					<Anchor
						size="sm"
						renderRoot={(props) => <OutlineLink {...props} to={{ kind: "home" }} />}
					>
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
						<Button
							size="compact-xs"
							variant={historyOpen ? "light" : "subtle"}
							color="gray"
							leftSection={<IconHistory size={14} />}
							aria-pressed={historyOpen}
							title={t(historyOpen ? "asOf.close" : "asOf.openHint")}
							onClick={() => {
								if (historyOpen) setAsOf(undefined);
								setHistoryOpen(!historyOpen);
							}}
							data-testid="outline-space-history"
						>
							{t("asOf.open")}
						</Button>
						{actions}
					</Group>
				</Group>

				{asOf !== undefined && (
					<OutlineHistoryBar
						spaceId={spaceId}
						rootId={null}
						asOf={asOf}
						canWrite={detail.canWrite}
						onBack={backToNow}
						onMarks={setDiffMarks}
						onRestore={(thenSeq) => setRestoring({ spaceId, rootId: null, thenSeq })}
					/>
				)}
				{historyOpen && asOf === undefined && (
					<Text size="sm" c="dimmed" data-testid="outline-space-history-hint">
						{t("asOf.pick")}
					</Text>
				)}
				{asOf !== undefined && (
					<OutlineForest
						root={{ kind: "block", spaceId, blockId: null, view: "all", asOf }}
						host={host}
						diffMarks={diffMarks}
					/>
				)}

				{asOf === undefined && (
					<TextInput
						leftSection={<IconSearch size={16} />}
						placeholder={t("space.searchPlaceholder")}
						aria-label={t("space.searchPlaceholder")}
						value={query}
						onChange={(event) => setQuery(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" && query !== "") setQuery("");
						}}
						data-testid="outline-search-input"
					/>
				)}
				{/* The search drawn as a tree, in the tree's place; a match is then shown in the tree. */}
				{searching && asOf === undefined && (
					<OutlineSearchTree
						query={debounced}
						spaceId={spaceId}
						onLocate={(target) => {
							setQuery("");
							setLocate(target);
						}}
					/>
				)}
				{root && (
					<OutlineForest
						root={root}
						host={host}
						locate={locate}
						hidden={searching || asOf !== undefined}
					/>
				)}
				<OutlineRestoreModal
					target={restoring}
					onClose={() => setRestoring(null)}
					onFinished={backToNow}
				/>
				{historyOpen && (
					<OutlineTimeline
						spaceId={spaceId}
						rootId={null}
						canWrite={detail.canWrite}
						asOf={asOf}
						onSelect={setAsOf}
					/>
				)}
			</Stack>
		</ForestSwitcher>
	);
}
