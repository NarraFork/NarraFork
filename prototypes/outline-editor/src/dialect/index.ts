export { parseBlock, parseOutline, pmToSrc, sameMarks, srcToPm } from "./parse";
export { serializeBody, serializeInlineFragment, serializeOutline } from "./serialize";
export type * from "./types";

import { parseBlock } from "./parse";
import { serializeBody } from "./serialize";
import type { OutlineNode } from "./types";

/**
 * 服务端写入时的规范化（§6.8）：保证「解析 → 序列化」往返不变；
 * 方言外的结构拆成子块并说明拆成了什么（D23）。
 */
export function normalizeBlock(src: string): {
	content: string;
	children: OutlineNode[];
	notes: string[];
} {
	const p = parseBlock(src);
	return { content: serializeBody(p.body), children: p.extra, notes: p.notes };
}
