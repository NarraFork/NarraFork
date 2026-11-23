import type { Database } from "bun:sqlite";
import {
	checkDomainBudget,
	type DomainReadParams,
	type DomainReadTaskKind,
	type DomainReadTaskMap,
	validateDomainRead,
} from "./domain-protocol";
import { DbReadError, readAborted } from "./errors";
import type { ReadBudgetMeter } from "./read-budget";

export type DomainReadHandler<K extends DomainReadTaskKind> = (
	sqlite: Database,
	input: DomainReadTaskMap[K]["params"],
	signal: AbortSignal,
	deadlineAt?: number,
) => DomainReadTaskMap[K]["result"];
interface DomainReadModule<K extends DomainReadTaskKind> {
	read: DomainReadHandler<K>;
	validate?: (input: unknown) => boolean;
}
const loaders: { [K in DomainReadTaskKind]: () => Promise<DomainReadModule<K>> } = {
	readerProbe: async () => ({
		read: (sqlite) => {
			sqlite.query("SELECT 1").get();
			return { ready: true };
		},
	}),
};
const loadedModules = new Map<DomainReadTaskKind, Promise<unknown>>();
function loadDomain<K extends DomainReadTaskKind>(task: K): Promise<DomainReadModule<K>> {
	let loaded = loadedModules.get(task);
	if (!loaded) {
		loaded = loaders[task]();
		loadedModules.set(task, loaded);
	}
	// The private cache erases K; the fixed, typed loader above preserves its key/module pairing.
	return loaded as Promise<DomainReadModule<K>>;
}
export async function runDomainRead(
	sqlite: Database,
	params: DomainReadParams,
	signal: AbortSignal,
	deadlineAt = Number.POSITIVE_INFINITY,
	meter?: ReadBudgetMeter,
): Promise<unknown> {
	if (!Object.hasOwn(loaders, params.task))
		throw new DbReadError("DB_READ_UNSUPPORTED", "Unregistered database read task");
	if (signal.aborted) throw readAborted();
	const checkDeadline = () => {
		if (Date.now() >= deadlineAt)
			throw new DbReadError("DB_READ_TASK_TIMEOUT", "database read task timed out");
	};
	checkDeadline();
	const definition = validateDomainRead(params, meter);
	const module = await loadDomain(params.task);
	if (module.read.constructor.name === "AsyncFunction")
		throw new DbReadError("DB_READ_INVALID", "Domain read handlers must be synchronous");
	if (signal.aborted) throw readAborted();
	if (module.validate && !module.validate(params.input))
		throw new DbReadError("DB_READ_INVALID", "Invalid domain read parameters");
	checkDeadline();
	return sqlite.transaction(() => {
		const result = module.read(sqlite, params.input, signal, deadlineAt);
		if (result && typeof result === "object" && "then" in result)
			throw new DbReadError("DB_READ_INVALID", "Domain read handlers must be synchronous");
		checkDomainBudget(result, definition.maxResultBytes, definition.maxArrayItems, meter);
		if (definition.validateResult && !definition.validateResult(result))
			throw new DbReadError("DB_READ_INVALID", "Invalid domain read result");
		checkDeadline();
		return result;
	})();
}
