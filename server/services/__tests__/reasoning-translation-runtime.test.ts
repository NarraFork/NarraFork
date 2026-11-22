import { beforeEach, expect, mock, test } from "bun:test";
import type {
	ReasoningTranslationPatch,
	ReasoningTranslationVisibilityTarget,
} from "@shared/reasoning-translation";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
const realAgent = { ...(await import("../../lib/agent")) };
const realI18n = { ...(await import("../../lib/prompt-i18n")) };
const generate = mock(async () => ({ text: "已翻译", outputTruncated: false }));
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
mock.module("../../lib/agent", () => ({ ...realAgent, summaryGenerate: generate }));
mock.module("../../lib/prompt-i18n", () => ({ ...realI18n, getUserLanguage: async () => "zh-CN" }));

await import("../narrator-service");
const { settings } = await import("../../lib/settings");
const { syncEnvelopeNow } = await import("../narrator-block-sync");
const { translateDemand } = await import("../reasoning-translation-runtime");

const source = "A private reasoning paragraph";
const seed = (): ReasoningTranslationVisibilityTarget => {
	const now = "2026-11-01T00:00:00.000Z";
	for (const id of ["owner", "unrelated"]) {
		sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			id,
			id,
			now,
			now,
		]);
	}
	sqlite.run(
		`INSERT INTO narrator_messages (id, narrator_id, role, content_json, body_format, created_at)
		 VALUES ('msg', 'owner', 'assistant', ?, 2, ?)`,
		[JSON.stringify([{ type: "reasoning", id: "element", text: source, completed: true }]), now],
	);
	sqlite.run(
		`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('ref', 'owner', 'msg', 1)`,
	);
	syncEnvelopeNow("msg");
	const row = sqlite
		.query<{ id: string; revision: number }, []>(
			"SELECT id, revision FROM narrator_blocks WHERE message_id = 'msg' AND kind = 'reasoning'",
		)
		.get();
	if (!row) throw new Error("Missing persisted reasoning block");
	return {
		ownerNarratorId: "owner",
		messageId: "msg",
		blockId: row.id,
		blockRevision: row.revision,
		elementId: "element",
	};
};

const run = (
	target: ReasoningTranslationVisibilityTarget,
	narratorId = "owner",
	authorize = async () => true,
	signal = new AbortController().signal,
) => {
	const publish = mock<(frame: ReasoningTranslationPatch) => void>();
	return translateDemand(
		{ viewer: { narratorId, userId: "user", authorize }, target, publish },
		signal,
	).then(() => publish);
};

beforeEach(() => {
	cleanDb(sqlite);
	settings.agent.translateReasoning = true;
	generate.mockReset();
	generate.mockImplementation(async () => ({ text: "已翻译", outputTruncated: false }));
});

test("translates only an exact visible persisted source and publishes a state-only patch", async () => {
	const target = seed();
	expect((await run(target, "unrelated")).mock.calls).toHaveLength(0);
	expect(
		(await run({ ...target, blockRevision: target.blockRevision + 1 })).mock.calls,
	).toHaveLength(0);
	expect(generate).not.toHaveBeenCalled();
	const publish = await run(target);
	expect(generate).toHaveBeenCalledTimes(1);
	expect(publish).toHaveBeenCalledWith(
		expect.objectContaining({
			type: "reasoning_translation_patch",
			blockId: target.blockId,
			blockRevision: target.blockRevision,
			stateRevision: 1,
			part: expect.objectContaining({ sourceText: source, translatedText: "已翻译" }),
		}),
	);
	expect((await run(target)).mock.calls).toHaveLength(0);
	expect(generate).toHaveBeenCalledTimes(1);
});

test("does not persist or publish if demand disappears or access is lost during generation", async () => {
	const target = seed();
	const controller = new AbortController();
	generate.mockImplementationOnce(async () => {
		controller.abort();
		return { text: "obsolete", outputTruncated: false };
	});
	expect((await run(target, "owner", async () => true, controller.signal)).mock.calls).toHaveLength(
		0,
	);
	const authorize = mock(async () => false)
		.mockResolvedValueOnce(true)
		.mockResolvedValueOnce(true);
	expect((await run(target, "owner", authorize)).mock.calls).toHaveLength(0);
	expect(generate).toHaveBeenCalledTimes(2);
	expect(
		sqlite.query("SELECT state_revision AS revision FROM narrator_messages WHERE id = 'msg'").get(),
	).toEqual({ revision: 0 });
});
