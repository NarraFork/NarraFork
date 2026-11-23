import { spyOn } from "bun:test";

export function withSocketTimers(run: (fire: (delay: number) => void) => void) {
	const timers = new Map<number, { callback: () => void; delay: number }>();
	let id = 0;
	const set = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: unknown,
		delay?: number,
	) => {
		timers.set(++id, { callback: callback as () => void, delay: delay ?? 0 });
		return id;
	}) as typeof setTimeout);
	const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((handle) => {
		timers.delete(Number(handle));
	}) as typeof clearTimeout);
	try {
		run((delay) => {
			for (const [key, timer] of [...timers]) {
				if (timer.delay !== delay || !timers.has(key)) continue;
				timers.delete(key);
				timer.callback();
			}
		});
	} finally {
		set.mockRestore();
		clear.mockRestore();
	}
}
