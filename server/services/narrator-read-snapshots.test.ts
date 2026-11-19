import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanDb } from "../../tests/setup";
import { readDomainTask } from "../db/worker-read";
import { createDomainReadParams } from "../lib/db-worker/domain-protocol";
import { runDomainRead } from "../lib/db-worker/domain-task-registry";
import { readAborted } from "../lib/db-worker/errors";
import { bodyLengthSql, boundedBodyText } from "../lib/narrator-bodies";
import { getNarratorWorkerTestDb } from "./__tests__/narrator-worker-fixture";
import { readRevertSelectionBody, readRevertSelectionBodyVerify } from "./file-read-snapshots";
import {
	readNarratorBodyTextsSnapshot,
	readNarratorMessageRowsSnapshot,
} from "./narrator-message-snapshot-reader";

const fixture = getNarratorWorkerTestDb();
const { sqlite } = fixture;
const NOW = "2026-10-01T00:00:00.000Z";
beforeEach(() => {
	cleanDb(sqlite);
	sqlite.run("INSERT INTO narrators (id,title,created_at,updated_at) VALUES ('n','n',?,?)", [
		NOW,
		NOW,
	]);
});
afterAll(() => fixture.close());
function seed(id: string, content: unknown[], rowsOnly = true) {
	const body = JSON.stringify(content);
	sqlite.run(
		"INSERT INTO narrator_messages (id,narrator_id,role,content_json,body_format,body_rows_only,original_content_json,created_at) VALUES (?,'n','assistant',?,?,?,?,?)",
		[
			id,
			rowsOnly ? "[]" : body,
			rowsOnly ? 2 : 1,
			rowsOnly ? 1 : 0,
			JSON.stringify([{ type: "text", text: "original" }]),
			NOW,
		],
	);
	if (rowsOnly) {
		const payload = JSON.stringify({ raw: content });
		sqlite.run(
			"INSERT INTO narrator_blocks (id,message_id,ordinal,kind,phase,payload,byte_size,created_at) VALUES (?,?,0,'output','done',?,?,?)",
			[`block-${id}`, id, payload, Buffer.byteLength(payload), NOW],
		);
	}
	return body;
}

describe("explicit-connection body snapshots", () => {
	test("rows-only and legacy return the same source body and retain original output", () => {
		const body = seed("rows", [{ type: "text", text: "正文😀" }]);
		seed("legacy", [{ type: "text", text: "legacy" }], false);
		const snapshot = sqlite.transaction(() =>
			readNarratorMessageRowsSnapshot(sqlite, {
				messageIds: ["rows", "legacy"],
				includeTools: false,
				includeCreator: false,
			}),
		)();
		expect(snapshot.messages.find((row) => row.id === "rows")?.content_json).toBe(body);
		expect(JSON.parse(String(snapshot.messages[0].original_content_json))).toEqual([
			{ type: "text", text: "original" },
		]);
		expect(snapshot.messages.find((row) => row.id === "legacy")?.content_json).toBe(
			JSON.stringify([{ type: "text", text: "legacy" }]),
		);
	});

	test("byte gates measure assembled UTF-8, not content_json marker or UTF-16 length", () => {
		const body = seed("rows", [{ type: "text", text: "界😀" }]);
		const bytes = Buffer.byteLength(body);
		const measured = sqlite
			.query<{ bytes: number }, [string]>(
				`SELECT ${bodyLengthSql("m", true)} AS bytes FROM narrator_messages m WHERE id=?`,
			)
			.get("rows");
		expect(measured?.bytes).toBe(bytes);
		expect(boundedBodyText(sqlite, "rows", true, { maxBytes: bytes, exactBytes: bytes })).toBe(
			body,
		);
		expect(boundedBodyText(sqlite, "rows", true, { maxBytes: bytes - 1 })).toBeUndefined();
		expect(
			readNarratorBodyTextsSnapshot(sqlite, {
				entries: [{ id: "rows", maxBytes: bytes, exactBytes: 2 }],
			}),
		).toEqual([{ id: "rows", body: null }]);
		const proof = readRevertSelectionBody(
			sqlite,
			{ id: "rows", contentBytes: bytes, digestOnly: false },
			new AbortController().signal,
		);
		expect(proof.error).toBeNull();
		expect(proof.summary?.blocks).toHaveLength(1);
		expect(
			readRevertSelectionBodyVerify(
				sqlite,
				{ entries: [{ id: "rows", contentBytes: bytes, digest: proof.summary?.digest ?? "" }] },
				new AbortController().signal,
			),
		).toEqual({ matches: true });
		expect(
			readRevertSelectionBody(
				sqlite,
				{ id: "rows", contentBytes: 2, digestOnly: true },
				new AbortController().signal,
			).error,
		).toBe("STALE");
	});

	test("pre-cancelled Worker snapshots leave the same WAL source readable", async () => {
		await fixture.ready;
		const body = seed("cancel-recover", [{ type: "text", text: "WAL 正文😀" }]);
		const input = {
			messageIds: ["cancel-recover"],
			includeTools: false,
			includeCreator: false,
		};
		const options = { executionPolicy: "worker-required" as const, timeoutMs: 30_000 };
		const controller = new AbortController();
		controller.abort();
		await expect(
			readDomainTask(sqlite, "narratorMessageRows", input, {
				...options,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ code: "DB_READ_ABORTED" });
		const snapshot = await readDomainTask(sqlite, "narratorMessageRows", input, options);
		expect(snapshot.messages).toHaveLength(1);
		expect(snapshot.messages[0].id).toBe("cancel-recover");
		expect(snapshot.messages[0].content_json).toBe(body);
	}, 30_000);

	test("readonly snapshots preserve transactions and held statements across failures", async () => {
		await fixture.ready;
		const body = seed("lifecycle", [{ type: "text", text: "恢复正文😀" }]);
		sqlite.run(
			`WITH RECURSIVE sequence(n) AS (
				SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 10000
			)
			INSERT INTO narrator_tool_calls
				(id,narrator_id,message_id,tool_use_id,tool_name,is_internal,created_at)
			SELECT 'budget-tool-' || n,'n','lifecycle','internal_read_' || n,'Read',1,?
			FROM sequence`,
			[NOW],
		);
		const reader = new Database(sqlite.filename, { readonly: true });
		const held = reader.prepare<{ answer: number }, []>("SELECT 42 AS answer");
		const params = createDomainReadParams("narratorMessageRows", {
			messageIds: ["lifecycle"],
			includeTools: true,
			includeCreator: false,
		});
		const snapshot = () => runDomainRead(reader, params, new AbortController().signal);
		const expected = { messages: [{ id: "lifecycle", content_json: body }] };
		try {
			expect(held.get()).toEqual({ answer: 42 });
			await expect(snapshot()).rejects.toMatchObject({ code: "DB_READ_BUDGET" });
			expect(reader.inTransaction).toBe(false);
			expect(held.get()).toEqual({ answer: 42 });
			sqlite.run("DELETE FROM narrator_tool_calls WHERE message_id = ?", ["lifecycle"]);
			await expect(snapshot()).resolves.toMatchObject(expected);

			const controller = new AbortController();
			const check = controller.signal.throwIfAborted.bind(controller.signal);
			let checks = 0;
			const cancel = spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
				// The final handler checkpoint follows payload reads, before the snapshot commits.
				if (++checks === 3) {
					expect(reader.inTransaction).toBe(true);
					controller.abort(readAborted());
				}
				check();
			});
			try {
				await expect(runDomainRead(reader, params, controller.signal)).rejects.toMatchObject({
					code: "DB_READ_ABORTED",
				});
				expect(checks).toBe(3);
			} finally {
				cancel.mockRestore();
			}
			expect(reader.inTransaction).toBe(false);
			expect(held.get()).toEqual({ answer: 42 });
			await expect(snapshot()).resolves.toMatchObject(expected);
		} finally {
			held.finalize();
			reader.close();
		}
	}, 30_000);

	test("cancelled snapshots never read their source", () => {
		const controller = new AbortController();
		controller.abort();
		expect(() =>
			readNarratorMessageRowsSnapshot(
				sqlite,
				{ messageIds: ["missing"], includeTools: false, includeCreator: false },
				controller.signal,
			),
		).toThrow();
	});
});
