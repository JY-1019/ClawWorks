import { AsyncLocalStorage } from "node:async_hooks";

export type EnterpriseDispatchContext = {
  runId: string;
  abortSignal: AbortSignal;
};

// One dispatch owns the admitted session lane and trace across attempts. Run-id scoping
// prevents a spawned child from inheriting its parent's session admission.
const KEY = Symbol.for("openclaw.enterpriseDispatchContext");
const globals = globalThis as { [KEY]?: AsyncLocalStorage<EnterpriseDispatchContext> };
const context = (globals[KEY] ??= new AsyncLocalStorage<EnterpriseDispatchContext>());

export function getEnterpriseDispatchContext(runId: string): EnterpriseDispatchContext | undefined {
  const state = context.getStore();
  return state?.runId === runId ? state : undefined;
}

export function isEnterpriseDispatchManaged(runId: string): boolean {
  return getEnterpriseDispatchContext(runId) !== undefined;
}

export function withEnterpriseDispatch<T>(
  state: EnterpriseDispatchContext,
  run: () => Promise<T>,
): Promise<T> {
  return context.run(state, run);
}
