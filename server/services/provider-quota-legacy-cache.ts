import { hotSafe } from "@server/lib/hot-safe";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import { WorkerHandle } from "@server/lib/worker-runtime/lifecycle";
import { TaskQueue } from "@server/lib/worker-runtime/queue";

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
// Pure legacy read in a Worker; the old file is never changed, even on malformed input.
const SOURCE = `const {parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs');const {createHmac}=require('node:crypto');
let result=null,fd;try{fd=fs.openSync(workerData.path,'r');const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>1048576)throw Error();const bytes=Buffer.alloc(stat.size+1);let size=0;while(size<bytes.length){const n=fs.readSync(fd,bytes,size,bytes.length-size,null);if(!n)break;size+=n;}if(size!==stat.size)throw Error();const data=JSON.parse(bytes.subarray(0,size).toString('utf8'));if(data.version!==1||typeof data.salt!=='string'||!(/^[a-f0-9]{32,128}$/).test(data.salt)||!data.entries||typeof data.entries!=='object')throw Error();const row=data.entries[workerData.key];if(row&&row.fingerprint===createHmac('sha256',data.salt).update(workerData.identity).digest('hex')&&Buffer.byteLength(JSON.stringify(row.value))<=16384)result=row.value;}catch{}finally{if(fd!==undefined)fs.closeSync(fd);}parentPort.postMessage(result);parentPort.close();`;
export async function readLegacyQuotaCache(
	key: string,
	identity: string,
	signal?: AbortSignal,
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
		handle = WorkerHandle.thread(SOURCE, {
			eval: true,
			workerData: { path: getNarraforkPath("provider-quota-cache.json"), key, identity },
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
