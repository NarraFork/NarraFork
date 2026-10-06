import type {
	BuildPretextEngineOptions,
	PretextEngineProvider,
	PretextEngineSource,
} from "./engine";

export interface GoldenSource extends PretextEngineSource {
	textLength: number;
	complexity: number;
}

export const PRETEXT_GOLDEN_SOURCES: readonly GoldenSource[] = [
	{
		itemKey: "golden-message-1",
		firstSeq: 1,
		lastSeq: 1,
		sourceMessageIds: ["golden-message-1"],
		kind: "message-bubble",
		textLength: 42,
		complexity: 1,
	},
	{
		itemKey: "golden-tool-run",
		firstSeq: 2,
		lastSeq: 4,
		sourceMessageIds: ["golden-message-2", "golden-message-3", "golden-message-4"],
		kind: "tool-run",
		textLength: 280,
		complexity: 3,
	},
	{
		itemKey: "golden-plan",
		firstSeq: 5,
		lastSeq: 5,
		sourceMessageIds: ["golden-message-5"],
		kind: "plan-card",
		textLength: 160,
		complexity: 2,
	},
];

export const PRETEXT_GOLDEN_OPTIONS: BuildPretextEngineOptions = {
	layoutRevision: "golden-layout-1",
	documentRevision: "golden-document-1",
	lod: 4,
	widthBucket: "720",
	layoutOptionsRevision: "golden-options-1",
	contentWidth: 720,
	viewportHeight: 600,
	metrics: { topPadding: 12, itemGap: 4, bottomPadding: 12 },
};

export type GoldenPrepared = GoldenSource;

export const PRETEXT_GOLDEN_PROVIDER: PretextEngineProvider<GoldenSource, GoldenPrepared> = {
	prepare: (source) => ({ ...source }),
	measure: (source, context) => {
		const columns = Math.max(1, Math.floor(context.contentWidth / 8));
		const wrappedLines = Math.max(1, Math.ceil(source.textLength / columns));
		return wrappedLines * 20 + source.complexity * 6 + context.lod;
	},
};
