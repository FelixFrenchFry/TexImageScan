import { type AppState } from './protocol';

export type InactiveWorkspace = { resultId: string | null; inputId: string | null };

/** a new panel starts empty but follows recognition already in progress */
export function inactiveWorkspace(state: AppState): InactiveWorkspace {
  return {
    resultId: state.result?.id ?? null,
    inputId:
      state.job.kind === 'running' && state.job.phase !== 'downloading'
        ? null
        : (state.input?.id ?? null),
  };
}

export function visibleWorkspace(
  state: AppState,
  inactive: InactiveWorkspace,
): Pick<AppState, 'result' | 'input'> {
  const result = state.result?.id === inactive.resultId && !state.saveError ? null : state.result;
  const input = state.input?.id === inactive.inputId ? null : state.input;
  return {
    result,
    input: input ?? (result ? { id: result.id, name: result.name, image: result.image } : null),
  };
}
