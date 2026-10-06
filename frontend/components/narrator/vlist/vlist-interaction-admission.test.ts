import { describe, expect, it } from "bun:test";
import {
	createVListInteractionAdmission,
	type VListInteractionAdmissionRuntime,
} from "./vlist-interaction-admission";

function clock() {
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	const frames = new Map<number, () => void>();
	const runtime: VListInteractionAdmissionRuntime = {
		now: () => now,
		setTimeout(callback, delay) {
			const id = ++nextId;
			timers.set(id, { at: now + delay, callback });
			return id;
		},
		clearTimeout: (id) => void timers.delete(id),
		requestAnimationFrame(callback) {
			const id = ++nextId;
			frames.set(id, callback);
			return id;
		},
		cancelAnimationFrame: (id) => void frames.delete(id),
	};
	return {
		runtime,
		advance(ms: number) {
			const end = now + ms;
			while (true) {
				const due = [...timers].filter(([, timer]) => timer.at <= end);
				due.sort((a, b) => a[1].at - b[1].at);
				const first = due[0];
				if (!first) break;
				now = first[1].at;
				timers.delete(first[0]);
				first[1].callback();
			}
			now = end;
		},
		frame() {
			for (const [id, callback] of [...frames]) {
				if (!frames.delete(id)) continue;
				callback();
			}
		},
		jobs: () => ({ timers: timers.size, frames: frames.size }),
	};
}

function setup() {
	const time = clock();
	const store = createVListInteractionAdmission({ runtime: time.runtime });
	const idle = () => store.observeScroll({ scrollTop: 0, viewportHeight: 100, atBottom: false });
	const move = (scrollTop = 100) =>
		store.observeScroll({ scrollTop, viewportHeight: 100, atBottom: false });
	return { time, store, idle, move };
}

describe("list interaction admission phase", () => {
	it("starts at bottom and only actual displacement rearms the 120ms quiet gate", () => {
		const { time, store, idle, move } = setup();
		expect(store.getPhase()).toBe("at-bottom");
		idle();
		expect(store.getPhase()).toBe("idle");
		expect(time.jobs()).toEqual({ timers: 0, frames: 0 });
		move();
		expect(store.getPhase()).toBe("history-scrolling");
		time.advance(100);
		move(101);
		time.advance(119);
		expect(store.getPhase()).toBe("history-scrolling");
		time.advance(1);
		expect(store.getPhase()).toBe("idle");
		expect(store.getView()).toEqual({ scrollTop: 101, viewportHeight: 100 });
	});

	it("no-movement and viewport-only events neither begin nor extend history scrolling", () => {
		const { time, store, idle, move } = setup();
		idle();
		store.observeScroll({ scrollTop: 0, viewportHeight: 200, atBottom: false });
		expect(store.getPhase()).toBe("idle");
		move();
		time.advance(119);
		store.observeScroll({ scrollTop: 100, viewportHeight: 500, atBottom: false });
		time.advance(1);
		expect(store.getPhase()).toBe("idle");
		expect(store.getView().viewportHeight).toBe(500);
	});

	it("inactive anchoring echoes cache view without starting or extending history scrolling", () => {
		const { time, store, move } = setup();
		store.observeScroll({ scrollTop: 500, viewportHeight: 200, atBottom: false, activity: false });
		expect(store.getPhase()).toBe("idle");
		expect(store.getView()).toEqual({ scrollTop: 500, viewportHeight: 200 });
		expect(time.jobs().timers).toBe(0);
		move(501);
		time.advance(100);
		store.observeScroll({ scrollTop: 700, viewportHeight: 300, atBottom: false, activity: false });
		expect(store.getPhase()).toBe("history-scrolling");
		expect(store.getView()).toEqual({ scrollTop: 700, viewportHeight: 300 });
		time.advance(20);
		expect(store.getPhase()).toBe("idle");
		move(700);
		expect(store.getPhase()).toBe("idle");
		move(701);
		expect(store.getPhase()).toBe("history-scrolling");
	});

	it("inactive pinned resize still synchronizes bottom and immediately admits cold subscribers", () => {
		const { time, store, move } = setup();
		move();
		const lease = store.createLease();
		lease.subscribe(() => {});
		store.observeScroll({ scrollTop: 500, viewportHeight: 300, atBottom: true, activity: false });
		expect(store.getPhase()).toBe("at-bottom");
		expect(store.getView()).toEqual({ scrollTop: 500, viewportHeight: 300 });
		expect(lease.getSnapshot()).toBe(true);
		expect(time.jobs()).toEqual({ timers: 0, frames: 0 });
	});

	it("bottom pin cancels quiet immediately and false preserves an active history gate", () => {
		const { time, store, move } = setup();
		move();
		store.setAtBottom(false);
		expect(store.getPhase()).toBe("history-scrolling");
		store.setAtBottom(true);
		expect(store.getPhase()).toBe("at-bottom");
		expect(time.jobs().timers).toBe(0);
		store.observeScroll({ scrollTop: 300, viewportHeight: 100, atBottom: true });
		time.advance(1000);
		expect(store.getPhase()).toBe("at-bottom");
	});

	it("upward intent gates before detaching and scrollend cannot stop recent movement", () => {
		const { time, store, move } = setup();
		store.markHistoryIntent();
		expect(store.getPhase()).toBe("history-scrolling");
		store.setAtBottom(false);
		store.finishScroll();
		expect(store.getPhase()).toBe("idle");
		move();
		time.advance(119);
		store.finishScroll();
		expect(store.getPhase()).toBe("history-scrolling");
		time.advance(1);
		expect(store.getPhase()).toBe("idle");
		store.markHistoryIntent();
		time.advance(100);
		store.markHistoryIntent();
		time.advance(119);
		expect(store.getPhase()).toBe("history-scrolling");
		time.advance(1);
		expect(store.getPhase()).toBe("idle");
	});

	it("suspend retains the gate while hidden; resume rearms and StrictMode is reversible", () => {
		const { time, store, move } = setup();
		move();
		const lease = store.createLease();
		lease.subscribe(() => {});
		store.suspend();
		time.advance(10000);
		store.finishScroll();
		expect(store.getPhase()).toBe("history-scrolling");
		expect(lease.getSnapshot()).toBe(false);
		expect(time.jobs()).toEqual({ timers: 0, frames: 0 });
		store.resume(false);
		time.advance(119);
		expect(lease.getSnapshot()).toBe(false);
		time.advance(1);
		expect(store.getPhase()).toBe("idle");
		time.frame();
		expect(lease.getSnapshot()).toBe(true);
		store.suspend();
		store.resume(true);
		expect(store.getPhase()).toBe("at-bottom");
	});
});

describe("sticky per-component leases", () => {
	it.each([
		"history",
		"hidden",
	] as const)("rechecks provisional at-bottom readiness before first subscription: %s", (change) => {
		const { store, time } = setup();
		const lease = store.createLease();
		expect(lease.getSnapshot()).toBe(true);
		if (change === "history") store.markHistoryIntent();
		else store.suspend();
		expect(lease.getSnapshot()).toBe(false);
		let notifications = 0;
		const unsubscribe = lease.subscribe(() => notifications++);
		expect(lease.getSnapshot()).toBe(false);
		expect(store.getDebugSnapshot()).toMatchObject({ active: 1, pending: 1 });
		time.frame();
		expect(notifications).toBe(0);
		if (change === "history") {
			time.advance(120);
			expect(lease.getSnapshot()).toBe(false);
			time.frame();
		} else {
			time.advance(1000);
			expect(lease.getSnapshot()).toBe(false);
			store.resume(true);
		}
		expect(lease.getSnapshot()).toBe(true);
		expect(notifications).toBe(1);
		unsubscribe();
		store.suspend();
	});

	it("only committed bottom readiness remains sticky after phase changes", () => {
		const { store } = setup();
		const lease = store.createLease();
		const off = lease.subscribe(() => {});
		expect(lease.getSnapshot()).toBe(true);
		store.markHistoryIntent();
		store.suspend();
		expect(lease.getSnapshot()).toBe(true);
		off();
		const nextOff = lease.subscribe(() => {});
		expect(lease.getSnapshot()).toBe(true);
		expect(store.getDebugSnapshot().pending).toBe(0);
		nextOff();
	});

	it("explicit ensure before subscription retains the user-intent exemption", () => {
		const { store } = setup();
		const lease = store.createLease();
		lease.ensure();
		store.markHistoryIntent();
		store.suspend();
		const off = lease.subscribe(() => {});
		expect(lease.getSnapshot()).toBe(true);
		expect(store.getDebugSnapshot().pending).toBe(0);
		off();
	});

	it("provisional eager reads cannot consume an idle admission batch", () => {
		const { store, time, idle } = setup();
		const leases = Array.from({ length: 5 }, () => store.createLease());
		expect(leases.every((lease) => lease.getSnapshot())).toBe(true);
		idle();
		for (const lease of leases) lease.subscribe(() => {});
		expect(leases.every((lease) => !lease.getSnapshot())).toBe(true);
		expect(store.getDebugSnapshot().pending).toBe(5);
		time.frame();
		expect(leases.filter((lease) => lease.getSnapshot())).toHaveLength(2);
	});

	it("provisional leases never register, and at-bottom creation is immediately ready", () => {
		const { time, store, idle } = setup();
		expect(store.createLease().getSnapshot()).toBe(true);
		idle();
		for (let i = 0; i < 1000; i++) expect(store.createLease().getSnapshot()).toBe(false);
		expect(store.getDebugSnapshot()).toMatchObject({ pending: 0, active: 0 });
		expect(time.jobs()).toEqual({ timers: 0, frames: 0 });
	});

	it("idle sorts current priorities and admits at most two per animation frame", () => {
		const { time, store, idle } = setup();
		idle();
		let lastPriority = 1;
		const admitted: number[] = [];
		const leases = [1, 1, 0, 0, 1].map((priority, i) => {
			const lease = store.createLease({ priority: () => (i === 4 ? lastPriority : priority) });
			lease.subscribe(() => admitted.push(i));
			return lease;
		});
		expect(leases.every((lease) => !lease.getSnapshot())).toBe(true);
		lastPriority = -1;
		time.frame();
		expect(admitted).toEqual([4, 2]);
		expect(store.getDebugSnapshot().pending).toBe(3);
		time.frame();
		expect(admitted).toEqual([4, 2, 3, 0]);
		time.frame();
		expect(admitted).toEqual([4, 2, 3, 0, 1]);
		expect(time.jobs().frames).toBe(0);
	});

	it("another scroll cancels admission; warm leases receive no phase notifications", () => {
		const { time, store, idle, move } = setup();
		idle();
		let notifications = 0;
		const leases = Array.from({ length: 5 }, () => {
			const lease = store.createLease();
			lease.subscribe(() => notifications++);
			return lease;
		});
		time.frame();
		expect(notifications).toBe(2);
		move();
		expect(time.jobs().frames).toBe(0);
		time.frame();
		expect(notifications).toBe(2);
		store.setAtBottom(true);
		expect(leases.every((lease) => lease.getSnapshot())).toBe(true);
		expect(notifications).toBe(5);
		move(200);
		time.advance(120);
		time.frame();
		expect(notifications).toBe(5);
	});

	it("ensure admits exactly one lease without releasing the history gate", () => {
		const { time, store, move } = setup();
		move();
		const first = store.createLease();
		const second = store.createLease();
		let notifications = 0;
		first.subscribe(() => notifications++);
		second.subscribe(() => notifications++);
		first.ensure();
		first.ensure();
		expect(first.getSnapshot()).toBe(true);
		expect(second.getSnapshot()).toBe(false);
		expect(notifications).toBe(1);
		expect(store.getPhase()).toBe("history-scrolling");
		expect(time.jobs().frames).toBe(0);
	});

	it("last unsubscribe removes the queue; the same lease can subscribe again", () => {
		const { time, store, idle } = setup();
		idle();
		const lease = store.createLease();
		let notifications = 0;
		const listener = () => notifications++;
		const first = lease.subscribe(listener);
		const second = lease.subscribe(listener);
		first();
		first();
		expect(store.getDebugSnapshot()).toMatchObject({ active: 1, pending: 1 });
		second();
		expect(store.getDebugSnapshot()).toMatchObject({ active: 0, pending: 0 });
		expect(time.jobs().frames).toBe(0);
		const unsubscribe = lease.subscribe(listener);
		time.frame();
		expect(lease.getSnapshot()).toBe(true);
		expect(notifications).toBe(1);
		unsubscribe();
		expect(store.getDebugSnapshot().active).toBe(0);
	});

	it("suspended bottom creates cold leases until resume, with ensure retaining explicit exemption", () => {
		const { time, store } = setup();
		store.suspend();
		const lease = store.createLease();
		const immediate = store.createLease();
		let notifications = 0;
		lease.subscribe(() => notifications++);
		immediate.subscribe(() => notifications++);
		expect(store.getPhase()).toBe("at-bottom");
		expect(lease.getSnapshot()).toBe(false);
		expect(immediate.getSnapshot()).toBe(false);
		expect(time.jobs()).toEqual({ timers: 0, frames: 0 });
		time.advance(1000);
		expect(lease.getSnapshot()).toBe(false);
		immediate.ensure();
		expect(immediate.getSnapshot()).toBe(true);
		expect(lease.getSnapshot()).toBe(false);
		expect(notifications).toBe(1);
		expect(time.jobs()).toEqual({ timers: 0, frames: 0 });
		store.resume(true);
		expect(lease.getSnapshot()).toBe(true);
		expect(notifications).toBe(2);
		expect(store.getDebugSnapshot()).toMatchObject({ suspended: false, pending: 0 });
		expect(time.jobs()).toEqual({ timers: 0, frames: 0 });
	});

	it("suspended idle queues cannot schedule until resumed; bottom bypass resumes immediately", () => {
		const { time, store, idle } = setup();
		idle();
		store.suspend();
		const leases = Array.from({ length: 5 }, () => {
			const lease = store.createLease();
			lease.subscribe(() => {});
			return lease;
		});
		expect(time.jobs().frames).toBe(0);
		store.resume();
		expect(time.jobs().frames).toBe(1);
		store.suspend();
		store.setAtBottom(true);
		expect(leases.every((lease) => !lease.getSnapshot())).toBe(true);
		store.resume();
		expect(leases.every((lease) => lease.getSnapshot())).toBe(true);
		expect(time.jobs()).toEqual({ timers: 0, frames: 0 });
	});

	it("an uncommitted cold lease subscribes at bottom without waiting for a frame", () => {
		const { store, move, time } = setup();
		move();
		const lease = store.createLease();
		store.setAtBottom(true);
		// Bottom is visible to an uncommitted render, but this read is not sticky.
		expect(lease.getSnapshot()).toBe(true);
		store.markHistoryIntent();
		expect(lease.getSnapshot()).toBe(false);
		store.setAtBottom(true);
		lease.subscribe(() => {});
		expect(lease.getSnapshot()).toBe(true);
		expect(time.jobs()).toEqual({ timers: 0, frames: 0 });
	});
});
