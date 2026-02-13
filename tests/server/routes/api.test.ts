import { describe, expect, it } from "bun:test";
import { app } from "../../../server/app";

describe("GET /api/health", () => {
	it("returns status ok", async () => {
		const res = await app.request("/api/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
	});
});

describe("GET /api/auth/status", () => {
	it("returns hasUsers and registrationOpen", async () => {
		const res = await app.request("/api/auth/status");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("hasUsers");
		expect(body).toHaveProperty("registrationOpen");
		expect(typeof body.hasUsers).toBe("boolean");
		expect(typeof body.registrationOpen).toBe("boolean");
	});
});

describe("protected routes without auth", () => {
	it("GET /api/projects returns 401", async () => {
		const res = await app.request("/api/projects");
		expect(res.status).toBe(401);
	});

	it("GET /api/chapters/fake-id returns 401", async () => {
		const res = await app.request("/api/chapters/fake-id");
		expect(res.status).toBe(401);
	});

	it("GET /api/narrators/fake-id returns 401", async () => {
		const res = await app.request("/api/narrators/fake-id");
		expect(res.status).toBe(401);
	});

	it("GET /api/settings returns 401", async () => {
		const res = await app.request("/api/settings");
		expect(res.status).toBe(401);
	});
});

describe("auth error format", () => {
	it("returns JSON error body for 401", async () => {
		const res = await app.request("/api/projects");
		const body = await res.json();
		expect(body).toHaveProperty("error");
		expect(body).toHaveProperty("code");
		expect(body.code).toBe("UNAUTHORIZED");
	});
});
