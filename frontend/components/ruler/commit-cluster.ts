import type { RulerSegment } from "../../hooks/useRuler";
import { COLLAPSED_GAP, type TickPosition } from "./elastic-layout";

export interface CommitCluster {
	startSha: string;
	endSha: string;
	count: number;
	startIndex: number;
	endIndex: number;
	hasSegments: boolean;
	activeCount: number;
	worldPos: number;
	worldSize: number;
}

export function getClusterMinScreenSize(scale: number): number {
	if (scale < 0.25) return 40;
	if (scale < 0.6) return 20;
	return 0;
}

export function clusterCommits(
	ticks: TickPosition[],
	segmentBySha: Map<string, RulerSegment>,
	scale: number,
): CommitCluster[] {
	const minScreen = getClusterMinScreenSize(scale);
	if (minScreen === 0) return [];

	const gap = COLLAPSED_GAP;
	const clusters: CommitCluster[] = [];
	let i = 0;

	while (i < ticks.length) {
		const start = ticks[i];
		const seg = segmentBySha.get(start.sha);

		if (seg) {
			clusters.push({
				startSha: start.sha,
				endSha: start.sha,
				count: 1,
				startIndex: start.index,
				endIndex: start.index,
				hasSegments: true,
				activeCount: seg.activeChapterCount,
				worldPos: start.x,
				worldSize: gap,
			});
			i++;
			continue;
		}

		let j = i + 1;
		while (j < ticks.length) {
			if (segmentBySha.has(ticks[j].sha)) break;
			if ((ticks[j].x - start.x) * scale >= minScreen) break;
			j++;
		}

		const end = ticks[j - 1];
		const span = end.x - start.x;
		clusters.push({
			startSha: start.sha,
			endSha: end.sha,
			count: j - i,
			startIndex: start.index,
			endIndex: end.index,
			hasSegments: false,
			activeCount: 0,
			worldPos: start.x + span / 2,
			worldSize: span + gap,
		});
		i = j;
	}

	return clusters;
}

export interface HeatSegment {
	startX: number;
	endX: number;
	intensity: number;
}

export function computeHeatmap(
	clusters: CommitCluster[],
	totalWidth: number,
	screenWidth: number,
): HeatSegment[] {
	const n = Math.max(1, Math.floor(screenWidth / 4));
	const winSize = totalWidth / n;
	const segments: HeatSegment[] = [];

	for (let w = 0; w < n; w++) {
		const wStart = w * winSize;
		const wEnd = wStart + winSize;
		let totalCount = 0;
		let activeCount = 0;

		for (const c of clusters) {
			const cStart = c.worldPos - c.worldSize / 2;
			const cEnd = c.worldPos + c.worldSize / 2;
			if (cEnd > wStart && cStart < wEnd) {
				totalCount += c.count;
				activeCount += c.activeCount;
			}
		}

		segments.push({
			startX: wStart,
			endX: wEnd,
			intensity: activeCount / Math.max(1, totalCount),
		});
	}

	return segments;
}
