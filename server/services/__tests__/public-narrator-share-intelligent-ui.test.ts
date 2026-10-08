import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { INTELLIGENT_UI_PUBLIC_SUMMARY_CODE } from "@shared/intelligent-ui-public";
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
import { narratorService } from "../narrator-service";
import {
	isPublicToolSourceAllowed,
	projectPublicNarratorEvent,
	projectPublicNarratorPayload,
	rememberPublicToolIdentity,
} from "../public-narrator-share-intelligent-ui";
import { createPublicShare } from "../public-narrator-share-service";
import { toolInputStreamSource } from "../tool-input-stream-source";

const now = "2026-10-08T00:00:00.000Z";
const owner = generateId();
const secret = "PRIVATE_UI_SOURCE_<script>capability-secret</script>";
const app = new Hono();
app.route("/api/public/narrator-shares", publicNarratorShareRoutes);

beforeAll(() => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	db.insert(users)
		.values({ id: owner, username: `ui-share-${owner}`, passwordHash: "x", createdAt: now })
		.run();
});

async function fixture(toolName = "IntelligentUI") {
	const narratorId = generateId();
	const messageId = generateId();
	const toolUseId = generateId();
	const toolCallId = generateId();
	db.insert(narrators)
		.values({
			id: narratorId,
			title: "UI privacy",
			ownerUserId: owner,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId,
			role: "assistant",
			createdAt: now,
			contentJson: [
				{ type: "text", text: "normal surrounding text" },
				{
					type: "tool_use",
					id: toolUseId,
					name: toolName,
					input: { source: secret, public: true },
				},
			],
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId, messageId, seq: 0, isCompact: 0 })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId,
			messageId,
			toolUseId,
			toolName,
			status: "success",
			createdAt: now,
			inputJson: { action: "show", path: `.narrafork/intelligent_ui/${secret}/index.tsx` },
			outputJson: {
				text: secret,
				_metadata: {
					intelligentUi: { version: 1, path: `${secret}/index.tsx`, title: secret },
				},
			},
			errorMessage: secret,
		})
		.run();
	const share = await createPublicShare(
		narratorId,
		{ userId: owner, isAdmin: false },
		{ guestName: "Visitor" },
	);
	const get = (path: string) =>
		app.request(`/api/public/narrator-shares/${share.share.id}${path}`, {
			headers: { Authorization: `Share ${share.token}` },
		});
	return { narratorId, messageId, toolUseId, toolCallId, get };
}

function assertStatic(value: unknown) {
	const text = JSON.stringify(value);
	expect(text).not.toContain(secret);
	expect(text).not.toContain("inputDocument");
	expect(text).not.toContain('"intelligentUi"');
	expect(text).toContain(INTELLIGENT_UI_PUBLIC_SUMMARY_CODE);
}

describe("IntelligentUI anonymous read boundary", () => {
	test("history replaces all UI input/output/metadata while keeping surrounding text", async () => {
		const f = await fixture();
		const response = await f.get("/pretext-document");
		expect(response.status).toBe(200);
		const body = await response.json();
		assertStatic(body);
		expect(JSON.stringify(body)).toContain("normal surrounding text");
		// Projection must never mutate the persisted owner document.
		const original = db
			.select({ input: narratorToolCalls.inputJson })
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, f.toolCallId))
			.get();
		expect(JSON.stringify(original)).toContain(secret);
	});

	test("detail and historical source refuse before loading UI bodies", async () => {
		const f = await fixture();
		const detail = spyOn(narratorService, "getToolCallDetail");
		const source = spyOn(toolInputStreamSource, "ensureWriteDocumentSource");
		try {
			for (const suffix of [
				`/tool-calls/${f.toolUseId}`,
				`/tool-calls/${f.toolUseId}?toolCallId=${f.toolCallId}&messageId=${f.messageId}`,
				`/tool-calls/${f.toolUseId}/input-document?toolCallId=${f.toolCallId}&messageId=${f.messageId}&executionAttempt=1`,
			]) {
				const response = await f.get(suffix);
				expect(response.status).toBe(404);
				expect(await response.text()).not.toContain(secret);
			}
			expect(detail).not.toHaveBeenCalled();
			expect(source).not.toHaveBeenCalled();
		} finally {
			detail.mockRestore();
			source.mockRestore();
		}
	});

	test("a known text ref cannot bypass UI denial; ordinary Write source still works", async () => {
		for (const toolName of ["IntelligentUI", "Write"]) {
			const f = await fixture(toolName);
			const ref = toolInputStreamSource.create(
				{
					narratorId: f.narratorId,
					toolUseId: f.toolUseId,
					toolCallId: f.toolCallId,
					messageId: f.messageId,
					field: "content",
				},
				generateId(),
			);
			await toolInputStreamSource.append(ref.id, secret, 0, true);
			const read = spyOn(toolInputStreamSource, "getTextDocumentRange");
			try {
				const response = await f.get(`/text-documents/${ref.id}`);
				if (toolName === "IntelligentUI") {
					expect(response.status).toBe(404);
					expect(read).not.toHaveBeenCalled();
				} else {
					expect(response.status).toBe(200);
					expect((await response.json()).text).toBe(secret);
				}
			} finally {
				read.mockRestore();
				await toolInputStreamSource.discard(ref.id);
			}
		}
	});

	for (const toolName of ["Read", "Write", "Edit"]) {
		test(`${toolName} UI source remains ordinary shared file history`, async () => {
			const f = await fixture(toolName);
			const input = {
				file_path: ".narrafork/intelligent_ui/demo-abc123/App.tsx",
				content: "export default function App() { return <p>ordinary UI source</p>; }",
			};
			db.update(narratorToolCalls)
				.set({ inputJson: input, outputJson: { text: input.content } })
				.where(eq(narratorToolCalls.id, f.toolCallId))
				.run();
			const detail = await f.get(`/tool-calls/${f.toolUseId}`);
			expect(detail.status).toBe(200);
			expect(await detail.text()).toContain("ordinary UI source");
			const page = await f.get("/pretext-document");
			expect(page.status).toBe(200);
			const text = await page.text();
			expect(text).toContain(".narrafork/intelligent_ui/demo-abc123/App.tsx");
			expect(text).not.toContain(INTELLIGENT_UI_PUBLIC_SUMMARY_CODE);
		});
	}

	test("a non-UI tool's similarly named metadata is not a privacy control", async () => {
		const f = await fixture("Bash");
		const response = await f.get(`/tool-calls/${f.toolUseId}`);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain(secret);
		const page = await f.get("/pretext-document");
		expect(await page.text()).toContain(secret);
	});
});

describe("shared projection and live identity", () => {
	test("nested trees, tool results, catch-up activities and snapshots redact without mutating", async () => {
		const f = await fixture();
		const call = {
			toolName: "IntelligentUI",
			toolUseId: f.toolUseId,
			inputJson: secret,
			errorMessage: secret,
			outputJson: secret,
			inputSummary: { description: secret },
			inputDocument: { ref: secret },
			metadata: { capability: secret },
		};
		const payload = {
			type: "catch_up",
			narratorId: f.narratorId,
			topLevel: [
				{
					contentJson: [
						{ type: "tool_use", id: f.toolUseId, name: "IntelligentUI", input: secret },
					],
					children: [{ toolCalls: [call] }],
				},
			],
			orphanChildren: [
				{
					contentJson: [{ type: "tool_result", tool_use_id: f.toolUseId, content: secret }],
					contentText: secret,
				},
			],
			subagentActivities: [{ activity: { latestToolCalls: [call] } }],
		};
		assertStatic(projectPublicNarratorEvent(f.narratorId, payload));
		assertStatic(
			projectPublicNarratorEvent(f.narratorId, { type: "streaming_snapshot", toolChunks: [call] }),
		);
		expect(JSON.stringify(payload)).toContain(secret);
	});

	test("persisted identity wins over a misleading block name or forged public flag", async () => {
		const f = await fixture();
		assertStatic(
			projectPublicNarratorPayload(f.narratorId, {
				contentJson: [
					{
						type: "tool_use",
						id: f.toolUseId,
						tcId: f.toolCallId,
						name: "Bash",
						input: { privacy: "public", source: secret },
					},
				],
			}),
		);
	});

	test("id-only output is denied after a fresh/reconnecting subscription", async () => {
		const f = await fixture();
		expect(
			projectPublicNarratorEvent(f.narratorId, {
				type: "tool_output",
				toolUseId: f.toolUseId,
				output: secret,
			}),
		).toBeNull();
		assertStatic(
			projectPublicNarratorEvent(f.narratorId, {
				type: "tool_completed",
				toolUseId: f.toolUseId,
				output: secret,
			}),
		);
		expect(isPublicToolSourceAllowed(f.narratorId, { toolUseId: f.toolUseId })).toBe(false);
		const other = await fixture("Bash");
		const event = { type: "tool_output", toolUseId: other.toolUseId, output: secret };
		expect(projectPublicNarratorEvent(other.narratorId, event)).toBe(event);
		// Already-authorized parent/fork frames can carry a child/original tool ID.
		expect(projectPublicNarratorEvent(generateId(), event)).toBe(event);
		expect(
			projectPublicNarratorEvent(generateId(), {
				type: "tool_output",
				toolUseId: f.toolUseId,
				output: secret,
			}),
		).toBeNull();
	});

	test("all live source/permission paths deny UI while trusted pre-persistence Write stays readable", () => {
		const narratorId = generateId();
		const toolUseId = generateId();
		rememberPublicToolIdentity(narratorId, { toolUseId, toolName: "IntelligentUI" });
		for (const type of [
			"tool_use_chunk",
			"tool_output",
			"tool_structured_progress",
			"permission_resolved",
		]) {
			expect(
				projectPublicNarratorEvent(narratorId, { type, toolUseId, output: secret }),
			).toBeNull();
		}
		expect(
			projectPublicNarratorEvent(narratorId, {
				type: "permission_request",
				request: { toolUseId, toolName: "IntelligentUI", input: secret },
			}),
		).toBeNull();
		rememberPublicToolIdentity(narratorId, { toolUseId, toolName: "Write" });
		expect(isPublicToolSourceAllowed(narratorId, { toolUseId })).toBe(false);
		const writeId = generateId();
		rememberPublicToolIdentity(narratorId, { toolUseId: writeId, toolName: "Write" });
		expect(isPublicToolSourceAllowed(narratorId, { toolUseId: writeId })).toBe(true);
		expect(isPublicToolSourceAllowed(generateId(), { toolUseId: writeId })).toBe(false);
	});

	test("unknown identities fail closed without caching absence, and cache eviction cannot expose UI", async () => {
		const f = await fixture();
		for (let i = 0; i < 4200; i++)
			rememberPublicToolIdentity(f.narratorId, { toolUseId: `unused-${i}`, toolName: "Write" });
		expect(isPublicToolSourceAllowed(f.narratorId, { toolUseId: f.toolUseId })).toBe(false);
		const pending = generateId();
		expect(isPublicToolSourceAllowed(f.narratorId, { toolUseId: pending })).toBe(false);
		rememberPublicToolIdentity(f.narratorId, { toolUseId: pending, toolName: "Write" });
		expect(isPublicToolSourceAllowed(f.narratorId, { toolUseId: pending })).toBe(true);
	});

	test("a large ordinary tool snapshot stays intact with batched identity reads", async () => {
		const f = await fixture("Bash");
		const toolCalls = Array.from({ length: 300 }, () => ({
			id: generateId(),
			toolUseId: generateId(),
			toolName: "Bash",
			outputJson: secret,
		}));
		db.insert(narratorToolCalls)
			.values(
				toolCalls.map((call) => ({
					...call,
					narratorId: f.narratorId,
					messageId: f.messageId,
					status: "success" as const,
					createdAt: now,
				})),
			)
			.run();
		const snapshot = { toolCalls };
		const select = spyOn(db, "select");
		try {
			expect(projectPublicNarratorPayload(f.narratorId, snapshot)).toBe(snapshot);
			expect(select.mock.calls.length).toBe(3);
		} finally {
			select.mockRestore();
		}
	});

	test("projection work and deep malformed event payloads are bounded", () => {
		let value: unknown = { toolName: "IntelligentUI", toolUseId: "private", input: secret };
		for (let i = 0; i < 70; i++) value = { children: [value] };
		expect(projectPublicNarratorEvent("scope", { type: "message", message: value })).toBeNull();
	});
});
