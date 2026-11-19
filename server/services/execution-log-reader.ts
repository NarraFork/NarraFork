import type { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { narratorToolCalls } from "../db/schema";

/** The bounded recent metadata window, never tool input/output bodies. */
export function readExecutionLogFacetsTask(
	client: Database,
	_input: Record<string, never>,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	const database = drizzle(client);
	return database
		.select({ toolName: sql<string | null>`tool_name`, provider: sql<string | null>`provider` })
		.from(sql`(SELECT ${narratorToolCalls.toolName} AS tool_name, ${narratorToolCalls.provider} AS provider
			FROM ${narratorToolCalls} ORDER BY ${narratorToolCalls.startedAt} DESC, ${narratorToolCalls.id} DESC
			LIMIT 20000) AS recent`)
		.groupBy(sql`tool_name`, sql`provider`)
		.all();
}
