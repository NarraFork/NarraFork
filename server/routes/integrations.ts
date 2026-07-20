import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { integrationSummaryQuerySchema } from "../lib/validators/integrations";
import { getIntegrationSummary } from "../services/integration-summary-service";

export const integrationRoutes = new Hono();

integrationRoutes.get("/summary", async (c) => {
	const parsed = integrationSummaryQuerySchema.safeParse({
		attentionLimit: c.req.query("attentionLimit"),
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const user = c.get("user");
	return c.json(
		await getIntegrationSummary({
			userId: user.sub,
			role: user.role,
			attentionLimit: parsed.data.attentionLimit,
		}),
	);
});
