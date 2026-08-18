/**
 * The enrollment exchange — the one moment a device key crosses the wire.
 *
 * Everywhere else the key only participates in the `/ws/device` nonce/HMAC
 * handshake and never travels in plaintext. This endpoint deliberately gives that
 * up in exchange for a one-line install, so the properties that make the trade
 * acceptable are pinned here rather than trusted to review:
 *
 * 1. An unsuitable transport is refused BEFORE the ticket is spent.
 * 2. The exchange rotates the key, so the ticket is single-assignment and a
 *    duplicate redemption fails visibly instead of silently sharing a credential.
 * 3. Who collected the key is recorded.
 * 4. A revoked device cannot be enrolled.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { remoteDevices } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { issueExecutorTicket, resetExecutorTickets } from "../../lib/executor-bootstrap-ticket";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { settings } from "../../lib/settings";
import { hashDeviceToken } from "../../services/device-service";
import { executorBootstrapRoutes, resetExecutorBootstrapRateLimit } from "../executor-bootstrap";

const created: string[] = [];
let originalAllowPlaintext: boolean | undefined;

beforeEach(() => {
	resetExecutorTickets();
	resetExecutorBootstrapRateLimit();
	originalAllowPlaintext = settings.devices?.allowPlaintextEnrollmentOnPrivateNetwork;
});

afterEach(async () => {
	if (settings.devices) {
		settings.devices.allowPlaintextEnrollmentOnPrivateNetwork = originalAllowPlaintext;
	}
	if (created.length) {
		await db.delete(remoteDevices).where(inArray(remoteDevices.id, created.splice(0)));
	}
	resetExecutorTickets();
	resetExecutorBootstrapRateLimit();
});

function setAllowPlaintext(value: boolean): void {
	if (!settings.devices) return;
	settings.devices.allowPlaintextEnrollmentOnPrivateNetwork = value;
}

/**
 * The bootstrap router is public by design (a machine being enrolled has no
 * session), so no auth middleware is installed here — matching how app.ts mounts
 * it ahead of the session gate.
 */
function app(): Hono {
	const instance = new Hono();
	instance.route("/api/executor", executorBootstrapRoutes);
	instance.onError(
		(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
	);
	return instance;
}

async function makeDevice(): Promise<{ id: string; tokenHash: string }> {
	const now = new Date().toISOString();
	const id = generateId();
	const tokenHash = hashDeviceToken(`rdev_original_${id}`);
	await db.insert(remoteDevices).values({
		id,
		name: `Enroll ${id.slice(0, 6)}`,
		slug: `enroll-${id.slice(0, 8).toLowerCase()}`,
		tokenHash,
		tokenPrefix: "rdev_orig",
		connectionMode: "reverse",
		scope: "global",
		createdBy: "user-owner",
		createdAt: now,
		updatedAt: now,
	});
	created.push(id);
	return { id, tokenHash };
}

/**
 * Issue an enroll-capable ticket and POST to the endpoint through a real request,
 * so the origin the policy sees comes from the URL rather than a stub.
 */
async function enroll(
	deviceId: string,
	options: { url?: string; userAgent?: string; ticket?: string } = {},
) {
	const ticket =
		options.ticket ??
		issueExecutorTicket("linux-amd64", { deviceId, allowTokenDelivery: true }).ticket;
	const url = options.url ?? "https://nf.example.com";
	const response = await app().request(
		`${url}/api/executor/enroll/linux-amd64?ticket=${ticket}`,
		{ method: "POST", headers: options.userAgent ? { "User-Agent": options.userAgent } : {} },
		{ trustedProxy: false },
	);
	return { response, ticket };
}

describe("transport requirements", () => {
	test("https enrollment succeeds", async () => {
		const device = await makeDevice();
		const { response } = await enroll(device.id);
		expect(response.status).toBe(200);
		expect((await response.json()).token).toMatch(/^rdev_[0-9a-f]{40}$/);
	});

	test("plaintext http on a public host is refused", async () => {
		const device = await makeDevice();
		setAllowPlaintext(false);
		const { response } = await enroll(device.id, { url: "http://nf.example.com" });
		expect(response.status).toBe(403);
		expect((await response.json()).error).toContain("https");
	});

	test("plaintext http on a public host stays refused even with the opt-in on", async () => {
		// The opt-in covers private networks only. If it also unlocked routable
		// plaintext, a LAN-motivated toggle would start leaking keys over the internet.
		const device = await makeDevice();
		setAllowPlaintext(true);
		const { response } = await enroll(device.id, { url: "http://nf.example.com" });
		expect(response.status).toBe(403);
	});

	test("plaintext loopback succeeds, since nothing leaves the machine", async () => {
		const device = await makeDevice();
		setAllowPlaintext(false);
		const { response } = await enroll(device.id, { url: "http://127.0.0.1:7779" });
		expect(response.status).toBe(200);
	});

	test("plaintext on a private network follows the opt-in", async () => {
		const denied = await makeDevice();
		setAllowPlaintext(false);
		expect((await enroll(denied.id, { url: "http://192.168.1.20:7779" })).response.status).toBe(
			403,
		);

		const allowed = await makeDevice();
		setAllowPlaintext(true);
		expect((await enroll(allowed.id, { url: "http://192.168.1.20:7779" })).response.status).toBe(
			200,
		);
	});

	test("a refused transport does NOT spend the ticket", async () => {
		// Otherwise a misconfiguration would burn the operator's only-once exchange and
		// force them to regenerate the install command for a settings problem.
		const device = await makeDevice();
		setAllowPlaintext(false);
		const ticket = issueExecutorTicket("linux-amd64", {
			deviceId: device.id,
			allowTokenDelivery: true,
		}).ticket;

		expect(
			(await enroll(device.id, { url: "http://nf.example.com", ticket })).response.status,
		).toBe(403);
		// Same ticket, now over https: still good.
		expect((await enroll(device.id, { ticket })).response.status).toBe(200);
	});
});

describe("key rotation and single assignment", () => {
	test("enrollment replaces the key created at registration", async () => {
		const device = await makeDevice();
		const { response } = await enroll(device.id);
		const { token } = await response.json();

		const row = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, device.id),
		});
		// The stored hash matches the key just handed out, and not the original one.
		expect(row?.tokenHash).toBe(hashDeviceToken(token));
		expect(row?.tokenHash).not.toBe(device.tokenHash);
	});

	test("a second exchange with the same ticket fails loudly", async () => {
		const device = await makeDevice();
		const ticket = issueExecutorTicket("linux-amd64", {
			deviceId: device.id,
			allowTokenDelivery: true,
		}).ticket;
		expect((await enroll(device.id, { ticket })).response.status).toBe(200);
		// This is the property that makes a leaked install command survivable: whoever
		// runs second is told it failed rather than quietly getting a working key.
		expect((await enroll(device.id, { ticket })).response.status).toBe(403);
	});

	/**
	 * "Failing loudly" only helps if the failure is investigable. The rejected caller
	 * is the party that LOST the race, so a log holding just its address answers
	 * nothing — the question is who redeemed the command first.
	 *
	 * Asserts on what the route logs, because the 403 body is deliberately generic
	 * and the log is the only place this evidence exists.
	 */
	test("the rejection log names the client that redeemed the ticket first", async () => {
		const device = await makeDevice();
		const ticket = issueExecutorTicket("linux-amd64", {
			deviceId: device.id,
			deviceSlug: "build-box",
			allowTokenDelivery: true,
		}).ticket;

		const warnings: Array<Record<string, unknown>> = [];
		const originalWarn = logger.warn;
		logger.warn = ((message: string, meta?: Record<string, unknown>) => {
			if (message === "Rejected executor enrollment") warnings.push(meta ?? {});
		}) as typeof logger.warn;
		try {
			await enroll(device.id, { ticket, userAgent: "curl/8.5.0" });
			await enroll(device.id, { ticket, userAgent: "curl/8.5.0" });
		} finally {
			logger.warn = originalWarn;
		}

		expect(warnings).toHaveLength(1);
		const logged = warnings[0];
		expect(logged.reason).toBe("already_used");
		expect(logged.firstRedeemedByIp).toBeTruthy();
		expect(logged.firstRedeemedAt).toBeTruthy();
		// Names the affected device, so the log is actionable without a ticket lookup.
		expect(logged.device).toBe("build-box");
		// Both runs came from the same test client, so this must NOT cry wolf.
		expect(logged.redeemedByDifferentClient).toBe(false);
	});

	test("a prompt-mode ticket cannot be redeemed for a key", async () => {
		const device = await makeDevice();
		const ticket = issueExecutorTicket("linux-amd64", {
			deviceId: device.id,
			allowTokenDelivery: false,
		}).ticket;
		const response = await app().request(
			`https://nf.example.com/api/executor/enroll/linux-amd64?ticket=${ticket}`,
			{ method: "POST" },
		);
		expect(response.status).toBe(403);

		// And the device key is untouched.
		const row = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, device.id),
		});
		expect(row?.tokenHash).toBe(device.tokenHash);
	});
});

describe("provenance", () => {
	test("records when and from where the key was collected", async () => {
		const device = await makeDevice();
		await enroll(device.id, { userAgent: "curl/8.5.0" });
		const row = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, device.id),
		});
		expect(row?.enrolledAt).toBeTruthy();
		expect(row?.enrolledUserAgent).toBe("curl/8.5.0");
		// The IP is whatever the boundary resolved; it must at least be recorded.
		expect(row?.enrolledFromIp === null).toBe(false);
	});

	test("a manually enrolled device has no enrollment record", async () => {
		// Distinguishes "key pasted by a human" from "key fetched by a script", which is
		// the only signal available if a ticket is later found to have leaked.
		const device = await makeDevice();
		const row = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, device.id),
		});
		expect(row?.enrolledAt).toBeNull();
	});
});

describe("device availability", () => {
	test("a revoked device cannot be enrolled", async () => {
		// Revocation between generating the command and running it must win.
		const device = await makeDevice();
		const ticket = issueExecutorTicket("linux-amd64", {
			deviceId: device.id,
			allowTokenDelivery: true,
		}).ticket;
		await db
			.update(remoteDevices)
			.set({ revokedAt: new Date().toISOString() })
			.where(eq(remoteDevices.id, device.id));

		const { response } = await enroll(device.id, { ticket });
		expect(response.status).toBe(403);
		const row = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, device.id),
		});
		expect(row?.tokenHash).toBe(device.tokenHash);
	});
});
