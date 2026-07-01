export * from './graph.js';
export * from './transitions.js';
export * from './machine.js';
export * from './closure.js';
export * from './validation.js';
export * from './runtime.js';

import type { NodeData, EdgeDef, IncidenceGraphSet, FibredGraph, DepProxy } from './graph.js';
import { defineDeps } from './graph.js';
import type { IncidenceMachine, MachineSet, MachineSetValidationIssue, RunningMachine } from './machine.js';
import type { TransitionNames, TransitionInput } from './transitions.js';
import type { TransitionDef } from './graph.js';
import type { Widen } from './graph.js';
import type { RunningMachineSet } from './runtime.js';
import { closeMachineSet } from './closure.js';
import { validateMachineSet } from './validation.js';
import { startMachineSet } from './runtime.js';

// --- Mixin interfaces ---

/**
 * An IncidenceGraphSet with method extensions for the pipeline.
 * Two branches from the same starting point, both validating
 * closure [E ⊆ V × V]:
 *
 * - `close()` validates closure [E ⊆ V × V]. If deps exist,
 *   applies the namespaceFunctors [{ fₖ: Gₖ → G' }] and
 *   computes the correspondence maps [{ fₖ, fₖ⁻¹ }]. Returns a
 *   `FibredGraph`.
 * - `implement()` validates closure internally, then equips
 *   the IncidenceGraphSet with transition functions [δ = { δⱼ }],
 *   producing an `IncidenceMachineMixin`. The topology is the
 *   contract; implementing against a broken contract is not
 *   permitted and will throw `ClosureError`.
 *
 * @template TNodes - The node set [V = { vᵢ }].
 * @template TEdges - The incidence relation [E = { eᵢ }].
 */
export interface IncidenceGraphSetMixin<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>
> extends IncidenceGraphSet<TNodes, TEdges> {
  implement<TResultMap extends Record<TransitionNames<TEdges>, unknown>>(
    transitions: TransitionInput<TNodes, this['deps'], TEdges, TResultMap>
  ): IncidenceMachineMixin<TNodes, TEdges, TransitionInput<TNodes, this['deps'], TEdges, TResultMap>>
  close(): FibredGraph<TNodes, TEdges>
}

/**
 * An IncidenceMachine with a `close()` method. Delegates to
 * IncidenceGraphSet closure for the topology (already validated
 * at `implement()` time), then performs machine-level closure,
 * producing a `MachineSetMixin`.
 *
 * @template TNodes - The node set [V = { vᵢ }].
 * @template TEdges - The incidence relation [E = { eᵢ }].
 * @template TTransitions - The transition implementations [δ = { δⱼ }].
 */
export interface IncidenceMachineMixin<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>,
  TTransitions extends Record<string, TransitionDef>
> extends IncidenceMachine<TNodes, TEdges, TTransitions> {
  close(): MachineSetMixin<TNodes, TEdges, TTransitions>
}

/**
 * A closed MachineSet with method extensions for the post-closure
 * pipeline. All graphs are closed [E ⊆ V × V], connected
 * [|{Gᵢ}| = 1], and all edge-demanded handlers exist.
 *
 * - `validate()` checks handler coverage and transition usage
 *   across all namespaces. Returns non-blocking diagnostic issues:
 *   - `missing-handler`: transition δⱼ does not implement one or
 *     more optional handlers [keys(δⱼ) \ {$, next} ⊂ {error, complete}].
 *     If $ errors without an `error` handler, a
 *     `MachineUnhandledError` is thrown. If $ completes without
 *     emitting and no `complete` handler exists, a
 *     `MachineCompletionError` is thrown.
 *   - `unused-transition`: transition δⱼ is implemented but no
 *     edge references it. Dead code (caught at compile time in
 *     TypeScript but not in plain JavaScript).
 * - `start()` begins traversing the root supergraph
 *   [G' = (V', E')], producing a `RunningMachineSet`.
 *
 * @template TNodes - The node set [V = { vᵢ }] of the root IncidenceMachine.
 * @template TEdges - The incidence relation [E = { eᵢ }].
 * @template TTransitions - The transition implementations [δ = { δⱼ }].
 */
export interface MachineSetMixin<
  TNodes extends Record<string, NodeData> = Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>> = Record<string, EdgeDef<TNodes>>,
  TTransitions extends Record<string, TransitionDef> = Record<string, TransitionDef>
> extends MachineSet<TNodes, TEdges, TTransitions> {
  validate(): MachineSetValidationIssue[]
  start(
    entry: Extract<keyof TNodes, string>,
    runningMachines?: Record<string, RunningMachine>,
    initialNodeData?: { [K in Extract<keyof TNodes, string>]?: Partial<Widen<TNodes[K]>> }
  ): RunningMachineSet<TNodes, TEdges, TTransitions>
}

// --- Factory (two-step) ---

/**
 * Defines an IncidenceGraphSet G = (V, E) with an optional K-indexed family
 * of dependencies { Gₖ }ₖ∈K. The graph may be open: edges can reference
 * nodes vₖ ∈ Vₖ outside V via `DepNodeRef`, resolved during closure.
 *
 * Returns the IncidenceGraph G = (V, E) and an `implement()` method
 * to supply transition functions δ, producing an IncidenceMachine.
 *
 * @param def - The IncidenceGraphSet definition.
 * @param def.nodes - V = { vᵢ }, the node set with typed data shapes.
 * @param def.deps - (Optional) A K-indexed family of IncidenceMachines { Gₖ }ₖ∈K
 *   whose nodes may be referenced by edges via `DepNodeRef`.
 * @param def.edges - A record or a function receiving a `DepProxy` over { Gₖ }ₖ∈K,
 *   returning E = { eᵢ }, the incidence relation.
 * @returns `{ incidenceGraph, implement() }`.
 */
export function define<
  TNodes extends Record<string, NodeData>,
  TDeps extends Record<string, IncidenceMachine<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>>>,
  const TEdges extends Record<string, EdgeDef<TNodes>>,
>(def: {
  nodes: TNodes
  deps?: TDeps
  edges: TEdges | ((refs: DepProxy<TDeps>) => TEdges)
}) {
  const depRefs = def.deps ? defineDeps(def.deps) : ({} as DepProxy<TDeps>)
  const edgeDefs = typeof def.edges === 'function' ? def.edges(depRefs) : def.edges

  const incidenceGraphSet: IncidenceGraphSet<TNodes, TEdges> = { nodes: def.nodes, edges: edgeDefs, deps: def.deps ?? {} }

  return {
    incidenceGraphSet,
    /**
     * Equips the incidence graph with transition functions δ, producing
     * an `IncidenceMachine`. Each transition referenced by the edges must
     * be implemented with a `$` observable factory, a `next` handler, and
     * optionally `error` and `complete` handlers.
     *
     * @param transitions - A record of transition implementations [δ = { δⱼ }],
     *   one per distinct transition name in E = { eᵢ }.
     * @returns An `IncidenceMachine`: incidence graph + transitions + incidence machines.
     */
    implement<TResultMap extends Record<TransitionNames<TEdges>, unknown>>(
      transitions: TransitionInput<TNodes, TDeps, TEdges, TResultMap>
    ): IncidenceMachine<TNodes, TEdges, TransitionInput<TNodes, TDeps, TEdges, TResultMap>> & {
      /**
       * Closes the incidence machine by validating all constituent graphs.
       * Delegates to `closeMachineSet`. See its docstring for the full
       * algorithm: classify, flatten, namespace, close, correspondence,
       * validate transitions.
       *
       * @returns A `MachineSet` with `.validate()` and `.start()` methods.
       */
      close(): MachineSet<TNodes, TEdges, TransitionInput<TNodes, TDeps, TEdges, TResultMap>> & {
        /**
         * Checks handler coverage and transition usage across all
         * namespaces. Delegates to `validateMachineSet`. Returns
         * non-blocking diagnostic warnings: `missing-handler` for
         * transitions [δⱼ] missing optional handlers (`error`,
         * `complete`) whose absence would cause
         * `MachineUnhandledError` or `MachineCompletionError` at
         * runtime, and `unused-transition` for transitions [δⱼ]
         * no edge references.
         *
         * @returns A list of `MachineSetValidationIssue`s (may be empty).
         */
        validate(): MachineSetValidationIssue[]
        /**
         * Starts the machine set, traversing the root supergraph.
         * Delegates to `startMachineSet`. See its docstring for the
         * full runtime behaviour: subscription, transition resolution,
         * teardown.
         *
         * @param entry - The starting node in the root machine's V.
         * @param runningMachines - Running instances of disconnected machines.
         * @param initialNodeData - Partial map of nodes to partial data, amending any node in V'.
         * @returns A `RunningMachineSet`.
         */
        start(
          entry: Extract<keyof TNodes, string>,
          runningMachines?: Record<string, RunningMachine>,
          initialNodeData?: { [K in Extract<keyof TNodes, string>]?: Partial<Widen<TNodes[K]>> }
        ): RunningMachineSet<TNodes, TEdges, TransitionInput<TNodes, TDeps, TEdges, TResultMap>>
      }
    } {
      const im: IncidenceMachine<TNodes, TEdges, TransitionInput<TNodes, TDeps, TEdges, TResultMap>> = { nodes: incidenceGraphSet.nodes, edges: incidenceGraphSet.edges, transitions, deps: def.deps ?? {}, source: incidenceGraphSet }
      return {
        ...im,
        close() {
          const ms = closeMachineSet(im)
          return {
            ...ms,
            validate() {
              return validateMachineSet(ms)
            },
            start(entry, runningMachines?, initialNodeData?) {
              return startMachineSet(ms, entry, runningMachines, initialNodeData)
            }
          }
        }
      }
    }
  }
}
