import { existsSync } from "node:fs";
import { Hono } from "hono";
import { z } from "zod";
import { ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { scheduleServerRestart } from "../lib/server-restart";
import { saveSettings, settings } from "../lib/settings";
import {
	getTlsPaths,
	getTlsStatus,
	issueServerCert,
	MAX_CUSTOM_SANS,
	regenerateCa,
} from "../lib/tls";

import { requireAdmin } from "../middleware/auth";
import { buildServerRestartUrl } from "./settings";

/**
 * TLS certificate management: a locally generated root CA plus CA-signed
 * server certificates with user-managed Subject Alternative Names.
 *
 * Mounted at `/api/settings/tls` alongside the main settings router. The CA
 * flow exists so that trusting NarraFork on a new device is a ONE-TIME CA
 * import — re-issuing the server certificate (new SANs, new LAN IP) then
 * requires no client-side changes at all.
 */

const generateSchema = z.object({
	customSans: z.array(z.string().trim().min(1).max(253)).max(MAX_CUSTOM_SANS).optional(),
});

export const tlsRoutes = new Hono()
	// Any signed-in user may inspect status: the UI needs it to render the TLS
	// section, and it discloses nothing secret (cert metadata + file booleans).
	.get("/status", (c) => c.json(getTlsStatus()))

	// The CA certificate is public by design (it can only verify, not sign), and
	// non-admin users need it to trust NarraFork on their own devices — so this
	// is session-gated rather than admin-gated like the mutating endpoints.
	.get("/ca.pem", (c) => {
		const { caCertPath } = getTlsPaths();
		if (!existsSync(caCertPath)) {
			return c.json({ error: "No CA certificate has been generated yet", code: "NOT_FOUND" }, 404);
		}
		return new Response(Bun.file(caCertPath), {
			headers: {
				"Content-Type": "application/x-pem-file",
				"Content-Disposition": 'attachment; filename="narrafork-ca.pem"',
			},
		});
	})

	// One-shot setup / re-issue: validate SANs, ensure CA, issue (or re-issue)
	// the server cert, point settings at the files, restart to apply.
	.post("/generate", requireAdmin, async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const parsed = generateSchema.safeParse(body);
		if (!parsed.success) throw new ValidationError(parsed.error.message);

		// issueServerCert validates SANs before any file is touched and ensures
		// the CA internally, so a rejected request never creates a stray CA.
		const issued = await issueServerCert(parsed.data.customSans);

		const current = settings;
		const merged = {
			...current,
			server: {
				...current.server,
				tls: {
					...current.server.tls,
					enabled: true,
					certFile: issued.certPath,
					keyFile: issued.keyPath,
				},
			},
		};
		saveSettings(merged);

		const host = merged.server.host;
		const port = merged.server.port;
		scheduleServerRestart(host, port);

		logger.info("TLS server certificate issued via API", {
			caCreated: issued.ca.created,
			customSans: issued.customSans,
			userId: c.get("user").sub,
		});

		return c.json({
			certPath: issued.certPath,
			keyPath: issued.keyPath,
			expiresAt: issued.expiresAt,
			effectiveSans: issued.effectiveSans,
			customSans: issued.customSans,
			autoSans: issued.autoSans,
			caCreated: issued.ca.created,
			caExpiresAt: issued.ca.expiresAt,
			newUrl: buildServerRestartUrl(c.req.url, host, port, true),
			serverRestarting: true,
		});
	})

	// Regenerate the root CA and re-issue the server cert with the STORED SANs.
	// Every device that imported the old CA must import the new one — the UI
	// confirms this before calling.
	.post("/regenerate-ca", requireAdmin, async (c) => {
		const ca = await regenerateCa();
		const issued = await issueServerCert();

		// Keep TLS enabled only if it already was: this endpoint never turns
		// HTTPS on by itself, it just replaces the trust anchor.
		if (settings.server.tls?.enabled) {
			scheduleServerRestart(settings.server.host, settings.server.port);
		}

		logger.warn("TLS root CA regenerated via API — all clients must re-import ca.pem", {
			userId: c.get("user").sub,
		});

		return c.json({
			expiresAt: issued.expiresAt,
			effectiveSans: issued.effectiveSans,
			caExpiresAt: ca.expiresAt,
			serverRestarting: settings.server.tls?.enabled === true,
		});
	});
