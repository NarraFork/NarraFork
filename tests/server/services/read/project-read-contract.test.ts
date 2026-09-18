import { describe, expect, it } from "bun:test";
import { isReadablePrincipal } from "../../../../server/services/read/project-read-adapter";
import { withPostgres } from "../../../db/pg-test-harness";

describe("project read adapter security contract", () => {
	it("fails closed for absent or malformed principals", () => {
		expect(isReadablePrincipal({ userId: "user-1", isAdmin: false })).toBe(true);
		expect(isReadablePrincipal({ userId: "", isAdmin: false })).toBe(false);
		expect(isReadablePrincipal({ userId: undefined as unknown as string, isAdmin: false })).toBe(
			false,
		);
		expect(isReadablePrincipal(null as never)).toBe(false);
	});
});

/**
 * Where the PostgreSQL gate actually lives.
 *
 * This previously asserted that `withPostgres` reports `status: "blocked"` unless
 * `PG_INTEGRATION=1`. It does not: the harness never reads that variable, and on a machine
 * with a local `postgres:17` image it happily starts a container and returns the callback's
 * value. The assertion only passed on machines without the image, which is the wrong reason
 * to be green and would mislead anyone reading it into thinking the flag is enforced here.
 *
 * `PG_INTEGRATION` is a SUITE-level gate: `pg-project-read-parity.test.ts` consults it to
 * decide between an explicit skip and a run in which a blocked harness is a failure. What
 * the harness itself guarantees, and what is worth pinning, is that its outcome is always
 * self-describing — either the callback's value, or a status that names why PostgreSQL did
 * not run. A silent third state would let a suite report success without any PostgreSQL.
 */
describe("PostgreSQL harness outcome contract", () => {
	it("either returns the callback value or a status explaining why PostgreSQL did not run", async () => {
		const sentinel = { ran: true };
		const result = await withPostgres(async ({ port, exec }) => {
			// Reached only when a container really started, so these are real facts about it.
			expect(port).toBeGreaterThan(0);
			expect((await exec("SELECT 1;")).stdout.trim()).toBe("1");
			return sentinel;
		});

		if (result === sentinel) return;
		// Not the callback's value, so PostgreSQL did not complete the work: the harness must
		// say so in a form a caller can branch on, never an ambiguous empty/undefined result.
		expect(result).toMatchObject({ status: expect.any(String) });
		const status = (result as { status: string }).status;
		expect(["blocked", "failed"]).toContain(status);
		expect((result as { errorType: string }).errorType).toMatch(/^(environment|callback)$/);
		expect(typeof (result as { reason: string }).reason).toBe("string");
	}, 120_000);
});
