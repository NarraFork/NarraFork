/**
 * licenses.test.ts — Contract for the license attribution API.
 *
 * The properties here are the ones whose violation would be invisible: a summary
 * response that quietly grew to 1.1 MB, an unknown id returning 200 with nothing,
 * or the endpoint becoming authenticated and silently breaking the link on the
 * login page.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { resetLicenseManifestCache } from "../../lib/licenses/manifest";
import licenseRoutes from "../licenses";

const app = new Hono().route("/api/licenses", licenseRoutes);

afterEach(() => {
	resetLicenseManifestCache();
});

interface SummaryResponse {
	entries: Array<{
		name: string;
		version: string;
		license: string;
		kind: string;
		textId?: string;
		textSource: string;
		declaredLicense?: string;
	}>;
	problems: Array<{ severity: string; message: string; name?: string }>;
	generatedAt: number;
	source: string;
}

async function fetchSummary(): Promise<SummaryResponse> {
	const response = await app.request("/api/licenses");
	expect(response.status).toBe(200);
	return (await response.json()) as SummaryResponse;
}

describe("GET /api/licenses", () => {
	test("serves the manifest without requiring authentication", async () => {
		// The /licenses page is reachable from the login screen; auth here would break
		// attribution for anyone not signed in.
		const response = await app.request("/api/licenses");
		expect(response.status).toBe(200);
	});

	test("lists every distributed component, not just direct dependencies", async () => {
		// The regression this whole change exists to prevent: 97 of 864 shipped
		// packages listed.
		const body = await fetchSummary();
		expect(body.entries.length).toBeGreaterThan(500);
	});

	test("includes components that ship outside node_modules", async () => {
		// zstd, the Bun runtime and the Go executor are unreachable from the dependency
		// graph, so only the hand-maintained entries can surface them.
		const body = await fetchSummary();
		const bundled = body.entries.filter((entry) => entry.kind === "bundled");
		expect(bundled.length).toBeGreaterThan(0);
		expect(bundled.map((entry) => entry.name)).toContain("zstd");
		expect(bundled.map((entry) => entry.name)).toContain("Bun runtime");
	});

	test("omits license texts from the list response", async () => {
		// Including them would make this a ~1.1 MB payload serialized on the main
		// thread for a page that shows one text at a time.
		const response = await app.request("/api/licenses");
		const raw = await response.text();
		const body = JSON.parse(raw) as SummaryResponse;
		for (const entry of body.entries) {
			expect(entry).not.toHaveProperty("licenseText");
			expect(entry).not.toHaveProperty("text");
		}
		// Metadata for ~1200 entries is a few hundred KB; a megabyte means text leaked in.
		expect(raw.length).toBeLessThan(600_000);
	});

	test("every entry carries a license identifier", async () => {
		const body = await fetchSummary();
		for (const entry of body.entries) {
			expect(entry.license, `${entry.name} must state a license`).toBeTruthy();
		}
	});

	test("distributed entries all have retrievable license text", async () => {
		// A shipped component with no text to show is the compliance gap, so this is
		// asserted rather than left to the problems list.
		const body = await fetchSummary();
		const shipped = body.entries.filter(
			(entry) => entry.kind === "bundled" || entry.kind === "runtime",
		);
		const textless = shipped.filter((entry) => !entry.textId);
		expect(textless.map((entry) => entry.name)).toEqual([]);
	});

	test("reports no blocking problems for the current tree", async () => {
		const body = await fetchSummary();
		const errors = body.problems.filter((problem) => problem.severity === "error");
		expect(errors.map((problem) => `${problem.name ?? "-"}: ${problem.message}`)).toEqual([]);
	});

	test("groups bundled components first so the heaviest obligations lead", async () => {
		const body = await fetchSummary();
		const order = ["bundled", "runtime", "development"];
		let previous = 0;
		for (const entry of body.entries) {
			const rank = order.indexOf(entry.kind);
			expect(rank).toBeGreaterThanOrEqual(previous);
			previous = rank;
		}
	});

	test("records where the manifest came from", async () => {
		const body = await fetchSummary();
		expect(["filesystem", "embedded"]).toContain(body.source);
		expect(body.generatedAt).toBeGreaterThan(0);
	});

	test("dual-licensed components state the branch selected and its origin", async () => {
		// dompurify is the worked example of a documented disjunction: we take
		// Apache-2.0 to avoid MPL-2.0's source-disclosure obligation on a component
		// shipped in the frontend bundle. Asserted rather than skipped when absent —
		// `if (!dompurify) return;` turned "the package left the tree" into a pass, so
		// the selection mechanism would stop being covered with no signal at all.
		const body = await fetchSummary();
		const dompurify = body.entries.find((entry) => entry.name === "dompurify");
		expect(
			dompurify,
			"dompurify is no longer in the dependency tree; re-point this at another " +
				"documented disjunction (see server/lib/licenses/dual-license.ts) instead " +
				"of leaving the selection path uncovered.",
		).toBeDefined();
		expect(dompurify?.license).toBe("Apache-2.0");
		expect(dompurify?.declaredLicense).toContain("MPL-2.0");
	});

	test("no entry displays an unresolved disjunction as its license", async () => {
		// Showing "A OR B" looks like an answer while hiding that no branch was chosen.
		const body = await fetchSummary();
		const unresolved = body.entries.filter(
			(entry) => / OR /.test(entry.license) && entry.kind !== "development",
		);
		expect(unresolved.map((entry) => `${entry.name}: ${entry.license}`)).toEqual([]);
	});
});

describe("GET /api/licenses/text/:id", () => {
	test("returns the text for a referenced id", async () => {
		const body = await fetchSummary();
		const textId = body.entries.find((entry) => entry.textId)?.textId;
		if (!textId) throw new Error("no entry carries a license text id");

		const response = await app.request(`/api/licenses/text/${textId}`);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as { id: string; text: string };
		expect(payload.id).toBe(textId);
		expect(payload.text.length).toBeGreaterThan(0);
	});

	test("404s an unknown id instead of returning empty text", async () => {
		const response = await app.request("/api/licenses/text/0123456789abcdef");
		expect(response.status).toBe(404);
	});

	test.each([
		["not-a-hash"],
		["0123456789ABCDEF"],
		["0123456789abcde"],
		["0123456789abcdef0"],
		["../../etc/passwd"],
		["%2e%2e%2fetc%2fpasswd"],
	])("rejects a malformed id: %s", async (id) => {
		// Ids are content hashes used as map keys; refusing anything else keeps a
		// traversal-shaped string from ever reaching a lookup.
		const response = await app.request(`/api/licenses/text/${id}`);
		expect(response.status).not.toBe(200);
	});

	test("serves text without authentication", async () => {
		const body = await fetchSummary();
		const withText = body.entries.find((entry) => entry.textId);
		const response = await app.request(`/api/licenses/text/${withText?.textId}`);
		expect(response.status).toBe(200);
	});

	test("SPDX-template entries are labelled so the page can disclose the source", async () => {
		// Presenting a template as upstream's own wording would be a false statement
		// about the license; the label is what lets the UI avoid that.
		const body = await fetchSummary();
		const templated = body.entries.filter((entry) => entry.textSource === "spdx-template");
		for (const entry of templated) {
			expect(entry.textId).toBeTruthy();
		}
		expect(
			body.entries.every((entry) =>
				["package", "spdx-template", "missing"].includes(entry.textSource),
			),
		).toBe(true);
	});
});
