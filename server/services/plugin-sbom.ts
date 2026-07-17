export type SbomFormat = "spdx" | "cyclonedx";

export interface SbomComponent {
	id: string;
	name: string;
	version?: string;
	license?: string;
	type?: string;
	supplier?: string;
	purl?: string;
	sha256?: string;
}

export interface PluginSbom {
	format: SbomFormat;
	spdxVersion?: string;
	bomFormat?: string;
	serialNumber?: string;
	components: SbomComponent[];
}

export interface SbomInstallPolicy {
	allowedFormats?: readonly SbomFormat[];
	allowedLicenses?: readonly string[];
	deniedLicenses?: readonly string[];
	maxComponents?: number;
	requireSbom?: boolean;
	allowUnknownLicense?: boolean;
}

export interface SbomPolicyResult {
	allowed: boolean;
	violations: string[];
	components: number;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseSbom(input: string | unknown): PluginSbom {
	let value: unknown = input;
	if (typeof input === "string") {
		try {
			value = JSON.parse(input) as unknown;
		} catch {
			throw new Error("SBOM is not valid JSON");
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("SBOM must be a JSON object");
	const object = value as Record<string, unknown>;
	if (typeof object.spdxVersion === "string") return parseSpdx(object);
	if (
		object.bomFormat === "CycloneDX" ||
		typeof object.specVersion === "string" ||
		Array.isArray(object.components)
	)
		return parseCycloneDx(object);
	throw new Error("Unsupported SBOM format; expected SPDX or CycloneDX");
}

function parseSpdx(object: Record<string, unknown>): PluginSbom {
	const packages = Array.isArray(object.packages) ? object.packages : [];
	const components = packages.map((raw, index) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			throw new Error(`Invalid SPDX package at index ${index}`);
		const item = raw as Record<string, unknown>;
		const id = stringValue(item.SPDXID) ?? stringValue(item.name);
		if (!id) throw new Error(`SPDX package ${index} has no identity`);
		const checksums = Array.isArray(item.checksums) ? item.checksums : [];
		const sha = checksums.find(
			(checksum) =>
				checksum &&
				typeof checksum === "object" &&
				(checksum as Record<string, unknown>).algorithm === "SHA256",
		);
		return {
			id,
			name: stringValue(item.name) ?? id,
			version: stringValue(item.versionInfo),
			license: stringValue(item.licenseConcluded) ?? stringValue(item.licenseDeclared),
			supplier: stringValue(item.supplier),
			sha256:
				sha && typeof sha === "object"
					? stringValue((sha as Record<string, unknown>).checksumValue)
					: undefined,
		} satisfies SbomComponent;
	});
	return { format: "spdx", spdxVersion: object.spdxVersion as string, components };
}

function parseCycloneDx(object: Record<string, unknown>): PluginSbom {
	const rawComponents = Array.isArray(object.components) ? object.components : [];
	const components = rawComponents.map((raw, index) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			throw new Error(`Invalid CycloneDX component at index ${index}`);
		const item = raw as Record<string, unknown>;
		const id = stringValue(item.bomRef) ?? stringValue(item.purl) ?? stringValue(item.name);
		if (!id || !stringValue(item.name))
			throw new Error(`CycloneDX component ${index} has no identity`);
		const hashes = Array.isArray(item.hashes) ? item.hashes : [];
		const sha = hashes.find(
			(hash) =>
				hash && typeof hash === "object" && (hash as Record<string, unknown>).alg === "SHA-256",
		);
		return {
			id,
			name: item.name as string,
			version: stringValue(item.version),
			type: stringValue(item.type),
			purl: stringValue(item.purl),
			supplier:
				typeof item.supplier === "object" && item.supplier
					? stringValue((item.supplier as Record<string, unknown>).name)
					: undefined,
			license: licenseFromCyclone(item.licenses),
			sha256:
				sha && typeof sha === "object"
					? stringValue((sha as Record<string, unknown>).content)
					: undefined,
		} satisfies SbomComponent;
	});
	return { format: "cyclonedx", bomFormat: "CycloneDX", components };
}

function licenseFromCyclone(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const first = value[0];
	if (!first || typeof first !== "object") return undefined;
	const license = (first as Record<string, unknown>).license;
	if (!license || typeof license !== "object") return undefined;
	const item = license as Record<string, unknown>;
	return stringValue(item.id) ?? stringValue(item.name);
}

export function generateSpdxSbom(
	components: readonly SbomComponent[],
	name = "narrafork-plugin",
): Record<string, unknown> {
	return {
		spdxVersion: "SPDX-2.3",
		dataLicense: "CC0-1.0",
		SPDXID: "SPDXRef-DOCUMENT",
		name,
		documentNamespace: `https://narrafork.local/sbom/${name}`,
		packages: components.map((component) => ({
			SPDXID: component.id.startsWith("SPDXRef-")
				? component.id
				: `SPDXRef-${component.id.replace(/[^A-Za-z0-9.-]/g, "-")}`,
			name: component.name,
			versionInfo: component.version,
			licenseDeclared: component.license ?? "NOASSERTION",
			licenseConcluded: component.license ?? "NOASSERTION",
			supplier: component.supplier,
		})),
	};
}

export function generateCycloneDxSbom(
	components: readonly SbomComponent[],
): Record<string, unknown> {
	return {
		bomFormat: "CycloneDX",
		specVersion: "1.5",
		version: 1,
		components: components.map((component) => ({
			type: component.type ?? "library",
			bomRef: component.id,
			name: component.name,
			version: component.version,
			purl: component.purl,
			supplier: component.supplier ? { name: component.supplier } : undefined,
			licenses: component.license ? [{ license: { id: component.license } }] : undefined,
			hashes: component.sha256 ? [{ alg: "SHA-256", content: component.sha256 }] : undefined,
		})),
	};
}

export function checkSbomInstallPolicy(
	sbom: PluginSbom | undefined,
	policy: SbomInstallPolicy = {},
): SbomPolicyResult {
	const violations: string[] = [];
	if (!sbom) {
		if (policy.requireSbom) violations.push("SBOM_REQUIRED");
		return { allowed: violations.length === 0, violations, components: 0 };
	}
	if (policy.allowedFormats && !policy.allowedFormats.includes(sbom.format))
		violations.push(`FORMAT_NOT_ALLOWED:${sbom.format}`);
	if (policy.maxComponents !== undefined && sbom.components.length > policy.maxComponents)
		violations.push("COMPONENT_LIMIT_EXCEEDED");
	const allowed = new Set(policy.allowedLicenses ?? []);
	const denied = new Set(policy.deniedLicenses ?? []);
	for (const component of sbom.components) {
		if (!component.license && !policy.allowUnknownLicense)
			violations.push(`UNKNOWN_LICENSE:${component.id}`);
		if (component.license && denied.has(component.license))
			violations.push(`DENIED_LICENSE:${component.license}`);
		if (allowed.size > 0 && component.license && !allowed.has(component.license))
			violations.push(`LICENSE_NOT_ALLOWED:${component.license}`);
	}
	return { allowed: violations.length === 0, violations, components: sbom.components.length };
}
