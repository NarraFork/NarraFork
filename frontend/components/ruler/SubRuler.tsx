import { Badge, Box, Group, Loader, Text } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type RulerData, useSubRulerData } from "../../hooks/useRuler";
import { api } from "../../lib/api";
import { computeElasticLayout } from "./elastic-layout";
import { TickContextMenu } from "./RulerContextMenus";
import { SegmentCanvas } from "./SegmentCanvas";

interface SubRulerProps {
	projectId: string;
	chapterId: string;
	chapterTitle: string;
	/** Available width for this sub-ruler */
	width: number;
	/** Nesting depth (0 = direct child of main ruler) */
	depth: number;
	/** Callback when user wants to navigate up */
	onBreadcrumbClick?: (depth: number) => void;
}

const SUB_RULER_HEIGHT = 36;
const TICK_WIDTH = 2;

export function SubRuler({ projectId, chapterId, chapterTitle, width, depth }: SubRulerProps) {
	const { t } = useTranslation("graph");
	const queryClient = useQueryClient();
	const { data, isLoading } = useSubRulerData(projectId, chapterId);
	const [expandedSegments, setExpandedSegments] = useState<Set<string>>(new Set());
	const scrollX = 0;

	const [tickMenu, setTickMenu] = useState<{
		x: number;
		y: number;
		sha: string;
		message: string;
		hasSegment: boolean;
	} | null>(null);

	const toggleSegment = useCallback((fromSha: string) => {
		setExpandedSegments((prev) => {
			const next = new Set(prev);
			if (next.has(fromSha)) next.delete(fromSha);
			else next.add(fromSha);
			return next;
		});
	}, []);

	const handleForkFromCommit = useCallback(
		async (commitSha: string) => {
			try {
				await api.rulerFork(projectId, {
					startCommitSha: commitSha,
					parentChapterId: chapterId,
				});
				queryClient.invalidateQueries({ queryKey: ["ruler", projectId, "sub", chapterId] });
			} catch {
				// Global error handler
			}
		},
		[projectId, chapterId, queryClient],
	);

	const rulerData = (data as RulerData) ?? { commits: [], segments: [], activeChapters: [] };
	const commits = rulerData.commits ?? [];
	const segments = rulerData.segments ?? [];

	const commitShas = useMemo(() => commits.map((c) => c.sha), [commits]);
	const layout = useMemo(
		() => computeElasticLayout(commitShas, segments, expandedSegments),
		[commitShas, segments, expandedSegments],
	);

	const expandedTicks = useMemo(
		() => layout.ticks.filter((t) => t.isExpanded && t.segment),
		[layout.ticks],
	);

	if (isLoading) {
		return (
			<Box style={{ padding: 8 }}>
				<Loader size="xs" />
			</Box>
		);
	}

	if (commits.length === 0) {
		return (
			<Box style={{ padding: 8 }}>
				<Text size="xs" c="dimmed">
					{t("ruler.noCommitsOnBranch")}
				</Text>
			</Box>
		);
	}

	// Opacity decreases with depth for visual hierarchy
	const opacity = Math.max(0.4, 1 - depth * 0.15);

	return (
		<Box style={{ opacity, marginTop: 8 }}>
			{/* Sub-ruler header */}
			<Group gap={4} px={4} py={2}>
				<Badge size="xs" variant="outline" color="indigo">
					{chapterTitle}
				</Badge>
				<Text size="9px" c="dimmed">
					{t("ruler.commitCount", { count: commits.length })}
				</Text>
			</Group>

			{/* Sub-ruler track */}
			<Box
				style={{
					position: "relative",
					height: SUB_RULER_HEIGHT,
					background: "var(--mantine-color-dark-7)",
					borderTop: "1px solid var(--mantine-color-indigo-9)",
					borderBottom: "1px solid var(--mantine-color-indigo-9)",
					overflow: "hidden",
					borderRadius: 4,
					margin: "0 4px",
				}}
			>
				<Box
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						width: layout.totalWidth,
						height: "100%",
						transform: `translateX(${scrollX}px)`,
					}}
				>
					{layout.ticks.map((tick) => {
						const x = tick.x;
						const commit = commits[tick.index];
						const segment = tick.segment;
						const hasActive = segment && segment.activeChapterCount > 0;
						const isExpandable = segment?.isExpandable;
						const isExpanded = tick.isExpanded;

						return (
							<Box
								key={tick.sha}
								style={{
									position: "absolute",
									left: x,
									top: 0,
									height: "100%",
									display: "flex",
									flexDirection: "column",
									alignItems: "center",
									cursor: isExpandable ? "pointer" : "default",
								}}
								onClick={isExpandable ? () => toggleSegment(tick.sha) : undefined}
								onContextMenu={(e) => {
									e.preventDefault();
									e.stopPropagation();
									setTickMenu({
										x: e.clientX,
										y: e.clientY,
										sha: tick.sha,
										message: commit?.message ?? "",
										hasSegment: !!segment,
									});
								}}
							>
								<Box
									style={{
										width: TICK_WIDTH,
										height: hasActive ? 16 : 10,
										background: hasActive
											? "var(--mantine-color-indigo-5)"
											: "var(--mantine-color-dark-2)",
										marginTop: 3,
										borderRadius: 1,
									}}
								/>
								{isExpandable && (
									<Box
										style={{
											width: isExpanded ? 8 : 5,
											height: isExpanded ? 8 : 5,
											borderRadius: "50%",
											background: isExpanded
												? "var(--mantine-color-indigo-4)"
												: hasActive
													? "var(--mantine-color-indigo-5)"
													: "var(--mantine-color-dark-3)",
											marginTop: 2,
											border: isExpanded ? "1px solid var(--mantine-color-indigo-3)" : "none",
											transition: "all 150ms ease",
										}}
									/>
								)}
							</Box>
						);
					})}
				</Box>
			</Box>

			{/* Expanded segments within sub-ruler */}
			{expandedTicks.map((tick) => {
				const seg = tick.segment;
				if (!seg) return null;
				const nextTick = layout.ticks[tick.index + 1];
				const segWidth = nextTick ? nextTick.x - tick.x : 300;

				return (
					<Box key={`sub-seg-${tick.sha}`} style={{ marginLeft: 4, marginRight: 4 }}>
						<SegmentCanvas
							projectId={projectId}
							fromSha={tick.sha}
							toSha={seg.toSha}
							x={0}
							width={Math.min(segWidth, width - 8)}
							segment={seg}
						/>
					</Box>
				);
			})}

			{tickMenu && (
				<TickContextMenu
					x={tickMenu.x}
					y={tickMenu.y}
					commitSha={tickMenu.sha}
					commitMessage={tickMenu.message}
					hasSegment={tickMenu.hasSegment}
					onClose={() => setTickMenu(null)}
					onFork={handleForkFromCommit}
				/>
			)}
		</Box>
	);
}
