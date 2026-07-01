import { Observable } from 'rxjs';
import type { NodeData, EdgeDef, ResolveNodeData, SourceNodeData, Widen, HandlerDirection, DepNodeRef, TransitionDef } from './graph.js';
import type { RunningMachinesOf } from './machine.js';

// --- Edge + transition inference ---

/**
 * Extracts the union of transition names referenced in the incidence
 * relation [E = { eᵢ }]. Each edge's `on` field encodes a transition
 * name and handler direction; this type collects the distinct names.
 *
 * @template TEdges - The incidence relation [E = { eᵢ }].
 */
export type TransitionNames<TEdges> = {
  [K in keyof TEdges]: TEdges[K] extends { on: `${infer U}.${string}` } ? U : never
}[keyof TEdges]

/**
 * Collects all target nodes v₂ for edges matching a given transition
 * name (acting as the index j into δ) and handler direction
 * [e = (v₁, v₂) where e.on = TOn.THandler].
 *
 * @template TEdges - The incidence relation [E = { eᵢ }].
 * @template TOn - The transition name, indexing into [δ = { δⱼ }].
 * @template THandler - The handler direction (`'next'` or `'error'`).
 */
export type CollectTargets<TEdges, TOn extends string, THandler extends string> = {
  [K in keyof TEdges]: TEdges[K] extends { on: `${TOn}.${THandler}`; to: infer To } ? To : never
}[keyof TEdges]

/**
 * Collects all source nodes v₁ for edges matching a given transition
 * name (acting as the index j into δ) and handler direction
 * [e = (v₁, v₂) where e.on = TOn.THandler].
 *
 * @template TEdges - The incidence relation [E = { eᵢ }].
 * @template TOn - The transition name, indexing into [δ = { δⱼ }].
 * @template THandler - The handler direction (`'next'` or `'error'`).
 */
export type CollectSources<TEdges, TOn extends string, THandler extends string> = {
  [K in keyof TEdges]: TEdges[K] extends { on: `${TOn}.${THandler}`; from: infer From } ? From : never
}[keyof TEdges]

/**
 * Derives the expected signature for a transition handler δⱼ based on the
 * edges that reference it. The handler receives the source data [dₙ from
 * q(n)], the destination data [dᵥ' from its last visit], and the emission
 * from $. Return type is inferred from the union of target node data shapes.
 *
 * @template TNodes - V = { vᵢ }, the node set.
 * @template TEdges - The incidence relation [E = { eᵢ }].
 * @template TOn - The transition name, indexing into [δ = { δⱼ }].
 * @template THandler - The handler direction (`'next'` or `'error'`).
 * @template TResult - The emission type from the `$` observable [∈ $].
 */
export type ExpectedHandler<
  TNodes extends Record<string, NodeData>,
  TEdges,
  TOn extends string,
  THandler extends string,
  TResult
> = [CollectTargets<TEdges, TOn, THandler>] extends [never]
  ? (result: TResult) => unknown
  : (
      result: TResult,
      dest: ResolveNodeData<TNodes, CollectTargets<TEdges, TOn, THandler>>,
      source: SourceNodeData<TNodes, CollectSources<TEdges, TOn, THandler>>,
      edge: string
    ) => ResolveNodeData<TNodes, CollectTargets<TEdges, TOn, THandler>>

/**
 * The shape of a transition within the `implement()` callback.
 * The `$` factory returns an Observable monad over the environment,
 * and the `next` and `error` handlers are the transition functions
 * [δⱼ] that compute the next state q(n+1).
 *
 * @template TNodes - The node set [V = { vᵢ }].
 * @template TIncidenceMachines - A K-indexed family of dep IncidenceMachines [{ IMₖ }ₖ∈K].
 * @template TEdges - The incidence relation [E = { eᵢ }].
 * @template TOn - The transition name, indexing into [δ = { δⱼ }].
 * @template TResult - The emission type from the `$` observable [∈ $].
 */
export type TransitionShape<TNodes extends Record<string, NodeData>, TIncidenceMachines, TEdges, TOn extends string, TResult> = {
  /** Environment monad factory; returns an Observable over the external environment whose emissions feed into δⱼ. */
  $: (runningMachines: RunningMachinesOf<TIncidenceMachines>) => Observable<TResult>
  /** Called when the environment Observable emits a value. */
  next: ExpectedHandler<TNodes, TEdges, TOn, 'next', TResult>
} & ([CollectTargets<TEdges, TOn, 'error'>] extends [never]
  ? { /** Optional when no error edges exist. If omitted and the environment Observable errors, throws MachineUnhandledError. */ error?: ExpectedHandler<TNodes, TEdges, TOn, 'error', TResult> }
  : { /** Required when error edges exist. */ error: ExpectedHandler<TNodes, TEdges, TOn, 'error', TResult> }
) & ([CollectTargets<TEdges, TOn, 'complete'>] extends [never]
  ? { /** Optional when no complete edges exist. If omitted and the environment Observable completes without emission, throws MachineCompletionError. */ complete?: ExpectedHandler<TNodes, TEdges, TOn, 'complete', TResult> }
  : { /** Required when complete edges exist. */ complete: ExpectedHandler<TNodes, TEdges, TOn, 'complete', TResult> }
)

/**
 * A mapped type over the distinct transition names in E = { eᵢ }.
 * Each index j produces a `TransitionShape` parameterised by j and
 * by `TResultMap[j]`, the emission type of δⱼ's environment
 * Observable `$`. Reverse mapped type inference resolves `TResultMap`
 * from the `$` return types, then flows each emission type into
 * the `next`/`error`/`complete` handler signatures for δⱼ.
 *
 * @template TNodes - The node set [V = { vᵢ }].
 * @template TIncidenceMachines - A K-indexed family of dep IncidenceMachines [{ IMₖ }ₖ∈K].
 * @template TEdges - The incidence relation [E = { eᵢ }].
 * @template TResultMap - A map from each transition name j to the emission type of δⱼ's environment Observable `$`.
 */
export type TransitionInput<TNodes extends Record<string, NodeData>, TIncidenceMachines, TEdges, TResultMap extends Record<TransitionNames<TEdges>, unknown>> = {
  [J in keyof TResultMap & TransitionNames<TEdges>]: TransitionShape<TNodes, TIncidenceMachines, TEdges, J, TResultMap[J]>
}

/**
 * Extracts the concrete function type of a transition handler δⱼ
 * (`'next'` or `'error'`) from a transition object.
 *
 * @template T - The transition object containing [δⱼ].
 * @template H - The handler key (`'next'` or `'error'`).
 */
export type GetHandler<T, H extends string> = T extends { [K in H]: infer F } ? F : never

/**
 * The union of all possible state values for a machine, one per node
 * [{ node: v, data: dᵥ } for each v ∈ V].
 *
 * @template TNodes - The node set [V = { vᵢ }].
 */
export type StateUnion<TNodes extends Record<string, NodeData>> = {
  [K in keyof TNodes]: { node: K; data: Widen<TNodes[K]> }
}[keyof TNodes]
