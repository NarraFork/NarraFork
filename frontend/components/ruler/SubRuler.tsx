import { Badge, Box, Group, Loader, Text } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type RulerData, useSubRulerData } from "../../hooks/useRuler";
import { api } from "../../lib/api";
import { computeElasticLayout } from "./elastic-layout";
import { TickContextMenu } from "./RulerContextMenus";
import { SegmentCanvas } from "./SegmentCanvas";
import type { RulerOrientation } from "./types";

interface SubRulerProps {
	projectId: string;
	chapterId: string;
	chapterTitle: string;
	/** Available width for this sub-ruler */
	width: number;
	/** Nesting depth (0 = direct child of main ruler) */
	depth: number;
	orientation?: RulerOrientation;
	/** Callback when user wants to navigate up */
	onBreadcrumbClick?: (depth: number) => void;
}

const SUB_RULER_HEIGHT = 36;
const TICK_WIDTH = 2;

export function SubRuler({
	projectId,
	chapterId,
	chapterTitle,
	width,
	depth,
	orientation = "horizontal",
}: SubRulerProps) {
	const { t } = useTranslation("graph");
	const queryClient = useQueryClient();
	const isH = orientation === "horizontal";
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
					...(isH
						? { height: SUB_RULER_HEIGHT }
						: { width: SUB_RULER_HEIGHT, minHeight: layout.totalWidth || 60 }),
					background: "var(--mantine-color-dark-7)",
					...(isH
						? {
								borderTop: "1px solid var(--mantine-color-indigo-9)",
								borderBottom: "1px solid var(--mantine-color-indigo-9)",
							}
						: {
								borderLeft: "1px solid var(--mantine-color-indigo-9)",
								borderRight: "1px solid var(--mantine-color-indigo-9)",
							}),
					overflow: "hidden",
					borderRadius: 4,
					margin: isH ? "0 4px" : "4px 0",
				}}
			>
				<Box
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						...(isH
							? { width: layout.totalWidth, height: "100%", transform: `translateX(${scrollX}px)` }
							: {
									height: layout.totalWidth,
									width: "100%",
									transform: `translateY(${scrollX}px)`,
								}),
					}}
				>
					{layout.ticks.map((tick) => {
						const pos = tick.x;
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
									...(isH
										? { left: pos, top: 0, height: "100%" }
										: { top: pos, left: 0, width: "100%" }),
									display: "flex",
									flexDirection: isH ? "column" : "row",
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
										...(isH
											? { width: TICK_WIDTH, height: hasActive ? 16 : 10, marginTop: 3 }
											: { height: TICK_WIDTH, width: hasActive ? 16 : 10, marginLeft: 3 }),
										background: hasActive
											? "var(--mantine-color-indigo-5)"
											: "var(--mantine-color-dark-2)",
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
											...(isH ? { marginTop: 2 } : { marginLeft: 2 }),
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
				const segSize = nextTick ? nextTick.x - tick.x : 300;

				return (
					<Box key={`sub-seg-${tick.sha}`} style={{ marginLeft: 4, marginRight: 4 }}>
						<SegmentCanvas
							projectId={projectId}
							fromSha={tick.sha}
							toSha={seg.toSha}
							mainPos={0}
							mainSize={Math.min(segSize, width - 8)}
							segment={seg}
							orientation={orientation}
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
