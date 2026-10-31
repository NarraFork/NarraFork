// 兼容改造前的 ModelTrace 数据。
//
// 旧实现每次 /modeltrace 都 fork 一个新的 primary 叙述者，既没有隐藏标记也没有绑定键，
// 所以它们一直堆在叙述者列表里。启动时做一次收编：
//   - 全部隐藏（列表/搜索/最近标签都不再出现）；
//   - 每个模型最近的那一个写回 `modeltrace_key`，成为该模型的舱，模型的入口仍能打开旧历史；
//   - 同一个模型更早的同类叙述者只隐藏不删除，直接访问 id 仍可查看。
//
// 模型名解析不出来（供应商已删除等）时只隐藏，不猜绑定关系。

import { db } from "@server/db";
import { narrators } from "@server/db/schema";
import { resolveProviderAndModel } from "@server/lib/agent/provider";
import { logger } from "@server/lib/logger";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { modelTraceKey } from "./modeltrace-store";

export async function adoptLegacyModelTraceNarrators(): Promise<void> {
	const rows = await db
		.select({ id: narrators.id, model: narrators.model })
		.from(narrators)
		.where(
			and(
				isNull(narrators.modeltraceKey),
				sql`COALESCE(${narrators.traits}, '[]') LIKE '%"modeltrace"%'`,
			),
		)
		.orderBy(desc(narrators.updatedAt));

	if (rows.length === 0) return;

	const claimed = new Set<string>();
	let adopted = 0;
	for (const row of rows) {
		let key: string | undefined;
		try {
			const resolved = resolveProviderAndModel(row.model ?? undefined);
			key = modelTraceKey(resolved.provider, resolved.model);
		} catch {
			// 供应商已不存在：保留为纯历史，只隐藏。
		}
		// 最新的一条（已按 updatedAt 倒序）成为该模型的舱；其余只隐藏。
		const claim = key && !claimed.has(key) ? key : undefined;
		if (claim) claimed.add(claim);
		await db
			.update(narrators)
			.set({ hiddenFromLists: true, ...(claim ? { modeltraceKey: claim } : {}) })
			.where(eq(narrators.id, row.id));
		if (claim) adopted++;
	}

	logger.info("Adopted legacy ModelTrace narrators", {
		total: rows.length,
		adopted,
		hiddenOnly: rows.length - adopted,
	});
}
