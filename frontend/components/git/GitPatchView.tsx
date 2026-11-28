import type { DiffLineOperations } from "@frontend/components/narrator/diff/DiffContent";
import { DiffView } from "@frontend/components/narrator/diff/DiffView";
import { getShikiLang } from "@frontend/lib/shiki-lang";
import { Loader, Text } from "@mantine/core";
import type { GitStagingUnit, GitStagingUnitDiffMapping } from "@shared/git-staging-lists";
import { parseUnifiedDiff } from "@shared/pretext-layout/parse-unified-diff";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import classes from "./GitPatchView.module.css";
import { GitSplitDiff } from "./GitSplitDiff";
import { completeStagingDiffMappings } from "./git-staging-diff-mappings";

export interface GitPatchUnitActions {
	units: readonly GitStagingUnit[];
	mappings?: readonly GitStagingUnitDiffMapping[];
	selectedIds: readonly string[];
	showAll?: boolean;
	render: (unit: GitStagingUnit, inline: boolean) => ReactNode;
}

const DIFF_SEGMENT_ROWS = 500;
const METADATA_MAX_CHARS = 8_192;
const METADATA_MAX_LINES = 80;

export interface GitPatchViewProps {
	/** One file's unified patch; the parser reads only the first file. */
	diff: string | undefined;
	truncated?: boolean;
	/** Used for syntax highlighting. */
	file: string | null;
	/** Changes whenever the patch identity changes; restarts paging and scroll. */
	resetKey: string;
	loading?: boolean;
	error?: Error | null;
	maxHeight?: number;
	/** `split` is the side-by-side GitHub layout; `unified` is the merged diff. */
	layout?: "unified" | "split";
	/** Fill the parent pane instead of capping the diff at `maxHeight`. */
	fill?: boolean;
	/** Complete ownership units only; unsupported projections stay in the explicit list. */
	unitActions?: GitPatchUnitActions;
}

function UnitFallback({
	units,
	render,
}: {
	units: readonly GitStagingUnit[];
	render: GitPatchUnitActions["render"];
}) {
	const { t } = useTranslation("git");
	const [top, setTop] = useState(0);
	const rowHeight = 34;
	const start = Math.min(
		Math.max(0, units.length - 12),
		Math.max(0, Math.floor(top / rowHeight) - 3),
	);
	return (
		<section
			className={classes.unitFallback}
			data-git-staging-unit-fallback
			data-total={units.length}
			aria-label={t("staging.allUnits")}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the virtualized unit list is a keyboard scrollport
			tabIndex={0}
			onScroll={(event) => setTop(event.currentTarget.scrollTop)}
		>
			<div style={{ height: units.length * rowHeight, position: "relative", flexShrink: 0 }}>
				{units.slice(start, start + 12).map((unit, index) => (
					<div
						key={unit.id}
						style={{
							position: "absolute",
							top: (start + index) * rowHeight,
							width: "100%",
							height: rowHeight,
						}}
					>
						{render(unit, false)}
					</div>
				))}
			</div>
		</section>
	);
}

/** Presentation for a single-file patch: loading, errors, binary, truncation and paging. */
export function GitPatchView({
	diff,
	truncated = false,
	file,
	resetKey,
	loading = false,
	error = null,
	maxHeight = 500,
	layout = "unified",
	fill = false,
	unitActions,
}: GitPatchViewProps) {
	const { t } = useTranslation("git");
	// Git already computed this diff, so the rows are parsed from the patch rather
	// than recomputed from two texts. That keeps the real file line numbers the
	// `@@` headers carry, and lets the shared renderer supply highlighting, the
	// added/removed tint and word-level marking.
	const parsed = useMemo(
		() => (!error && !loading && diff?.trim() ? parseUnifiedDiff(diff) : null),
		[diff, error, loading],
	);
	const metadata = useMemo(
		() =>
			parsed && !parsed.binary && parsed.lines.length === 0
				? (diff ?? "")
						.slice(0, METADATA_MAX_CHARS)
						.split("\n")
						.slice(0, METADATA_MAX_LINES)
						.join("\n")
				: "",
		[diff, parsed],
	);
	const [visibleWindow, setVisibleWindow] = useState(() => ({
		resetKey,
		lineCount: DIFF_SEGMENT_ROWS,
	}));
	// A new patch starts at the first segment without a setState-in-effect reset.
	const visibleLineCount =
		visibleWindow.resetKey === resetKey ? visibleWindow.lineCount : DIFF_SEGMENT_ROWS;

	const visibleLines = useMemo(
		() => parsed?.lines.slice(0, visibleLineCount) ?? [],
		[parsed, visibleLineCount],
	);
	const visibleHunks = useMemo(
		() => parsed?.hunks.filter((hunk) => hunk.rowIndex < visibleLines.length) ?? [],
		[parsed, visibleLines.length],
	);
	const hasMoreLines = !!parsed && visibleLines.length < parsed.lines.length;
	const loadNextSegment = useCallback(() => {
		if (!parsed) return;
		setVisibleWindow({
			resetKey,
			lineCount: Math.min(parsed.lines.length, visibleLineCount + DIFF_SEGMENT_ROWS),
		});
	}, [parsed, resetKey, visibleLineCount]);

	const ownershipUnits = unitActions?.units;
	const ownershipMappings = unitActions?.mappings;
	const mapped = useMemo(
		() =>
			ownershipUnits && parsed && layout === "unified"
				? completeStagingDiffMappings(
						ownershipUnits,
						ownershipMappings,
						parsed.lines,
						visibleLines.length,
						truncated,
					)
				: [],
		[ownershipUnits, ownershipMappings, parsed, layout, visibleLines.length, truncated],
	);
	const projection = useMemo(() => {
		const anchors = new Map(mapped.map((mapping) => [mapping.lineRanges[0].start, mapping.unitId]));
		const units = new Map(ownershipUnits?.map((unit) => [unit.id, unit]) ?? []);
		const keys = new Map<number, string>();
		for (const mapping of mapped) {
			let offset = 0;
			for (const { start, end } of mapping.lineRanges) {
				for (let index = start; index < end; index++)
					keys.set(index, `${mapping.unitId}:${offset++}`);
			}
		}
		return { anchors, units, keys, anchorRows: new Set(anchors.keys()) };
	}, [mapped, ownershipUnits]);
	const selectedIds = unitActions?.selectedIds;
	const selectedLines = useMemo(() => {
		const selected = new Set<number>();
		const ids = new Set(selectedIds);
		for (const mapping of mapped) {
			if (!ids.has(mapping.unitId)) continue;
			for (const { start, end } of mapping.lineRanges) {
				for (let index = start; index < end; index++) selected.add(index);
			}
		}
		return selected;
	}, [selectedIds, mapped]);
	const lineOperations: DiffLineOperations | undefined =
		unitActions && mapped.length
			? {
					width: 84,
					selected: selectedLines,
					keys: projection.keys,
					anchors: projection.anchorRows,
					render: (index) => {
						const id = projection.anchors.get(index);
						const unit = id ? projection.units.get(id) : undefined;
						return unit ? unitActions.render(unit, true) : null;
					},
				}
			: undefined;
	const mappedIds = new Set(mapped.map((mapping) => mapping.unitId));
	const fallbackUnits =
		unitActions?.units.filter((unit) => unitActions.showAll || !mappedIds.has(unit.id)) ?? [];

	// A failed refetch may still carry cached data. The error replaces the entire
	// preview, including binary/metadata branches, rather than exposing that data.
	if (error) {
		return (
			<Text c="red" size="sm" role="alert">
				{error.message}
			</Text>
		);
	}
	if (loading) return <Loader size="sm" />;

	const boundedHeight = fill ? undefined : maxHeight;
	return (
		<div className={fill ? classes.fill : undefined} data-git-patch-view={layout}>
			{unitActions && fallbackUnits.length > 0 && (
				<UnitFallback units={fallbackUnits} render={unitActions.render} />
			)}
			{/* The server-side byte ceiling applies even to binary or zero-row patches. */}
			{truncated && (
				<Text size="xs" c="yellow" mb="xs">
					{t("diffTruncated")}
				</Text>
			)}
			{!parsed && (
				<Text size="sm" c="dimmed">
					{t("noDiff")}
				</Text>
			)}

			{parsed?.binary && (
				<Text size="sm" c="dimmed">
					{t("diffBinary")}
				</Text>
			)}

			{metadata && (
				<>
					<Text size="sm" c="dimmed" mb="xs">
						{t("diffMetadataOnly")}
					</Text>
					<Text
						component="pre"
						size="xs"
						ff="monospace"
						tabIndex={0}
						aria-label={t("diffMetadataOnly")}
						data-git-patch-metadata
						style={{
							whiteSpace: "pre-wrap",
							overflowWrap: "anywhere",
							maxHeight: Math.min(maxHeight, 200),
							overflowY: "auto",
						}}
					>
						{metadata}
					</Text>
					{metadata.length < (diff?.length ?? 0) && (
						<Text size="xs" c="yellow">
							{t("diffMetadataTruncated")}
						</Text>
					)}
				</>
			)}

			{parsed && !parsed.binary && parsed.lines.length > 0 && (
				<>
					{hasMoreLines && (
						<Text size="xs" c="dimmed" mb="xs" className={classes.notice}>
							{t("diffLoadMore", {
								shown: visibleLines.length,
								total: parsed.lines.length,
							})}
						</Text>
					)}
					{layout === "split" ? (
						<GitSplitDiff
							lines={visibleLines}
							hunks={visibleHunks}
							language={file ? getShikiLang(file) : undefined}
							maxHeight={boundedHeight}
							fill={fill}
							onNearBottom={hasMoreLines ? loadNextSegment : undefined}
						/>
					) : (
						<div className={fill ? classes.unified : undefined}>
							<DiffView
								key={resetKey}
								lines={visibleLines}
								lineOperations={lineOperations}
								hunks={visibleHunks}
								language={file ? getShikiLang(file) : undefined}
								maxHeight={boundedHeight}
								onNearBottom={hasMoreLines ? loadNextSegment : undefined}
								// This panel is not measured by pretext, so the gutter may shrink to
								// the digits actually present, which matters on a phone.
								gutterMinWidth={1}
							/>
						</div>
					)}
				</>
			)}
		</div>
	);
}
