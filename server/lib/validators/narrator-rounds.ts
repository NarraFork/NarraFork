import { z } from "zod";

/**
 * `GET /api/narrators/:id/rounds` 的查询参数。
 *
 * 分页用 `beforeSeq`（上一页最后一轮的 `seq`）而不是 offset：轮次集合会随新消息
 * 增长，offset 会让翻页时漏掉或重复。`limit` 上限 500 —— 导航轨一次只需百来根。
 */
export const narratorRoundsQuerySchema = z.object({
	/** 只返回 `seq < beforeSeq` 的轮（取更早的一页）。 */
	beforeSeq: z.coerce.number().int().min(0).optional(),
	limit: z.coerce.number().int().min(1).max(500).default(200),
});
