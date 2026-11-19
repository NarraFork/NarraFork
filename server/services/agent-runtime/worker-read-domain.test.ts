import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { readDomainTask } from "@server/db/worker-read";
import { splitEnvelope } from "@shared/narrator-blocks/storage";
import { cleanDb } from "../../../tests/setup";
import { closeRuntimeTestDb, getRuntimeTestDb } from "../__tests__/agent-runtime-test-database";
import {
	MODEL_HISTORY_REVISION_CONTRACT,
	MODEL_HISTORY_SQLITE_TRIGGERS,
} from "./model-history-revision-sql";
import { publicationDedupeKey } from "./publication-key";
import type { PublicationRun } from "./publication-outbox";

const { sqlite, ready } = getRuntimeTestDb();
await ready;
const strict = { executionPolicy: "worker-required" as const, timeoutMs: 30_000 };
const run: PublicationRun = {
	producerKind: "agent",
	taskId: "child",
	logicalRunId: "run-a",
	recipientId: "parent",
};
beforeEach(() => {
	cleanDb(sqlite);
	sqlite.run(
		"INSERT INTO model_history_revision_contracts(id,installed_version) VALUES ('model-history',?)",
		[MODEL_HISTORY_REVISION_CONTRACT],
	);
	sqlite.run("INSERT INTO narrators(id,created_at,updated_at) VALUES ('parent','now','now')");
	sqlite.run(
		"INSERT INTO narrators(id,logical_run_id,status,parent_narrator_id,created_at,updated_at) VALUES ('child','run-a','idle','parent','now','now')",
	);
});
afterAll(() => closeRuntimeTestDb(sqlite));

function forbidOwnerReads() {
	const query = spyOn(sqlite, "query").mockImplementation(() => {
		throw new Error("Owner connection SELECT is forbidden");
	});
	const prepare = spyOn(sqlite, "prepare").mockImplementation(() => {
		throw new Error("Owner connection SELECT preparation is forbidden");
	});
	return () => {
		query.mockRestore();
		prepare.mockRestore();
		expect(query).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
	};
}

function reserve() {
	sqlite.run(
		"INSERT INTO runtime_publication_outbox(id,producer_kind,task_id,logical_run_id,recipient_id,event_kind,state,result_ref,summary,dedupe_key,delivery_id,created_at,updated_at) VALUES ('intent','agent','child','run-a','parent','terminal','reserved','source_after:0','',?,'delivery','now','now')",
		[publicationDedupeKey(run, "terminal")],
	);
}

function body(id: string, text: string, seq: number) {
	const [block] = splitEnvelope({
		id,
		narratorId: "child",
		role: "assistant",
		contentJson: [{ type: "text", text }],
		contentText: text,
		parentToolUseId: null,
	}).blocks;
	if (!block) throw new Error("Rows-only fixture requires a stored block");
	sqlite.run(
		"INSERT INTO narrator_messages(id,narrator_id,role,content_json,content_text,body_format,body_rows_only,created_at) VALUES (?,'child','assistant','[]','',2,1,'now')",
		[id],
	);
	sqlite.run(
		"INSERT INTO narrator_blocks(id,message_id,ordinal,kind,subtype,phase,model_text,payload,state,created_at) VALUES (?,?,0,?,?,?,?,?,?,'now')",
		[
			`block:${id}`,
			id,
			block.kind,
			block.subtype,
			block.phase,
			block.modelText,
			JSON.stringify(block.payload),
			block.state ? JSON.stringify(block.state) : null,
		],
	);
	sqlite.run(
		"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES (?,'child',?,?)",
		[`ref:${id}`, id, seq],
	);
}

test("publication Worker reads rows-only bodies without touching the owner connection", async () => {
	reserve();
	body("current", "ROWS ONLY RESULT", 1);
	const restore = forbidOwnerReads();
	try {
		expect(
			await readDomainTask(
				sqlite,
				"publicationTerminalResult",
				{
					run,
					options: { settledRunId: run.logicalRunId },
				},
				strict,
			),
		).toEqual({ output: "ROWS ONLY RESULT", sourceResultRef: "message:current" });
	} finally {
		restore();
	}
});

test("publication snapshot cannot project another run during WAL replacement", async () => {
	reserve();
	body("original", "RUN A", 1);
	const writer = new Database(sqlite.filename);
	writer.run("PRAGMA busy_timeout=0");
	let alternate = false;
	const write = writer.transaction(() => {
		alternate = !alternate;
		writer.run("UPDATE narrators SET logical_run_id=? WHERE id='child'", [
			alternate ? "run-b" : "run-a",
		]);
		writer.run("DELETE FROM narrator_message_refs WHERE id='ref:other'");
		writer.run("DELETE FROM narrator_blocks WHERE message_id='other'");
		writer.run("DELETE FROM narrator_messages WHERE id='other'");
		if (alternate) {
			writer.run(
				"INSERT INTO narrator_messages(id,narrator_id,role,content_json,content_text,created_at) VALUES ('other','child','assistant','[]','PRIVATE RUN B','now')",
			);
			writer.run(
				"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES ('ref:other','child','other',2)",
			);
		}
	});
	const restore = forbidOwnerReads();
	const timer = setInterval(write, 1);
	try {
		for (let i = 0; i < 15; i++) {
			const result = await readDomainTask(
				sqlite,
				"publicationTerminalResult",
				{
					run,
					options: { settledRunId: run.logicalRunId },
				},
				strict,
			);
			expect(result === null || result.output === "RUN A").toBe(true);
		}
	} finally {
		clearInterval(timer);
		writer.close();
		restore();
	}
});

test("signature trust requires every current block/model trigger", async () => {
	const signature = await readDomainTask(
		sqlite,
		"modelHistorySignature",
		{ narratorId: "child" },
		strict,
	);
	expect(signature.trusted).toBe(true);
	const trigger = MODEL_HISTORY_SQLITE_TRIGGERS.find((name) => name.includes("block"));
	if (!trigger) throw new Error("Current history contract must cover block writes");
	const definition = sqlite
		.query<{ sql: string }, [string]>(
			"SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?",
		)
		.get(trigger);
	if (!definition) throw new Error("Missing fixture trigger");
	try {
		sqlite.run(`DROP TRIGGER "${trigger}"`);
		expect(
			(await readDomainTask(sqlite, "modelHistorySignature", { narratorId: "child" }, strict))
				.trusted,
		).toBe(false);
	} finally {
		sqlite.run(definition.sql);
	}
});
