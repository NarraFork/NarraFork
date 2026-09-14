import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessageRefs, narratorMessages, narrators } from "../../db/schema";
import {
	mirrorDeliveryStateTx,
	setDeliveryProjectionStateTx,
} from "../agent-runtime/mailbox-transitions";

const { db, sqlite } = getTestDb();
const now = "2026-09-13T00:00:00.000Z";

beforeEach(() => {
	cleanDb(sqlite);
	db.insert(narrators).values({ id: "recipient", createdAt: now, updatedAt: now }).run();
	db.insert(narratorMessages)
		.values({
			id: "message-1",
			narratorId: "recipient",
			role: "user",
			contentJson: [{ type: "text", text: "queued" }],
			contentText: "queued",
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: "ref-1",
			narratorId: "recipient",
			messageId: "message-1",
			seq: 0,
			deliveryId: "delivery-1",
			deliveryKind: "user_input",
			deliveryState: "queued",
		})
		.run();
});

afterAll(() => sqlite.close());

describe("mailbox delivery state transitions", () => {
	test("updates only the matching narrator and delivery projection", () => {
		const changed = db.transaction((tx) =>
			setDeliveryProjectionStateTx(tx, "recipient", "delivery-1", "materialized"),
		);

		expect(changed).toBe(1);
		expect(
			db.query.narratorMessageRefs.findFirst({ where: eq(narratorMessageRefs.id, "ref-1") }).sync()
				?.deliveryState,
		).toBe("materialized");
	});

	test("does not create a projection when a legacy row has no delivery id", () => {
		db.insert(narratorMessages)
			.values({
				id: "message-2",
				narratorId: "recipient",
				role: "user",
				contentJson: [{ type: "text", text: "legacy" }],
				contentText: "legacy",
				createdAt: now,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: "ref-2", narratorId: "recipient", messageId: "message-2", seq: 1 })
			.run();

		db.transaction((tx) => mirrorDeliveryStateTx(tx, "recipient", null, "cancelled"));

		expect(
			db.query.narratorMessageRefs.findFirst({ where: eq(narratorMessageRefs.id, "ref-2") }).sync()
				?.deliveryState,
		).toBeNull();
	});
});
