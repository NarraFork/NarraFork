// ModelTrace 舱的存取：每个用户、每个模型一个叙述者。它不进列表，只能凭 id 打开。
//
// 单独成模块是为了把 SQL 与探测流程分开：探测侧要能在没有真实数据库的测试里跑。

import { db } from "@server/db";
import {
	aclGrants,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "@server/db/schema";
import { resolveProviderAndModel } from "@server/lib/agent/provider";
import { addTrait, parseTraits } from "@server/lib/narrator-utils";
import { and, eq, inArray, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

const otherRefs = alias(narratorMessageRefs, "other_refs");

/** 不透明绑定键。调用方不要拆它；同一身份只通过 `modelTraceKeyFor` 生成。 */
export function modelTraceKey(userId: string, provider: string, model: string): string {
	return ["v1", userId, provider, model].map((part) => encodeURIComponent(part)).join("/");
}

/** 写入、收编、查找共用这一次解析，避免模型串的两种写法对上两个舱。 */
export function modelTraceKeyFor(userId: string, model: string, stickyProvider?: string): string {
	const resolved = resolveProviderAndModel(model, stickyProvider);
	return modelTraceKey(userId, resolved.provider, resolved.model);
}

async function narratorIdForKey(key: string): Promise<string | null> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.modeltraceKey, key),
		columns: { id: true },
	});
	return row?.id ?? null;
}

function isKeyConflict(error: unknown): boolean {
	return error instanceof Error && error.message.includes("narrators.modeltrace_key");
}

/**
 * 取该用户这个模型的舱，没有就建一个。
 *
 * 首次创建沿用 `forkNarrator`，带上源会话的工作目录、系统提示词、权限模式与模型。
 * 舱本身收成所有者私有：源会话后来被分享时，诊断记录不跟着公开。
 */
export async function ensureTraceNarrator(input: {
	parentId: string;
	userId: string;
	provider: string;
	model: string;
	title: string;
	locale: string;
}): Promise<string> {
	const key = modelTraceKeyFor(input.userId, input.model, input.provider);
	const existing = await narratorIdForKey(key);
	if (existing) {
		await retarget(existing, input);
		return existing;
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
	try {
		seal(created.id, key, input.userId, input.parentId, created.traits);
	} catch (error) {
		if (!isKeyConflict(error)) throw error;
		await narratorService.remove(created.id);
		const winner = await narratorIdForKey(key);
		if (!winner) throw error;
		await retarget(winner, input);
		return winner;
	}
	return created.id;
}

function seal(id: string, key: string, userId: string, parentId: string, traits: unknown): void {
	db.transaction((tx) => {
		tx.delete(aclGrants)
			.where(and(eq(aclGrants.scopeType, "narrator"), eq(aclGrants.scopeId, id)))
			.run();
		tx.update(narrators)
			.set({
				traits: addTrait(parseTraits(traits), "modeltrace"),
				parentNarratorId: parentId,
				ownerUserId: userId,
				visibility: "private",
				writeAudience: "owner",
				hiddenFromLists: true,
				modeltraceKey: key,
			})
			.where(eq(narrators.id, id))
			.run();
	});
}

async function retarget(
	id: string,
	input: { parentId: string; model: string; title: string },
): Promise<void> {
	const parent = await db.query.narrators.findFirst({
		where: eq(narrators.id, input.parentId),
		columns: { cwd: true, contextProjectId: true },
	});
	await db
		.update(narrators)
		.set({
			model: input.model,
			title: input.title,
			parentNarratorId: input.parentId,
			cwd: parent?.cwd ?? null,
			contextProjectId: parent?.contextProjectId ?? null,
		})
		.where(eq(narrators.id, id));
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
