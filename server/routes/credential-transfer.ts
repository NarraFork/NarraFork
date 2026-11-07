import { Hono } from "hono";
import { z } from "zod";
import {
	applyCredentialImport,
	exportCredentials,
	listTransferableCredentials,
	previewCredentialImport,
} from "../lib/credential-transfer";
import {
	BundleError,
	bundleCatalogError,
	MAX_BUNDLE_BYTES,
	MIN_PASSPHRASE_LENGTH,
} from "../lib/credential-transfer/bundle";
import { zodValidationError } from "../lib/errors";
import { requireAdmin } from "../middleware/auth";
import { consumeStepUp } from "../services/step-up-service";

/**
 * Admin-only credential export / import between instances. Export needs a step-up
 * grant (`POST /api/auth/step-up`, purpose `credentials.export`); import needs the
 * bundle's passphrase, and only adds what a signed-in admin could add by hand.
 */
export const credentialTransferRoutes = new Hono();
credentialTransferRoutes.use("*", requireAdmin);

const selectionSchema = z
	.array(z.object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(100) }))
	.max(2000);
const exportSchema = z.object({
	stepUpToken: z.string().min(1).max(200),
	passphrase: z.string().min(MIN_PASSPHRASE_LENGTH).max(500),
	/** Absent = every credential. */
	selection: selectionSchema.optional(),
});
const bundleSchema = z.object({
	bundle: z.string().min(1).max(MAX_BUNDLE_BYTES),
	passphrase: z.string().min(1).max(500),
});
const importSchema = bundleSchema.extend({
	choices: z
		.array(z.object({ index: z.number().int().min(0), action: z.enum(["import", "replace"]) }))
		.max(5000),
});

async function withBundleErrors<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof BundleError) bundleCatalogError(error);
		throw error;
	}
}

credentialTransferRoutes.get("/credentials", (c) =>
	c.json({ credentials: listTransferableCredentials() }),
);

credentialTransferRoutes.post("/export", async (c) => {
	const parsed = exportSchema.safeParse(await c.req.json());
	if (!parsed.success) throw zodValidationError(parsed.error);
	const user = c.get("user");
	consumeStepUp(parsed.data.stepUpToken, {
		userId: user.sub,
		sessionId: user.sid,
		purpose: "credentials.export",
	});
	const { text, count } = await exportCredentials(parsed.data.selection, parsed.data.passphrase, {
		userId: user.sub,
	});
	const stamp = new Date().toISOString().slice(0, 10);
	c.header("Content-Disposition", `attachment; filename="narrafork-credentials-${stamp}.json"`);
	c.header("Cache-Control", "no-store");
	c.header("X-Credential-Count", String(count));
	return c.body(text, 200, { "Content-Type": "application/json; charset=utf-8" });
});

credentialTransferRoutes.post("/import/preview", async (c) => {
	const parsed = bundleSchema.safeParse(await c.req.json());
	if (!parsed.success) throw zodValidationError(parsed.error);
	return c.json(
		await withBundleErrors(() =>
			previewCredentialImport(parsed.data.bundle, parsed.data.passphrase),
		),
	);
});

credentialTransferRoutes.post("/import", async (c) => {
	const parsed = importSchema.safeParse(await c.req.json());
	if (!parsed.success) throw zodValidationError(parsed.error);
	const choices = new Map(parsed.data.choices.map((choice) => [choice.index, choice.action]));
	return c.json(
		await withBundleErrors(() =>
			applyCredentialImport(parsed.data.bundle, parsed.data.passphrase, choices, {
				userId: c.get("user").sub,
			}),
		),
	);
});
