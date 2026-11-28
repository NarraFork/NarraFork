/**
 * What `GET /api/sourcing/templates` returns: the public side of the service templates and
 * the add-provider catalog (docs/PROVIDER-SOURCING-DESIGN.md §15.2). No user data, no
 * secrets; display names are i18n keys the frontend translates.
 */
import type { CredentialUserAgentMode } from "../credential-network";
import type { ServiceTemplateId, SourceProtocol, SourceRegion } from "./identify";

/** Protocols the add-provider form offers: the HTTP protocols plus a NUG gateway. */
export type AddProviderType = "nug" | SourceProtocol;

export type PresetEndpoints = Partial<Record<AddProviderType, string>>;

export type ProviderBilling = "payg" | "token-plan";
/** MiMo's international Token Plan clusters; a key belongs to one of them. */
export type ProviderCluster = "sgp" | "ams";

export interface ProviderConnectionSelection {
	region: SourceRegion;
	billing: ProviderBilling;
	cluster?: ProviderCluster;
}

/** One region / billing (/ cluster) variant of a preset and what it creates. */
export interface ProviderConnection extends ProviderConnectionSelection {
	endpoints: PresetEndpoints;
	defaultProtocol: AddProviderType;
	/** Protocol the provider is created with when it is not the generic Responses-first pick. */
	creationProtocol?: AddProviderType;
	userAgentMode?: CredentialUserAgentMode;
}

export interface ProviderPreset {
	id: string;
	name: string;
	nameKey?: string;
	endpoints: PresetEndpoints;
	category?: "api" | "platform-login";
	defaultProtocol?: AddProviderType;
	/**
	 * Protocol the add-provider form starts on when this preset offers several.
	 *
	 * NarraFork otherwise prefers Responses → Messages → Chat Completions, so a
	 * provider whose features only unlock on one route has to say so here: Kimi
	 * needs Chat Completions for its dynamic tool loading (a `system` message
	 * carrying `tools`), which the Anthropic and Responses relays have no form of.
	 */
	creationProtocol?: AddProviderType;
	/** Short tagline shown on the catalog card. */
	descriptionKey?: string;
	/** UI languages (primary subtags, e.g. "zh") the preset is offered in. Omitted: all. */
	languages?: readonly string[];
	/** Extra search terms (local names, brands). */
	aliases?: readonly string[];
	/** Position in the Popular list, ascending; omitted means not popular. */
	popular?: number;
	/** Region / billing variants; when present the form asks for them. */
	connections?: readonly ProviderConnection[];
	/** Region preselected whatever the UI language (the international-only aliases). */
	defaultRegion?: SourceRegion;
}

export interface ServiceTemplateView {
	id: ServiceTemplateId;
	kind: "known" | "api";
	endpoints?: Partial<Record<SourceProtocol, string>>;
	regions?: Partial<Record<SourceRegion, Partial<Record<SourceProtocol, string>>>>;
	defaults?: { userAgentMode?: CredentialUserAgentMode };
}

export interface SourcingCatalog {
	templates: ServiceTemplateView[];
	presets: ProviderPreset[];
}
