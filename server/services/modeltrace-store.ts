// ModelTrace 舱的存取：每个用户、每个模型一个叙述者。它不进列表，只能凭 id 打开。
//
// 单独成模块是为了把 SQL 与探测流程分开：探测侧要能在没有真实数据库的测试里跑。

import { db } from "@server/db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "@server/db/schema";
import { resolveProviderAndModel } from "@server/lib/agent/provider";
import { generateId } from "@server/lib/id";
import { and, eq, inArray, ne, notExists, sql } from "drizzle-orm";
import { aliasedTable } from "drizzle-orm/alias";

const otherRefs = aliasedTable(narratorMessageRefs, "other_refs");

/** 不透明绑定键。调用方不要拆它；同一身份只通过 `modelTraceKeyFor` 生成。 */
export function modelTraceKey(userId: string, provider: string, model: string): string {
	return ["v1", userId, provider, model].map((part) => encodeURIComponent(part)).join("/");
}

/** 写入、收编、查找共用这一次解析，避免模型串的两种写法对上两个舱。 */
export function modelTraceKeyFor(userId: string, model: string, stickyProvider?: string): string {
	const resolved = resolveProviderAndModel(model, stickyProvider);
	return modelTraceKey(userId, resolved.provider, resolved.model);
}

/** Standalone private diagnostics never copy the parent's row, grants, refs or workspace. */
export async function createDiagnosticNarrator(input: {
	userId: string;
	model: string;
	title: string;
	locale: string;
}): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		ownerUserId: input.userId,
		model: input.model,
		title: input.title,
		visibility: "private",
		writeAudience: "owner",
		hiddenFromLists: true,
		traits: ["modeltrace"],
		// Non-reusable key also keeps startup legacy adoption from claiming this row.
		modeltraceKey: `fork/${id}`,
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

async function narratorIdForKey(key: string): Promise<string | null> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.modeltraceKey, key),
		columns: { id: true },
	});
	return row?.id ?? null;
}

/** 只复用当前用户和当前模型的私有舱；不从触发会话继承设置、消息或工具。 */
export async function ensureTraceNarrator(input: {
	parentId: string;
	userId: string;
	provider: string;
	model: string;
	title: string;
	locale: string;
}): Promise<string> {
	const key = modelTraceKeyFor(input.userId, input.model, input.provider);
	const now = new Date().toISOString();
	const [row] = await db
		.insert(narrators)
		.values({
			id: generateId(),
			modeltraceKey: key,
			ownerUserId: input.userId,
			model: input.model,
			title: input.title,
			visibility: "private",
			writeAudience: "owner",
			hiddenFromLists: true,
			traits: ["modeltrace"],
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: narrators.modeltraceKey,
			set: { model: input.model, title: input.title },
		})
		.returning({ id: narrators.id });
	return row.id;
}

/**
 * 清空舱的历史。别的叙述者还引用着的消息只去掉本舱的 ref。
 *
 * 独占消息上的 tool call 没有级联删除，要先于消息行删掉。
 */
export async function clearTraceHistory(id: string): Promise<void> {
	db.transaction((tx) => {
		const exclusive = tx
			.select({ messageId: narratorMessageRefs.messageId })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, id),
					notExists(
						tx
							.select({ one: sql`1` })
							.from(otherRefs)
							.where(
								and(
									eq(otherRefs.messageId, narratorMessageRefs.messageId),
									ne(otherRefs.narratorId, id),
								),
							),
					),
				),
			)
			.all()
			.map((row) => row.messageId);

		if (exclusive.length > 0) {
			tx.update(narrators)
				.set({ forkMessageId: null })
				.where(inArray(narrators.forkMessageId, exclusive))
				.run();
			tx.delete(narratorToolCalls).where(inArray(narratorToolCalls.messageId, exclusive)).run();
		}
		tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, id)).run();
		if (exclusive.length > 0) {
			tx.delete(narratorMessages).where(inArray(narratorMessages.id, exclusive)).run();
		}
		tx.update(narrators)
			.set({
				nextSeq: 0,
				apiConversationId: null,
				systemPrompt: null,
				enabledTools: null,
				contextUsageSnapshotJson: null,
				errorMessage: null,
				substatus: "[]",
			})
			.where(eq(narrators.id, id))
			.run();
	});
}

/** 当前用户这个模型的舱；没有跑过时为 null。模型解析不了也是 null。 */
export async function findModelTraceNarrator(
	userId: string,
	rawModel: string,
): Promise<string | null> {
	try {
		return await narratorIdForKey(modelTraceKeyFor(userId, rawModel));
	} catch {
		return null;
	}
}
