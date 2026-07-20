import { z } from "zod";
import { type PrincipalRef, principalRefSchema } from "./principals";
import {
	type ResourceRef,
	type ResourceScope,
	resourceRefSchema,
	resourceScopeSchema,
} from "./resources";

export const EVENT_TOPIC_MAX_LENGTH = 200;
export const EVENT_TOPICS_MAX_ITEMS = 32;

export const eventTopicSchema = z
	.string()
	.min(1)
	.max(EVENT_TOPIC_MAX_LENGTH)
	.regex(/^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/);
export type EventTopic = z.infer<typeof eventTopicSchema>;

export const eventSubscriptionSchema = z
	.object({
		topics: z
			.array(eventTopicSchema)
			.min(1)
			.max(EVENT_TOPICS_MAX_ITEMS)
			.refine((topics) => new Set(topics).size === topics.length, "Event topics must be unique"),
		scope: resourceScopeSchema,
	})
	.strict();
export interface EventSubscription {
	topics: EventTopic[];
	scope: ResourceScope;
}

export const integrationEventMetadataSchema = z
	.object({
		id: z.string().min(1).max(128),
		topic: eventTopicSchema,
		occurredAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		actor: principalRefSchema.optional(),
		resource: resourceRefSchema.optional(),
	})
	.strict();
export interface IntegrationEventMetadata {
	id: string;
	topic: EventTopic;
	occurredAt: number;
	actor?: PrincipalRef;
	resource?: ResourceRef;
}

/** Payload schemas are owned by each event topic; the kernel only standardizes metadata. */
export type IntegrationEvent<TPayload> = IntegrationEventMetadata & { payload: TPayload };
