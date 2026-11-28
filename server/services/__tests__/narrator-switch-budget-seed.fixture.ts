import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { testEnvironment } from "../../../tests/preload";
import { db } from "../../db";
import { getDbPath } from "../../db/connection";
import { narratorMessageRefs, narratorMessages } from "../../db/schema";

export const switchBudgetMessageCount = 60;

/** Server-side message writer; the browser still reads real production block DTOs. */
export function seedSwitchBudgetMessages(narratorId: string, label: "A" | "B", now: string) {
	const home = realpathSync(testEnvironment.narraforkHome);
	if (process.env.NARRAFORK_TEST !== "1" || !resolve(getDbPath()).startsWith(`${home}${sep}`))
		throw new Error("Budget message seeding requires the preload-owned isolated test DB");
	for (let seq = 1; seq <= switchBudgetMessageCount; seq++) {
		const messageId = `${narratorId}-message-${seq}`;
		const text =
			seq === switchBudgetMessageCount
				? `BUDGET_BODY_${label}_TAIL`
				: `Necessary body ${seq}: ${"body content ".repeat(100)}`;
		db.insert(narratorMessages)
			.values({
				id: messageId,
				narratorId,
				role: seq % 2 ? "user" : "assistant",
				contentJson: [{ type: "text", text }],
				contentText: text,
				createdAt: now,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: `ref-${messageId}`, narratorId, messageId, seq })
			.run();
	}
}
