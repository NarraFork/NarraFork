import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { db } from "../../server/db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
	users,
} from "../../server/db/schema";
import {
	type ProviderAdapter,
	registerExternalProviderResolver,
} from "../../server/lib/agent/provider";
import { findStagedAttachment } from "../../server/lib/attachment-staging";
import { revokeSessionToken, verifyToken } from "../../server/lib/auth";
import { generateId } from "../../server/lib/id";
import { saveUploadedMedia } from "../../server/lib/media-uploads";
import { settings } from "../../server/lib/settings";
import {
	appendLiveCompactDelta,
	finishLiveCompactProgress,
	startLiveCompactProgress,
} from "../../server/services/compact-live-state";
import { closePrefixSnapshotStore } from "../../server/services/narrator-prefix-snapshots";
import { closeNarrator } from "../../server/services/narrator-session";
import type { RemoteClient } from "../../shared/remote-access/browser-client";
import type { BusinessSocket } from "../../shared/remote-access/business-transport";
import { rowsAsHistory } from "../fixtures/model-input";
import {
	productionTestBrowserExecutable,
	startProductionRemoteTestRuntime,
	waitForProductionTest,
} from "./production-test-runtime";

const USER = "rtc_acceptance_admin";
const USERNAME = "rtc-acceptance-admin";
const PASSWORD = "isolated-rtc-test-password";
const PROJECT = generateId();
const NARRATOR = generateId();
const COMPACT = "rtc_acceptance_compact";
const MODEL = "rtcacceptance:model";
const REPLY = `真实 RTC 回复。${"跨分片长消息验证。".repeat(6000)}`;
interface PageState {
	rtc: RemoteClient;
	token: string;
	socket?: BusinessSocket;
	events: string[];
	compact?: { reader: ReadableStreamDefaultReader<Uint8Array>; controller: AbortController };
}

let modelCalls = 0;
const provider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: rowsAsHistory,
	injectSystemPrompt(history, systemPrompt) {
		history.unshift({ role: "system", content: systemPrompt });
	},
	async *chat(params) {
		modelCalls++;
		params.onRequestStart?.();
		yield { text: REPLY };
	},
	generate: async () => "RTC acceptance",
	generateWithMeta: async () => ({ text: "RTC acceptance" }),
	generateWithHistory: async () => "RTC acceptance",
};

describe("M2 real Chromium/Pion/NF application and database", () => {
	let runtime: Awaited<ReturnType<typeof startProductionRemoteTestRuntime>>;
	let browser: Browser | undefined;
	let page: Page;
	let unregister: (() => void) | undefined;
	let token = "";
	const network: string[] = [];
	const previousContinuation = settings.agent.autoContinuationMode;

	beforeAll(async () => {
		settings.agent.autoContinuationMode = "off";
		unregister = registerExternalProviderResolver({
			resolve: (name) => (name === "rtcacceptance" ? provider : null),
			listReadiness: () => [],
		});
		runtime = await startProductionRemoteTestRuntime();
		const timestamp = new Date().toISOString();
		await db.insert(users).values({
			id: USER,
			username: USERNAME,
			passwordHash: await Bun.password.hash(PASSWORD),
			role: "admin",
			createdAt: timestamp,
		});
		await db.insert(projects).values({
			id: PROJECT,
			name: "RTC acceptance project",
			gitPath: runtime.directory,
			rootKey: runtime.directory,
			ownerUserId: USER,
			visibility: "private",
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		await db.insert(narrators).values({
			id: NARRATOR,
			type: "primary",
			variant: "primary",
			traits: ["standalone"],
			title: "RTC acceptance conversation",
			model: MODEL,
			ownerUserId: USER,
			contextProjectId: PROJECT,
			permissionMode: "default",
			autoContinuationOverride: "off",
			status: "idle",
			cwd: runtime.directory,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		browser = await puppeteer.launch({
			executablePath: productionTestBrowserExecutable(),
			headless: true,
			args: ["--no-sandbox", "--disable-dev-shm-usage"],
		});
		page = await browser.newPage();
		page.setDefaultTimeout(15_000);
		page.on("request", (request) => network.push(request.url()));
		await page.goto(runtime.coordinator.origin, { waitUntil: "networkidle0" });
		await page.evaluate(async (invitation) => {
			const modulePath = "/client.js";
			const module = (await import(
				modulePath
			)) as typeof import("../../shared/remote-access/browser-client");
			const state = window as unknown as PageState;
			state.events = [];
			state.rtc = await module.RemoteClient.connect(invitation, {
				mode: "narrafork",
				allowLocalhost: true,
				expectedInstanceId: invitation.instanceId,
			});
		}, runtime.invitation);
	}, 180_000);

	afterAll(async () => {
		try {
			await browser?.close();
			closeNarrator(NARRATOR);
			await closePrefixSnapshotStore();
		} finally {
			await runtime?.stop();
			unregister?.();
			settings.agent.autoContinuationMode = previousContinuation;
		}
	});

	test("verified hello carries real NF identity; pairing alone is not business login", async () => {
		const identity = await page.evaluate(
			() => (window as unknown as PageState).rtc.backendIdentity,
		);
		expect(identity).toEqual(runtime.backend.identity);
		const denied = await page.evaluate(async () => {
			try {
				await (window as unknown as PageState).rtc.request("/api/projects");
				return false;
			} catch {
				return true;
			}
		});
		expect(denied).toBe(true);
	});

	test("the actual password route issues an opaque session over RTC", async () => {
		const result = await page.evaluate(
			async (credentials) => {
				const state = window as unknown as PageState;
				const response = await state.rtc.request("/api/auth/login", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(credentials),
				});
				if (!response.ok) throw new Error(`Login failed: ${response.status}`);
				const session = (await response.json()) as { token: string; user: { role: string } };
				await state.rtc.authenticate(session.token);
				state.token = session.token;
				return { token: session.token, role: session.user.role };
			},
			{ username: USERNAME, password: PASSWORD },
		);
		expect(result.token.startsWith("nfs_")).toBe(true);
		expect(result.role).toBe("admin");
		token = result.token;
		expect((await verifyToken(token)).sub).toBe(USER);
	});

	test("real projects and narrator routes are reachable without hosted business HTTP", async () => {
		const result = await page.evaluate(async (narratorId) => {
			const rtc = (window as unknown as PageState).rtc;
			const projects = await rtc.request("/api/projects");
			const narrator = await rtc.request(`/api/narrators/${narratorId}`);
			return {
				projectStatus: projects.status,
				projects: await projects.json(),
				narratorStatus: narrator.status,
				narrator: await narrator.json(),
			};
		}, NARRATOR);
		expect(result.projectStatus).toBe(200);
		expect(JSON.stringify(result.projects)).toContain(PROJECT);
		expect(result.narratorStatus).toBe(200);
		expect(JSON.stringify(result.narrator)).toContain(NARRATOR);
		expect(network.filter((url) => /\/api\/|\/ws\//.test(new URL(url).pathname))).toEqual([]);
	});

	test("a real message runs the deterministic provider and persists a long response", async () => {
		await page.evaluate(async (narratorId) => {
			const state = window as unknown as PageState;
			const socket = state.rtc.openSocket("/ws/narrator", state.token);
			state.socket = socket;
			socket.onmessage = (event) => {
				if (typeof event.data === "string") state.events.push(event.data);
			};
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("socket_timeout")), 15_000);
				socket.onopen = () => {
					clearTimeout(timeout);
					resolve();
				};
				socket.onerror = () => {
					clearTimeout(timeout);
					reject(new Error("socket_failed"));
				};
				socket.onclose = (event) => {
					clearTimeout(timeout);
					reject(new Error(`socket_closed:${event.code}:${event.reason}`));
				};
			});
			socket.send(
				JSON.stringify({
					type: "subscribe",
					narratorIds: [narratorId],
					kind: "messages",
					requestId: "rtc_acceptance_subscription",
				}),
			);
		}, NARRATOR);
		const response = await page.evaluate(async (narratorId) => {
			const response = await (window as unknown as PageState).rtc.request(
				`/api/narrators/${narratorId}/messages`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ message: "Return the deterministic RTC acceptance response." }),
				},
			);
			return { status: response.status, body: await response.text() };
		}, NARRATOR);
		expect([201, 202]).toContain(response.status);
		await waitForProductionTest(() => modelCalls > 0, "real model admission", 30_000);
		await waitForProductionTest(
			async () => {
				const rows = await db
					.select({ id: narratorMessages.id })
					.from(narratorMessages)
					.where(
						and(eq(narratorMessages.narratorId, NARRATOR), eq(narratorMessages.role, "assistant")),
					)
					.limit(1);
				return rows.length > 0;
			},
			"assistant persistence",
			30_000,
		);
		await page.waitForFunction(
			() =>
				(window as unknown as PageState).events.some((message) =>
					message.includes("真实 RTC 回复"),
				),
			{ timeout: 30_000 },
		);
		expect(await page.evaluate(() => (window as unknown as PageState).rtc.state)).toBe("ready");
		expect(runtime.errors).toEqual([]);
	}, 60_000);

	test("a small staged attachment keeps its filename and bytes through the real upload route", async () => {
		const content = "小附件通过真实 WebRTC 上传。".repeat(1000);
		const staged = await page.evaluate(
			async ({ narratorId, content }) => {
				const response = await (window as unknown as PageState).rtc.request(
					`/api/narrator-attachments/${narratorId}`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/octet-stream",
							"X-Attachment-Filename": encodeURIComponent("测试附件.txt"),
							"X-Attachment-Type": "text/plain",
						},
						body: new TextEncoder().encode(content),
					},
				);
				return {
					status: response.status,
					data: (await response.json()) as {
						uploadId: string;
						filename: string;
						mediaType: string;
						size: number;
					},
				};
			},
			{ narratorId: NARRATOR, content },
		);
		expect(staged.status).toBe(201);
		expect(staged.data.filename).toBe("测试附件.txt");
		expect(staged.data.mediaType).toBe("text/plain");
		expect(staged.data.size).toBe(new TextEncoder().encode(content).byteLength);
		const stored = findStagedAttachment(NARRATOR, staged.data.uploadId);
		expect(stored).not.toBeNull();
		if (!stored) throw new Error("Missing real staged attachment");
		expect(await Bun.file(stored.path).text()).toBe(content);
		const sent = await page.evaluate(
			async ({ narratorId, uploadId }) => {
				const form = new FormData();
				form.set("message", "Read this small attachment.");
				form.set("stagedAttachments", JSON.stringify([{ uploadId, index: 0 }]));
				const response = await (window as unknown as PageState).rtc.upload(
					`/api/narrators/${narratorId}/messages`,
					form,
				);
				await response.body?.cancel();
				return response.status;
			},
			{ narratorId: NARRATOR, uploadId: staged.data.uploadId },
		);
		expect([201, 202]).toContain(sent);
		await waitForProductionTest(() => modelCalls >= 2, "staged attachment model admission", 30_000);
	}, 45_000);

	test("small media downloads preserve byte identity and real 206/416 range semantics", async () => {
		const bytes = new Uint8Array(76);
		const view = new DataView(bytes.buffer);
		const ascii = (offset: number, text: string) =>
			bytes.set(new TextEncoder().encode(text), offset);
		ascii(0, "RIFF");
		view.setUint32(4, bytes.length - 8, true);
		ascii(8, "WAVE");
		ascii(12, "fmt ");
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, 8000, true);
		view.setUint32(28, 16000, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		ascii(36, "data");
		view.setUint32(40, bytes.length - 44, true);
		for (let index = 44; index < bytes.length; index++) bytes[index] = index;
		const media = await saveUploadedMedia(
			NARRATOR,
			new File([bytes], "远程测试.wav", { type: "audio/wav" }),
		);
		const downloaded = await page.evaluate(
			async ({ narratorId, mediaId }) => {
				const rtc = (window as unknown as PageState).rtc;
				const path = `/api/uploads/${narratorId}/media/${mediaId}`;
				const full = await rtc.request(path);
				const body = Array.from(new Uint8Array(await full.arrayBuffer()));
				const range = await rtc.request(path, { headers: { Range: "bytes=0-11" } });
				const rangeBody = Array.from(new Uint8Array(await range.arrayBuffer()));
				const invalid = await rtc.request(path, { headers: { Range: "bytes=10000-" } });
				await invalid.body?.cancel();
				return {
					status: full.status,
					body,
					range: range.status,
					rangeHeader: range.headers.get("content-range"),
					rangeBody,
					invalid: invalid.status,
					invalidHeader: invalid.headers.get("content-range"),
				};
			},
			{ narratorId: NARRATOR, mediaId: media.mediaId },
		);
		expect(downloaded.status).toBe(200);
		expect(downloaded.body).toEqual(Array.from(bytes));
		expect(downloaded.range).toBe(206);
		expect(downloaded.rangeHeader).toBe(`bytes 0-11/${bytes.length}`);
		expect(downloaded.rangeBody).toEqual(Array.from(bytes.slice(0, 12)));
		expect(downloaded.invalid).toBe(416);
		expect(downloaded.invalidHeader).toBe(`bytes */${bytes.length}`);
	});
	test("the real compact SSE route carries unicode progress and cancellation", async () => {
		const timestamp = new Date().toISOString();
		const [latest] = await db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, NARRATOR))
			.orderBy(desc(narratorMessageRefs.seq))
			.limit(1);
		await db.insert(narratorMessages).values({
			id: COMPACT,
			narratorId: NARRATOR,
			role: "system",
			contentJson: [{ type: "compact", status: "compacting" }],
			createdAt: timestamp,
		});
		await db.insert(narratorMessageRefs).values({
			id: `${COMPACT}_ref`,
			narratorId: NARRATOR,
			messageId: COMPACT,
			seq: (latest?.seq ?? 0) + 1,
			isCompact: 0,
		});
		startLiveCompactProgress(COMPACT, { model: MODEL, startedAt: timestamp });
		appendLiveCompactDelta(COMPACT, "output", "压缩开始", { outputChars: 4, thinkingChars: 0 });
		const result = await page.evaluate(
			async ({ narratorId, messageId }) => {
				const state = window as unknown as PageState;
				const controller = new AbortController();
				const response = await state.rtc.request(
					`/api/narrators/${narratorId}/compact/${messageId}/live`,
					{ signal: controller.signal },
				);
				if (!response.body) throw new Error("missing_sse_body");
				const reader = response.body.getReader();
				state.compact = { reader, controller };
				const first = await reader.read();
				return {
					status: response.status,
					type: response.headers.get("content-type"),
					text: new TextDecoder().decode(first.value),
				};
			},
			{ narratorId: NARRATOR, messageId: COMPACT },
		);
		expect(result.status).toBe(200);
		expect(result.type).toContain("text/event-stream");
		expect(result.text).toContain("压缩开始");
		await page.evaluate(async () => {
			const compact = (window as unknown as PageState).compact;
			compact?.controller.abort();
			await compact?.reader.cancel().catch(() => {});
		});
		finishLiveCompactProgress(COMPACT, "failed");
	});

	test("signaling loss does not revoke the established authorized RTC", async () => {
		runtime.coordinator.disconnectInstances();
		runtime.coordinator.expireLeases();
		const result = await page.evaluate(async () => {
			const response = await (window as unknown as PageState).rtc.request("/api/projects");
			await response.body?.cancel();
			return response.status;
		});
		expect(result).toBe(200);
	});

	test("real session revocation closes the peer and releases its bridge context", async () => {
		await revokeSessionToken(await verifyToken(token));
		await page.waitForFunction(() => (window as unknown as PageState).rtc.state === "closed");
		await waitForProductionTest(
			() => runtime.backend.registry.contexts.size === 0,
			"remote context revocation",
		);
		expect(network.filter((url) => /\/api\/|\/ws\//.test(new URL(url).pathname))).toEqual([]);
	});
});
