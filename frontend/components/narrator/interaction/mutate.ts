/** The mutate call these controls actually make. The rest of the react-query result is unused. */
export interface Mutate<TVariables> {
	mutate: (variables: TVariables) => void;
}

/** Same call, plus the pending flag a toolbar button reads. */
export interface PendingMutate<TVariables> extends Mutate<TVariables> {
	isPending: boolean;
}
