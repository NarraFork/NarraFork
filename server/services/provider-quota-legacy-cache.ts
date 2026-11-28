import { hotSafe } from "@server/lib/hot-safe";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import { WorkerHandle } from "@server/lib/worker-runtime/lifecycle";
import { TaskQueue } from "@server/lib/worker-runtime/queue";
import type { ProviderQuotaPersistenceContext } from "./provider-quota-persistence";
import { isTrustedQuotaSettingsPackage } from "./provider-quota-settings-compat";

const owner = hotSafe("narrafork.legacyQuotaReaders.owner", () => ({
	queue: new TaskQueue({ concurrency: 1, maxQueued: 8, maxQueuedBytes: 256 * 1024 }),
	handles: new Set<ReturnType<typeof WorkerHandle.thread>>(),
	shutdown: new AbortController(),
}));
export async function closeLegacyQuotaReaders(): Promise<void> {
	owner.shutdown.abort(Error("Legacy quota cache reader closed"));
	const drained = owner.queue.close();
	await Promise.all([...owner.handles].map((handle) => handle.close()));
	await drained;
}

/** The registry owns the full revision and live grant check; IDs alone never authorize migration. */
async function trustedLegacySource(
	context: ProviderQuotaPersistenceContext | undefined,
	signal: AbortSignal,
) {
	if (context?.isCurrent?.() !== true) return undefined;
	const revision = /^([^:]+):([a-f0-9]{64}):(opencode|deepseek):[a-f0-9]{64}\/([^/]+)\/\d+$/.exec(
		context.sourceRevision,
	);
	if (
		!revision ||
		context.sourceId !== `${context.pluginId}/${revision[3]}` ||
		context.installationId !== revision[4] ||
		!(await isTrustedQuotaSettingsPackage(context.pluginId, revision[1], revision[2], signal)) ||
		context.isCurrent?.() !== true
	)
		return undefined;
	return {
		kind: revision[3],
		path: getNarraforkPath(
			revision[3] === "opencode" ? "opencode-usages.json" : "deepseek-balances.json",
		),
		providerId: context.providerId,
		credentialId: context.credentialId,
		sourceId: context.sourceId,
		sourceRevision: context.sourceRevision,
	};
}

// Frozen old-file migration only. No plugin parser, network, writes or main-thread fallback.
const SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { createHmac } = require('node:crypto');
function read(path, keys, identity) {
	let fd;
	try {
		fd = fs.openSync(path, 'r');
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > 1048576) return null;
		const bytes = Buffer.alloc(stat.size + 1);
		let size = 0;
		while (size < bytes.length) {
			const n = fs.readSync(fd, bytes, size, bytes.length - size, null);
			if (!n) break;
			size += n;
		}
		if (size !== stat.size) return null;
		const data = JSON.parse(bytes.subarray(0, size).toString('utf8'));
		if (data.version !== 1 || typeof data.salt !== 'string' ||
			!(/^[a-f0-9]{32,128}$/).test(data.salt) || !data.entries || typeof data.entries !== 'object') return null;
		const fingerprint = createHmac('sha256', data.salt).update(identity).digest('hex');
		for (const key of keys) {
			const row = Object.hasOwn(data.entries, key) && data.entries[key];
			if (row && row.fingerprint === fingerprint && Buffer.byteLength(JSON.stringify(row.value)) <= 16384)
				return row.value;
		}
	} catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
	return null;
}
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
function migrate() {
	const source = workerData.source;
	if (!source) return null;
	const fields = JSON.parse(workerData.identity);
	if (!Array.isArray(fields) || fields.length !== 17 || fields[0] !== 'custom-api' ||
		fields[1] !== source.providerId || fields[2] !== (source.credentialId ?? null) ||
		workerData.key !== (source.credentialId ? 'key/' + source.credentialId : source.providerId) ||
		typeof fields[3] !== 'string' || typeof fields[4] !== 'string' || !fields[4] ||
		(fields[8] != null && fields[8] !== (fields[5] === 'anthropic-messages' ? 'claude-code' : fields[5] === 'openai-responses' ? 'codex' : 'narrafork')) ||
		fields[9] != null || !Array.isArray(fields[10]) || fields[10].length ||
		[fields[11], fields[12], fields[13]].some((value) => value != null && value !== '')) return null;
	const url = new URL(fields[3]);
	if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return null;
	const path = url.pathname.replace(/\/+$/, '') || '/';
	if (source.kind === 'deepseek') {
		if (url.hostname !== 'api.deepseek.com' || !['/', '/v1', '/anthropic'].includes(path)) return null;
	} else if (!(url.hostname === 'opencode.ai' || url.hostname.endsWith('.opencode.ai')) ||
		!['/zen/go/v1', '/inference/go/v1', '/inference/go/openai/v1', '/inference/go/anthropic/v1', '/inference/go/google/v1beta'].includes(path)) return null;
	const identity = JSON.stringify(source.kind === 'opencode'
		? [fields[3], fields[4], fields[6], fields[7], fields[14]]
		: [fields[3], fields[5], fields[4], fields[6], fields[7], fields[14]]);
	const value = read(source.path, [source.credentialId ?? source.providerId, source.providerId], identity);
	if (!value || value.error !== null || !finite(value.fetchedAt) || value.fetchedAt <= 0 || value.fetchedAt > Date.now() + 60000) return null;
	const data = { scope: source.kind === 'opencode' ? 'subscription' : 'wallet', amounts: [], windows: [] };
	if (source.kind === 'opencode') {
		for (const id of ['rolling', 'weekly', 'monthly']) {
			const window = value[id];
			if (window == null) continue;
			if (typeof window !== 'object' || ![null, 'ok', 'rate-limited'].includes(window.status) ||
				(window.percent !== null && (!finite(window.percent) || window.percent < 0 || window.percent > 100)) ||
				(window.resetsAt !== null && (typeof window.resetsAt !== 'string' || !Number.isFinite(Date.parse(window.resetsAt))))) return null;
			const used = window.used ?? null, limit = window.limit ?? null;
			if ((used !== null && (!finite(used) || used < 0)) || (limit !== null && (!finite(limit) || limit <= 0))) return null;
			data.windows.push({ id, used, limit, remaining: used !== null && limit !== null ? limit - used : null,
				usedPercent: window.percent, resetAt: window.resetsAt === null ? null : new Date(window.resetsAt).toISOString(), status: window.status });
		}
		if (value.balance != null) {
			if (!finite(value.balance) || value.balance < 0) return null;
			data.amounts.push({ id: 'balance:USD', unit: 'USD', remaining: value.balance, quota: 'none' });
		}
	} else {
		if (typeof value.isAvailable !== 'boolean' || !Array.isArray(value.balanceInfos) || value.balanceInfos.length > 2) return null;
		data.available = value.isAvailable;
		const currencies = new Set();
		for (const info of value.balanceInfos) {
			if (!info || !['USD', 'CNY'].includes(info.currency) || currencies.has(info.currency)) return null;
			currencies.add(info.currency);
			for (const [id, field] of [['balance', 'totalBalance'], ['granted', 'grantedBalance'], ['topped-up', 'toppedUpBalance']]) {
				const raw = info[field];
				if (typeof raw !== 'string' || raw.length > 64 || !(/^-?\d+(?:\.\d+)?$/).test(raw) || !finite(Number(raw))) return null;
				data.amounts.push({ id: id + ':' + info.currency, unit: info.currency, remaining: Number(raw), remainingText: raw,
					display: id === 'balance' ? 'summary' : 'detail', quota: id === 'balance' ? 'alternative' : 'none' });
			}
		}
	}
	if (!data.windows.length && !data.amounts.length) return null;
	return { sourceId: source.sourceId, sourceRevision: source.sourceRevision, status: 'supported', data,
		fetchedAt: value.fetchedAt, attemptedAt: value.fetchedAt, legacyDisplayOnly: true };
}
let result = read(workerData.path, [workerData.key], workerData.identity);
try { if (result == null) result = migrate(); } catch {}
parentPort.postMessage(result);
parentPort.close();
`;
export async function readLegacyQuotaCache(
	key: string,
	identity: string,
	signal?: AbortSignal,
	context?: ProviderQuotaPersistenceContext,
): Promise<unknown> {
	if (key.length > 256 || Buffer.byteLength(identity) > 32768) return undefined;
	const permit = await owner.queue.acquire({
		bytes: Buffer.byteLength(identity) + key.length,
		deadlineAt: Date.now() + 3000,
		signal: signal ? AbortSignal.any([signal, owner.shutdown.signal]) : owner.shutdown.signal,
	});
	let handle: ReturnType<typeof WorkerHandle.thread> | undefined;
	try {
		permit.signal.throwIfAborted();
		const source = await trustedLegacySource(context, permit.signal);
		permit.signal.throwIfAborted();
		handle = WorkerHandle.thread(SOURCE, {
			eval: true,
			workerData: { path: getNarraforkPath("provider-quota-cache.json"), key, identity, source },
		});
		owner.handles.add(handle);
		const worker = handle.resource;
		return await new Promise((resolve, reject) => {
			const cleanup = () => {
				permit.signal.removeEventListener("abort", fail);
				worker.off("message", receive);
				worker.off("error", fail);
				worker.off("exit", fail);
			};
			const fail = () => {
				cleanup();
				reject(Error("Legacy quota cache reader unavailable"));
			};
			const receive = (value: unknown) => {
				cleanup();
				if (permit.signal.aborted) reject(Error("Legacy quota cache read cancelled"));
				else if (context?.isCurrent?.() === false) resolve(undefined);
				else resolve(value);
			};
			worker.once("message", receive);
			worker.once("error", fail);
			worker.once("exit", fail);
			permit.signal.addEventListener("abort", fail, { once: true });
			if (permit.signal.aborted) fail();
		});
	} finally {
		await handle?.close();
		if (handle) owner.handles.delete(handle);
		permit.release();
	}
}
