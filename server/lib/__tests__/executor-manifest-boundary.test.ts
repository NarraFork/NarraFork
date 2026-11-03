import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { HelperSource } from "../../../shared/helper-distribution";
import {
	EXECUTOR_MANIFEST_FILENAME,
	EXECUTOR_PLATFORMS,
	type ExecutorPlatform,
	executorPublishedFilename,
} from "../../../shared/remote-executor";
import { db } from "../../db";
import { remoteDevices } from "../../db/schema";
import { deviceRoutes } from "../../routes/devices";
import { buildAppErrorResponse } from "../app-error-response";
import {
	type ExecutorArtifactBinding,
	freezeExecutorArtifact,
	getExecutorManifest,
	resetExecutorManifestCache,
} from "../executor-binaries";
import {
	attachExecutorTicketScripts,
	countLiveExecutorTickets,
	issueExecutorGroupTicket,
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
import { BUILD_EXECUTOR_DISTRIBUTION } from "../version";

const EXECUTOR_VERSION = BUILD_EXECUTOR_DISTRIBUTION.version;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function manifest() {
	return {
		version: EXECUTOR_VERSION,
		protocolVersion: 1,
		releasedAt: "2026-01-01T00:00:00Z",
		platforms: Object.fromEntries(
			EXECUTOR_PLATFORMS.map((platform) => [
				platform,
				{
					filename: executorPublishedFilename(EXECUTOR_VERSION, platform),
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
		githubRepository:
			source.source === "github"
				? source.repository
				: source.serverUrl.includes("server-b")
					? "fork/repo-b"
					: "fork/repo-a",
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
function offlineFixture(_source: HelperSource) {
	const tag = `executor-v${EXECUTOR_VERSION}`;
	const canonical = distribution.captureHelperSource();
	if (canonical.source !== "github") throw new Error("Expected GitHub authority");
	const value = {
		schemaVersion: 1,
		repository: canonical.repository,
		tag,
		commit: "a".repeat(40),
		manifest: manifest(),
		licenses: [{ name: "LICENSE.txt", size: 10, sha256: "a".repeat(64) }],
	};
	const path = distribution.distributionPath(
		canonical,
		`${tag}\0${EXECUTOR_VERSION}\0${1}\0manifest`,
	);
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
				target: "unix",
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
async function groupBindings(kind: "github" | "update-server" = "github") {
	const source = sourceA(kind);
	selectSource(source);
	offlineFixture(source);
	const value = await getExecutorManifest();
	if (!value) throw new Error("Missing fixture manifest");
	return Object.fromEntries(
		EXECUTOR_PLATFORMS.map((platform) => [platform, freezeExecutorArtifact(value, platform)]),
	) as Record<ExecutorPlatform, ExecutorArtifactBinding>;
}

const LINUX_SCRIPT = { body: "linux body", filename: "linux.sh", shell: "sh" as const };
const MAC_SCRIPT = { body: "mac body", filename: "mac.sh", shell: "sh" as const };

describe("executor group ticket binding", () => {
	test("serves only the correct published script and binary for each variant", async () => {
		const bindings = await groupBindings();
		const issued = issueExecutorGroupTicket("unix", {
			"linux-amd64": bindings["linux-amd64"],
			"darwin-arm64": bindings["darwin-arm64"],
		});
		expect(issued).not.toHaveProperty("platform");
		attachExecutorTicketScripts(issued.ticket, {
			"linux-amd64": LINUX_SCRIPT,
			"darwin-arm64": MAC_SCRIPT,
		});
		for (const [platform, script] of [
			["linux-amd64", LINUX_SCRIPT],
			["darwin-arm64", MAC_SCRIPT],
		] as const) {
			expect(redeemExecutorTicket(issued.ticket, platform, "script").script).toEqual(script);
			expect(redeemExecutorTicket(issued.ticket, platform, "binary").artifact).toEqual(
				bindings[platform],
			);
		}
	});

	test("cross-group and unpublished platforms reject without consuming shared retry budgets", async () => {
		const bindings = await groupBindings();
		const issued = issueExecutorGroupTicket(
			"unix",
			{
				"linux-amd64": bindings["linux-amd64"],
				"darwin-arm64": bindings["darwin-arm64"],
			},
			{ allowTokenDelivery: true },
		);
		attachExecutorTicketScripts(issued.ticket, {
			"linux-amd64": LINUX_SCRIPT,
			"darwin-arm64": MAC_SCRIPT,
		});
		for (let i = 0; i < 6; i++) {
			for (const platform of ["windows-amd64", "linux-arm64"] as const) {
				for (const purpose of ["script", "binary", "token"] as const) {
					expect(redeemExecutorTicket(issued.ticket, platform, purpose).reason).toBe(
						"platform_mismatch",
					);
				}
			}
		}
		for (const purpose of ["script", "binary"] as const) {
			for (let i = 0; i < 5; i++) {
				const platform = i % 2 ? "linux-amd64" : "darwin-arm64";
				expect(redeemExecutorTicket(issued.ticket, platform, purpose).ok).toBe(true);
			}
			for (const platform of ["linux-amd64", "darwin-arm64"] as const) {
				expect(redeemExecutorTicket(issued.ticket, platform, purpose).reason).toBe(
					"purpose_exhausted",
				);
			}
		}
		expect(redeemExecutorTicket(issued.ticket, "darwin-arm64", "token").ok).toBe(true);
		for (const platform of ["linux-amd64", "darwin-arm64"] as const) {
			for (const purpose of ["script", "binary", "token"] as const) {
				expect(redeemExecutorTicket(issued.ticket, platform, purpose).reason).toBe("already_used");
			}
		}
	});

	test("windows variants share one credential and cannot attach cross-group scripts", async () => {
		const bindings = await groupBindings();
		const issued = issueExecutorGroupTicket(
			"windows",
			{
				"windows-amd64": bindings["windows-amd64"],
				"windows-arm64": bindings["windows-arm64"],
			},
			{ allowTokenDelivery: true },
		);
		const script = { body: "windows", filename: "install.ps1", shell: "powershell" as const };
		expect(() =>
			attachExecutorTicketScripts(issued.ticket, {
				"windows-amd64": script,
				"linux-amd64": LINUX_SCRIPT,
			}),
		).toThrow("platform mismatch");
		expect(redeemExecutorTicket(issued.ticket, "windows-amd64", "script").reason).toBe(
			"purpose_not_allowed",
		);
		attachExecutorTicketScripts(issued.ticket, {
			"windows-amd64": script,
			"windows-arm64": script,
		});
		expect(redeemExecutorTicket(issued.ticket, "windows-arm64", "script").script).toEqual(script);
		expect(redeemExecutorTicket(issued.ticket, "windows-arm64", "token").ok).toBe(true);
		expect(redeemExecutorTicket(issued.ticket, "windows-amd64", "token").reason).toBe(
			"already_used",
		);
	});

	test("copies and freezes artifacts, sources and scripts independent of input or current source", async () => {
		const bindings = await groupBindings();
		const binding = { ...bindings["linux-amd64"], source: { ...bindings["linux-amd64"].source } };
		const expected = structuredClone(binding);
		const script = { ...LINUX_SCRIPT };
		const controller = new AbortController();
		const issued = issueExecutorGroupTicket(
			"unix",
			{ "linux-amd64": binding },
			{
				signal: controller.signal,
			},
		);
		controller.abort(new Error("issuance completed; redemption remains valid"));
		attachExecutorTicketScripts(issued.ticket, { "linux-amd64": script });
		binding.filename = "tampered";
		binding.sha256 = "b".repeat(64);
		if (binding.source.source === "github") binding.source.repository = "tampered/repo";
		script.body = "tampered";
		selectSource(sourceB("github"));
		const result = redeemExecutorTicket(issued.ticket, "linux-amd64", "binary");
		expect(result.artifact).toEqual(expected);
		expect(Object.isFrozen(result.artifact)).toBe(true);
		expect(Object.isFrozen(result.artifact?.source)).toBe(true);
		const redeemedScript = redeemExecutorTicket(issued.ticket, "linux-amd64", "script").script;
		expect(redeemedScript).toEqual(LINUX_SCRIPT);
		if (redeemedScript) redeemedScript.body = "mutated response";
		expect(redeemExecutorTicket(issued.ticket, "linux-amd64", "script").script).toEqual(
			LINUX_SCRIPT,
		);
	});

	test("rejects empty groups, cross-target and key/platform mismatch before ticket registration", async () => {
		const bindings = await groupBindings();
		expect(() => issueExecutorGroupTicket("unix", {})).toThrow("requires published artifacts");
		expect(() =>
			issueExecutorGroupTicket("unix", { "windows-amd64": bindings["windows-amd64"] }),
		).toThrow("platform mismatch");
		expect(() =>
			issueExecutorGroupTicket("windows", { "linux-amd64": bindings["linux-amd64"] }),
		).toThrow("platform mismatch");
		expect(() =>
			issueExecutorGroupTicket("unix", { "linux-amd64": bindings["linux-arm64"] }),
		).toThrow("platform mismatch");
		expect(countLiveExecutorTickets()).toBe(0);
	});

	for (const field of ["version", "tag", "protocolVersion"] as const) {
		test(`rejects mixed ${field} before ticket registration`, async () => {
			const bindings = await groupBindings();
			const second = { ...bindings["darwin-arm64"] };
			if (field === "protocolVersion") second.protocolVersion += 1;
			else second[field] += "-other";
			expect(() =>
				issueExecutorGroupTicket("unix", {
					"linux-amd64": bindings["linux-amd64"],
					"darwin-arm64": second,
				}),
			).toThrow("share source/version/tag/protocol");
			expect(countLiveExecutorTickets()).toBe(0);
		});
	}

	for (const kind of ["github", "update-server"] as const) {
		for (const transition of ["source change", "cancel"] as const) {
			test(`${kind}: ${transition} before group mint prevents issuance`, async () => {
				const bindings = await groupBindings(kind);
				const controller = new AbortController();
				if (transition === "source change") selectSource(sourceB(kind));
				else controller.abort(new Error("group canceled"));
				expect(() =>
					issueExecutorGroupTicket(
						"unix",
						{
							"linux-amd64": bindings["linux-amd64"],
							"darwin-arm64": bindings["darwin-arm64"],
						},
						{ signal: controller.signal },
					),
				).toThrow();
				expect(countLiveExecutorTickets()).toBe(0);
			});
		}
	}

	for (const transition of ["source change", "cancel"] as const) {
		test(`${transition} while copying a later variant prevents partial registration`, async () => {
			const bindings = await groupBindings();
			const controller = new AbortController();
			const second = {
				...bindings["darwin-arm64"],
				get filename() {
					if (transition === "source change") selectSource(sourceB("github"));
					else controller.abort(new Error("group canceled during copy"));
					return bindings["darwin-arm64"].filename;
				},
			};
			expect(() =>
				issueExecutorGroupTicket(
					"unix",
					{
						"linux-amd64": bindings["linux-amd64"],
						"darwin-arm64": second,
					},
					{ signal: controller.signal },
				),
			).toThrow();
			expect(countLiveExecutorTickets()).toBe(0);
		});
	}
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
