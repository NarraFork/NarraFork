import { runReadTask } from "../../lib/db-worker/pool";
import { logger } from "../../lib/logger";
import { knowledgeInjectionReads } from "../knowledge-service";
import { assertKeywordCandidateBudget, type CompiledMatcher } from "./keyword-matcher";
import { knowledgeReadStore } from "./store";

export {
	type CompiledMatcher,
	candidateKey,
	compileMatcher,
	type KeywordCandidate,
	matchWithCompiledMatcher,
	normalizeForKeywordMatch,
} from "./keyword-matcher";

interface IndexOptions {
	userId?: string | null;
	collectionId?: string;
	projectId?: string;
	signal?: AbortSignal;
}
interface CacheEntry {
	store: typeof knowledgeReadStore;
	signature: string;
	matcher: CompiledMatcher;
}
interface Refresh {
	store: typeof knowledgeReadStore;
	controller: AbortController;
	promise: Promise<CompiledMatcher>;
	waiters: number;
	settled: boolean;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Refresh>();
// Count actual unsettled jobs, including an abandoned job replaced under the same scope key.
let outstanding = 0;
const MAX_SCOPES = 64;
const MAX_PENDING = 4;
const MAX_CACHED_NODES = 131_072;
const MAX_CACHED_INPUT_BYTES = 8 * 1024 * 1024;
const REFRESH_BUDGET_MS = 750;

function cacheMatcher(key: string, entry: CacheEntry): void {
	cache.delete(key);
	let nodes = entry.matcher.nodes.length;
	let bytes = entry.matcher.inputBytes;
	for (const item of cache.values()) {
		nodes += item.matcher.nodes.length;
		bytes += item.matcher.inputBytes;
	}
	while (cache.size >= MAX_SCOPES || nodes > MAX_CACHED_NODES || bytes > MAX_CACHED_INPUT_BYTES) {
		const oldest = cache.entries().next().value;
		if (!oldest) break;
		cache.delete(oldest[0]);
		nodes -= oldest[1].matcher.nodes.length;
		bytes -= oldest[1].matcher.inputBytes;
	}
	cache.set(key, entry);
}

async function refreshMatcher(
	key: string,
	opts: IndexOptions,
	store: typeof knowledgeReadStore,
): Promise<CompiledMatcher> {
	const { signal } = opts;
	signal?.throwIfAborted();
	const signature = await knowledgeInjectionReads.keywordInjectionCandidatesSignature(opts);
	signal?.throwIfAborted();
	const cached = cache.get(key);
	if (cached?.store === store && cached.signature === signature) return cached.matcher;
	const candidates = await knowledgeInjectionReads.listKeywordInjectionCandidates(opts);
	signal?.throwIfAborted();
	assertKeywordCandidateBudget(candidates);
	// Pure computation: no database handle, content, authorization decision or external service.
	const matcher = await runReadTask<CompiledMatcher>(
		"",
		{
			kind: "knowledgeKeywordMatcher",
			candidates,
		},
		{ signal, timeoutMs: REFRESH_BUDGET_MS },
	);
	signal?.throwIfAborted();
	if (store === knowledgeReadStore) cacheMatcher(key, { store, signature, matcher });
	return matcher;
}

function startRefresh(key: string, opts: IndexOptions): Refresh {
	outstanding++;
	const controller = new AbortController();
	const store = knowledgeReadStore;
	const started = Date.now();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error("Knowledge keyword index deadline exceeded"));
	}, REFRESH_BUDGET_MS);
	const job: Refresh = {
		store,
		controller,
		waiters: 0,
		settled: false,
		promise: Promise.resolve()
			.then(() => refreshMatcher(key, { ...opts, signal: controller.signal }, store))
			.finally(() => {
				job.settled = true;
				outstanding--;
				clearTimeout(timer);
				if (pending.get(key) === job) pending.delete(key);
				if (timedOut || Date.now() - started > 500) {
					logger.warn("Slow knowledge keyword index refresh", {
						durationMs: Date.now() - started,
						timedOut,
					});
				}
			}),
	};
	pending.set(key, job);
	return job;
}

/** Each waiter owns its cancellation; the job is cancelled only when nobody needs it anymore. */
async function waitForRefresh(job: Refresh, caller?: AbortSignal): Promise<CompiledMatcher> {
	job.waiters++;
	const signal = caller ? AbortSignal.any([caller, job.controller.signal]) : job.controller.signal;
	let onAbort: (() => void) | undefined;
	try {
		signal.throwIfAborted();
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		const matcher = await Promise.race([job.promise, aborted]);
		signal.throwIfAborted();
		return matcher;
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
		if (--job.waiters === 0 && !job.settled)
			job.controller.abort(new Error("Knowledge index has no waiters"));
	}
}

/** Metadata scans and index compilation are worker jobs, never synchronous request-path rebuilds. */
export async function getCompiledMatcher(opts: IndexOptions): Promise<CompiledMatcher> {
	opts.signal?.throwIfAborted();
	const key = JSON.stringify([opts.collectionId ?? "", opts.projectId ?? "", opts.userId ?? ""]);
	const active = pending.get(key);
	if (active && active.store === knowledgeReadStore && !active.controller.signal.aborted) {
		return waitForRefresh(active, opts.signal);
	}
	if (outstanding >= MAX_PENDING) throw new Error("Knowledge keyword index is busy");
	return waitForRefresh(startRefresh(key, opts), opts.signal);
}
