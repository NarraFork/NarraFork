import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "../../../server/app";
import { db, sqlite } from "../../../server/db";
import { getDbPath } from "../../../server/db/connection";
import * as schema from "../../../server/db/schema";
import { createServerRequestDispatcher } from "../../../server/http-dispatcher";
import { createServerRequestLifecycle } from "../../../server/http-request-lifecycle";
import { createToken } from "../../../server/lib/auth";
import { settings } from "../../../server/lib/settings";
import { injectSpaBaseHref, spaIndexHeaders } from "../../../server/lib/spa-base-href";
import { createStartupReadinessGate } from "../../../server/lib/startup-readiness";
import { backgroundOccupancyStore } from "../../../server/services/background-occupancy-store";
import { type WSData, wsHandlers } from "../../../server/websocket/ws-handler";
import { testEnvironment } from "../../../tests/preload";
import { cleanDb } from "../../../tests/setup";

// No test router/auth middleware, mocked projections, component substitutes, or API
// interception: the shipped SPA talks to the real application/ACL/DB workers.
export const frontendDist = fileURLToPath(new URL("../../../dist/frontend/", import.meta.url));
export const modelCount = 1200;
export const bulkySentinel = "BUDGET_UNRELATED_DATA_";
export interface RestArrival {
	method: string;
	path: string;
	startedAt: number;
	endedAt: number;
	status: number;
	bytes: number;
	body?: string;
}

export async function createSwitchBudgetFixture() {
	if (process.env.NARRAFORK_TEST !== "1") throw new Error("Requires test preload isolation");
	const home = realpathSync(testEnvironment.narraforkHome);
	if (!resolve(getDbPath()).startsWith(`${home}/`)) throw new Error("DB is not in test HOME");
	if (resolve(frontendDist) !== resolve(import.meta.dir, "../../../dist/frontend"))
		throw new Error("Only this worktree's frontend build is allowed");
	const repo = mkdtempSync(join(testEnvironment.isolatedHome, "switch-budget-repo-"));
	const init = Bun.spawnSync(["git", "init", "--quiet", repo]);
	if (init.exitCode !== 0) throw new Error(init.stderr.toString());
	const suffix = crypto.randomUUID().slice(0, 8);
	const userId = `budget-user-${suffix}`;
	const ids = [`budget-a-${suffix}`, `budget-b-${suffix}`];
	const now = new Date().toISOString();
	const model = "budget:fixture-0000";
	settings.agent.defaultModel = model;
	settings.agent.summaryModel = model;
	settings.agent.defaultSystemPrompt = bulkySentinel.repeat(24_000);
	settings.agent.customModels = Array.from({ length: modelCount }, (_, index) => ({
		value: `budget:fixture-${String(index).padStart(4, "0")}`,
		label: `Budget model ${String(index).padStart(4, "0")}`,
	}));
	settings.customApiProviders = [
		{
			id: "budget-provider",
			name: "Budget isolated provider",
			prefix: "budget",
			apiKey: "dummy-test-only-never-transmitted",
			baseUrl: "http://127.0.0.1:9/never-model-network",
			defaultModel: "fixture-0000",
			protocol: "completions-compatible",
		},
	];
	settings.paths.defaultProjectDir = repo;
	db.insert(schema.users)
		.values({
			id: userId,
			username: userId,
			role: "admin",
			passwordHash: "not-a-login-password",
			createdAt: now,
		})
		.run();
	db.insert(schema.userPreferences)
		.values({
			id: `prefs-${suffix}`,
			userId,
			language: "en",
			setupWizardCompleted: true,
			commands: JSON.stringify([{ name: "large", prompt: bulkySentinel.repeat(16_000) }]),
			gatewayConfig: JSON.stringify({ ignored: bulkySentinel.repeat(16_000) }),
			recentTabs: JSON.stringify(
				Array.from({ length: 1200 }, (_, index) => ({
					type: "narrator",
					id: `legacy-unrelated-${index}`,
					title: bulkySentinel.repeat(20),
					lastVisitedAt: index,
				})),
			),
			specTabLayout: JSON.stringify(
				Object.fromEntries(
					Array.from({ length: 1000 }, (_, index) => [
						`unrelated-${index}`,
						{ order: [bulkySentinel.repeat(10)], pinned: [] },
					]),
				),
			),
			createdAt: now,
			updatedAt: now,
		})
		.run();
	// Mark legacy sidebar migration complete. Keep the deliberately huge legacy
	// column for the UI projection test without asking the sidebar to display it.
	db.insert(schema.userRecentTabsMeta)
		.values({
			userId,
			revision: 1,
			foldersMigrated: true,
			migratedAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	for (const [index, id] of ids.entries()) {
		db.insert(schema.narrators)
			.values({
				id,
				title: `Budget narrator ${index ? "B" : "A"}`,
				handle: `budget-${suffix}-${index}`,
				handleFold: `budget-${suffix}-${index}`,
				traits: ["named"],
				ownerUserId: userId,
				visibility: "private",
				writeAudience: "owner",
				model,
				cwd: repo,
				messageCount: 60,
				lastMessageAt: now,
				status: "idle",
				permissionMode: "bypassPermissions",
				createdAt: now,
				updatedAt: now,
			} satisfies typeof schema.narrators.$inferInsert)
			.run();
		db.insert(schema.userRecentTabs)
			.values({
				id: `tab-${id}`,
				userId,
				tabKey: `narrator:${id}`,
				section: "work",
				type: "narrator",
				entityId: id,
				narratorId: id,
				representedNarratorId: id,
				title: `Budget narrator ${index ? "B" : "A"}`,
				sortOrder: index,
				lastVisitedAt: Date.now() - index,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		for (let seq = 1; seq <= 60; seq++) {
			const messageId = `${id}-message-${seq}`;
			const text =
				seq === 60
					? `BUDGET_BODY_${index ? "B" : "A"}_TAIL`
					: `Necessary body ${seq}: ${"body content ".repeat(100)}`;
			db.insert(schema.narratorMessages)
				.values({
					id: messageId,
					narratorId: id,
					role: seq % 2 ? "user" : "assistant",
					contentJson: [{ type: "text", text }],
					contentText: text,
					createdAt: now,
				})
				.run();
			db.insert(schema.narratorMessageRefs)
				.values({ id: `ref-${messageId}`, narratorId: id, messageId, seq })
				.run();
		}
	}
	await backgroundOccupancyStore.start();
	backgroundOccupancyStore.refreshNarrators(ids);
	await backgroundOccupancyStore.flush();
	const token = await createToken(userId);
	const lifecycle = createServerRequestLifecycle();
	const readiness = createStartupReadinessGate();
	readiness.markReady();
	readiness.settle({ ok: true });
	const dispatch = createServerRequestDispatcher({
		app,
		lifecycle,
		startupReadiness: readiness,
		activeDatabaseBackend: "sqlite",
	});
	const requests: RestArrival[] = [];
	const blockedOutbound: string[] = [];
	const originalFetch = globalThis.fetch;
	// Fail closed before any accidental provider/updater egress. This is not an API
	// response mock: browser REST and all tested production projections remain real.
	globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const target = new URL(
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
		);
		if (target.origin !== server.url.origin) {
			blockedOutbound.push(target.origin + target.pathname);
			return Promise.reject(new Error("External network forbidden in switch budget fixture"));
		}
		return originalFetch(input, init);
	}) as typeof fetch;
	const server = Bun.serve<WSData>({
		hostname: "127.0.0.1",
		port: 0,
		websocket: wsHandlers,
		async fetch(request, bunServer) {
			const url = new URL(request.url);
			if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/ws/")) {
				const path = resolve(frontendDist, `.${url.pathname}`);
				if (!path.startsWith(`${resolve(frontendDist)}/`))
					return new Response(null, { status: 404 });
				const file = Bun.file(path);
				if (await file.exists()) return new Response(file);
				if (!url.pathname.includes("."))
					return new Response(
						injectSpaBaseHref(
							await Bun.file(join(frontendDist, "index.html")).text(),
							url.pathname,
						),
						{
							headers: spaIndexHeaders(url.pathname),
						},
					);
				return new Response(null, { status: 404 });
			}
			if (url.pathname.startsWith("/ws/")) return dispatch(request, bunServer);
			const record: RestArrival = {
				method: request.method,
				path: url.pathname + url.search,
				startedAt: performance.now(),
				endedAt: 0,
				status: 0,
				bytes: 0,
			};
			requests.push(record);
			// The update subsystem is outside the measured business contract and
			// otherwise contacts the public update service. Never invoke that service.
			const response =
				url.pathname === "/api/update/check"
					? Response.json({ updateAvailable: false, currentVersion: "0.0.0-test" })
					: await dispatch(request, bunServer);
			if (!response) throw new Error("Unexpected REST upgrade");
			const body = await response.clone().text();
			record.endedAt = performance.now();
			record.status = response.status;
			record.bytes = new TextEncoder().encode(body).byteLength;
			if (
				/settings\/runtime|user-preferences\/ui|model-catalog\/(runtime|options)|\/ui-summary|\/api\/narrators\/[^/]+$/.test(
					url.pathname,
				)
			)
				record.body = body;
			return response;
		},
	});
	return {
		ids,
		userId,
		token,
		repo,
		requests,
		blockedOutbound,
		url: server.url.origin,
		async close() {
			globalThis.fetch = originalFetch;
			lifecycle.stopAccepting();
			lifecycle.abortAll();
			await server.stop(true);
			await lifecycle.drain();
			await backgroundOccupancyStore.stop();
			backgroundOccupancyStore.resetForTests();
			// The file is preload-owned and --isolate is mandatory: do not leave
			// the contract case's fake account/narrators visible to the SPA case.
			cleanDb(sqlite);
			rmSync(repo, { recursive: true, force: true });
		},
		isolation: {
			database: getDbPath(),
			home,
			users: sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM users").get()
				?.count,
		},
	};
}
