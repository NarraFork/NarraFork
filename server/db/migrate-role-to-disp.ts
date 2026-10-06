import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { db } from "./index";
import { narratorMessages } from "./schema";

/**
 * 将现有 role='system' 的消息迁移为 role='disp'
 * 这是一次性迁移脚本，在部署时手动执行
 */
export async function migrateSystemToDisp() {
	await db
		.update(narratorMessages)
		.set({ role: "disp" })
		.where(eq(narratorMessages.role, "system"));

	logger.info("Migrated role='system' to role='disp'");
}

// 如果直接运行此文件，执行迁移
if (import.meta.main) {
	await migrateSystemToDisp();
	process.exit(0);
}
