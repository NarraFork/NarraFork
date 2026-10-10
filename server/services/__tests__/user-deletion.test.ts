/**
 * 删除用户时，指向它的无级联外键必须先被释放。
 *
 * 背景：线上库里 `narrator_messages.created_by`、`projects.owner_user_id` 等五列仍是
 * NO ACTION，删除用户会直接 `FOREIGN KEY constraint failed`。本仓的构建只能派生
 * `CREATE TABLE IF NOT EXISTS` 基线、无法重建已有表，所以约束修不进线上库，清理只能
 * 发生在代码里——本测试固定的是清理后的最终状态。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
	gatewaySessionMappings,
	narratorMessages,
	narrators,
	projects,
	userPluginThemes,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { releaseUserForeignKeys } from "../user-deletion";

const now = "2026-10-10T00:00:00.000Z";
const userId = generateId();
const narratorId = generateId();
const projectId = generateId();
const messageId = generateId();
const themeId = generateId();
const mappingId = generateId();

beforeAll(async () => {
	await db.insert(users).values({
		id: userId,
		username: `doomed-${userId}`,
		passwordHash: "x",
		createdAt: now,
	});
	await db.insert(narrators).values({
		id: narratorId,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "default",
		permissionMode: "default",
		status: "idle",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(projects).values({
		id: projectId,
		name: "被删用户的项目",
		ownerUserId: userId,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "user",
		contentJson: [{ type: "text", text: "hi" }],
		createdBy: userId,
		editedBy: userId,
		createdAt: now,
	});
	await db
		.insert(userPluginThemes)
		.values({ id: themeId, userId, pluginId: "p", themeId: "t", createdAt: now, updatedAt: now });
	await db.insert(gatewaySessionMappings).values({
		id: mappingId,
		platform: "test",
		chatId: "c",
		userId: "platform-user",
		narratorId,
		appUserId: userId,
		createdAt: now,
		updatedAt: now,
	});
});

describe("releaseUserForeignKeys", () => {
	test("删除用户成功，且引用被释放而不是连带删掉对象", () => {
		const deleted = db.transaction((tx) => {
			releaseUserForeignKeys(tx, userId);
			return tx.delete(users).where(eq(users.id, userId)).returning().all();
		});

		expect(deleted).toHaveLength(1);
		expect(db.select().from(users).where(eq(users.id, userId)).all()).toHaveLength(0);

		// 消息与项目保留，只丢失归属。
		expect(
			db.select().from(projects).where(eq(projects.id, projectId)).get()?.ownerUserId,
		).toBeNull();
		const message = db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.id, messageId))
			.get();
		expect(message?.createdBy).toBeNull();
		expect(message?.editedBy).toBeNull();

		// 个人主题偏好没有可空形态，只能删行。
		expect(
			db.select().from(userPluginThemes).where(eq(userPluginThemes.id, themeId)).all(),
		).toHaveLength(0);

		// IM 会话映射保留，停用应用用户绑定。
		const mapping = db
			.select()
			.from(gatewaySessionMappings)
			.where(eq(gatewaySessionMappings.id, mappingId))
			.get();
		expect(mapping?.appUserId).toBeNull();
		expect(mapping?.narratorId).toBe(narratorId);
	});
});
