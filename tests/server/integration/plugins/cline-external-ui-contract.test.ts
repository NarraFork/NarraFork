import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseManifest } from "@server/lib/plugins/manifest";

/**
 * The iframe/backend contract, asserted against the built artifacts.
 *
 * ## Why this file exists
 *
 * The settings view and the plugin backend exchange JSON across an iframe boundary. Neither
 * side has a type for the other's payload — both see `unknown` — so a field the backend
 * renames and the view still reads compiles cleanly and fails only at runtime, as a control
 * that never appears or a button that does nothing. During this plugin's design that mistake
 * happened twice, on `enabledModels` and on `browserAuth`.
 *
 * So the shared vocabulary is pinned here: command ids, the `browserAuth` states, and the
 * absence of superseded spellings. The assertions read the **built artifacts** rather than the
 * sources, because the artifacts are what actually ship and what the runtime loads.
 */

const PLUGIN_ROOT = resolve(import.meta.dir, "../../../../examples/plugins/cline-external");

async function artifacts() {
	const [manifestText, backend, ui] = await Promise.all([
		readFile(join(PLUGIN_ROOT, "manifest.json"), "utf8"),
		readFile(join(PLUGIN_ROOT, "server/index.js"), "utf8"),
		readFile(join(PLUGIN_ROOT, "ui/provider-settings.iife.js"), "utf8"),
	]);
	return { manifest: parseManifest(JSON.parse(manifestText)), backend, ui };
}

describe("cline-external UI contract: commands", () => {
	test("every command the view invokes is declared in the manifest", async () => {
		// A view calling an undeclared command gets METHOD_NOT_FOUND from the registry, which
		// surfaces as a control that silently fails.
		const { manifest, ui } = await artifacts();
		const declared = new Set(manifest.contributes.commands.map((command) => command.id));
		// The ids the view is known to call. Listed explicitly rather than scraped, so adding a
		// call without declaring it is caught here.
		const invoked = [
			"status",
			"auth.browser",
			"auth.cancel",
			"auth.callback",
			"auth.logout",
			"balance",
			"recommended-models",
			"models.refresh",
			"models.search",
			"config.setEnabledModels",
		];
		for (const id of invoked) {
			expect(declared.has(id), `${id} must be declared in the manifest`).toBe(true);
			expect(ui.includes(`"${id}"`), `${id} must appear in the built view`).toBe(true);
		}
	});

	test("every declared command is implemented in the backend artifact", async () => {
		// The other direction: a declared command with no handler answers METHOD_NOT_FOUND.
		//
		// The handler map is read by key rather than by substring, because the bundler emits
		// object shorthand for ids that happen to be valid identifiers (`status,` and `balance,`
		// rather than `"status":`). A naive `includes('"status"')` check would fail on a correct
		// artifact — and, worse, would have been "fixed" by loosening it until it stopped
		// asserting anything.
		const { manifest, backend } = await artifacts();
		const handlerMap = /var COMMAND_HANDLERS = \{([\s\S]*?)\n\};/.exec(backend);
		expect(handlerMap?.[1], "COMMAND_HANDLERS must be present in the artifact").toBeDefined();
		const keys = new Set(
			(handlerMap?.[1] ?? "")
				.split("\n")
				.map((line) => /^\s*(?:"([^"]+)"\s*:|([A-Za-z_$][\w$]*)\s*[,:])/.exec(line))
				.map((match) => match?.[1] ?? match?.[2])
				.filter((key): key is string => Boolean(key)),
		);
		expect(keys.size).toBe(manifest.contributes.commands.length);
		for (const command of manifest.contributes.commands) {
			expect(keys.has(command.id), `${command.id} must have a handler`).toBe(true);
		}
	});

	test("every declared command is handled on the server side", async () => {
		// `handler: "ui"` commands have no backend, and the registry reports INVALID_STATE for
		// them. All of this plugin's commands are backend-handled.
		const { manifest } = await artifacts();
		for (const command of manifest.contributes.commands) {
			expect(command.handler, command.id).toBe("server");
		}
	});
});

describe("cline-external UI contract: browserAuth", () => {
	test("both artifacts use the same field name and the same three values", async () => {
		// The exact failure this prevents: backend emits `browserAuth`, view reads
		// `browserAuthAvailable`, and the sign-in button never renders.
		const { backend, ui } = await artifacts();
		for (const token of ['"available"', '"port_busy"', '"unsupported"']) {
			expect(backend.includes(token), `backend must emit ${token}`).toBe(true);
			expect(ui.includes(token), `view must handle ${token}`).toBe(true);
		}
		expect(backend).toContain("browserAuth");
		expect(ui).toContain("browserAuth");
	});

	test("the superseded spelling appears in neither artifact", async () => {
		const { backend, ui } = await artifacts();
		expect(backend).not.toContain("browserAuthAvailable");
		expect(ui).not.toContain("browserAuthAvailable");
	});
});

describe("cline-external UI contract: the view holds no credential authority", () => {
	test("the view never calls a secrets method", async () => {
		// Credentials must not travel through the iframe. The view learns *whether* an account
		// exists from `status`; it can never read the token, and it cannot write the vault
		// directly — every mutation goes through a command whose `secretWrites` the host validates.
		const { ui } = await artifacts();
		for (const method of ["secrets.get", "secrets.set", "secrets.delete", "secrets.list"]) {
			expect(ui.includes(method), `view must not call ${method}`).toBe(false);
		}
	});

	test("the view's only host method is commands.execute", async () => {
		// A sandboxed iframe has `connect-src 'none'`, so this is also the only channel it has.
		// Asserted so a future addition is a deliberate change rather than an accident.
		const { ui } = await artifacts();
		expect(ui).toContain("commands.execute");
		for (const method of ["queries.execute", "storage.set", "config.get", "events.subscribe"]) {
			expect(ui.includes(method), `view must not call ${method}`).toBe(false);
		}
	});

	test("the backend is the side that talks to the vault", async () => {
		const { backend } = await artifacts();
		expect(backend).toContain("secrets.get");
		expect(backend).toContain("secrets.set");
	});
});

describe("cline-external UI contract: vault keys", () => {
	test("the secret keys match the provider contribution id", async () => {
		// `provider.<contributionId>.<field>` is validated host-side against the contributions the
		// plugin registered. Using the user-facing prefix (`cline-ext`) would put every write
		// outside the writable namespace.
		const { manifest, backend } = await artifacts();
		const contributionId = manifest.contributes.providers[0].id;
		expect(contributionId).toBe("cline");
		for (const field of ["credentials", "enabledModels"]) {
			expect(backend).toContain(`provider.${contributionId}.${field}`);
		}
		expect(backend).not.toContain("provider.cline-ext.");
	});

	test("each key names a field the configSchema declares as secret", async () => {
		// Only declared secret fields are injected back into provider calls, so a key with no
		// matching field would be stored and never read.
		const { manifest } = await artifacts();
		const schema = manifest.contributes.providers[0].configSchema as Record<
			string,
			Record<string, unknown>
		>;
		for (const field of ["credentials", "enabledModels"]) {
			expect(schema[field]?.["x-narrafork-secret"], field).toBe(true);
			expect(schema[field]?.writeOnly, field).toBe(true);
			expect(schema[field]?.type, field).toBe("string");
		}
	});
});

describe("cline-external UI contract: artifacts are self-contained", () => {
	test("neither artifact carries host infrastructure", async () => {
		// A plugin runs in its own process and must not have pulled the host's database, ORM or
		// settings graph into its bundle. This plugin shares no module with the core, so the check
		// is a boundary assertion rather than a bundle-purity guard.
		const { backend, ui } = await artifacts();
		for (const marker of ["bun:sqlite", "drizzle-orm", "settings.json", "narrafork.db"]) {
			expect(backend.includes(marker), `backend must not contain ${marker}`).toBe(false);
			expect(ui.includes(marker), `view must not contain ${marker}`).toBe(false);
		}
	});

	test("the view carries no bare import, since the iframe has no module loader", async () => {
		// It is loaded with a plain <script> tag as an IIFE; a leftover import would fail at load
		// time rather than at build time.
		const { ui } = await artifacts();
		expect(ui).not.toMatch(/^\s*import\s+.*\sfrom\s+["']/m);
		expect(ui).not.toMatch(/^\s*export\s/m);
	});

	test("the manifest's declared entries are the files that exist", async () => {
		const { manifest } = await artifacts();
		expect(manifest.server?.entry).toBe("server/index.js");
		expect(manifest.ui?.entry).toBe("ui/provider-settings.iife.js");
		expect(await Bun.file(join(PLUGIN_ROOT, "server/index.js")).exists()).toBe(true);
		expect(await Bun.file(join(PLUGIN_ROOT, "ui/provider-settings.iife.js")).exists()).toBe(true);
	});
});

describe("cline-external UI contract: coexistence with the built-in provider", () => {
	test("the prefix differs from the built-in one, so neither shadows the other", async () => {
		// `resolveProviderAndModel` resolves plugin prefixes only after every builtin has declined,
		// but a colliding prefix would still be rejected at registration.
		const { manifest } = await artifacts();
		expect(manifest.contributes.providers[0].providerPrefix).toBe("cline-ext");
	});

	test("reasoningContinuation is declared false", async () => {
		// OpenAI chat/completions cannot return a thinking block, so a continuation is impossible.
		// Declaring true would have the host send back metadata this provider must then drop.
		const { manifest, backend } = await artifacts();
		expect(manifest.contributes.providers[0].capabilities?.reasoningContinuation).toBe(false);
		expect(backend).toContain("reasoningContinuation");
	});
});
