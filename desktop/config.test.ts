import { expect, test } from "bun:test";
import config from "../electrobun.config";
import { version } from "../package.json";

test("desktop release metadata uses the server package version", () => {
	expect(config.app.version).toBe(version);
});
