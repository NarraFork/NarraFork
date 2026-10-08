/**
 * Public share read-through endpoints: pretext-document / tool-calls /
 * message-location forward verbatim to the narrator read services — the share
 * link IS the grant, so the shapes are the narrator's own (no projection).
 *
 * Pinned here: the narrator's contentJson structure and tool IO survive intact
 * (that is what lets the public page run the real vlist), and a share for
 * narrator A can never read narrator B (the auth middleware scopes every query
 * by the verified narratorId).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { publicNarratorShareRoutes } from "../../routes/public-narrator-shares";
import { createPublicShare, type VerifiedPublicShare } from "../public-narrator-share-service";

const now = "2026-09-08T00:00:00.000Z";
const owner = generateId();
const app = new Hono();
app.route("/api/public/narrator-shares", publicNarratorShareRoutes);
app.onError((error, c) =>
	c.json(
		{ error: "error", code: "code" in error ? (error as { code: string }).code : "UNKNOWN" },
		"statusCode" in error ? ((error as { statusCode: number }).statusCode as 400) : 500,
	),
);

beforeAll(() => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	db.insert(users)
		.values({
			id: owner,
			username: `readthrough-${generateId()}`,
			passwordHash: "x",
			role: "user",
			createdAt: now,
		})
		.run();
});

function narrator(): string {
	const id = generateId();
	db.insert(narrators)
		.values({
			id,
			title: "Read-through narrator",
			ownerUserId: owner,
			type: "primary",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return id;
}

function message(
	narratorId: string,
	seq: number,
	text: string,
	role: "assistant" | "user" | "system" | "sys" | "disp" = "assistant",
): string {
	const id = generateId();
	db.insert(narratorMessages)
		.values({
			id,
			narratorId,
			role,
			contentJson: [{ type: "text", text }],
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId, messageId: id, seq, isCompact: 0 })
		.run();
	return id;
}

function tool(narratorId: string, messageId: string): string {
	const toolUseId = generateId();
	db.insert(narratorToolCalls)
		.values({
			id: generateId(),
			narratorId,
			messageId,
			toolUseId,
			toolName: "Bash",
			status: "success",
			inputJson: { command: "ls -la" },
			outputJson: { text: "total 0" },
			createdAt: now,
		})
		.run();
	// The message's contentJson must name the call — the document page joins tool
	// rows through tool_use blocks, not by messageId alone.
	const row = db
		.select({ contentJson: narratorMessages.contentJson })
		.from(narratorMessages)
		.where(eq(narratorMessages.id, messageId))
		.get();
	const blocks = Array.isArray(row?.contentJson) ? [...row.contentJson] : [];
	blocks.push({ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "ls -la" } });
	db.update(narratorMessages)
		.set({ contentJson: blocks })
		.where(eq(narratorMessages.id, messageId))
		.run();
	return toolUseId;
}

async function shared(narratorId: string) {
	const created = await createPublicShare(
		narratorId,
		{ userId: owner, isAdmin: false },
		{
			guestName: "Visitor",
		},
	);
	return created;
}

function get(share: { share: { id: string }; token: string }, suffix: string) {
	return app.request(`/api/public/narrator-shares/${share.share.id}${suffix}`, {
		headers: { Authorization: `Share ${share.token}` },
	});
}

describe("public share read-through endpoints", () => {
	test("pretext-document returns the narrator's real TreeMessage shape", async () => {
		const narratorId = narrator();
		const messageId = message(narratorId, 0, "hello **world**");
		const toolUseId = tool(narratorId, messageId);
		const share = await shared(narratorId);
		const res = await get(share, "/pretext-document");
		expect(res.status).toBe(200);
		const page = (await res.json()) as {
			messages: Array<{
				id: string;
				contentJson: Array<{
					type: string;
					text?: string;
					id?: string;
					status?: string;
					inputJson?: unknown;
					outputJson?: unknown;
				}>;
			}>;
			hasPrev: boolean;
			messageVersion: number;
		};
		const row = page.messages.find((m) => m.id === messageId);
		expect(row).toBeDefined();
		// Structure, not flattening: contentJson blocks survive as blocks.
		expect(row?.contentJson[0]).toEqual({ type: "text", text: "hello **world**" });
		// The tool_use block is hydrated in place with the call's real payload —
		// that is exactly the shape the vlist's tool card renders from.
		const toolBlock = row?.contentJson.find((b) => b.type === "tool_use") as
			| { id: string; status?: string; inputJson?: unknown; outputJson?: unknown }
			| undefined;
		expect(toolBlock?.id).toBe(toolUseId);
		expect(toolBlock?.status).toBe("success");
		expect(JSON.stringify(toolBlock?.inputJson)).toContain("ls -la");
		expect(JSON.stringify(toolBlock?.outputJson)).toContain("total 0");
		expect(typeof page.messageVersion).toBe("number");
	});

	test("tool-calls detail forwards the full input/output JSON", async () => {
		const narratorId = narrator();
		const messageId = message(narratorId, 0, "with tool");
		const toolUseId = tool(narratorId, messageId);
		const share = await shared(narratorId);
		const res = await get(share, `/tool-calls/${toolUseId}`);
		expect(res.status).toBe(200);
		const detail = (await res.json()) as { inputJson?: unknown; outputJson?: unknown };
		expect(JSON.stringify(detail.inputJson)).toContain("ls -la");
		expect(JSON.stringify(detail.outputJson)).toContain("total 0");
	});

	test("message-location resolves the document coordinate", async () => {
		const narratorId = narrator();
		message(narratorId, 0, "first");
		const second = message(narratorId, 1, "second");
		const share = await shared(narratorId);
		const res = await get(share, `/message-location/${second}`);
		expect(res.status).toBe(200);
		const location = (await res.json()) as { messageId: string; seq: number };
		expect(location.messageId).toBe(second);
		expect(location.seq).toBe(1);
	});

	test("a share can never read another narrator's document", async () => {
		const narratorA = narrator();
		const narratorB = narrator();
		message(narratorA, 0, "alpha");
		message(narratorB, 0, "beta-secret");
		const shareA = await shared(narratorA);
		const res = await get(shareA, "/pretext-document");
		const page = (await res.json()) as { messages: Array<{ contentJson: unknown }> };
		expect(JSON.stringify(page.messages)).toContain("alpha");
		expect(JSON.stringify(page.messages)).not.toContain("beta-secret");
	});

	test("a missing or wrong token is indistinguishable from a missing share", async () => {
		const narratorId = narrator();
		message(narratorId, 0, "hello");
		const share = await shared(narratorId);
		for (const authorization of [
			undefined,
			"Share wrong-token-wrong-token-wrong-token-wrong-tok",
			"Bearer x",
		]) {
			const res = await app.request(
				`/api/public/narrator-shares/${share.share.id}/pretext-document`,
				{
					...(authorization ? { headers: { Authorization: authorization } } : {}),
				},
			);
			expect(res.status).toBe(404);
		}
	});
});
