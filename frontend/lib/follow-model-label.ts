/**
 * Readable labels for the "follow the configured model" choices (`__default__`, `__summary__`).
 *
 * The sentinel values are settings plumbing, never text for people. Before a default model is
 * configured (a fresh instance, or one whose model was removed) there is no target to name, and
 * the pickers used to fall back to the sentinel itself ("__default__") or to an empty
 * interpolation ("Default ()"). These helpers name the role instead and say it is not configured.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The label of a follow option inside a model list: its target model's label, else the target's
 * value, else the role's "not configured" text — never the sentinel.
 */
export function followOptionLabel(
	targetLabel: string | null | undefined,
	targetValue: string | null | undefined,
	unsetLabel: string,
): string {
	return targetLabel?.trim() || targetValue?.trim() || unsetLabel;
}

/**
 * "Default (model)" where a session follows the default model, or the "not configured" text when
 * no default is set. `t` must resolve `followDefault` and `followDefaultUnset` (the `narrator`
 * and `narrators` namespaces both have them).
 */
export function followDefaultLabel(t: Translate, defaultModel: string | null | undefined): string {
	const model = defaultModel?.trim();
	return model ? t("followDefault", { model }) : t("followDefaultUnset");
}
