import { getLicenseSummaries, getLicenseText } from "@server/lib/licenses/manifest";
import { isLicenseTextId } from "@server/lib/licenses/types";
import { Hono } from "hono";

/**
 * Third-party license attribution.
 *
 * Public, like `/api/changelog`: MIT/BSD/Apache all require the notice to reach
 * whoever receives the software, and `/licenses` is linked from the login page —
 * putting it behind auth would leave that link broken for anyone who has not
 * signed in. Nothing here is user data; it is a property of the released build.
 *
 * Split into a summary list and per-text lookups because the full manifest is
 * ~1.1 MB of license text against ~260 KB of metadata. Serializing all of it per
 * request would be exactly the oversized-list-response pattern the project's
 * performance rules forbid.
 */
const app = new Hono();

app.get("/", async (c) => {
	const result = await getLicenseSummaries();
	return c.json(result);
});

app.get("/text/:id", async (c) => {
	const id = c.req.param("id");
	// Ids are content hashes. Validating the shape keeps an arbitrary string from
	// ever reaching a lookup, and makes a malformed request a 400 rather than a
	// silent empty result.
	if (!isLicenseTextId(id)) {
		return c.json({ error: "Invalid license text id" }, 400);
	}

	const text = await getLicenseText(id);
	if (text === null) {
		return c.json({ error: "Unknown license text id" }, 404);
	}

	return c.json({ id, text });
});

export default app;
