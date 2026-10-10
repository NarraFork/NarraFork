/**
 * 删除用户前，先释放指向它、但在已部署数据库里没有级联的外键。
 *
 * 为什么必须在代码里做：本仓的构建只从 schema 派生一份 `CREATE TABLE IF NOT EXISTS`
 * 基线，能补建表与索引，**无法重建已有表**，所以改 schema 上的 onDelete 对线上库无效。
 *
 * 五个列实际是 NO ACTION，其中两个（`projects.owner_user_id`、
 * `gateway_session_mappings.app_user_id`）是迁移过程把 schema 已声明的 `set null`
 * 弄丢了，另外三个（`narrator_messages.created_by/edited_by`、
 * `user_plugin_themes.user_id`）从未声明过。
 *
 * 语义沿用既有先例：可空归属列置空（消息与项目都保留，只丢掉“由谁触发”的展示归属），
 * 与 `narrators.owner_user_id` 一样让对象在没有 owner 的情况下继续存在；NOT NULL 的
 * 个人偏好只能删行。
 */

import { eq } from "drizzle-orm";
import type { db } from "../db";
import { gatewaySessionMappings, narratorMessages, projects, userPluginThemes } from "../db/schema";

/** Transaction handle as produced by `db.transaction((tx) => …)`. SQLite-side only. */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function releaseUserForeignKeys(tx: DbTransaction, userId: string): void {
	// 四列都可空且已建索引，置空是 O(匹配行) 而不是全表扫描。
	tx.update(narratorMessages)
		.set({ createdBy: null })
		.where(eq(narratorMessages.createdBy, userId))
		.run();
	tx.update(narratorMessages)
		.set({ editedBy: null })
		.where(eq(narratorMessages.editedBy, userId))
		.run();
	tx.update(projects).set({ ownerUserId: null }).where(eq(projects.ownerUserId, userId)).run();
	tx.update(gatewaySessionMappings)
		.set({ appUserId: null })
		.where(eq(gatewaySessionMappings.appUserId, userId))
		.run();
	// user_plugin_themes.user_id 是 NOT NULL，没有可空形态，只能连带主题偏好一起删。
	tx.delete(userPluginThemes).where(eq(userPluginThemes.userId, userId)).run();
}
