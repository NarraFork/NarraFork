import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { HelperSource } from "../../../shared/helper-distribution";
import {
	EXECUTOR_MANIFEST_FILENAME,
	EXECUTOR_PLATFORMS,
	executorPublishedFilename,
} from "../../../shared/remote-executor";
import { db } from "../../db";
import { remoteDevices } from "../../db/schema";
import { deviceRoutes } from "../../routes/devices";
import { buildAppErrorResponse } from "../app-error-response";
import {
	freezeExecutorArtifact,
	getExecutorManifest,
	resetExecutorManifestCache,
} from "../executor-binaries";
import {
	countLiveExecutorTickets,
	issueExecutorTicket,
	redeemExecutorTicket,
	resetExecutorTickets,
} from "../executor-bootstrap-ticket";
import * as installCa from "../executor-install-ca";
import { HELPER_BIN_DIR } from "../helper-binaries";
import * as distribution from "../helper-distribution-runtime";
import { generateId } from "../id";
import { setOutboundFetchOverrideForTest } from "../net/outbound-fetch";
import { settings } from "../settings";
import { DEFAULT_UPDATE_SETTINGS } from "../settings/update-source";
import { APP_VERSION } from "../version";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function manifest() {
	return {
		version: APP_VERSION,
		protocolVersion: 1,
		releasedAt: "2026-01-01T00:00:00Z",
		platforms: Object.fromEntries(
			EXECUTOR_PLATFORMS.map((platform) => [
				platform,
				{
					filename: executorPublishedFilename(APP_VERSION, platform),
					size: 256,
					sha256: "a".repeat(64),
				},
			]),
		),
	};
}
const originalUpdate = settings.update;
const originalReadLocal = distribution.readLocalDistributionJson;
const deviceIds: string[] = [];
const calls: string[] = [];
const gates: (() => void)[] = [];
function selectSource(source: HelperSource) {
	settings.update = {
		...DEFAULT_UPDATE_SETTINGS,
		...source,
		...(source.source === "github" ? { githubRepository: source.repository } : {}),
		proxy: { mode: "direct" },
	};
}
function sourceA(kind: "github" | "update-server"): HelperSource {
	return kind === "github"
		? { source: "github", repository: "fork/repo-a" }
		: { source: "update-server", serverUrl: "https://server-a.example" };
}
function sourceB(kind: "github" | "update-server"): HelperSource {
	return kind === "github"
		? { source: "github", repository: "fork/repo-b" }
		: { source: "update-server", serverUrl: "https://server-b.example" };
}
function offlineFixture(source: HelperSource) {
	const tag = source.source === "github" ? `executor-v${APP_VERSION}` : "legacy-tools";
	const value =
		source.source === "github"
			? {
					schemaVersion: 1,
					repository: source.repository,
					tag,
					commit: "a".repeat(40),
					manifest: manifest(),
					licenses: [{ name: "LICENSE.txt", size: 10, sha256: "a".repeat(64) }],
				}
			: manifest();
	const path = distribution.distributionPath(source, `${tag}\0${APP_VERSION}\0${1}\0manifest`);
	writeFileSync(path, JSON.stringify(value));
	return path;
}
function delayRealOfflineRead(path: string) {
	const started = deferred<void>();
	const resume = deferred<void>();
	gates.push(() => resume.resolve());
	spyOn(distribution, "readLocalDistributionJson").mockImplementation(async (actualPath) => {
		const value = await originalReadLocal(actualPath); // Real bounded disk read and JSON parsing.
		if (actualPath === path) {
			started.resolve();
			await resume.promise;
		}
		return value;
	});
	return { started: started.promise, resume: () => resume.resolve() };
}
function app() {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: "user-owner", role: "admin", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.route("/api/devices", deviceRoutes);
	instance.onError(
		(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: error.message }, 500),
	);
	return instance;
}
async function createDevice() {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(remoteDevices).values({
		id,
		name: `Fixture ${id}`,
		slug: `fixture-${id.toLowerCase()}`,
		tokenHash: "0".repeat(64),
		tokenPrefix: "rdev_test",
		connectionMode: "reverse",
		scope: "global",
		createdBy: "user-owner",
		createdAt: now,
		updatedAt: now,
	});
	deviceIds.push(id);
	return id;
}
function generate(id: string, signal: AbortSignal) {
	return app().request(
		new Request(`https://nf.example/api/devices/${id}/install-script`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				platform: "linux-amd64",
				mode: "user",
				serverBaseUrl: "https://nf.example",
				tokenDelivery: "prompt",
			}),
			signal,
		}),
	);
}
beforeEach(() => {
	calls.length = 0;
	resetExecutorManifestCache();
	resetExecutorTickets();
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
	mkdirSync(distribution.DISTRIBUTION_CACHE_DIR, { recursive: true });
	setOutboundFetchOverrideForTest(async (input) => {
		calls.push(String(input));
		return new Response(null, { status: 404 });
	});
});
afterEach(async () => {
	for (const resume of gates.splice(0)) resume();
	mock.restore();
	setOutboundFetchOverrideForTest(null);
	settings.update = originalUpdate;
	resetExecutorManifestCache();
	resetExecutorTickets();
	if (deviceIds.length)
		await db.delete(remoteDevices).where(inArray(remoteDevices.id, deviceIds.splice(0)));
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
});
describe("executor manifest completion and new-ticket boundaries", () => {
	for (const kind of ["github", "update-server"] as const) {
		for (const transition of ["source change", "cancel"] as const) {
			test(`${kind}: offline read in flight followed by ${transition} issues no ticket or artifact`, async () => {
				const source = sourceA(kind);
				selectSource(source);
				const path = offlineFixture(source);
				const read = delayRealOfflineRead(path);
				const id = await createDevice();
				const controller = new AbortController();
				const response = generate(id, controller.signal);
				await read.started;
				if (transition === "source change") selectSource(sourceB(kind));
				else controller.abort(new Error("offline manifest request canceled"));
				read.resume();
				expect((await response).status).toBeGreaterThanOrEqual(400);
				expect(countLiveExecutorTickets()).toBe(0);
				expect(calls).toHaveLength(1);
				expect(calls.every((url) => url.endsWith(EXECUTOR_MANIFEST_FILENAME))).toBe(true);
			});
		}
	}
	for (const transition of ["source change", "cancel"] as const) {
		test(`after manifest freezing, a ${transition} during CA resolution cannot mint a new ticket`, async () => {
			const source = sourceA("github");
			selectSource(source);
			offlineFixture(source);
			const entered = deferred<void>();
			const resume = deferred<void>();
			gates.push(() => resume.resolve());
			spyOn(installCa, "resolveExecutorInstallCa").mockImplementation(async () => {
				entered.resolve();
				await resume.promise;
				return undefined;
			});
			const id = await createDevice();
			const controller = new AbortController();
			const response = generate(id, controller.signal);
			await entered.promise;
			if (transition === "source change") selectSource(sourceB("github"));
			else controller.abort(new Error("install request canceled before ticket mint"));
			resume.resolve();
			expect((await response).status).toBeGreaterThanOrEqual(400);
			expect(countLiveExecutorTickets()).toBe(0);
			expect(calls).toHaveLength(1);
			expect(calls[0]).toEndWith(EXECUTOR_MANIFEST_FILENAME);
		});
	}
	test("a previously returned manifest or unissued binding cannot create a ticket after switching source", async () => {
		const source = sourceA("github");
		selectSource(source);
		offlineFixture(source);
		const value = await getExecutorManifest();
		if (!value) throw new Error("Missing fixture manifest");
		const binding = freezeExecutorArtifact(value, "linux-amd64");
		selectSource(sourceB("github"));
		expect(() => freezeExecutorArtifact(value, "linux-amd64")).toThrow("source changed");
		expect(() => issueExecutorTicket("linux-amd64", { artifact: binding })).toThrow(
			"source changed",
		);
		expect(countLiveExecutorTickets()).toBe(0);
		expect(calls).toHaveLength(1);
	});
	test("the mint-time source guard does not invalidate an already issued immutable ticket", async () => {
		const source = sourceA("github");
		selectSource(source);
		offlineFixture(source);
		const value = await getExecutorManifest();
		if (!value) throw new Error("Missing fixture manifest");
		const ticket = issueExecutorTicket("linux-amd64", {
			artifact: freezeExecutorArtifact(value, "linux-amd64"),
		});
		selectSource(sourceB("github"));
		const redemption = redeemExecutorTicket(ticket.ticket, "linux-amd64", "binary");
		expect(redemption.ok).toBe(true);
		expect(redemption.artifact?.source).toEqual(source);
		expect(calls).toHaveLength(1);
	});
});
