import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import {
	narratorBufferedMessages,
	narratorCommunicationNodes,
	narratorCommunicationPeers,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import { executionPrincipalOf } from "../../lib/runtime-source";
import { delegationRegistration } from "../../lib/validators/runtime-registration";
import {
	resolveCommunicationSendTargets,
	resolveSubagentTargets,
	sendSubagentMessageDetailed,
} from "../agent-communication";
import * as inbox from "../agent-runtime/inbox";
import * as communication from "../narrator-communication";
import { authorizeAgentControl } from "../narrator-control";
import { captureWorkerRejectionThrower } from "./narrator-worker-fixture";

async function expectRejected(work: PromiseLike<unknown>, message?: string) {
	const thrower = await captureWorkerRejectionThrower(work);
	if (message) expect(thrower).toThrow(message);
	else expect(thrower).toThrow();
}

const time = "2026-09-09T00:00:00.000Z";
const parents: Record<string, string | null> = {
	root: null,
	"branch-a": "root",
	"grandchild-a": "branch-a",
	"branch-b": "root",
	"grandchild-b": "branch-b",
	peer: null,
	"peer-child": "peer",
	independent: null,
};
let serial = 0;
const wake = spyOn(inbox, "wakeInboxIfEligible").mockResolvedValue(false);
beforeEach(() => {
	wake.mockClear();
	cleanDb(sqlite);
	for (const id of ["sender-user", "recipient-user"])
		db.insert(users)
			.values({ id, username: id, passwordHash: "test", role: "user", createdAt: time })
			.run();
	for (const [id, parent] of Object.entries(parents)) {
		db.insert(narrators)
			.values({
				id,
				title: id,
				type: parent ? "subagent" : "primary",
				variant: parent ? "subagent:general" : "primary",
				parentNarratorId: parent,
				policySourceNarratorId: parent,
				runtimeRegistrationJson: parent ? delegationRegistration(parent, "general") : null,
				aclRootNarratorId: parent ? (id.startsWith("peer") ? "peer" : "root") : null,
				ownerUserId: id.startsWith("peer") ? "recipient-user" : "sender-user",
				visibility: "public",
				writeAudience: "public",
				status: "working",
				createdAt: time,
				updatedAt: time,
			})
			.run();
		db.insert(narratorCommunicationNodes)
			.values({
				narratorId: id,
				parentNarratorId: parent,
				originalParentNarratorId: parent,
				version: 1,
			})
			.run();
	}
	db.insert(narratorCommunicationPeers)
		.values({
			id: "root-peer-connection",
			endpointLo: "peer",
			endpointHi: "root",
			createdBy: "sender-user",
			source: "manual",
			createdAt: time,
		})
		.run();
});
afterAll(() => wake.mockRestore());

function request(callerNarratorId: string, ids: string[]) {
	const id = `topology-tool-${++serial}`;
	db.insert(narratorMessages)
		.values({
			id,
			narratorId: callerNarratorId,
			role: "assistant",
			contentJson: [],
			createdAt: time,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: `${id}-call`,
			narratorId: callerNarratorId,
			messageId: id,
			toolUseId: id,
			toolName: "Send",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			status: "running",
			createdAt: time,
		})
		.run();
	return {
		callerNarratorId,
		ids,
		toolUseId: id,
		toolCallBinding: { toolCallId: `${id}-call`, attempt: 1 },
		message: "Relevant finding",
		locale: "en",
		signal: new AbortController().signal,
		// Untrusted authorship must not replace the source or recipient principal.
		userId: "recipient-user",
	};
}
function queued() {
	return db.select().from(narratorBufferedMessages).all();
}

test("Send reaches all levels and branches while the generic team resolver stays unchanged", async () => {
	for (const [callerNarratorId, ids] of [
		["root", ["grandchild-a", "grandchild-b"]],
		["grandchild-a", ["root", "grandchild-b"]],
	] as const) {
		const targets = await resolveCommunicationSendTargets({ callerNarratorId, ids: [...ids] });
		expect(targets.map((target) => target.id)).toEqual([...ids]);
	}
	await expectRejected(
		resolveSubagentTargets({ callerNarratorId: "root", id: "grandchild-a" }),
		"subagent team",
	);
});

test("exact peers are not inherited by their descendants or other members of a group", async () => {
	expect(
		(await resolveCommunicationSendTargets({ callerNarratorId: "root", id: "peer" }))[0]?.id,
	).toBe("peer");
	for (const [source, target] of [
		["root", "peer-child"],
		["branch-a", "peer"],
		["peer", "branch-a"],
	])
		await expectRejected(resolveCommunicationSendTargets({ callerNarratorId: source, id: target }));
});

test("cross-level and peer deliveries have neutral provenance and retain recipient execution identity", async () => {
	const before = executionPrincipalOf(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, "peer") })) ?? {},
	);
	const delivered = await sendSubagentMessageDetailed(
		request("root", ["grandchild-a", "peer", "branch-a"]),
	);
	expect(delivered.targets.map((target) => target.status)).toEqual(["queued", "queued", "queued"]);
	for (const row of queued()) {
		const metadata = JSON.parse(row.metadataJson ?? "{}");
		expect(metadata.delivery.sender.isParent).toBe(row.narratorId === "branch-a");
		expect(row.createdBy).toBe("sender-user");
		if (row.narratorId !== "branch-a") {
			expect(metadata.projection.prefix).toContain("Message from session");
			expect(metadata.projection.prefix).not.toContain("Message from the parent");
		}
	}
	const after = executionPrincipalOf(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, "peer") })) ?? {},
	);
	expect(after).toEqual(before);
	expect(after).toEqual({ userId: "recipient-user" });
});

test("a split blocks manual parent/main without changing controller or generic visibility", async () => {
	db.update(narratorCommunicationNodes)
		.set({ parentNarratorId: null, version: 2 })
		.where(eq(narratorCommunicationNodes.narratorId, "branch-a"))
		.run();
	for (const id of ["parent", "main", "root"])
		await expectRejected(resolveCommunicationSendTargets({ callerNarratorId: "branch-a", id }));
	expect((await resolveSubagentTargets({ callerNarratorId: "root", id: "branch-a" }))[0]?.id).toBe(
		"branch-a",
	);
	expect(
		(
			await authorizeAgentControl({
				callerNarratorId: "root",
				targetNarratorId: "branch-a",
				action: "steer",
				userId: "sender-user",
			})
		).id,
	).toBe("branch-a");
});

test("communication reachability never grants interrupt, resume or model control", async () => {
	for (const target of ["grandchild-a", "peer"])
		for (const extra of [{ doInterrupt: true }, { resume: true }, { model: "parent" }])
			await expectRejected(
				sendSubagentMessageDetailed({ ...request("root", ["branch-a", target]), ...extra }),
				"not a direct child",
			);
	expect(queued()).toHaveLength(0);
});

test("ambiguous titles are rejected with full stable IDs instead of choosing the first", async () => {
	db.update(narrators)
		.set({ title: "Repeated title" })
		.where(eq(narrators.id, "grandchild-a"))
		.run();
	db.update(narrators)
		.set({ title: "Repeated title" })
		.where(eq(narrators.id, "grandchild-b"))
		.run();
	await expectRejected(
		resolveCommunicationSendTargets({ callerNarratorId: "root", name: "Repeated title" }),
		"Ambiguous communication target",
	);
	expect(
		(await resolveCommunicationSendTargets({ callerNarratorId: "root", id: "grandchild-b" }))[0]
			?.id,
	).toBe("grandchild-b");
});

test("names match before the display limit and a current alias outranks title-only matches", async () => {
	const fillers = Array.from({ length: 205 }, (_, index) => ({
		id: `a-filler-${index}`,
		title: "Some other title",
		ownerUserId: "sender-user",
		status: "idle" as const,
		createdAt: time,
		updatedAt: time,
	}));
	db.insert(narrators).values(fillers).run();
	db.insert(narratorCommunicationNodes)
		.values(fillers.map(({ id }) => ({ narratorId: id, parentNarratorId: "root", version: 1 })))
		.run();
	db.update(narrators)
		.set({ title: "Previously shared", titleSlug: "shared" })
		.where(eq(narrators.id, "grandchild-a"))
		.run();
	db.update(narrators)
		.set({ traits: ["subagent-alias:shared"], aliasSelector: "shared" })
		.where(eq(narrators.id, "grandchild-b"))
		.run();
	const display = await communication.listCommunicationTargets("root", { limit: 200 });
	expect(display).toHaveLength(200);
	expect(display.some(({ id }) => id === "grandchild-b")).toBe(false);
	const resolve = async (name: string) =>
		(await resolveCommunicationSendTargets({ callerNarratorId: "root", name }))[0]?.id;
	expect(await resolve("shared")).toBe("grandchild-b");
	expect(await resolve("Previously shared")).toBe("grandchild-a");

	db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, "grandchild-b")).run();
	expect(await resolve("shared")).toBe("grandchild-a");
});

test("disconnected archived IDs and historical parent names never gain Send authority", async () => {
	db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, "independent")).run();
	await expectRejected(sendSubagentMessageDetailed(request("root", ["branch-a", "independent"])));
	expect(queued()).toHaveLength(0);

	db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, "root")).run();
	await expectRejected(
		resolveCommunicationSendTargets({ callerNarratorId: "branch-a", id: "main" }),
	);
	await expectRejected(resolveCommunicationSendTargets({ callerNarratorId: "root", name: "peer" }));
});

test("parent aliases name the original delegator, never a different run result recipient", async () => {
	db.update(narrators)
		.set({
			runtimeRegistrationJson: {
				version: 1,
				run: {
					logicalRunId: "rerouted-run",
					deliverTo: { narratorId: "peer", toolUseId: "result-tool" },
					principal: { userId: "sender-user" },
				},
			},
		})
		.where(eq(narrators.id, "branch-a"))
		.run();
	const targets = await resolveCommunicationSendTargets({
		callerNarratorId: "branch-a",
		ids: ["parent", "main"],
	});
	expect(targets.map((target) => target.id)).toEqual(["root"]);
});

test("an input user cannot lend the recipient's ACL to the source's persisted principal", async () => {
	db.update(narrators)
		.set({ visibility: "private", writeAudience: "owner" })
		.where(eq(narrators.id, "peer"))
		.run();
	await expectRejected(sendSubagentMessageDetailed(request("root", ["peer"])));
	expect(queued()).toHaveLength(0);
});

test("aliases and full IDs deduplicate and self-targets are rejected", async () => {
	db.update(narrators)
		.set({ traits: ["subagent-alias:unique-helper"] })
		.where(eq(narrators.id, "grandchild-a"))
		.run();
	const targets = await resolveCommunicationSendTargets({
		callerNarratorId: "root",
		ids: ["unique-helper", "grandchild-a", "grandchild-a"],
	});
	expect(targets.map((target) => target.id)).toEqual(["grandchild-a"]);
	await expectRejected(
		resolveCommunicationSendTargets({ callerNarratorId: "root", id: "root" }),
		"themselves",
	);
});
