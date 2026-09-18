/**
 * The wrapper-equivalence suite, run against the PRODUCTION SQLite classes.
 *
 * This is the equivalence baseline: the shared scenarios in
 * `tests/server/services/write-counterparts/equivalence-suite.ts` drive the five
 * atomicity wrappers through backend-agnostic facades, here implemented by
 * `tests/server/services/write-counterparts/sqlite-kit.ts` over the production
 * classes. The PostgreSQL runner
 * (`tests/server/services/write-counterparts/pg-equivalence.test.ts`) runs the
 * same scenarios over the PG counterparts and asserts its projections DEEP-EQUAL
 * the ones produced by the same factory here.
 *
 * ISOLATION: the isolated database from `tests/preload.ts` (temp NARRAFORK_HOME).
 */
import { describe, test } from "bun:test";
import {
	blobCatalogScenario,
	evidenceScenario,
	revertFlowScenario,
	workspaceLeaseScenario,
} from "../../../tests/server/services/write-counterparts/equivalence-suite";
import { makeSqliteKit } from "../../../tests/server/services/write-counterparts/sqlite-kit";
import { db } from "../../db";

describe("wrapper equivalence (SQLite baseline)", () => {
	test("blob catalog", async () => {
		await blobCatalogScenario(makeSqliteKit(db));
	});

	test("workspace lease lifecycle", async () => {
		await workspaceLeaseScenario(makeSqliteKit(db));
	});

	test("evidence store", async () => {
		await evidenceScenario(makeSqliteKit(db));
	});

	test("revert plan + mutation journal", async () => {
		await revertFlowScenario(makeSqliteKit(db));
	});
});
