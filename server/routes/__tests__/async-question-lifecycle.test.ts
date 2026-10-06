import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narratorQuestions,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import { AppError } from "../../lib/errors";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { narratorRoutes } = await import("../narrators");

const OWNER = "question-route-owner";
const VIEWER = "question-route-viewer";
const ROOT = "question-route-root";
const PUBLIC = "question-route-public";
const PRIVATE = "question-route-private";
const NOW = "2026-10-05T00:00:00.000Z";
const SECRET = "credential-only-visible-in-details";
let nextSeq = 0;

function appAs(userId = OWNER) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError(
		(error) =>
			new Response(JSON.stringify({ error: error.message }), {
				status: error instanceof AppError ? error.statusCode : 500,
				headers: { "content-type": "application/json" },
			}),
	);
	app.route("/narrators", narratorRoutes);
	return app;
}

async function seedQuestion(
	id: string,
	narratorId = ROOT,
	status: "open" | "answered" | "dismissed" | "withdrawn" = "open",
	resolved = false,
) {
	await db.insert(narratorMessages).values({
		id: `message-${id}`,
		narratorId,
		role: "assistant",
		contentJson: [],
		createdAt: NOW,
	});
	await db.insert(narratorMessageRefs).values({
		id: `ref-${id}`,
		narratorId,
		messageId: `message-${id}`,
		seq: ++nextSeq,
	});
	await db.insert(narratorToolCalls).values({
		id: `call-${id}`,
		narratorId,
		messageId: `message-${id}`,
		toolUseId: `tool-${id}`,
		toolName: "AskUserQuestion",
		status: "success",
		inputJson: { async: true, context: "采样登录，等待期间继续静态调查" },
		createdAt: NOW,
	});
	const questions = [
		{
			id: "login",
			header: "如何登录？",
			description: "为只读采样选择登录方式",
			options: [{ header: "正常登录", description: "由用户登录", preview: "large-preview" }],
		},
	];
	await db.insert(narratorQuestions).values({
		id,
		narratorId,
		toolCallId: `call-${id}`,
		toolUseId: `tool-${id}`,
		questionsJson: questions,
		summaryJson: questions.map((question) => ({
			...question,
			options: question.options.map(({ header, description }) => ({ header, description })),
		})),
		context: "采样登录，等待期间继续静态调查",
		status,
		answersJson: status === "answered" ? { login: SECRET } : null,
		answerMessageId: status === "answered" ? `answer-${id}` : null,
		resolutionJson: resolved
			? { answerMessageId: `answer-${id}`, note: "采样已结束", resolvedAt: NOW, actor: narratorId }
			: null,
		createdAt: NOW,
	});
}

beforeEach(async () => {
	await db.insert(users).values([
		{ id: OWNER, username: OWNER, passwordHash: "test", createdAt: NOW },
		{ id: VIEWER, username: VIEWER, passwordHash: "test", createdAt: NOW },
	]);
	await db.insert(narrators).values([
		{
			id: ROOT,
			ownerUserId: OWNER,
			visibility: "private",
			writeAudience: "owner",
			title: "Private owner session",
			createdAt: NOW,
			updatedAt: NOW,
		},
		{
			id: PUBLIC,
			ownerUserId: OWNER,
			visibility: "public",
			writeAudience: "owner",
			title: "Readable session",
			createdAt: NOW,
			updatedAt: NOW,
		},
		{
			id: PRIVATE,
			ownerUserId: VIEWER,
			visibility: "private",
			writeAudience: "owner",
			title: "Other private session",
			createdAt: NOW,
			updatedAt: NOW,
		},
	]);
});

afterEach(() => cleanDb(sqlite));
afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.restore();
});

describe("async question lifecycle HTTP API", () => {
	test("summary pages retain terminal cards without exposing answers or previews", async () => {
		await seedQuestion("open");
		await seedQuestion("answered", ROOT, "answered");
		const response = await appAs().request(`/narrators/${ROOT}/questions?filter=all`);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const text = await response.text();
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain("large-preview");
		const page = JSON.parse(text);
		expect(page.items.map((item: { id: string }) => item.id).sort()).toEqual(["answered", "open"]);
	});

	test("pending and history views classify current processing confirmation", async () => {
		await seedQuestion("pending", ROOT, "answered");
		await seedQuestion("handled", ROOT, "answered", true);
		await seedQuestion("skipped", ROOT, "dismissed");
		for (const [filter, expected] of [
			["pending", ["pending"]],
			["history", ["handled", "skipped"]],
		] as const) {
			const response = await appAs().request(`/narrators/${ROOT}/questions?filter=${filter}`);
			expect(response.status).toBe(200);
			const page = await response.json();
			expect(page.items.map((item: { id: string }) => item.id).sort()).toEqual([...expected]);
		}
	});

	test("global pages respect narrator read ACL and show read-only capabilities", async () => {
		await seedQuestion("owned", ROOT, "answered");
		await seedQuestion("public", PUBLIC, "answered");
		await seedQuestion("hidden", PRIVATE, "answered");
		const ownerResponse = await appAs().request("/narrators/questions?filter=pending");
		expect(ownerResponse.status).toBe(200);
		const ownerPage = await ownerResponse.json();
		expect(ownerPage.items.map((item: { id: string }) => item.id).sort()).toEqual([
			"owned",
			"public",
		]);
		const viewerResponse = await appAs(VIEWER).request("/narrators/questions?filter=pending");
		const viewerPage = await viewerResponse.json();
		const readable = viewerPage.items.find((item: { id: string }) => item.id === "public");
		expect(readable.canAct).toBe(false);
		expect(viewerPage.items.some((item: { id: string }) => item.id === "owned")).toBe(false);
	});

	test("detail reads are scoped to the authorized narrator", async () => {
		await seedQuestion("detail", PUBLIC, "answered");
		const response = await appAs(VIEWER).request(`/narrators/${PUBLIC}/questions/detail`);
		expect(response.status).toBe(200);
		const detail = await response.json();
		expect(detail.question.answers).toEqual({ login: SECRET });
		expect(detail.question.questions[0].options[0].preview).toBe("large-preview");
		expect(detail.supplements).toEqual([]);
		expect(detail.canAct).toBe(false);
		expect((await appAs().request(`/narrators/${ROOT}/questions/detail`)).status).toBe(404);
	});

	test("supplement write requires permission and matching question ownership", async () => {
		await seedQuestion("answer", PUBLIC, "answered");
		const body = { text: "更正：采用正常登录", answerMessageId: "answer-answer" };
		const request = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		};
		const denied = await appAs(VIEWER).request(
			`/narrators/${PUBLIC}/questions/answer/supplement`,
			request,
		);
		expect([403, 404]).toContain(denied.status);
		const wrongOwner = await appAs().request(
			`/narrators/${ROOT}/questions/answer/supplement`,
			request,
		);
		expect(wrongOwner.status).toBe(404);
	});

	test("supplement creates a linked user event and reopens processing confirmation", async () => {
		await seedQuestion("supplement", ROOT, "answered", true);
		const response = await appAs().request(`/narrators/${ROOT}/questions/supplement/supplement`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text: "  更正：采用正常登录。  ",
				answerMessageId: "answer-supplement",
			}),
		});
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.question.resolution).toBeNull();
		expect(result.question.answers).toEqual({ login: SECRET });
		expect(result.question.answerMessageId).not.toBe("answer-supplement");
		const detailResponse = await appAs().request(`/narrators/${ROOT}/questions/supplement`);
		const detail = await detailResponse.json();
		expect(detail.supplements).toHaveLength(1);
		expect(detail.supplements[0].text).toBe("  更正：采用正常登录。  ");
		expect(detail.supplements[0].messageId).toBe(result.question.answerMessageId);
	});

	test("a stale supplement reference returns conflict without adding a user event", async () => {
		await seedQuestion("stale", ROOT, "answered");
		const response = await appAs().request(`/narrators/${ROOT}/questions/stale/supplement`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "更正", answerMessageId: "old-answer" }),
		});
		expect(response.status).toBe(409);
		const detail = await (await appAs().request(`/narrators/${ROOT}/questions/stale`)).json();
		expect(detail.question.answerMessageId).toBe("answer-stale");
		expect(detail.supplements).toEqual([]);
	});

	test("invalid event cursors and multibyte budgets return validation errors", async () => {
		await seedQuestion("bounded", ROOT, "answered");
		expect(
			(await appAs().request(`/narrators/${ROOT}/questions/bounded?cursor=invalid`)).status,
		).toBe(400);
		const response = await appAs().request(`/narrators/${ROOT}/questions/bounded/supplement`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "中".repeat(6000) }),
		});
		expect(response.status).toBe(400);
		const detail = await (await appAs().request(`/narrators/${ROOT}/questions/bounded`)).json();
		expect(detail.question.answerMessageId).toBe("answer-bounded");
		expect(detail.supplements).toEqual([]);
	});

	test("rejects excessive page sizes and empty supplements", async () => {
		await seedQuestion("answer", ROOT, "answered");
		expect((await appAs().request(`/narrators/${ROOT}/questions?filter=all&limit=33`)).status).toBe(
			400,
		);
		expect((await appAs().request(`/narrators/${ROOT}/questions/answer?limit=33`)).status).toBe(
			400,
		);
		const response = await appAs().request(`/narrators/${ROOT}/questions/answer/supplement`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "  " }),
		});
		expect(response.status).toBe(400);
	});
});
