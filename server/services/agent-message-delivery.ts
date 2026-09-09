import type { SideCarBody } from "@shared/sidecar-body";
import { generateId } from "../lib/id";
import type { AgentMessageSender } from "./agent-message-origin";

/** An exact delivery, never inferred from model text or a text hash. */
export interface AgentMessageDelivery {
	recipientNarratorId: string;
	recipientMessageId: string;
	sender: AgentMessageSender;
	fromToolUseId: string;
	/** Reader-facing body, before sender prefixes and reply-request instructions. */
	text: string;
}

export function createAgentMessageDelivery(
	recipientNarratorId: string,
	sender: AgentMessageSender,
	fromToolUseId: string,
	text: string,
): AgentMessageDelivery {
	return {
		recipientNarratorId,
		recipientMessageId: generateId(),
		sender: { ...sender },
		fromToolUseId,
		text,
	};
}

export function agentMessageDeliveryBody(delivery: AgentMessageDelivery): SideCarBody {
	return {
		kind: "messages",
		items: [
			{
				fromId: delivery.sender.id,
				fromTitle: delivery.sender.title ?? null,
				fromLabel: delivery.sender.label,
				fromType: delivery.sender.type ?? null,
				fromToolUseId: delivery.fromToolUseId,
				text: delivery.text,
			},
		],
	};
}
