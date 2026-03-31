/**
 * Event coalescer — ported from VS Code's `EventCoalescer`
 * (`vs/platform/files/common/watcher.ts`).
 *
 * Merges a stream of raw file-change events into a minimal set:
 *
 *   CREATE + DELETE  → cancel out (removed from output)
 *   DELETE + CREATE  → UPDATED
 *   CREATE + UPDATE  → CREATE  (keep the original)
 *   otherwise        → latest type wins
 *
 * Additionally, nested DELETE events are collapsed: if a parent directory is
 * deleted, child DELETE events are suppressed.
 */

import { FileChangeType, type IFileChange } from "./types";

function isParent(childPath: string, parentPath: string): boolean {
	if (childPath === parentPath) return false;
	const parentWithSep = parentPath.endsWith("/") ? parentPath : `${parentPath}/`;
	return childPath.startsWith(parentWithSep);
}

export function coalesceEvents(changes: IFileChange[]): IFileChange[] {
	const coalescer = new EventCoalescer();
	for (const event of changes) {
		coalescer.processEvent(event);
	}
	return coalescer.coalesce();
}

class EventCoalescer {
	private readonly coalesced = new Set<IFileChange>();
	private readonly mapPathToChange = new Map<string, IFileChange>();

	processEvent(event: IFileChange): void {
		const key = event.path;
		const existing = this.mapPathToChange.get(key);

		let keepEvent = false;

		if (existing) {
			const currentType = existing.type;
			const newType = event.type;

			// CREATE followed by DELETE → cancel out
			if (currentType === FileChangeType.ADDED && newType === FileChangeType.DELETED) {
				this.mapPathToChange.delete(key);
				this.coalesced.delete(existing);
			}
			// DELETE followed by CREATE → flatten to UPDATED
			else if (currentType === FileChangeType.DELETED && newType === FileChangeType.ADDED) {
				(existing as { type: FileChangeType }).type = FileChangeType.UPDATED;
			}
			// CREATE followed by UPDATE → keep as CREATE
			else if (currentType === FileChangeType.ADDED && newType === FileChangeType.UPDATED) {
				// no-op: keep the original ADDED
			}
			// Otherwise apply the new type
			else {
				(existing as { type: FileChangeType }).type = newType;
			}
		} else {
			keepEvent = true;
		}

		if (keepEvent) {
			this.coalesced.add(event);
			this.mapPathToChange.set(key, event);
		}
	}

	coalesce(): IFileChange[] {
		const addOrChangeEvents: IFileChange[] = [];
		const deletedPaths: string[] = [];

		// 1) Split ADD/CHANGE and DELETE events
		// 2) Sort short deleted paths to the top
		// 3) For each DELETE, check if there is a deleted parent → ignore
		return Array.from(this.coalesced)
			.filter((e) => {
				if (e.type !== FileChangeType.DELETED) {
					addOrChangeEvents.push(e);
					return false;
				}
				return true;
			})
			.sort((a, b) => a.path.length - b.path.length)
			.filter((e) => {
				if (deletedPaths.some((dp) => isParent(e.path, dp))) {
					return false; // parent already deleted
				}
				deletedPaths.push(e.path);
				return true;
			})
			.concat(addOrChangeEvents);
	}
}
