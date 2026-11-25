import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ComposerDocument, composerDocumentText } from "@shared/composer-document";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	narratorBufferedMessages as mailbox,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorCommunicationNodes as nodes,
	narratorCommunicationPeers as peers,
	users,
} from "../../db/schema";
import { createAgentMessageDelivery } from "../agent-message-delivery";
import { enqueueInboxAgent } from "../agent-runtime/inbox";
import { MAILBOX_LIMITS } from "../agent-runtime/limits";
import { createMailboxStore } from "../agent-runtime/mailbox";
import {
	communicationReferenceTargets,
	submissionFingerprint,
} from "../agent-runtime/user-submission";
import {
	clearBufferedMessages,
	enqueueBufferedMessage,
	readUserSubmission,
} from "../narrator-buffer";
import { pushPendingInjection } from "../parent-injection-queue";
import { deliverTeamMessage } from "../subagent-team";

// The test preload selects a private file DB; strict worker reads see these committed rows.
const { db, sqlite } = await import("../../db");
async function rejected(work: Promise<unknown>): Promise<unknown> {
	return work.then(
		() => {
			throw new Error("Expected rejection");
		},
		(error) => error,
	);
}
const owner = "submission-owner";
const source = "submission-source";
const target = "submission-target";
let serial = 0;
const now = () => new Date().toISOString();
function document(ids = [target]): ComposerDocument {
	return {
		version: 1,
		assets: [],
		paragraphs: [
			{
				children: ids.map((narratorId, index) => ({
					type: "narratorReference",
					id: `ref-${index}`,
					narratorId,
					label: narratorId,
				})),
			},
		],
	};
}
function enqueue(
	doc: ComposerDocument | undefined,
	key = "submission-one",
	text = doc ? composerDocumentText(doc).text : "hello",
) {
	return enqueueBufferedMessage(
		source,
		text,
		undefined,
		undefined,
		owner,
		undefined,
		undefined,
		"back",
		undefined,
		undefined,
		"fifo",
		undefined,
		"turn",
		doc,
		undefined,
		undefined,
		{ clientSubmissionId: key, fingerprint: submissionFingerprint({ text, doc }) },
	);
}
function toolDelivery(body = "ordinary message") {
	const id = `submission-tool-${++serial}`;
	db.insert(narratorMessages)
		.values({ id, narratorId: source, role: "assistant", contentJson: [], createdAt: now() })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: `${id}-call`,
			narratorId: source,
			messageId: id,
			toolUseId: `${id}-use`,
			toolName: "Send",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			status: "running",
			createdAt: now(),
		})
		.run();
	return createAgentMessageDelivery(
		target,
		{ id: source, title: "source", label: "source", type: "primary", isParent: false },
		`${id}-use`,
		body,
		{ toolCallId: `${id}-call`, attempt: 1 },
	);
}
beforeEach(() => {
	db.insert(users)
		.values({ id: owner, username: owner, passwordHash: "test", role: "admin", createdAt: now() })
		.onConflictDoNothing()
		.run();
	for (const id of [source, target]) {
		db.insert(narrators)
			.values({
				id,
				ownerUserId: owner,
				type: "primary",
				variant: "primary",
				status: "idle",
				createdAt: now(),
				updatedAt: now(),
			})
			.run();
		db.insert(nodes)
			.values({
				narratorId: id,
				parentNarratorId: null,
				originalParentNarratorId: null,
				version: 1,
			})
			.run();
	}
});
afterEach(async () => {
	await clearBufferedMessages(source);
	cleanDb(sqlite);
});

describe("user submission acceptance", () => {
	test("first admission creates exact peer; replay after disconnect does not reconnect", async () => {
		const first = await enqueue(document());
		expect(first.ok).toBe(true);
		expect(db.select().from(peers).all()).toHaveLength(1);
		const receipt = await readUserSubmission(source, owner, "submission-one");
		expect(receipt).toMatchObject({
			status: "accepted",
			id: first.id,
			state: "queued",
			messageId: null,
		});
		expect(receipt?.dedupeExpiresAt).toBeString();
		db.delete(peers).run();
		const replay = await enqueue(document());
		expect(replay).toMatchObject({ duplicate: true, id: first.id });
		expect(db.select().from(peers).all()).toHaveLength(0);
		expect(db.select().from(mailbox).all()).toHaveLength(1);
	});
	test("different body or typed references with same key conflict", async () => {
		await enqueue(document());
		expect(await rejected(enqueue(undefined))).toMatchObject({
			statusCode: 409,
			code: "SUBMISSION_CONFLICT",
		});
	});
	test("plain @ text, quotes and historical markdown links never create peers", async () => {
		const doc: ComposerDocument = {
			version: 1,
			assets: [],
			paragraphs: [
				{
					children: [
						{ type: "text", text: `@${target} [old](nf-agent://open?id=${target})` },
						{ type: "quote", id: "quote", label: "history", text: `@${target}` },
					],
				},
			],
		};
		expect(communicationReferenceTargets(doc)).toEqual([]);
		await enqueue(doc);
		expect(db.select().from(peers).all()).toHaveLength(0);
	});
	test("full queue never creates a peer", async () => {
		for (let index = 0; index < MAILBOX_LIMITS.userPending; index++)
			await enqueue(undefined, `fill-${index}`);
		expect(await enqueue(document())).toMatchObject({ ok: false, full: true });
		expect(db.select().from(peers).all()).toHaveLength(0);
	});
	test("peer insert failure rolls back the accepted mailbox row and arrival sequence", async () => {
		sqlite.run(
			"CREATE TEMP TRIGGER reject_submission_peer BEFORE INSERT ON narrator_communication_peers BEGIN SELECT RAISE(ABORT, 'peer admission rejected'); END",
		);
		try {
			expect(await rejected(enqueue(document()))).toMatchObject({
				message: "peer admission rejected",
			});
			expect(db.select().from(mailbox).all()).toHaveLength(0);
			expect(db.select().from(peers).all()).toHaveLength(0);
			expect(
				db
					.select({ sequence: narrators.inboxSequence })
					.from(narrators)
					.where(eq(narrators.id, source))
					.get()?.sequence,
			).toBe(0);
		} finally {
			sqlite.run("DROP TRIGGER reject_submission_peer");
		}
	});
	test("one forbidden/missing reference rejects all admission and edges", async () => {
		expect(await rejected(enqueue(document([target, "missing-reference"])))).toBeInstanceOf(Error);
		expect(db.select().from(mailbox).all()).toHaveLength(0);
		expect(db.select().from(peers).all()).toHaveLength(0);
	});
	test("same-domain references create no redundant peer", async () => {
		db.update(nodes).set({ parentNarratorId: source }).where(eq(nodes.narratorId, target)).run();
		await enqueue(document());
		expect(db.select().from(peers).all()).toHaveLength(0);
	});
	test.each([
		["same", source],
		["same", target],
		["different", source],
		["different", target],
	] as const)("typed references to %s-group endpoints fail atomically after archiving %s", async (group, endpoint) => {
		if (group === "same")
			db.update(nodes).set({ parentNarratorId: source }).where(eq(nodes.narratorId, target)).run();
		const { prepareUserCommunicationAdmission } = await import("../narrator-communication/service");
		await expect(
			prepareUserCommunicationAdmission({
				sourceNarratorId: source,
				userId: owner,
				targetNarratorIds: [target],
			}),
		).resolves.toMatchObject({ targetNarratorIds: [target] });
		db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, endpoint)).run();
		await expect(enqueue(document())).rejects.toMatchObject({ code: "COMMUNICATION_DENIED" });
		expect(db.select().from(peers).all()).toEqual([]);
		expect(await readUserSubmission(source, owner, "submission-one")).toBeUndefined();
		expect(db.select().from(mailbox).all()).toEqual([]);
		expect(
			db
				.select({ sequence: narrators.inboxSequence })
				.from(narrators)
				.where(eq(narrators.id, source))
				.get()?.sequence,
		).toBe(0);
	});
	test("cancelled receipt retains fingerprint; old submission cannot resurrect it or peer", async () => {
		const first = await enqueue(document());
		const row = db.select().from(mailbox).where(eq(mailbox.id, first.id)).get();
		const submissionAttachments = [
			{
				channel: "textFiles",
				uploadId: "consumed-original",
				name: "large.txt",
				type: "text/plain",
				size: 5,
				digest: "a".repeat(64),
			},
		];
		db.update(mailbox)
			.set({
				metadataJson: JSON.stringify({
					...JSON.parse(row?.metadataJson ?? "{}"),
					submissionAttachments,
				}),
			})
			.where(eq(mailbox.id, first.id))
			.run();
		await clearBufferedMessages(source);
		expect(
			JSON.parse((await readUserSubmission(source, owner, "submission-one"))?.metadataJson ?? "{}")
				.submissionAttachments,
		).toEqual(submissionAttachments);
		db.delete(peers).run();
		expect(await enqueue(document())).toMatchObject({ duplicate: true, id: first.id });
		expect(await readUserSubmission(source, owner, "submission-one")).toMatchObject({
			state: "cancelled",
		});
		expect(db.select().from(peers).all()).toHaveLength(0);
	});
	test("receipts are isolated by user and source; only known expired receipts return 410", async () => {
		const first = await enqueue(document());
		expect(await readUserSubmission(source, "another-user", "submission-one")).toBeUndefined();
		expect(await readUserSubmission(target, owner, "submission-one")).toBeUndefined();
		expect(await readUserSubmission(source, owner, "random-unseen")).toBeUndefined();
		db.update(mailbox)
			.set({ dedupeExpiresAt: "2000-01-01T00:00:00.000Z" })
			.where(eq(mailbox.id, first.id))
			.run();
		expect(await rejected(readUserSubmission(source, owner, "submission-one"))).toMatchObject({
			statusCode: 410,
			code: "SUBMISSION_EXPIRED",
		});
	});
	test("at most 16 unique typed targets", () => {
		expect(() =>
			communicationReferenceTargets(
				document(Array.from({ length: 17 }, (_, index) => `target-${index}`)),
			),
		).toThrow("Too many narrator references");
	});
});

describe("final ordinary-message admission", () => {
	test("Send, TeamStatus and parent compatibility all reject a disconnected destination", async () => {
		const delivery = toolDelivery();
		expect(await rejected(enqueueInboxAgent(delivery, delivery.text))).toMatchObject({
			code: "COMMUNICATION_DENIED",
		});
		expect(
			await rejected(
				deliverTeamMessage(
					target,
					{
						fromId: source,
						fromTitle: "source",
						fromType: "primary",
						text: delivery.text,
						timestamp: now(),
						delivery,
						isBroadcast: false,
					},
					source,
				),
			),
		).toMatchObject({ code: "COMMUNICATION_DENIED" });
		expect(
			await rejected(
				pushPendingInjection(target, {
					kind: "subagent_message",
					message: {
						fromId: source,
						fromTitle: "source",
						fromType: "primary",
						text: delivery.text,
						timestamp: now(),
						delivery,
					},
				}),
			),
		).toMatchObject({ code: "COMMUNICATION_DENIED" });
		expect(db.select().from(mailbox).all()).toHaveLength(0);
	});
	test("already accepted agent receipt replays after disconnect but a new send is blocked", async () => {
		await enqueue(document());
		const delivery = toolDelivery();
		const first = await enqueueInboxAgent(delivery, delivery.text);
		db.delete(peers).run();
		expect(await enqueueInboxAgent(delivery, delivery.text)).toMatchObject({
			status: "duplicate",
			delivery: { id: first.delivery.id },
		});
		const fresh = toolDelivery();
		expect(await rejected(enqueueInboxAgent(fresh, fresh.text))).toMatchObject({
			code: "COMMUNICATION_DENIED",
		});
	});
	test.each([
		"anonymous",
		"unknown",
	] as const)("a source with %s principal cannot acquire ordinary Send authority from a peer", async (kind) => {
		await enqueue(document());
		db.update(narrators)
			.set({
				ownerUserId: null,
				runtimeRegistrationJson:
					kind === "anonymous"
						? { version: 1, run: { logicalRunId: "anonymous-source", principal: { userId: null } } }
						: null,
			})
			.where(eq(narrators.id, source))
			.run();
		const message = toolDelivery();
		expect(await rejected(enqueueInboxAgent(message, message.text))).toMatchObject({
			code: "COMMUNICATION_DENIED",
		});
		expect(db.select().from(mailbox).all()).toHaveLength(1);
	});
	test("task notices remain allowed across disconnected roots and do not create peers", () => {
		const result = createMailboxStore(db).enqueue({
			kind: "task_notice",
			noticeKind: "agent",
			narratorId: target,
			sourceKey: "result-registration",
			text: "registered task result",
			projectedByteSize: 32,
		});
		expect(result.status).toBe("accepted");
		expect(db.select().from(peers).all()).toHaveLength(0);
	});
});
