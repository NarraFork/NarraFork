import type { SourcingCatalog } from "@shared/sourcing/presets";
import { request } from "./client";

export const sourcingApi = {
	/** Service templates and the add-provider catalog (constant for a build). */
	templates: () => request<SourcingCatalog>("/sourcing/templates"),
};
