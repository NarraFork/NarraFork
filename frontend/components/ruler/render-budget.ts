export interface RenderBudget {
	maxTickElements: number;
	maxCardElements: number;
	maxPanelElements: number;
	maxConnectorLines: number;
}

export function getRenderBudget(scale: number): RenderBudget {
	if (scale < 0.6) {
		return {
			maxTickElements: 200,
			maxCardElements: 0,
			maxPanelElements: 0,
			maxConnectorLines: 0,
		};
	}
	if (scale < 1.2) {
		return {
			maxTickElements: 300,
			maxCardElements: 50,
			maxPanelElements: 0,
			maxConnectorLines: 30,
		};
	}
	if (scale < 2.0) {
		return {
			maxTickElements: 200,
			maxCardElements: 30,
			maxPanelElements: 4,
			maxConnectorLines: 30,
		};
	}
	return {
		maxTickElements: 100,
		maxCardElements: 15,
		maxPanelElements: 2,
		maxConnectorLines: 15,
	};
}

export interface CardPriorityInput {
	status: string;
	narratorStatus: string | null;
	role: string;
}

/**
 * Compute render priority for a chapter card.
 * Higher score = higher priority to render.
 */
export function computeCardPriority(
	chapter: CardPriorityInput,
	distanceFromViewCenter: number,
	viewportMainSize: number,
): number {
	let score = 0;

	// Status weight
	if (chapter.status === "active") score += 100;
	else if (chapter.status === "merged") score += 20;
	else score += 10;

	// Narrator activity
	if (chapter.narratorStatus === "streaming") score += 50;
	else if (chapter.narratorStatus === "thinking") score += 40;
	else if (chapter.narratorStatus === "idle") score += 10;

	// Role weight
	if (chapter.role === "review") score += 15;
	if (chapter.role === "trunk") score += 10;

	// Distance decay
	const normalizedDistance = distanceFromViewCenter / Math.max(1, viewportMainSize);
	score *= Math.max(0.1, 1 - normalizedDistance * 0.5);

	return score;
}

/**
 * Apply render budget to a list of cards, keeping only the highest-priority ones.
 */
export function applyBudget<T extends CardPriorityInput & { worldX: number }>(
	cards: T[],
	budget: RenderBudget,
	viewCenterX: number,
	viewportWidth: number,
): T[] {
	if (cards.length <= budget.maxCardElements) return cards;

	const scored = cards.map((card) => ({
		card,
		score: computeCardPriority(card, Math.abs(card.worldX - viewCenterX), viewportWidth),
	}));
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, budget.maxCardElements).map((s) => s.card);
}
