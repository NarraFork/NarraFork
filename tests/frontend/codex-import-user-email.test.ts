import { describe, expect, test } from "bun:test";

async function readSource(relativePath: string): Promise<string> {
	return Bun.file(new URL(`../../${relativePath}`, import.meta.url)).text();
}

function getCredentialFromObjectBody(source: string): string {
	const match = source.match(
		/function credentialFromObject\(item: unknown\): CodexImportCredential \| null \{([\s\S]*?)\n\}\n\nfunction credentialsFromAtMarkerRecord/,
	);
	if (!match?.[1]) throw new Error("credentialFromObject source not found");
	return match[1];
}

describe("Codex credential import user.email integration", () => {
	test("credentialFromObject safely reads user and preserves email priority", async () => {
		const source = await readSource("frontend/components/providers/CodexSection.tsx");
		const body = getCredentialFromObjectBody(source);

		expect(body).toContain("const user = optionalRecord(record.user);");

		const emailCandidates = body.match(/const email = firstOptionalString\(([\s\S]*?)\n\t\);/)?.[1];
		if (!emailCandidates) throw new Error("credentialFromObject email candidates not found");

		const topLevelIndex = emailCandidates.indexOf("record.email");
		const userIndex = emailCandidates.indexOf("user.email");
		const credentialsIndex = emailCandidates.indexOf("nestedCredentials.email");

		expect(topLevelIndex).toBeGreaterThanOrEqual(0);
		expect(userIndex).toBeGreaterThan(topLevelIndex);
		expect(credentialsIndex).toBeGreaterThan(userIndex);
	});
});
