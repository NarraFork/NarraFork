// 兼容改造前的 ModelTrace 数据。
//
// 旧实现每次 /modeltrace 都 fork 一个新的 primary 叙述者。启动时收编一次：
// 每个用户、每个能解析的模型，最近的一条成为舱；其余只隐藏。
// 解析不了或没有所有者的行写成 `legacy/<id>`，下一轮启动不再扫到它们。

import { activeDatabaseBackend, db } from "@server/db";
import { aclGrants, narrators, userRecentTabs } from "@server/db/schema";
import { logger } from "@server/lib/logger";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { modelTraceKeyFor } from "./modeltrace-store";

export async function adoptLegacyModelTraceNarrators(): Promise<void> {
	if (activeDatabaseBackend !== "sqlite") return;

	const rows = await db
		.select({
			id: narrators.id,
			model: narrators.model,
			ownerUserId: narrators.ownerUserId,
		})
		.from(narrators)
		.where(
			and(
				isNull(narrators.modeltraceKey),
				sql`COALESCE(${narrators.traits}, '[]') LIKE '%"modeltrace"%'`,
			),
		)
		.orderBy(desc(narrators.updatedAt), desc(narrators.id));

	if (rows.length === 0) return;

	// 上一轮收编写到一半时，键已经在库里。这轮只给还空着的行补墓碑，不再抢同一个键。
	const claimed = new Set<string>();
	const existing = await db
		.select({ key: narrators.modeltraceKey })
		.from(narrators)
		.where(isNotNull(narrators.modeltraceKey));
	for (const row of existing) {
		if (row.key) claimed.add(row.key);
	}
	let adopted = 0;
	for (const row of rows) {
		let key = `legacy/${row.id}`;
		let claim = false;
		if (row.ownerUserId && row.model) {
			try {
				const candidate = modelTraceKeyFor(row.ownerUserId, row.model);
				if (!claimed.has(candidate)) {
					claimed.add(candidate);
					key = candidate;
					claim = true;
					adopted++;
				}
			} catch {
				// 供应商已不存在：只隐藏。
			}
		}
		await db
			.update(narrators)
			.set({
				hiddenFromLists: true,
				modeltraceKey: key,
				...(claim ? { visibility: "private" as const, writeAudience: "owner" as const } : {}),
			})
			.where(eq(narrators.id, row.id));
		if (claim) {
			await db
				.delete(aclGrants)
				.where(and(eq(aclGrants.scopeType, "narrator"), eq(aclGrants.scopeId, row.id)));
		}
	}

	const ids = rows.map((row) => row.id);
	await db
		.delete(userRecentTabs)
		.where(
			and(
				inArray(userRecentTabs.type, ["narrator", "subagent"]),
				or(
					inArray(userRecentTabs.entityId, ids),
					inArray(userRecentTabs.representedNarratorId, ids),
				),
			),
		);

	logger.info("Adopted legacy ModelTrace narrators", {
		total: rows.length,
		adopted,
		hiddenOnly: rows.length - adopted,
	});
}
