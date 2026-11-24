import { mirrorUploadConcurrency } from "./mirror-relay";

export interface MirrorUploadAsset {
	name: string;
	size: number;
	sha256: string;
}
export interface MirrorUploadGroup<T> {
	asset: T;
	names: string[];
}
/** One physical object transfer may authorize several canonical filenames with identical bytes. */
export function groupMirrorUploads<T extends MirrorUploadAsset>(
	assets: T[],
): MirrorUploadGroup<T>[] {
	const groups = new Map<string, MirrorUploadGroup<T>>();
	for (const asset of assets) {
		const existing = groups.get(asset.sha256);
		if (existing) {
			if (existing.asset.size !== asset.size) throw new Error("Conflicting same-hash mirror size");
			existing.names.push(asset.name);
		} else groups.set(asset.sha256, { asset, names: [asset.name] });
	}
	return [...groups.values()];
}
/** Reserve all concurrently live files, not just the largest serial download. */
export function mirrorUploadDiskBytes(assets: MirrorUploadAsset[], concurrency: number): number {
	return (
		[...assets]
			.sort((a, b) => b.size - a.size)
			.slice(0, mirrorUploadConcurrency(concurrency))
			.reduce((sum, a) => sum + a.size, 0) +
		64 * 1024 ** 2
	);
}
/** Stable wire receipts use canonical order, independent of completion timing. */
export function orderMirrorUploads(uploaded: string[], assets: { name: string }[]): void {
	const positions = new Map(assets.map((a, i) => [a.name, i]));
	uploaded.sort((a, b) => (positions.get(a) ?? 0) - (positions.get(b) ?? 0));
}
/** Failure aborts every in-flight transfer, stops dequeueing, then joins cleanup before throwing. */
export class MirrorTransferPool {
	readonly concurrency: number;
	readonly signal: AbortSignal;
	private readonly controller = new AbortController();
	private failed = false;
	private failure: unknown;
	/** Producers can report a physical failure before awaiting their temporary-file cleanup. */
	fail(error: unknown): void {
		if (this.failed) return;
		this.failed = true;
		this.failure = error;
		this.controller.abort(error);
	}
	constructor(concurrency: number | undefined, parent: AbortSignal) {
		this.concurrency = mirrorUploadConcurrency(concurrency);
		this.signal = AbortSignal.any([parent, this.controller.signal]);
	}
	async run<T>(items: T[], work: (item: T, index: number) => Promise<void>): Promise<void> {
		this.signal.throwIfAborted();
		let next = 0;
		const worker = async () => {
			while (!this.signal.aborted && next < items.length) {
				const index = next++;
				try {
					await work(items[index], index);
				} catch (error) {
					this.fail(error);
					return;
				}
			}
		};
		// Only the bounded worker set is allocated, never one promise per release asset.
		await Promise.allSettled(
			Array.from({ length: Math.min(this.concurrency, items.length) }, worker),
		);
		if (this.failed) throw this.failure;
		this.signal.throwIfAborted();
	}
}
