import { randomUUID } from "node:crypto";
import type { EditorFileServerMessage } from "@shared/editor-file-events";

export interface EditorWatchTarget {
	resourceId: string;
	authorize(signal: AbortSignal): Promise<string>;
}
interface Observer {
	id: string;
	narratorId: string;
	controller: AbortController;
	generation: string;
	seq: number;
	epoch: number;
	running: boolean;
	pending: boolean;
	runtime?: string;
	target: EditorWatchTarget;
	live(): boolean;
	send(frame: EditorFileServerMessage): void;
}

/** Host polling adapter, not an executor/native watcher. One timer, four auth jobs,
 * 128 authorized resources, coalesced hints; no bodies, persistent log or doc pins. */
export class EditorFileSubscriptions {
	private groups = new Map<string, Set<Observer>>();
	private timer?: ReturnType<typeof setInterval>;
	private running = 0;
	constructor(private readonly intervalMs = 15_000) {}

	subscribe(options: {
		id: string;
		narratorId: string;
		target: EditorWatchTarget;
		live(): boolean;
		send(frame: EditorFileServerMessage): void;
	}) {
		let group = this.groups.get(options.target.resourceId);
		if (!group && this.groups.size >= 128) throw new Error("Editor watch capacity exceeded");
		if (group && group.size >= 16) throw new Error("Editor watch reference capacity exceeded");
		if (!group) {
			group = new Set();
			this.groups.set(options.target.resourceId, group);
		}
		const observer: Observer = {
			...options,
			controller: new AbortController(),
			generation: randomUUID(),
			seq: 0,
			epoch: 0,
			running: false,
			pending: true,
		};
		group.add(observer);
		this.timer ??= setInterval(() => this.hint(), this.intervalMs);
		this.timer.unref?.();
		this.pump();
		return () => this.remove(observer);
	}
	/** Call synchronously at authority/context mutations: fences all pre-await work. */
	hint(narratorId?: string) {
		for (const group of this.groups.values())
			for (const observer of group) {
				if (narratorId && observer.narratorId !== narratorId) continue;
				observer.epoch++;
				observer.pending = true;
			}
		this.pump();
	}
	private remove(observer: Observer) {
		observer.controller.abort();
		observer.pending = false;
		const group = this.groups.get(observer.target.resourceId);
		group?.delete(observer);
		if (!group?.size) this.groups.delete(observer.target.resourceId);
		if (!this.groups.size) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
	private pump() {
		for (const group of this.groups.values())
			for (const observer of group) {
				if (this.running >= 4) return;
				if (!observer.running && observer.pending) void this.run(observer);
			}
	}
	private async run(observer: Observer) {
		observer.running = true;
		observer.pending = false;
		this.running++;
		const epoch = observer.epoch;
		const current = () =>
			!observer.controller.signal.aborted && observer.live() && epoch === observer.epoch;
		try {
			if (!current()) {
				if (!observer.live()) this.remove(observer);
				return;
			}
			const signal = AbortSignal.any([observer.controller.signal, AbortSignal.timeout(20_000)]);
			const runtime = await observer.target.authorize(signal);
			if (!current()) return;
			// Re-read authority after asynchronous provider resolution, immediately before publish.
			if ((await observer.target.authorize(signal)) !== runtime || !current()) return;
			const initial = observer.seq === 0;
			const rebind = observer.runtime !== undefined && observer.runtime !== runtime;
			observer.runtime = runtime;
			observer.send({
				type: initial ? "editor_file_subscribed" : "editor_file_changed",
				subscriptionId: observer.id,
				resourceId: observer.target.resourceId,
				generation: observer.generation,
				seq: ++observer.seq,
				reason: rebind ? "rebind" : "poll",
			});
		} catch (error) {
			if (!current()) return;
			const status = (error as { statusCode?: number }).statusCode;
			if (status !== undefined && status >= 400 && status < 500) {
				observer.send({
					type: "editor_file_error",
					subscriptionId: observer.id,
					code: "access_denied",
				});
				this.remove(observer);
			}
			// Transport/offline failure is not revocation; the next shared tick retries.
		} finally {
			observer.running = false;
			this.running--;
			this.pump();
		}
	}
	get diagnostics() {
		let references = 0;
		for (const group of this.groups.values()) references += group.size;
		return {
			resources: this.groups.size,
			references,
			running: this.running,
			timers: this.timer ? 1 : 0,
		};
	}
}

export const editorFileSubscriptions = new EditorFileSubscriptions();
