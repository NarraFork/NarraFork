import { posix, win32 } from "node:path";

export interface FileHistoryTarget {
	deviceId: string;
	pathFlavor: "posix" | "windows";
	canonicalPath: string;
}

type Waiter = {
	resolve: (release: () => void) => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
};
const queues = new Map<string, Waiter[]>();
const held = new Set<string>();
const MAX_QUEUE = 256;

function key(target: FileHistoryTarget): string {
	const paths = target.pathFlavor === "windows" ? win32 : posix;
	const normalized = paths.normalize(target.canonicalPath);
	if (!paths.isAbsolute(normalized)) throw new TypeError("File history path must be absolute");
	const root = paths.parse(normalized).root;
	const trimmed = normalized.length > root.length ? normalized.replace(/[\\/]+$/, "") : normalized;
	return `${target.deviceId}\0${target.pathFlavor}\0${target.pathFlavor === "windows" ? trimmed.toLowerCase() : trimmed}`;
}
function overlaps(a: string, b: string): boolean {
	const [ad, af, ap] = a.split("\0");
	const [bd, bf, bp] = b.split("\0");
	if (ad !== bd || af !== bf) return false;
	const sep = af === "windows" ? "\\" : "/";
	const childPrefix = (path: string) => (path.endsWith(sep) ? path : `${path}${sep}`);
	return ap === bp || ap.startsWith(childPrefix(bp)) || bp.startsWith(childPrefix(ap));
}
function acquire(target: FileHistoryTarget, signal?: AbortSignal): Promise<() => void> {
	const k = key(target);
	if (signal?.aborted)
		return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
	const blocked = [...held, ...queues.keys()].some((other) => overlaps(k, other));
	if (!blocked) return Promise.resolve(hold(k));
	if ([...queues.values()].reduce((n, q) => n + q.length, 0) >= MAX_QUEUE)
		return Promise.reject(new Error("File history lock queue full"));
	return new Promise((resolve, reject) => {
		const waiter: Waiter = { resolve, reject, signal };
		const cancel = () => {
			const q = queues.get(k);
			if (q) {
				const i = q.indexOf(waiter);
				if (i >= 0) q.splice(i, 1);
				if (!q.length) queues.delete(k);
			}
			reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", cancel, { once: true });
		const q = queues.get(k) ?? [];
		q.push(waiter);
		queues.set(k, q);
	});
}
function hold(k: string): () => void {
	held.add(k);
	let done = false;
	return () => {
		if (done) return;
		done = true;
		held.delete(k);
		pump();
	};
}
function pump() {
	for (const [k, q] of queues)
		if (q.length && ![...held].some((h) => overlaps(k, h))) {
			const w = q.shift();
			if (!w) continue;
			if (!q.length) queues.delete(k);
			if (w.signal?.aborted) {
				w.reject(w.signal.reason ?? new DOMException("Aborted", "AbortError"));
			} else w.resolve(hold(k));
		}
}
export const acquireFileHistoryCapture = acquire;
export async function withFileHistoryWrite<T>(
	target: FileHistoryTarget,
	body: () => T | Promise<T>,
	signal?: AbortSignal,
) {
	const release = await acquire(target, signal);
	try {
		return await body();
	} finally {
		release();
	}
}
export async function withFileHistoryCapture<T>(
	root: FileHistoryTarget,
	body: () => T | Promise<T>,
	signal?: AbortSignal,
) {
	return withFileHistoryWrite(root, body, signal);
}
