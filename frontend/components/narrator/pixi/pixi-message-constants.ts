export type PixiMessageHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export const PIXI_MESSAGE_FONT = {
	sansFamily: "sans-serif",
	monoFamily: "monospace",
	sizes: {
		body: 14,
		small: 12,
		subtitle: 11,
		code: 11,
		toolName: 12,
		title: 12,
		avatarInitial: 10,
	},
	weights: {
		semibold: "600",
		bold: "700",
	},
	headingSizes: {
		1: 22,
		2: 19,
		3: 17,
		4: 15,
		5: 15,
		6: 15,
	} satisfies Record<PixiMessageHeadingLevel, number>,
} as const;

export const PIXI_MESSAGE_METRICS = {
	codePaddingX: 10,
	codePaddingY: 7,
	codeLineHeight: 18,
	blockquoteIndent: 16,
	listIndent: 24,
} as const;

export function pixiCssFont(fontSize: number, fontFamily: string, fontWeight?: string): string {
	return fontWeight ? `${fontWeight} ${fontSize}px ${fontFamily}` : `${fontSize}px ${fontFamily}`;
}
