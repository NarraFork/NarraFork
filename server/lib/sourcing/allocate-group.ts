/** Allocate connection ids and model prefixes across every source namespace. */
import { HOST_RESERVED_PREFIXES } from "../../services/plugin-provider-registry";
import { generateShortId } from "../id";
import { settings } from "../settings";
import { listSourceGroups } from "./source-groups";

const SINGLETONS = ["codex", "tokendance", "CommandCode"] as const;

export interface GroupAllocation {
	id: string;
	prefix: string;
}

/**
 * One allocator is shared by a whole import. Reservations made for earlier entries therefore
 * apply to later ones too, including custom API ↔ NUG and platform-instance collisions.
 */
export function createGroupAllocator() {
	const ids = new Set<string>(SINGLETONS);
	const prefixes = new Set<string>([...HOST_RESERVED_PREFIXES, ...SINGLETONS]);
	for (const group of listSourceGroups()) {
		ids.add(group.id);
		prefixes.add(group.prefix);
	}
	const agent = settings.agent as unknown as {
		platformInstances?: Array<{ id: string; prefix: string }>;
	};
	for (const instance of agent.platformInstances ?? []) {
		ids.add(instance.id);
		prefixes.add(instance.prefix);
	}

	return {
		allocate(preferred: GroupAllocation): GroupAllocation {
			let id = preferred.id || generateShortId();
			while (ids.has(id)) id = generateShortId();
			let prefix = preferred.prefix;
			for (let n = 2; prefixes.has(prefix); n++) prefix = `${preferred.prefix}-${n}`;
			ids.add(id);
			prefixes.add(prefix);
			return { id, prefix };
		},
	};
}
