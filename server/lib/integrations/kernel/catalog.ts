import {
	CANONICAL_CAPABILITY_DESCRIPTORS,
	type CanonicalCapabilityDescriptor,
	canonicalCapabilityDescriptorSchema,
} from "@shared/integrations/capabilities";

export const CAPABILITY_CATALOG_MAX_ITEMS = 512;

export type CatalogCapabilityDescriptor = Omit<
	Readonly<CanonicalCapabilityDescriptor>,
	"allowedSubjects"
> & {
	readonly allowedSubjects: readonly CanonicalCapabilityDescriptor["allowedSubjects"][number][];
};

function freezeDescriptor(descriptor: CanonicalCapabilityDescriptor): CatalogCapabilityDescriptor {
	const parsed = canonicalCapabilityDescriptorSchema.parse(descriptor);
	return Object.freeze({
		...parsed,
		allowedSubjects: Object.freeze([...parsed.allowedSubjects]),
	});
}

/** Pure in-memory descriptor registry. Construction rejects duplicates and oversized catalogs. */
export class CapabilityCatalog {
	readonly #descriptors = new Map<string, CatalogCapabilityDescriptor>();

	constructor(descriptors: Iterable<CanonicalCapabilityDescriptor>) {
		for (const descriptor of descriptors) {
			if (this.#descriptors.size >= CAPABILITY_CATALOG_MAX_ITEMS) {
				throw new Error(`Capability catalog exceeds ${CAPABILITY_CATALOG_MAX_ITEMS} descriptors`);
			}
			const frozen = freezeDescriptor(descriptor);
			if (this.#descriptors.has(frozen.id)) {
				throw new Error(`Duplicate capability descriptor: ${frozen.id}`);
			}
			this.#descriptors.set(frozen.id, frozen);
		}
	}

	get(id: string): CatalogCapabilityDescriptor | undefined {
		return this.#descriptors.get(id);
	}

	has(id: string): boolean {
		return this.#descriptors.has(id);
	}

	list(): readonly CatalogCapabilityDescriptor[] {
		return Object.freeze([...this.#descriptors.values()]);
	}
}

export const canonicalCapabilityCatalog = new CapabilityCatalog(
	Object.values(CANONICAL_CAPABILITY_DESCRIPTORS),
);
