export function shouldShowUpdateScheduleButton(options: {
	canRestartIntoUpdate: boolean;
	applySucceeded: boolean;
	coordinationFailed: boolean;
}): boolean {
	return options.canRestartIntoUpdate && (!options.applySucceeded || options.coordinationFailed);
}
