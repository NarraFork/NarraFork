import { and, eq, isNull, sql } from "drizzle-orm";
import { narrators } from "../../db/schema";
import { readQueryFirst } from "../../db/worker-read";
import { parseSubstatus } from "../../lib/narrator-utils";
import {
	committedNarratorStatusPatch,
	narratorStatusPatchColumns,
	versionNarratorStatusCommit,
} from "../narrator-status-version";
import type { RuntimeDb } from "./mailbox-types";
import { RuntimeReadConflictError } from "./read-conflict";
import type { RuntimeReadOptions } from "./read-options";
import { runAtomicWrite } from "./runtime-write";

export function createRuntimeFinalizationReads(db: RuntimeDb) {
	return {
		async restoreModel(narratorId: string, options: RuntimeReadOptions = {}) {
			const row = await readQueryFirst(
				db
					.select({ model: narrators.model, pending: narrators.pendingModelRestore })
					.from(narrators)
					.where(eq(narrators.id, narratorId))
					.limit(1),
				{ ...options, executionPolicy: "worker-required", maxRows: 1 },
			);
			if (!row?.pending) return undefined;
			const pending = row.pending;
			runAtomicWrite(db, "runtime.restoreModel", (tx) => {
				const updated = tx
					.update(narrators)
					.set({
						model: row.pending,
						pendingModelRestore: null,
						updatedAt: new Date().toISOString(),
					})
					.where(
						and(
							eq(narrators.id, narratorId),
							eq(narrators.pendingModelRestore, pending),
							row.model === null ? isNull(narrators.model) : eq(narrators.model, row.model),
						),
					)
					.returning({ id: narrators.id })
					.get();
				if (!updated) throw new RuntimeReadConflictError();
			});
			return row.pending;
		},
		async clearTransientSubstatus(narratorId: string, options: RuntimeReadOptions = {}) {
			return (await this.clearTransientStatusPatch(narratorId, options))?.substatus;
		},
		async clearTransientStatusPatch(narratorId: string, options: RuntimeReadOptions = {}) {
			const row = await readQueryFirst(
				db
					.select({ substatus: narrators.substatus })
					.from(narrators)
					.where(eq(narrators.id, narratorId))
					.limit(1),
				{ ...options, executionPolicy: "worker-required", maxRows: 1 },
			);
			const tags = parseSubstatus(row?.substatus);
			if (!row || !tags.some((tag) => tag === "reflecting" || tag === "reasoning"))
				return undefined;
			const substatus = tags.filter((tag) => tag !== "reflecting" && tag !== "reasoning");
			const now = new Date().toISOString();
			const committed = runAtomicWrite(db, "runtime.clearTransientSubstatus", (tx) => {
				const updated = tx
					.update(narrators)
					.set({
						substatus: JSON.stringify(substatus),
						updatedAt: sql`case when ${narrators.updatedAt} > ${now} then ${narrators.updatedAt} else ${now} end`,
					})
					.where(
						and(
							eq(narrators.id, narratorId),
							row.substatus === null
								? isNull(narrators.substatus)
								: eq(narrators.substatus, row.substatus),
						),
					)
					.returning(narratorStatusPatchColumns)
					.get();
				if (!updated) throw new RuntimeReadConflictError();
				return versionNarratorStatusCommit(updated);
			});
			return committed && committedNarratorStatusPatch(narratorId, committed);
		},
	};
}
