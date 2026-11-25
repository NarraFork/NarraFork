import { describe, expect, test } from "bun:test";
import viteConfig from "../../frontend/vite.config";

const config = await viteConfig({ command: "serve", mode: "production" });
const server = config.server as {
	port?: number;
	strictPort?: boolean;
	hmr?: { clientPort?: number };
};

describe("Vite HMR reverse-proxy configuration", () => {
	test("uses the configured client port and disables localhost direct fallback", () => {
		expect(server.strictPort).toBe(true);
		expect(server.hmr?.clientPort).toBe(server.port);
	});
});

describe("Vite version-check boundary", () => {
	for (const mode of ["development", "production"]) {
		test(`${mode} serve identifies the live frontend even behind a proxy`, async () => {
			const config = await viteConfig({ command: "serve", mode });
			expect(config.define?.__DEV_VITE_PORT__).toBe(JSON.stringify(config.server?.port));
			expect(config.define?.__DEV_VITE_PORT__).not.toBe("undefined");
		});

		test(`${mode} build keeps version checks enabled`, async () => {
			const config = await viteConfig({ command: "build", mode });
			expect(config.define?.__DEV_VITE_PORT__).toBe("undefined");
		});
	}
});
