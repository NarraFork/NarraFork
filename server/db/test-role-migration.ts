/**
 * 测试脚本：验证新的消息角色系统
 */

import { eq } from "drizzle-orm";
import { db } from "./index";
import { narratorMessages } from "./schema";

async function testRoleMigration() {
	console.log("Testing role migration...\n");

	// 1. 检查是否有旧的 role='system' 消息
	const oldSystemMessages = await db
		.select()
		.from(narratorMessages)
		.where(eq(narratorMessages.role, "system"))
		.limit(5);

	console.log(`Found ${oldSystemMessages.length} messages with role='system'`);
	if (oldSystemMessages.length > 0) {
		console.log("Sample:", oldSystemMessages[0]);
		console.log("\n⚠️  Warning: Old role='system' messages still exist.");
		console.log("   Run: bun server/db/migrate-role-to-disp.ts");
	}

	// 2. 检查新的 role='disp' 消息
	const dispMessages = await db
		.select()
		.from(narratorMessages)
		.where(eq(narratorMessages.role, "disp"))
		.limit(5);

	console.log(`\nFound ${dispMessages.length} messages with role='disp'`);
	if (dispMessages.length > 0) {
		console.log("Sample:", dispMessages[0]);
	}

	// 3. 检查新的 role='sys' 消息
	const sysMessages = await db
		.select()
		.from(narratorMessages)
		.where(eq(narratorMessages.role, "sys"))
		.limit(5);

	console.log(`\nFound ${sysMessages.length} messages with role='sys'`);
	if (sysMessages.length > 0) {
		console.log("Sample:", sysMessages[0]);
	}

	// 4. 统计各角色消息数量
	const allMessages = await db.select().from(narratorMessages);
	const roleCounts = allMessages.reduce(
		(acc, msg) => {
			acc[msg.role] = (acc[msg.role] || 0) + 1;
			return acc;
		},
		{} as Record<string, number>,
	);

	console.log("\n=== Role Distribution ===");
	for (const [role, count] of Object.entries(roleCounts)) {
		console.log(`  ${role}: ${count}`);
	}

	console.log("\n✅ Test complete");
}

if (import.meta.main) {
	await testRoleMigration();
	process.exit(0);
}
