// ModelTrace 舱的存取：一个模型一个叙述者，它不进叙述者列表，只能凭 id 打开。
//
// 单独成模块是为了把 SQL 与探测流程分开：探测侧要能在没有真实数据库的测试里跑，
// 这里的每条语句都是围绕 narrators / narrator_message_refs 的短事务。

import { db } from "@server/db";
import { narratorMessageRefs, narratorMessages, narrators } from "@server/db/schema";
import { addTrait, parseTraits } from "@server/lib/narrator-utils";
import { and, eq } from "drizzle-orm";

/** 绑定键：探测实际使用的 provider 与解析后的模型名。 */
export function modelTraceKey(provider: string, model: string): string {
	return `${provider}::${model}`;
}

/**
 * 取该模型的舱，没有就建一个。
 *
 * 首次创建沿用 `forkNarrator`：它会把源会话的工作目录、系统提示词、权限模式与模型
 * 一起带过来，探测的请求快照也因此和源会话一致。之后同一模型只复用，不再新建。
 */
export async function ensureTraceNarrator(input: {
	parentId: string;
	key: string;
	title: string;
	model: string;
	userId: string;
	locale: string;
}): Promise<string> {
	const existing = await db.query.narrators.findFirst({
		where: eq(narrators.modeltraceKey, input.key),
		columns: { id: true },
	});
	if (existing) {
		// 同一个键下模型名可能只是大小写或前缀写法不同，跟着最近一次请求更新。
		await db.update(narrators).set({ model: input.model }).where(eq(narrators.id, existing.id));
		return existing.id;
	}

	const { narratorService } = await import("./narrator-service");
	const created = await narratorService.forkNarrator(input.parentId, null, {
		title: input.title,
		model: input.model,
		inheritMode: "fresh",
		specCarryover: "clear",
		userId: input.userId,
		locale: input.locale,
	});
	await db
		.update(narrators)
		.set({
			traits: addTrait(parseTraits(created.traits), "modeltrace"),
			parentNarratorId: input.parentId,
			hiddenFromLists: true,
			modeltraceKey: input.key,
		})
		.where(eq(narrators.id, created.id));
	return created.id;
}

/**
 * 清空舱的历史，只保留下一次探测的结果。
 *
 * 消息行可能与 fork 出去的其它叙述者共享：先删自己的 refs，再删没有任何 ref 的消息行，
 * 这样别的会话不会因为这里清历史而丢内容。
 */
export async function clearTraceHistory(id: string): Promise<void> {
	db.transaction((tx) => {
		const messageIds = new Set(
			tx
				.select({ messageId: narratorMessageRefs.messageId })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, id))
				.all()
				.map((row) => row.messageId),
		);
		tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, id)).run();
		for (const messageId of messageIds) {
			const otherRef = tx
				.select({ id: narratorMessageRefs.id })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.messageId, messageId))
				.limit(1)
				.all();
			if (otherRef.length === 0) {
				tx.delete(narratorMessages).where(eq(narratorMessages.id, messageId)).run();
			}
		}
		tx.update(narrators)
			.set({
				nextSeq: 0,
				apiConversationId: null,
				contextUsageSnapshotJson: null,
				status: "idle",
			})
			.where(eq(narrators.id, id))
			.run();
	});
}

/** 该模型的舱 id；没有跑过 /modeltrace 时为 null，按钮据此提示先运行一次。 */
export async function findModelTraceNarrator(
	provider: string,
	model: string,
): Promise<string | null> {
	const row = await db.query.narrators.findFirst({
		where: and(eq(narrators.modeltraceKey, modelTraceKey(provider, model))),
		columns: { id: true },
	});
	return row?.id ?? null;
}
