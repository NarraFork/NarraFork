/**
 * The model of a session opened for a task (outline P2 PR 10c-1): the same list and "follow the
 * default" entry as creating any session. Loaded only when the form is opened (the model catalog
 * is not part of the board).
 */
import { Select } from "@mantine/core";
import { useAllModels } from "../../../hooks/useModels";
import { FOLLOW_DEFAULT_MODEL } from "../../../lib/constants";

/** Options the list shows at once (as the session creation form). */
const MODEL_SELECT_OPTION_LIMIT = 100;

export default function OpenSessionModelSelect({
	label,
	value,
	onChange,
}: {
	label: string;
	/** Empty: follow the default. */
	value: string;
	onChange: (model: string) => void;
}) {
	const { groupedModels, modelOptionsFilter } = useAllModels();
	return (
		<Select
			size="xs"
			label={label}
			data={groupedModels}
			searchable
			filter={modelOptionsFilter}
			limit={MODEL_SELECT_OPTION_LIMIT}
			value={value || FOLLOW_DEFAULT_MODEL}
			onChange={(next) => onChange(!next || next === FOLLOW_DEFAULT_MODEL ? "" : next)}
			maxDropdownHeight={240}
			// Inside the form's popover, not in a portal of its own: a click on an option would
			// otherwise count as a click outside the popover and close the form with what was typed.
			comboboxProps={{ withinPortal: false }}
			data-testid="task-open-session-model"
		/>
	);
}
