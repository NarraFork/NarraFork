import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `ctx.updateExecutionLease.transfer()` opts a tool OUT of the executor's automatic
 * release (`tool-executor.ts`: `finally { if (!updateLeaseTransferred) release() }`).
 * It does not hand the lease to anybody — it only stops the one release that was
 * guaranteed. So a tool that calls it takes on the duty of naming a new owner.
 *
 * TransferFile called `transfer()` with no owner anywhere: the background transfer
 * runner has no concept of a lease. The leaked entry then counted as "ordinary" work
 * forever (TransferFile matches no branch of `classifyToolUpdateExecution`), so
 * `waitForOrdinaryToolDrain()` — awaited by every scheduled update — could never
 * resolve again. One background transfer disabled updates for the process lifetime.
 *
 * Nothing reported this. The tool returned success, the transfer completed normally,
 * and the damage was visible only as updates that silently never applied. That is why
 * this is a source-level guard: there is no runtime signal to assert on.
 */

const TOOLS_DIR = join(import.meta.dir, "..");

/** Tools allowed to transfer, each with the owner that releases in its place. */
const OWNERS: Record<string, string> = {
	// Releases in its own fire-and-forget `finally` once the background shell exits.
	"bash.ts": "ctx.updateExecutionLease?.release()",
	// Hands the lease object itself to `runSubagent`, which claims it.
	"task.ts": "updateExecutionLease,",
};

function toolSources(): { file: string; src: string }[] {
	return readdirSync(TOOLS_DIR)
		.filter((f) => f.endsWith(".ts"))
		.map((file) => ({ file, src: readFileSync(join(TOOLS_DIR, file), "utf8") }));
}

describe("update execution lease ownership", () => {
	it("lets no tool transfer the lease without a named releaser", () => {
		const offenders: string[] = [];
		for (const { file, src } of toolSources()) {
			// `.transfer(` rather than the full expression: the point is to catch the call
			// however it is written, including through a local alias.
			if (!/updateExecutionLease[\s\S]{0,40}?\.transfer\(/.test(src)) continue;
			const owner = OWNERS[file];
			if (!owner) {
				offenders.push(`${file}: transfers the lease but is not a registered owner`);
				continue;
			}
			if (!src.includes(owner)) {
				offenders.push(`${file}: registered owner released via \`${owner}\`, which is gone`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("keeps TransferFile off the transfer path entirely", () => {
		// Pinned separately from the sweep above: re-adding `transfer()` here is the exact
		// regression, and a future edit to OWNERS must not be able to bless it silently.
		// A background transfer needs no lease — its durable owner is the committed task
		// row, and `recoverStaleTasksAfterRestart` resumes it from its `.nfpart` offset.
		const src = readFileSync(join(TOOLS_DIR, "transfer-file.ts"), "utf8");
		expect(src).not.toMatch(/updateExecutionLease[\s\S]{0,40}?\.transfer\(/);
		expect(OWNERS["transfer-file.ts"]).toBeUndefined();
	});

	it("still has the executor-side release the sweep depends on", () => {
		// If this `finally` ever stops releasing, every non-transferring tool leaks and
		// the sweep above would be guarding a mechanism that no longer exists.
		const executor = readFileSync(join(TOOLS_DIR, "..", "tool-executor.ts"), "utf8");
		expect(executor).toContain("if (!updateLeaseTransferred) updateExecutionLease.release();");
	});
});
