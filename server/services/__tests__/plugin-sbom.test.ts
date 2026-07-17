import { describe, expect, test } from "bun:test";
import { checkSbomInstallPolicy, generateCycloneDxSbom, parseSbom } from "../plugin-sbom";

describe("plugin SBOM", () => {
	test("parses SPDX and applies license policy", () => {
		const sbom = parseSbom({
			spdxVersion: "SPDX-2.3",
			packages: [{ SPDXID: "SPDXRef-a", name: "a", licenseDeclared: "MIT" }],
		});
		expect(sbom.format).toBe("spdx");
		expect(checkSbomInstallPolicy(sbom, { allowedLicenses: ["MIT"] }).allowed).toBe(true);
		expect(checkSbomInstallPolicy(sbom, { deniedLicenses: ["MIT"] }).allowed).toBe(false);
	});
	test("parses and generates CycloneDX", () => {
		const generated = generateCycloneDxSbom([
			{ id: "pkg:a", name: "a", version: "1.0.0", license: "Apache-2.0" },
		]);
		const sbom = parseSbom(generated);
		expect(sbom.format).toBe("cyclonedx");
		expect(sbom.components[0]?.license).toBe("Apache-2.0");
	});
});
