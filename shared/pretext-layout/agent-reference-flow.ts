import type { PreparedRichInline, RichInlineItem } from "@chenglou/pretext/rich-inline";
import { prepareRichInline } from "@chenglou/pretext/rich-inline";
import {
	AGENT_REFERENCE_MARGIN_X,
	AGENT_REFERENCE_MAX_WIDTH,
	AGENT_REFERENCE_MIN_HEIGHT,
	AGENT_REFERENCE_PADDING_X,
	AGENT_REFERENCE_STATUS_WIDTH,
} from "../agent-reference";
import { typographyMetrics } from "./pretext-fonts";
import { letterSpacingForFont } from "./typography";

/** Geometry shared by normal Markdown links and the prepared inline atom. */
export function agentReferenceMetrics(): {
	font: string;
	height: number;
	/** Total advance, including the chip's outer margins. */
	maxWidth: number;
	chromeWidth: number;
	paddingX: number;
	marginX: number;
	statusWidth: number;
	letterSpacing: number;
} {
	const { font, line } = typographyMetrics();
	return {
		font: font.body,
		height: Math.max(AGENT_REFERENCE_MIN_HEIGHT, line.body),
		maxWidth: AGENT_REFERENCE_MAX_WIDTH,
		chromeWidth:
			AGENT_REFERENCE_STATUS_WIDTH + (AGENT_REFERENCE_PADDING_X + AGENT_REFERENCE_MARGIN_X) * 2,
		paddingX: AGENT_REFERENCE_PADDING_X,
		marginX: AGENT_REFERENCE_MARGIN_X,
		statusWidth: AGENT_REFERENCE_STATUS_WIDTH,
		letterSpacing: letterSpacingForFont(font.body),
	};
}

/** Only reference-bearing flows retain these serializable, width-independent inputs. */
export interface PreparedAgentReferences {
	readonly items: RichInlineItem[];
	readonly atoms: Array<{ itemIndex: number; baseWidth: number }>;
}

const WIDTH_CACHE_LIMIT = 4;
const widthFlows = new WeakMap<PreparedAgentReferences, Map<number, PreparedRichInline>>();

/**
 * Both frame measurement and paint MUST use this view of a reference-bearing flow.
 * An atom moves whole to the next line; only a column narrower than its intrinsic
 * capped width shrinks it. The full label remains in the item for CSS ellipsis and
 * selection. Never mutate the prepared source (which can be shared across widths).
 */
export function inlineFlowForWidth(
	source: { flow: PreparedRichInline; agentReferences?: PreparedAgentReferences },
	width: number,
): PreparedRichInline {
	const refs = source.agentReferences;
	if (!refs) return source.flow;
	const columnWidth = Math.max(1, width);
	if (!refs.atoms.some((atom) => atom.baseWidth > columnWidth)) return source.flow;

	let cache = widthFlows.get(refs);
	const cached = cache?.get(columnWidth);
	if (cached) {
		// Refresh insertion order so alternating frame/paint widths remain hot.
		cache?.delete(columnWidth);
		cache?.set(columnWidth, cached);
		return cached;
	}

	const items = refs.items.slice();
	for (const { itemIndex, baseWidth } of refs.atoms) {
		if (baseWidth <= columnWidth) continue;
		const item = items[itemIndex];
		if (!item) continue;
		items[itemIndex] = {
			...item,
			extraWidth: (item.extraWidth ?? 0) - (baseWidth - columnWidth),
		};
	}
	const flow = prepareRichInline(items);
	if (!cache) {
		cache = new Map();
		widthFlows.set(refs, cache);
	}
	if (cache.size >= WIDTH_CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(columnWidth, flow);
	return flow;
}
