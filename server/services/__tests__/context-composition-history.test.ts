import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ContextSegment } from "@shared/context-composition";
import {
	CONTEXT_COMPOSITION_LIMITS,
	readContextHistory,
	readContextHistoryEntries,
} from "../context-composition-history";

let database: Database;
let reads: string[];
let counted: Database;
let maxReadMs: number;
beforeEach(() => {
	database = new Database(":memory:");
	// Bodies are deliberately absent; fixtures cannot accidentally materialize them.
	database.run(`CREATE TABLE narrator_message_refs (narrator_id TEXT, message_id TEXT, seq INTEGER, is_compact INTEGER DEFAULT 0, segment_compact_id TEXT);
	 CREATE INDEX refs_seq ON narrator_message_refs(narrator_id,seq);
	 CREATE UNIQUE INDEX refs_message ON narrator_message_refs(narrator_id,message_id);
	 CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, role TEXT, parent_tool_use_id TEXT, context_chars_json TEXT);
	 CREATE TABLE narrator_tool_calls (id TEXT PRIMARY KEY, narrator_id TEXT, message_id TEXT, tool_use_id TEXT, execution_attempt INTEGER DEFAULT 0, created_at TEXT DEFAULT '2026-01-01', input_chars INTEGER DEFAULT 0, output_chars INTEGER DEFAULT 0);
	 CREATE INDEX tools_message ON narrator_tool_calls(message_id);
	 CREATE INDEX tools_use ON narrator_tool_calls(tool_use_id);
	 CREATE UNIQUE INDEX tools_attempt ON narrator_tool_calls(narrator_id,tool_use_id,message_id,execution_attempt);`);
	reads = [];
	maxReadMs = 0;
	counted = new Proxy(database, {
		get(target, key) {
			if (key === "query")
				return (sql: string) => {
					reads.push(sql);
					expect(sql).toContain("LIMIT");
					expect(sql).not.toMatch(/content_json|input_json|output_json/);
					const statement = target.query(sql);
					return new Proxy(statement, {
						get(prepared, method) {
							if (method === "all")
								return (...bindings: (string | number)[]) => {
									const limit = bindings[bindings.length - 1];
									expect(typeof limit).toBe("number");
									expect(limit as number).toBeLessThanOrEqual(CONTEXT_COMPOSITION_LIMITS.toolBatch);
									const started = performance.now();
									const result = prepared.all(...bindings);
									maxReadMs = Math.max(maxReadMs, performance.now() - started);
									expect(result.length).toBeLessThanOrEqual(limit as number);
									return result;
								};
							const value = Reflect.get(prepared, method);
							return typeof value === "function" ? value.bind(prepared) : value;
						},
					});
				};
			return Reflect.get(target, key);
		},
	});
});
afterEach(() => database.close());
function message(
	id: string,
	seq: number,
	segments: ContextSegment[] | null = null,
	role = "assistant",
) {
	database
		.query("INSERT INTO narrator_messages(id,role,context_chars_json) VALUES (?,?,?)")
		.run(id, role, segments === null ? null : JSON.stringify({ segments }));
	database
		.query("INSERT INTO narrator_message_refs(narrator_id,message_id,seq) VALUES ('n',?,?)")
		.run(id, seq);
}
function tool(
	id: string,
	call: string,
	attempt: number,
	time: string,
	input = 1,
	output = 2,
	owner = "n",
	messageId = "m",
) {
	database
		.query(
			`INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,execution_attempt,created_at,input_chars,output_chars) VALUES (?,?,?,?,?,?,?,?)`,
		)
		.run(id, owner, messageId, call, attempt, time, input, output);
}
async function segments(options: { profile?: "primary" | "subagent"; check?: () => void } = {}) {
	return Array.fromAsync(
		readContextHistory(counted, "n", { profile: "primary", check: () => {}, ...options }),
	);
}

test("1000 legacy NULL messages use bounded batch reads, not per-message SQL/checks", async () => {
	const insert = database.transaction(() => {
		for (let i = 0; i < 1000; i++) message(`m${i}`, i);
	});
	insert();
	let checks = 0;
	const started = performance.now();
	expect(
		await segments({
			check: () => {
				checks++;
			},
		}),
	).toEqual([]);
	const elapsed = performance.now() - started;
	expect(reads.length).toBeLessThanOrEqual(100);
	expect(checks).toBeLessThanOrEqual(150);
	console.info(
		`1000 legacy history: ${elapsed.toFixed(1)}ms, ${reads.length} SQL, ${checks} checks`,
	);
});

test("bulk attempts and marker order preserve cross-narrator latest identity and result packet", async () => {
	message("m", 1, [
		{ category: "assistant", chars: 2 },
		{ category: "toolCall", chars: 0, toolUseId: "second" },
		{ category: "attachment", chars: 5 },
		{ category: "toolCall", chars: 0, toolUseId: "first" },
		{ category: "toolCall", chars: 99, toolUseId: "second" },
		{ category: "toolResult", chars: 999 },
	]);
	tool("a", "first", 0, "1", 11, 13);
	tool("b", "second", 0, "2", 100, 200);
	tool("c", "second", 1, "3", 17, 19, "different-narrator");
	tool("d", "unmarked", 0, "4", 23, 29);
	tool("e", "unmarked", 0, "4", 31, 37, "another-narrator");
	expect(await segments()).toEqual([
		{ category: "assistant", chars: 2 },
		{ category: "toolCall", chars: 17 },
		{ category: "attachment", chars: 5 },
		{ category: "toolCall", chars: 11 },
		{ category: "toolCall", chars: 31 },
		{ category: "toolResult", chars: 13 },
		{ category: "toolResult", chars: 19 },
		{ category: "toolResult", chars: 37 },
	]);
	expect(reads.filter((sql) => sql.includes("FROM narrator_tool_calls"))).toHaveLength(1);
});

test("targeted entries emit hidden/display/excluded/before-compact empties and omit missing refs", async () => {
	message("old", 1, [{ category: "user", chars: 90 }]);
	message("compact", 2, [{ category: "summary", chars: 100 }], "system");
	database.run("UPDATE narrator_message_refs SET is_compact=1 WHERE message_id='compact'");
	message("hidden", 3, [{ category: "user", chars: 80 }]);
	database.run(
		"UPDATE narrator_message_refs SET segment_compact_id='summary' WHERE message_id='hidden'",
	);
	message("display", 4, [{ category: "other", chars: 70 }], "disp");
	message("child", 5, [{ category: "assistant", chars: 60 }]);
	database.run("UPDATE narrator_messages SET parent_tool_use_id='parent' WHERE id='child'");
	message(
		"summary",
		6,
		[
			{ category: "summary", chars: 5 },
			{ category: "other", chars: 55 },
		],
		"system",
	);
	message("sys", 7, [{ category: "system", chars: 7 }], "sys");
	const entries = await Array.fromAsync(
		readContextHistoryEntries(counted, "n", {
			profile: "primary",
			check: () => {},
			messageIds: ["old", "compact", "hidden", "display", "child", "summary", "sys", "missing"],
		}),
	);
	expect(entries.map((entry) => [entry.messageId, entry.segments])).toEqual([
		["old", []],
		["compact", []],
		["hidden", []],
		["display", []],
		["child", []],
		["summary", [{ category: "summary", chars: 5 }]],
		["sys", [{ category: "system", chars: 7 }]],
	]);
	expect(await segments({ profile: "subagent" })).toEqual([
		{ category: "assistant", chars: 60 },
		{ category: "summary", chars: 5 },
		{ category: "system", chars: 7 },
	]);
});

test("linked child compact cannot advance primary boundary; tail reader skips old refs", async () => {
	message("top", 1, [{ category: "user", chars: 3 }]);
	message("child", 2, [], "system");
	database.run(`UPDATE narrator_message_refs SET is_compact=1 WHERE message_id='child';
	 UPDATE narrator_messages SET parent_tool_use_id='parent' WHERE id='child'`);
	message("last", 3, [{ category: "assistant", chars: 5 }]);
	expect(await segments()).toEqual([
		{ category: "user", chars: 3 },
		{ category: "assistant", chars: 5 },
	]);
	const entries = await Array.fromAsync(
		readContextHistoryEntries(counted, "n", { profile: "primary", check: () => {}, afterSeq: 2 }),
	);
	expect(entries.map((entry) => entry.messageId)).toEqual(["last"]);
});

test("5000 tools and large interleaved markers use bounded fallback without losing order", async () => {
	const count = 5000;
	const metadata: ContextSegment[] = [];
	for (let i = count - 1; i >= 0; i--) {
		metadata.push(
			{ category: "assistant", chars: i + 1 },
			{ category: "toolCall", chars: 0, toolUseId: `call${i}` },
		);
	}
	metadata.push({ category: "toolCall", chars: 0, toolUseId: "call0" });
	message("m", 1, metadata);
	database.transaction(() => {
		for (let i = 0; i < count; i++) {
			const id = String(i).padStart(5, "0");
			tool(id, `call${i}`, 0, id, i + 1, i + 2);
		}
		tool("latest", "call0", 1, "00000", 777, 888, "other");
	})();
	const started = performance.now();
	const result = await segments();
	console.info(
		`5000 tool fallback: ${(performance.now() - started).toFixed(1)}ms, ${reads.length} SQL`,
	);
	expect(result).toHaveLength(count * 3);
	for (let i = 0; i < count; i++) {
		const n = count - 1 - i;
		expect(result[i * 2]).toEqual({ category: "assistant", chars: n + 1 });
		expect(result[i * 2 + 1]).toEqual({ category: "toolCall", chars: n === 0 ? 777 : n + 1 });
		expect(result[count * 2 + i]).toEqual({ category: "toolResult", chars: i === 0 ? 888 : i + 2 });
	}
	const fallback = reads.find((sql) => sql.includes("(t.created_at, t.id) >"));
	expect(fallback).toBeDefined();
	const plan = database
		.query(`EXPLAIN QUERY PLAN ${fallback}`)
		.all("m", "", "", CONTEXT_COMPOSITION_LIMITS.toolBatch);
	console.info("5000 tools production-index plan:", JSON.stringify(plan));
	expect(reads.some((sql) => sql.includes("WITH requested(tool_use_id)"))).toBe(true);
	expect(reads.filter((sql) => sql.includes("(t.message_id, t.id) >"))).toHaveLength(
		CONTEXT_COMPOSITION_LIMITS.toolCache / CONTEXT_COMPOSITION_LIMITS.toolBatch + 1,
	);
});

test("legacy large unmarked tool rows retain all calls before all results; fallback can cancel", async () => {
	message("m", 1);
	database.transaction(() => {
		for (let i = 0; i < 1500; i++) {
			const id = String(i).padStart(5, "0");
			tool(id, `call${i}`, 0, id, i + 1, i + 2);
		}
	})();
	const result = await segments();
	expect(result).toHaveLength(3000);
	for (let i = 0; i < 1500; i++) {
		expect(result[i]).toEqual({ category: "toolCall", chars: i + 1 });
		expect(result[i + 1500]).toEqual({ category: "toolResult", chars: i + 2 });
	}
	reads.length = 0;
	let fallbackChecks = 0;
	await expect(
		segments({
			check: () => {
				if (reads.some((sql) => sql.includes("(t.created_at, t.id) >")) && ++fallbackChecks > 2) {
					throw new Error("cancel fallback");
				}
			},
		}),
	).rejects.toThrow("cancel fallback");
});

test("actual common/fallback SQL needs message-leading indexes under large global call-ID collisions", async () => {
	message("m", 1);
	database.transaction(() => {
		for (let i = 0; i < 5000; i++) {
			const id = String(i).padStart(5, "0");
			tool(`m-${id}`, `unique-${id}`, 0, id);
		}
		// Many unrelated actors share one toolUseId, as real per-session provider IDs do.
		for (let i = 0; i < 10000; i++)
			tool(`foreign-${i}`, "shared-call", 0, "0", 1, 1, `actor${i}`, `foreign-message-${i}`);
		// One large message has 5000 attempts of that same globally-colliding call ID.
		for (let i = 0; i < 5000; i++)
			tool(
				`collision-${i}`,
				"shared-call",
				i,
				String(i).padStart(5, "0"),
				i + 1,
				i + 2,
				"n",
				"collision",
			);
	})();
	await segments();
	const actualCommon = reads.find((sql) => sql.includes("(t.message_id, t.id) >"));
	const actualFallback = reads.find((sql) => sql.includes("(t.created_at, t.id) >"));
	expect(actualCommon).toBeDefined();
	expect(actualFallback).toBeDefined();
	const ids = ["m", ...Array.from({ length: 63 }, (_, i) => `absent-${i}`)];
	const common = (actualCommon as string).replace("IN (?)", `IN (${ids.map(() => "?").join(",")})`);
	const originalCommon = common
		.replace("AND (t.message_id, t.id) > (?, ?)", "AND t.id > ?")
		.replace("ORDER BY t.message_id, t.id", "ORDER BY t.id");
	const commonBindings = [...ids, "", "", CONTEXT_COMPOSITION_LIMITS.toolBatch];
	const originalBindings = [...ids, "", CONTEXT_COMPOSITION_LIMITS.toolBatch];
	const collisionBindings = ["collision", "", "", CONTEXT_COMPOSITION_LIMITS.toolBatch];
	const plan = (sql: string, bindings: (string | number)[]) =>
		database
			.query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`)
			.all(...bindings)
			.map((row) => row.detail);
	const measure = (sql: string, bindings: (string | number)[]) => {
		const start = performance.now();
		const result = database.query(sql).all(...bindings);
		return { ms: performance.now() - start, result };
	};
	const measureWithHeartbeat = async (sql: string, bindings: (string | number)[]) => {
		const scheduled = performance.now();
		const heartbeat = new Promise<number>((resolve) => {
			setTimeout(() => resolve(performance.now() - scheduled), 0);
		});
		const result = measure(sql, bindings);
		return { ...result, heartbeatMs: await heartbeat };
	};
	const oldOriginalPlan = plan(originalCommon, originalBindings);
	const oldTuplePlan = plan(common, commonBindings);
	const oldCollisionPlan = plan(actualFallback as string, collisionBindings);
	const oldOriginal = measure(originalCommon, originalBindings);
	const oldTuple = measure(common, commonBindings);
	const oldCollision = await measureWithHeartbeat(actualFallback as string, collisionBindings);
	expect(oldCollision.result).toHaveLength(CONTEXT_COMPOSITION_LIMITS.toolBatch);
	expect(oldCollision.result.every((row) => (row as { isLatest: number }).isLatest === 0)).toBe(
		true,
	);
	// These indexes are fixture-only: no production schema or user database changes.
	database.run(`CREATE INDEX idx_toolcalls_context_id ON narrator_tool_calls(message_id,id);
	 CREATE INDEX idx_toolcalls_context_order ON narrator_tool_calls(message_id,created_at,id);
	 CREATE INDEX idx_toolcalls_context_latest ON narrator_tool_calls(message_id,tool_use_id,execution_attempt,created_at,id);`);
	const indexedTuplePlan = plan(common, commonBindings);
	const indexedCollisionPlan = plan(actualFallback as string, collisionBindings);
	const indexedTuple = measure(common, commonBindings);
	const indexedCollision = await measureWithHeartbeat(actualFallback as string, collisionBindings);
	expect(indexedTuple.result).toEqual(oldTuple.result);
	expect(indexedCollision.result).toEqual(oldCollision.result);
	expect(indexedTuplePlan.join("\n")).not.toContain("TEMP B-TREE");
	expect(indexedTuplePlan.join("\n")).toContain("idx_toolcalls_context_id");
	expect(indexedCollisionPlan.join("\n")).not.toContain("TEMP B-TREE");
	expect(indexedCollisionPlan.join("\n")).toContain("idx_toolcalls_context_latest");
	expect(indexedCollisionPlan.join("\n")).toContain("execution_attempt>?");
	message("collision", 2, [{ category: "toolCall", chars: 0, toolUseId: "shared-call" }]);
	const projectionStart = reads.length;
	maxReadMs = 0;
	const measuredProjection = await (async () => {
		let lastHeartbeat = performance.now();
		let maxHeartbeatMs = 0;
		let ticks = 0;
		const timer = setInterval(() => {
			const now = performance.now();
			maxHeartbeatMs = Math.max(maxHeartbeatMs, now - lastHeartbeat);
			lastHeartbeat = now;
			ticks++;
		}, 1);
		try {
			const entries = await Array.fromAsync(
				readContextHistoryEntries(counted, "n", {
					profile: "primary",
					check: () => {},
					messageIds: ["collision"],
				}),
			);
			return { entries, maxHeartbeatMs, ticks, maxSingleSqlMs: maxReadMs };
		} finally {
			clearInterval(timer);
		}
	})();
	// CI checks deterministic progression and heartbeat participation, not timing thresholds.
	expect(measuredProjection.ticks).toBeGreaterThan(0);
	expect(
		reads.slice(projectionStart).filter((sql) => sql.includes("(t.created_at, t.id) >")),
	).toHaveLength(Math.ceil(5000 / CONTEXT_COMPOSITION_LIMITS.toolBatch));
	expect(measuredProjection.entries[0].segments).toEqual([
		{ category: "toolCall", chars: 5000 },
		{ category: "toolResult", chars: 5001 },
	]);
	const markerQuery = reads.find((sql) => sql.includes("WITH requested(tool_use_id)"));
	expect(markerQuery).toBeDefined();
	const indexedMarkerPlan = plan(markerQuery as string, [
		"shared-call",
		"collision",
		CONTEXT_COMPOSITION_LIMITS.batch,
	]);
	expect(indexedMarkerPlan.join("\n")).not.toContain("TEMP B-TREE");
	expect(indexedMarkerPlan.join("\n")).toContain("idx_toolcalls_context_latest");
	console.info(
		"20k tools (5000 common / 10000 unrelated collisions / 5000 attempts) index evidence:",
		JSON.stringify({
			oldOriginalMs: oldOriginal.ms,
			oldTupleMs: oldTuple.ms,
			oldCollisionMs: oldCollision.ms,
			indexedTupleMs: indexedTuple.ms,
			indexedCollisionMs: indexedCollision.ms,
			oldCollisionHeartbeatMs: oldCollision.heartbeatMs,
			indexedCollisionHeartbeatMs: indexedCollision.heartbeatMs,
			indexedProjectionWorstSingleSqlMs: measuredProjection.maxSingleSqlMs,
			indexedProjectionWorstHeartbeatMs: measuredProjection.maxHeartbeatMs,
			indexedProjectionHeartbeatTicks: measuredProjection.ticks,
			oldOriginalPlan,
			oldTuplePlan,
			oldCollisionPlan,
			indexedTuplePlan,
			indexedCollisionPlan,
			indexedMarkerPlan,
		}),
	);
}, 30000);

test("cancellation and budget checks occur after yielding during large marker/tool projection", async () => {
	message(
		"m",
		1,
		Array.from({ length: 6000 }, () => ({ category: "assistant", chars: 1 })),
	);
	let cancelled = false;
	const timer = setTimeout(() => {
		cancelled = true;
	}, 0);
	await expect(
		segments({
			check: () => {
				if (cancelled) throw new Error("cancelled");
			},
		}),
	).rejects.toThrow("cancelled");
	clearTimeout(timer);
	let checks = 0;
	await expect(
		segments({
			check: () => {
				if (++checks > 5) throw new Error("budget");
			},
		}),
	).rejects.toThrow("budget");
});
