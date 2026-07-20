import { z } from "zod";

export const integrationSummaryQuerySchema = z
	.object({
		attentionLimit: z.preprocess(
			(value) => (value === undefined ? 8 : Number(value)),
			z.number().int().min(1).max(20),
		),
	})
	.strict();

export type IntegrationSummaryQuery = z.infer<typeof integrationSummaryQuerySchema>;
