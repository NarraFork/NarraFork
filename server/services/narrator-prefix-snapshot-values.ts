/** Private wire format; a hash always addresses the complete immutable JSON value. */
export const PREFIX_TOOLS_FORMAT = "narrafork.prefix-tools.v1";
export interface PrefixToolsManifest {
	format: typeof PREFIX_TOOLS_FORMAT;
	definitions: string[];
}
export function isPrefixToolsManifest(value: unknown): value is PrefixToolsManifest {
	if (!value || typeof value !== "object") return false;
	const manifest = value as PrefixToolsManifest;
	return (
		manifest.format === PREFIX_TOOLS_FORMAT &&
		Array.isArray(manifest.definitions) &&
		manifest.definitions.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
	);
}

/** Freeze once per object identity, with cooperative traversal and no JSON/string copies. */
const frozen = new WeakMap<object, number>();
export async function freezePrefixValue(
	value: unknown,
	check: () => void = () => {},
): Promise<number> {
	type Frame = {
		value: object;
		keys: string[] | null;
		length: number;
		index: number;
		bytes: number;
	};
	const frames: Frame[] = [];
	const active = new Set<object>();
	let bytes = 0;
	const push = (item: object) => {
		if (active.has(item)) throw new Error("Prefix snapshot value is cyclic");
		active.add(item);
		Object.freeze(item);
		const keys = Array.isArray(item) ? null : Object.keys(item);
		frames.push({
			value: item,
			keys,
			length: keys?.length ?? (item as unknown[]).length,
			index: 0,
			bytes: 64,
		});
	};
	if (value && typeof value === "object") {
		const previous = frozen.get(value);
		if (previous !== undefined) {
			check();
			return previous;
		}
		push(value);
	}
	let slots = 0;
	while (frames.length) {
		const frame = frames[frames.length - 1];
		if (frame.index >= frame.length) {
			frozen.set(frame.value, frame.bytes);
			active.delete(frame.value);
			frames.pop();
			if (frames.length) frames[frames.length - 1].bytes += frame.bytes;
			else bytes = frame.bytes;
			continue;
		}
		const key = frame.keys ? frame.keys[frame.index++] : frame.index++;
		const child = (frame.value as Record<string | number, unknown>)[key];
		frame.bytes += 64 + (typeof key === "string" ? key.length * 2 : 0);
		if (typeof child === "string") frame.bytes += child.length * 2;
		else if (child && typeof child === "object") {
			const previous = frozen.get(child);
			if (previous !== undefined) frame.bytes += previous;
			else push(child);
		}
		if (++slots % 1000 === 0) {
			check();
			await Bun.sleep(0);
		}
	}
	check();
	return bytes;
}

/** A caller's cancellation never cancels work shared by another caller. */
export function waitForPrefix<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
