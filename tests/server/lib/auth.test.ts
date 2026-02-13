import { describe, expect, it } from "bun:test";
import { createToken, verifyToken } from "../../../server/lib/auth";

describe("JWT auth", () => {
	it("createToken returns a string", async () => {
		const token = await createToken("user-1", "admin");
		expect(typeof token).toBe("string");
		expect(token.split(".")).toHaveLength(3); // JWT has 3 parts
	});

	it("verifyToken decodes a valid token", async () => {
		const token = await createToken("user-1", "admin");
		const payload = await verifyToken(token);
		expect(payload.sub).toBe("user-1");
		expect(payload.role).toBe("admin");
		expect(payload.exp).toBeGreaterThan(payload.iat);
	});

	it("verifyToken rejects a tampered token", async () => {
		const token = await createToken("user-1", "user");
		const tampered = `${token}x`;
		expect(verifyToken(tampered)).rejects.toThrow();
	});

	it("token expiry is 7 days from now", async () => {
		const token = await createToken("user-1", "user");
		const payload = await verifyToken(token);
		const sevenDays = 7 * 24 * 60 * 60;
		expect(payload.exp - payload.iat).toBe(sevenDays);
	});
});
