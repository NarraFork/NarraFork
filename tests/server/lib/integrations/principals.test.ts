import { describe, expect, test } from "bun:test";
import {
	assertPrincipalRef,
	principalRefKey,
	principalRefSchema,
} from "@server/lib/integrations/principals";

describe("integration principal refs", () => {
	test("validates identified and system principals strictly", () => {
		expect(assertPrincipalRef({ type: "oauth_grant", id: "grant-1" })).toEqual({
			type: "oauth_grant",
			id: "grant-1",
		});
		expect(assertPrincipalRef({ type: "system" })).toEqual({ type: "system" });
		expect(principalRefSchema.safeParse({ type: "plugin_background" }).success).toBe(false);
		expect(principalRefSchema.safeParse({ type: "system", id: "root" }).success).toBe(false);
		expect(
			principalRefSchema.safeParse({ type: "user", id: "user-1", role: "admin" }).success,
		).toBe(false);
	});

	test("builds stable non-secret keys", () => {
		expect(principalRefKey({ type: "user", id: "user-1" })).toBe("user:user-1");
		expect(principalRefKey({ type: "system" })).toBe("system");
	});
});
