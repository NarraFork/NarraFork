import type { ContextSegment } from "@shared/context-composition";

export type NumericEntry = { messageId: string; seq: number; segments: ContextSegment[] };
export type NumericState = {
	profile: string;
	revision: string;
	maxSeq: number;
	boundary: number;
	totals: ContextSegment[];
	entries: Map<string, NumericEntry>;
};
/** Numeric only; deliberately never retains message bodies or parsed tool inputs. */
export class ContextNumericCache {
	private states = new Map<string, { state: NumericState; bytes: number }>();
	private bytes = 0;
	constructor(
		private maxActors = 32,
		private maxBytes = 8 * 1024 * 1024,
	) {}
	get(id: string) {
		const item = this.states.get(id);
		if (!item) return;
		this.states.delete(id);
		this.states.set(id, item);
		return item.state;
	}
	delete(id: string) {
		const item = this.states.get(id);
		if (item) this.bytes -= item.bytes;
		this.states.delete(id);
	}
	set(id: string, state: NumericState) {
		this.delete(id);
		let bytes = 2048 + (id.length + state.profile.length + state.revision.length) * 2;
		for (const entry of state.entries.values())
			bytes += 192 + entry.messageId.length * 2 + entry.segments.length * 96;
		if (bytes > this.maxBytes) return;
		this.states.set(id, { state, bytes });
		this.bytes += bytes;
		while (this.states.size > this.maxActors || this.bytes > this.maxBytes) {
			const oldest = this.states.keys().next().value;
			if (oldest === undefined) break;
			this.delete(oldest);
		}
	}
	clear() {
		this.states.clear();
		this.bytes = 0;
	}
}
