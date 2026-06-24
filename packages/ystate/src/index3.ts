import { Observable, Subject, filter, type Subscriber, type Subscription } from 'rxjs';

/**
 * Core library for defining pure finite state machines with typed nodes,
 * observable-driven edges, and compile-time edge validation.
 *
 * @packageDocumentation
 */

// --- Type primitives ---

/** Represents a record of node data (the state of each node). */
export interface NodeData { [key: string]: unknown }

/**
 * A branded reference to a node in a dependency IncidenceGraphSet.
 * Points to a specific node v ∈ Vₖ in one of the dependency graphs
 * from a K-indexed family { Gₖ }ₖ∈K, creating an open edge whose
 * target lies outside the current graph's node set V.
 *
 * @template TNodeMap - Vₖ = { vᵢ }, the node set of dependency IncidenceGraphSet Gₖ.
 * @template TNode - A specific node v ∈ Vₖ being referenced.
 */
export interface DepNodeRef<
  TNodeMap extends Record<string, NodeData> = Record<string, NodeData>,
  TNode extends Extract<keyof TNodeMap, string> = Extract<keyof TNodeMap, string>
> { __brand: 'depNodeRef'; dep: string; node: TNode }

/**
 * Given a set of dependency IncidenceGraphSets { k₁: G₁, k₂: G₂, ... },
 * produces a proxy exposing each Vₖ as branded `DepNodeRef`s, enabling
 * edge definitions of the form (v, vₖ) where v ∈ V and vₖ ∈ Vₖ.
 *
 * @template T - A K-indexed family of IncidenceGraphSets { Gₖ }ₖ∈K.
 */
export type DepProxy<T> = {
  [K in keyof T]: T[K] extends { incidenceGraph: { nodes: infer N } }
    ? { nodes: { readonly [NodeName in Extract<keyof N, string>]: DepNodeRef<N extends Record<string, NodeData> ? N : never, NodeName> } }
    : never
}

/**
 * Constructs a `DepProxy` for a K-indexed family of IncidenceGraphSets { Gₖ }ₖ∈K,
 * exposing each Vₖ as branded `DepNodeRef`s for cross-graph edge definitions.
 *
 * @param mapping - A K-indexed family of IncidenceGraphSets { Gₖ }ₖ∈K.
 * @returns A `DepProxy` mapping each kᵢ to its Vₖ as `DepNodeRef`s.
 */
export function defineDeps<T extends Record<string, any>>(mapping: T): DepProxy<T> {
  return new Proxy({} as any, {
    get(_, sym) {
      return {
        nodes: new Proxy({}, { get(_, node) { return { __brand: 'depNodeRef', dep: String(sym), node } } }),
      }
    },
  })
}

/**
 * Widens literal types in a node's data to their base types.
 * Used so that transition handlers can return plain `string` rather than string literals.
 *
 * @template T - The node data type to widen.
 */
export type Widen<T> =
  T extends string ? string :
  T extends number ? number :
  T extends boolean ? boolean :
  T extends readonly (infer U)[] ? Widen<U>[] :
  T extends Record<string, infer V> ? { [K in keyof T]: Widen<T[K]> } :
  T

/**
 * Resolves the data type of a target node v. If v ∈ V (local), returns the
 * widened data of V[v]. If v is a `DepNodeRef` referencing vₖ ∈ Vₖ, returns
 * the widened data of Vₖ[vₖ].
 *
 * @template TNodeMap - V = { vᵢ }, the node set of the current graph G.
 * @template TTo - Either a key v ∈ V or a `DepNodeRef` to vₖ ∈ Vₖ.
 */
export type ResolveNodeData<TNodeMap extends Record<string, NodeData>, TTo> =
  TTo extends keyof TNodeMap ? Widen<TNodeMap[TTo]> :
  TTo extends DepNodeRef<infer ForeignMap, infer ForeignNode> ? Widen<ForeignMap[ForeignNode]> :
  never

/**
 * Resolves the data type of a source node v₁ (the `from` of an edge e = (v₁, v₂)).
 *
 * @template TNodeMap - V = { vᵢ }, the node set of the current graph G.
 * @template TFrom - The source node v₁ ∈ V.
 */
export type SourceNodeData<TNodeMap extends Record<string, NodeData>, TFrom> =
  TFrom extends keyof TNodeMap ? Widen<TNodeMap[TFrom]> : never

/**
 * An edge in the incidence relation, connecting a source node to a target
 * node [e = (v₁, v₂) ∈ E]. The source v₁ must be in V, while the target
 * v₂ may be local [v₂ ∈ V] or a `DepNodeRef` into a dependency
 * IncidenceGraphSet [v₂ ∈ Vₖ]. The `on` field binds the edge to a
 * transition function δᵢ and direction (next | error).
 *
 * @template TNodes - V = { vᵢ }, the node set of graph G = (V, E).
 */
export interface EdgeDef<TNodes extends Record<string, NodeData> = Record<string, NodeData>> {
  from: Extract<keyof TNodes, string>
  to: Extract<keyof TNodes, string> | DepNodeRef
  on: `${string}.${'next' | 'error'}`
}

/** Describes a transition with an observable factory, a success handler, and an error handler. */
export interface TransitionDef {
  $: Function
  next: Function
  error: Function
}

/**
 * The pure topology of a finite state machine: a node set V = { vᵢ } and an
 * incidence relation E = { eᵢ } that maps edges to pairs of nodes.
 *
 * An IncidenceGraph may be **open** [∃ e = (v₁, v₂) ∈ E where v₂ ∉ V,
 * referenced via `DepNodeRef`] or **closed** [E ⊆ V × V].
 *
 * @template TNodes - V = { vᵢ }, the node set, a record of node names to data shapes.
 * @template TEdges - E = { eᵢ }, the incidence relation, a record of edge names to `EdgeDef`s.
 */
export interface IncidenceGraph<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>
> {
  nodes: TNodes
  edges: TEdges
}

/**
 * An IncidenceGraph equipped with a K-indexed family of dependency
 * IncidenceGraphSets [{ Gₖ }ₖ∈K]. The deps record carries the graphs
 * whose nodes may be referenced by open edges [∃ e = (v₁, v₂) ∈ E
 * where v₂ ∈ Vₖ, v₂ ∉ V] via `DepNodeRef`.
 *
 * An IncidenceGraphSet is itself an IncidenceGraph; the set always
 * contains at least one member (itself), so the minimum size is 1.
 *
 * Produced by `define()`. Not yet a valid closed graph: the edge set
 * may reference nodes outside V. Call `.close()` to validate closure
 * [E ⊆ V × V] and produce an `IncidenceGraphSetCorrespondence`, the
 * preimage and image maps of the namespaceFunctors applied during
 * closure [{ fₖ, fₖ⁻¹ | fₖ ∈ applied namespaceFunctors }]. Since
 * each fₖ is an injective graph homomorphism, fₖ⁻¹ is well-defined
 * on im(fₖ).
 *
 * @template TNodes - V = { vᵢ }, the node set.
 * @template TEdges - E = { eᵢ }, the incidence relation.
 */
export interface IncidenceGraphSet<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>
> extends IncidenceGraph<TNodes, TEdges> {
  deps: Record<string, IncidenceGraphSet<Record<string, NodeData>, Record<string, EdgeDef>>>
}

/**
 * An IncidenceGraphSet equipped with transition functions [δ = { δⱼ }].
 * The K-indexed family of dependencies [{ Gₖ }ₖ∈K] is narrowed from
 * IncidenceGraphSets to IncidenceMachines, so each Gₖ also carries its
 * own transition functions [δₖ = { δⱼ }ₖ].
 *
 * Produced by `define().implement()`. Not yet a valid FSM: the graph may
 * be open and has not been validated. Call `.close()` to validate closure
 * [E ⊆ V × V], compute F, and produce a `MachineSet`.
 *
 * @template TNodes - The node set [V = { vᵢ }].
 * @template TEdges - The incidence relation [E = { eᵢ }].
 * @template TTransitions - The transition implementations [δ = { δⱼ }].
 */
export interface IncidenceMachine<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>,
  TTransitions extends Record<string, TransitionDef>
> extends IncidenceGraphSet<TNodes, TEdges> {
  transitions: TTransitions
  deps: Record<string, IncidenceMachine<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>>>
}

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
  implement<TTransitions extends Record<TransitionNames<TEdges>, TransitionDef>>(
    factory: (t: TransitionBuilders<TNodes, this['deps'], TEdges>) => TTransitions
  ): IncidenceMachineMixin<TNodes, TEdges, TTransitions>
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
  close(): MachineSetMixin<TNodes>
}

/**
 * A MachineSet with a `start()` method that begins traversing the root
 * supergraph [G' = (V', E')], producing a `RunningMachineSet`.
 *
 * @template TNodes - The node set [V = { vᵢ }] of the root IncidenceMachine.
 */
export interface MachineSetMixin<
  TNodes extends Record<string, NodeData> = Record<string, NodeData>
> extends MachineSet<TNodes> {
  start(
    entry: Extract<keyof TNodes, string>,
    runningMachines?: Record<string, RunningMachine>,
    initialNodeData?: { [K in Extract<keyof TNodes, string>]?: Partial<Widen<TNodes[K]>> }
  ): RunningMachineSet
}

/**
 * A graph equipped with its fibre decomposition over the
 * namespaceFunctors that built it. Closure has been proven
 * [E ⊆ V × V], and the correspondence records the fibres
 * of each fₖ: Gₖ → G'. Since each fₖ is injective, the
 * fibres are singletons, giving a clean 1:1 map between
 * local and global names in both directions [fₖ, fₖ⁻¹].
 *
 * @template TNodes - The node set [V = { vᵢ }].
 * @template TEdges - The incidence relation [E = { eᵢ }].
 */
export interface FibredGraph<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>
> extends IncidenceGraphSet<TNodes, TEdges> {
  correspondence: IncidenceGraphSetCorrespondence
}

/**
 * Records the forward and inverse maps of the namespaceFunctors
 * applied during closure. Each namespaceFunctor fₖ is an injective
 * graph homomorphism [fₖ: Gₖ → G']. Since fₖ is injective, its
 * inverse fₖ⁻¹ is well-defined on im(fₖ).
 *
 * - `image`: the forward map [fₖ: Vₖ → V', Eₖ → E'], mapping local
 *   names to their namespaced global names. Keyed by namespace.
 * - `preimage`: the inverse map [fₖ⁻¹: im(fₖ) → Vₖ, im(fₖ) → Eₖ],
 *   mapping global names back to their local names. Keyed by namespace.
 */
export interface Correspondence {
  preimage: Record</* namespace */ string, {
    nodes: Record</* global */ string, /* local */ string>
    edges: Record</* global */ string, /* local */ string>
  }>
  image: Record</* namespace */ string, {
    nodes: Record</* local */ string, /* global */ string>
    edges: Record</* local */ string, /* global */ string>
  }>
}

/**
 * Correspondence extended with the unioned/disjoint classification
 * of dep keys [K = R ∪ (K \ R)]. Produced by `IncidenceGraphSet.close()`.
 *
 * - `unioned` [R ⊆ K]: deps to which a namespaceFunctor fₖ was applied
 *   [fₖ: Gₖ → G'], their nodes and edges appear in the correspondence maps.
 * - `disjoint` [K \ R]: deps with node sets disjoint from the supergraph
 *   [Vₖ ∩ V' = ∅], no fₖ was applied.
 */
export interface IncidenceGraphSetCorrespondence extends Correspondence {
  unioned: string[]
  disjoint: string[]
}

/**
 * Correspondence extended with the transition lookup. Produced by
 * `IncidenceMachine.close()`. Collects the transition functions
 * [δ = { δⱼ }] from the root machine and all unioned deps, indexed
 * by the namespace assigned by each namespaceFunctor fₖ so the
 * runtime can resolve which δⱼ handles a given edge via
 * `transitions[fₖ(ns)][j]` without walking the composition tree.
 * Root machine transitions live under `transitions['']`.
 */
export interface MachineCorrespondence extends IncidenceGraphSetCorrespondence {
  transitions: Record</* namespace */ string, Record</* local transition name */ string, TransitionDef>>
}

// --- Closure errors ---

/**
 * An IncidenceGraphSet closure issue. Each variant identifies
 * the edge [e ∈ E] that violates closure [E ⊆ V × V] and
 * carries enough context to diagnose the problem, including
 * the available alternatives where applicable.
 */
export type IncidenceGraphSetClosureIssue =
  | { kind: 'missing-dep'; edge: string; dep: string; availableDeps: string[] }
  | { kind: 'missing-dep-node'; edge: string; dep: string; node: string; availableNodes: string[] }
  | { kind: 'missing-target'; edge: string; node: string; namespace: string; availableNodes: string[] }
  | { kind: 'missing-source'; edge: string; node: string; namespace: string; availableNodes: string[] }
  | { kind: 'namespace-collision'; namespace: string; node: string; existingNamespace: string }

/**
 * IncidenceGraphSet closure failed [E ⊄ V × V]. Thrown by
 * `IncidenceGraphSet.close()` and internally by `implement()`
 * when the topology contract is broken.
 */
export class IncidenceGraphSetClosureError extends Error {
  issues: IncidenceGraphSetClosureIssue[]
  constructor(issues: IncidenceGraphSetClosureIssue[]) {
    const lines = issues.map(i => {
      switch (i.kind) {
        case 'missing-dep':
          return `  edge '${i.edge}': dep '${i.dep}' not in K. Available deps [K = {${i.availableDeps.join(', ')}}]`
        case 'missing-dep-node':
          return `  edge '${i.edge}': node '${i.node}' not in dep '${i.dep}'. Available [V_${i.dep} = {${i.availableNodes.join(', ')}}]`
        case 'missing-target':
          return `  edge '${i.edge}': target '${i.node}' not in V'${i.namespace ? ` (namespace '${i.namespace}')` : ''}. Available [V' = {${i.availableNodes.join(', ')}}]`
        case 'missing-source':
          return `  edge '${i.edge}': source '${i.node}' not in V${i.namespace ? ` (namespace '${i.namespace}')` : ''}. Available [V = {${i.availableNodes.join(', ')}}]`
        case 'namespace-collision':
          return `  namespaceFunctor collision: node '${i.node}' in namespace '${i.namespace}' already exists from namespace '${i.existingNamespace}'`
      }
    })
    super(`IncidenceGraphSet closure failed [E ⊄ V × V]:\n${lines.join('\n')}`)
    this.issues = issues
  }
}

/**
 * An IncidenceMachine closure issue. Each variant identifies an edge
 * [e ∈ E] with a transition-level problem and carries enough context
 * to diagnose it: a missing δⱼ at a given namespace, a malformed
 * edge binding, or a namespace with no collected transitions.
 */
export type IncidenceMachineClosureIssue =
  | { kind: 'missing-transition'; edge: string; transition: string; namespace: string; availableTransitions: string[] }
  | { kind: 'malformed-edge-on'; edge: string; on: string }
  | { kind: 'missing-namespace-transitions'; edge: string; namespace: string; availableNamespaces: string[] }

/**
 * IncidenceMachine closure failed. The topology is valid [E ⊆ V × V]
 * but one or more edges reference transition functions [δⱼ] that
 * have no implementation.
 */
export class IncidenceMachineClosureError extends Error {
  issues: IncidenceMachineClosureIssue[]
  constructor(issues: IncidenceMachineClosureIssue[]) {
    const lines = issues.map(i => {
      switch (i.kind) {
        case 'missing-transition':
          return `  edge '${i.edge}': transition '${i.transition}' not in δ at namespace '${i.namespace}'. Available [δ = {${i.availableTransitions.join(', ')}}]`
        case 'malformed-edge-on':
          return `  edge '${i.edge}': malformed on field '${i.on}', expected '{name}.{next|error}'`
        case 'missing-namespace-transitions':
          return `  edge '${i.edge}': no transitions at namespace '${i.namespace}'. Available namespaces [{${i.availableNamespaces.join(', ')}}]`
      }
    })
    super(`IncidenceMachine closure failed:\n${lines.join('\n')}`)
    this.issues = issues
  }
}

/** The namespace key for the root supergraph G' in a MachineSet, Correspondence, and RunningMachineSet. */
export const ROOT = ''

/**
 * A single closed *finite* state machine using a data-on-node model:
 * each node v ∈ V carries its own typed data space Dᵥ, so the state
 * of the machine at any point in time is the node it occupies paired
 * with that node's data. Formally (Q, Σ, δ, F):
 *
 * - Q: the state space [Q = ∐ᵥ∈V Dᵥ], a disjoint union of typed data
 *   spaces over V. Each state is a node name paired with data
 *   [qᵢ = (vᵢ, dᵢ) where dᵢ ∈ Dᵥᵢ]. The machine traces a path
 *   through Q in discrete machine time [q: {0, ..., N} → Q] where
 *   each step n → n+1 is one transition firing on edge (v, v'):
 *   [q(n+1) = (v', δⱼ(σₙ, dᵥ', dₙ))]. Here dₙ is the source data
 *   from q(n) and dᵥ' is the dest node's stored data from its own
 *   last visit (a different machine time). N is finite if q(N) ∈ F.
 * - Σ: the input alphabet. $ is the external environment modelled as
 *   an Observable monad; its emissions are outside the machine's
 *   control and may be unbounded. Each transition δⱼ receives
 *   an observation from $, the source data [dₙ from q(n)], the
 *   destination node's stored data [dᵥ' ∈ D_{target(j)}, from its
 *   own last visit], and the edge j being traversed. Because dᵥ' is
 *   data the machine itself wrote on a prior visit, the machine's
 *   own past outputs feed back as future inputs through Σ. Because
 *   dᵥ' enters via Σ, Q remains the disjoint union; no additional
 *   internal memory is needed. The full input is known only at
 *   runtime, and the complete alphabet can only be determined by
 *   running the machine. The coproduct over E selects both the edge
 *   and its target node's data space [∐ⱼ∈E D_{target(j)}], giving
 *   the full alphabet as the product with the environment
 *   [Σ = $ × ∐ⱼ∈E D_{target(j)}].
 * - δ: the transition functions [δ = { δᵢ }].
 * - F: terminal nodes, those with no outgoing edges
 *   [F = { v ∈ V | outdeg(v) = 0 }].
 *
 * The graph topology (V, E) and transition set (δ) are finitely
 * defined, but Q and Σ may range over infinite sets because each data
 * space Dᵥ can be infinite (e.g. `string` or a counter). Even without
 * the environment, δ alone can produce infinitely many distinct states.
 * The machine is a finite description over a potentially infinite
 * state space; all components are fully typed at compile time.
 *
 * The reachable subset of Q depends on the runtime execution of δ,
 * and Σ in turn depends on Q because the values in D_{target(j)} at
 * step n are those the machine itself wrote on earlier visits. This
 * self-referential feedback loop means each step reshapes the inputs
 * available to future steps. For sufficiently rich transition
 * functions the trajectory [q(0), ..., q(N)] is computationally
 * irreducible; determining which states the machine visits, or
 * whether N is finite, may require running it.
 *
 * The data-on-node model is a concise finite description of a potentially
 * much larger (possibly infinite) state machine.
 *
 * By contrast, a context bag model abandons the formalism entirely: a
 * single mutable store outside the graph makes Q undefined, severs the
 * relationship between state and topology, it offers no honest
 * accounting of the machine's behaviour.
 *
 * The `graph` field holds a closed IncidenceGraph where every edge
 * endpoint exists in V [E ⊆ V × V], with no unresolved `DepNodeRef`s.
 *
 * Produced internally by `closeMachineSet()`, not constructed directly.
 */
export interface Machine {
  graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>
  transitions: Record<string, TransitionDef>
  /** The terminal node set [F = { v ∈ V | outdeg(v) = 0 }]. */
  F: string[]
}

/**
 * A validated collection of closed finite state machines produced by
 * `closeMachineSet()`. Every constituent graph satisfies closure
 * [E ⊆ V × V].
 *
 * - `graphs`: all closed graphs keyed by namespace. The root supergraph
 *   [G' = (V', E'), the graph union of root + unioned deps after
 *   namespaceFunctor] lives at `ROOT` (`''`). Disjoint
 *   machines live at their namespace key.
 * - `machines`: the `Machine` instances keyed by namespace, each owning
 *   its closed graph and transition implementations [δ = { δⱼ }].
 * - `correspondence`: the fibre decomposition of G' over the
 *   namespaceFunctors [{ fₖ, fₖ⁻¹ }], extended with the collected
 *   transition implementations [δ] keyed by namespace.
 *
 * `startMachineSet()` requires a `MachineSet`; an unclosed IncidenceMachine
 * cannot be started because its edge set may reference nodes outside V.
 *
 * @template TNodes - V = { vᵢ }, the node set of the root IncidenceMachine.
 */
export interface MachineSet<TNodes extends Record<string, NodeData> = Record<string, NodeData>> {
  graphs: Record<string, IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>>
  machines: Record<string, Machine>
  correspondence: MachineCorrespondence
}

/**
 * A running instance of a closed machine. Provides observable streams
 * over the supergraph's state changes and edge firings.
 *
 * - `state$` emits `{ node, data }` on every state change across V',
 *   each emission representing q(n). Completes when the current node
 *   is terminal [v ∈ F, outdeg(v) = 0]. Errors when a transition's
 *   `$` observable errors with no error edge.
 * - `event$` emits `{ edge, from, to }` on every edge firing across E'.
 *   All names are namespaced, so filtering by prefix yields a subgraph's events.
 */
export interface RunningMachine {
  state$: Observable<{ node: string; data: NodeData }>
  event$: Observable<{ edge: string; from: string; to: string }>
}

/**
 * Maps a K-indexed family of IncidenceMachines { IMₖ }ₖ∈K to the
 * `RunningMachine` interfaces the `$` factory receives at runtime.
 * Each entry's `state$` is typed with the `StateUnion` of IMₖ's Vₖ.
 *
 * @template T - A K-indexed family of IncidenceMachines { IMₖ }ₖ∈K.
 */
export type RunningMachinesOf<T> = {
  [K in keyof T]: T[K] extends IncidenceMachine<infer TNodes, any, any>
    ? { state$: Observable<StateUnion<TNodes>>; event$: Observable<{ edge: string; from: string; to: string }> }
    : never
}

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
      dest?: ResolveNodeData<TNodes, CollectTargets<TEdges, TOn, THandler>>,
      source?: SourceNodeData<TNodes, CollectSources<TEdges, TOn, THandler>>,
      edge?: string
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
  /** Environment monad factory; returns an Observable whose emissions feed into δⱼ. */
  $: (runningMachines: RunningMachinesOf<TIncidenceMachines>) => Observable<TResult>
  /** Success handler, called when `$` emits. */
  next: ExpectedHandler<TNodes, TEdges, TOn, 'next', TResult>
  /** Error handler, called when `$` errors. */
  error: ExpectedHandler<TNodes, TEdges, TOn, 'error', TResult>
}

/**
 * A builder function that accepts a `TransitionShape` and returns it
 * unchanged (identity pass-through for type inference of δⱼ).
 *
 * @template TNodes - The node set [V = { vᵢ }].
 * @template TIncidenceMachines - A K-indexed family of dep IncidenceMachines [{ IMₖ }ₖ∈K].
 * @template TEdges - The incidence relation [E = { eᵢ }].
 * @template TOn - The transition name, indexing into [δ = { δⱼ }].
 */
export type TransitionBuilder<TNodes extends Record<string, NodeData>, TIncidenceMachines, TEdges, TOn extends string> =
  <TResult>(def: TransitionShape<TNodes, TIncidenceMachines, TEdges, TOn, TResult>) => TransitionShape<TNodes, TIncidenceMachines, TEdges, TOn, TResult>

/**
 * A mapping of transition names to their respective `TransitionBuilder`
 * functions, one per distinct name in the incidence relation [E = { eᵢ }].
 *
 * @template TNodes - The node set [V = { vᵢ }].
 * @template TIncidenceMachines - A K-indexed family of dep IncidenceMachines [{ IMₖ }ₖ∈K].
 * @template TEdges - The incidence relation [E = { eᵢ }].
 */
export type TransitionBuilders<TNodes extends Record<string, NodeData>, TIncidenceMachines, TEdges> = {
  [TrName in TransitionNames<TEdges>]: TransitionBuilder<TNodes, TIncidenceMachines, TEdges, TrName>
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
 * @param def.edges - A function receiving a `DepProxy` over { Gₖ }ₖ∈K,
 *   returns E = { eᵢ }, the incidence relation.
 * @returns `{ incidenceGraph, implement() }`.
 */
export function define<
  TNodes extends Record<string, NodeData>,
  TDeps extends Record<string, any>,
  const TEdges extends Record<string, EdgeDef<TNodes>>,
>(def: {
  nodes: TNodes
  deps?: TDeps
  edges: (refs: DepProxy<TDeps>) => TEdges
}) {
  const depRefs = def.deps ? defineDeps(def.deps as any) : ({} as DepProxy<TDeps>)
  const edgeDefs = def.edges(depRefs)

  const incidenceGraph: IncidenceGraph<TNodes, TEdges> = { nodes: def.nodes, edges: edgeDefs }

  return {
    incidenceGraph,
    /**
     * Equips the incidence graph with transition functions δ, producing
     * an `IncidenceMachine`. Each transition referenced by the edges must
     * be implemented with a `$` observable factory, a `next` handler, and
     * an `error` handler.
     *
     * @param factory - A callback that receives `TransitionBuilders`
     *   (one per transition name) and returns the transitions record.
     * @returns An `IncidenceMachine`: incidence graph + transitions + incidence machines.
     */
    implement<TTransitions extends Record<TransitionNames<TEdges>, TransitionDef>>(
      factory: (t: TransitionBuilders<TNodes, TDeps, TEdges>) => TTransitions
    ): IncidenceMachine<TNodes, TEdges, TTransitions> & {
      /**
       * Closes the incidence machine by validating all constituent graphs.
       * Delegates to `closeMachineSet`. See its docstring for the full
       * algorithm: classify, flatten, namespace, close, correspondence.
       *
       * @returns A `MachineSet` with a `.start()` method for chaining.
       */
      close(): MachineSet<TNodes> & {
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
        ): RunningMachineSet
      }
    } {
      const builders = new Proxy({} as any, {
        get(_, name) { return (transitionDef: any) => transitionDef }
      })
      const transitions = factory(builders)

      const im: IncidenceMachine<TNodes, TEdges, TTransitions> = { nodes: incidenceGraph.nodes, edges: incidenceGraph.edges, transitions, deps: def.deps ?? {} }
      return {
        ...im,
        close() {
          const ms = closeMachineSet(im)
          return {
            ...ms,
            start(entry, runningMachines?, initialNodeData?) {
              return startMachineSet(ms, entry, runningMachines, initialNodeData)
            }
          }
        }
      }
    }
  }
}

// --- Graph operations ---

/**
 * Partitions the dep keys K = { k₁, k₂, ... } into two disjoint sets
 * based on whether E = { eᵢ } references their nodes via `DepNodeRef`:
 *
 * Let R ⊆ K be the keys referenced by at least one `DepNodeRef` in E.
 *
 * - **unioned** = R: graphs to which a namespaceFunctor fₖ: Gₖ → G'
 *   (an injective graph homomorphism) will be applied during closure,
 *   mapping Vₖ → V' and Eₖ → E' by prefix while preserving the
 *   incidence relation.
 * - **disjoint** = K \ R: graphs for which no fₖ is applied;
 *   Vₖ ∩ V' = ∅. Observed only; a running instance must be provided
 *   at start time.
 *
 * @param edges - E = { eᵢ }, the incidence relation.
 * @param deps - A K-indexed family of IncidenceMachines { Gₖ }ₖ∈K.
 * @returns `{ unioned: R, disjoint: K \ R }`.
 */
export function classifyDeps<TNodes extends Record<string, NodeData>>(
  edges: Record<string, EdgeDef<TNodes>>,
  deps?: Record<string, IncidenceMachine<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>>>
): { unioned: string[]; disjoint: string[] } {
  const referencedKeys = new Set<string>()
  for (const edge of Object.values(edges)) {
    if (typeof edge.to !== 'string' && edge.to.__brand === 'depNodeRef') {
      referencedKeys.add(edge.to.dep)
    }
  }
  const keys = deps ? Object.keys(deps) : []
  return {
    unioned: keys.filter(k => referencedKeys.has(k)),
    disjoint: keys.filter(k => !referencedKeys.has(k)),
  }
}

/**
 * Injective graph homomorphism f: G → G' that maps V → V', E → E' by
 * applying a prefix, preserving the incidence relation.
 *
 * V' = { ns.v | v ∈ V }, and for each edge e = (v₁, v₂) ∈ E, the
 * corresponding edge f(e) = (ns.v₁, ns.v₂) ∈ E'. `DepNodeRef` targets
 * are left unresolved (they reference nodes outside V, resolved later
 * by `resolveRefs`).
 *
 * Edge keys are also prefixed to prevent collisions in the graph union.
 *
 * @param graph - G = (V, E), the IncidenceGraph to map.
 * @param namespace - The prefix ns to apply (e.g. `'payment'`).
 * @returns G' = (V', E'), the image of G under f.
 */
export function namespaceFunctor(
  graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>,
  namespace: string
): IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> {
  const prefix = `${namespace}.`
  const nodes: Record<string, NodeData> = {}
  for (const [name, data] of Object.entries(graph.nodes)) {
    nodes[`${prefix}${name}`] = data
  }
  const edges: Record<string, EdgeDef> = {}
  for (const [name, edge] of Object.entries(graph.edges)) {
    edges[`${prefix}${name}`] = {
      from: `${prefix}${edge.from}`,
      to: typeof edge.to === 'string' ? `${prefix}${edge.to}` : edge.to,
      on: edge.on,
    }
  }
  return { nodes, edges }
}

/**
 * Graph union: given G₁ = (V₁, E₁), G₂ = (V₂, E₂), ..., produces
 * G' = (V', E') where V' = V₁ ∪ V₂ ∪ ... and E' = E₁ ∪ E₂ ∪ ...
 *
 * Precondition: Vᵢ ∩ Vⱼ = ∅ for i ≠ j (apply `namespaceFunctor` first).
 * If node sets overlap, later graphs overwrite earlier ones.
 *
 * @param graphs - { Gᵢ } = { (Vᵢ, Eᵢ) }, the IncidenceGraphs to union.
 * @returns G' = (V', E'), the graph union.
 */
export function unionGraphs(
  ...graphs: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>[]
): IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> {
  const nodes: Record<string, NodeData> = {}
  const edges: Record<string, EdgeDef> = {}
  for (const graph of graphs) {
    Object.assign(nodes, graph.nodes)
    Object.assign(edges, graph.edges)
  }
  return { nodes, edges }
}

/**
 * Resolves open edges in G = (V, E). For each edge e = (v₁, v₂) ∈ E
 * where v₂ is a `DepNodeRef` to vₖ ∈ Vₖ (v₂ ∉ V), replaces the ref
 * with fₖ(vₖ), the image of vₖ under the namespaceFunctor fₖ for dep k.
 *
 * After resolution all edge targets are concrete names, but closure
 * (E' ⊆ V × V) may not yet hold. Apply `unionGraphs` to extend V
 * into V', then `validateClosure` to assert E' ⊆ V' × V'.
 *
 * @param graph - G = (V, E), the IncidenceGraph with possibly unresolved edges.
 * @param namespaceMap - M: K → NS, mapping dep keys to namespace prefixes.
 * @returns G' = (V, E') with all `DepNodeRef` targets replaced by namespaced names.
 */
export function resolveRefs<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>
>(
  graph: IncidenceGraph<TNodes, TEdges>,
  namespaceMap: Record<string, string>
): IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> {
  const edges: Record<string, EdgeDef> = {}
  for (const [name, edge] of Object.entries(graph.edges)) {
    if (typeof edge.to === 'string') {
      edges[name] = { from: edge.from, to: edge.to, on: edge.on }
    } else {
      const ref = edge.to as DepNodeRef
      const ns = namespaceMap[ref.dep]
      if (ns === undefined) {
        throw new Error(`Unresolved dep reference: '${ref.dep}' in edge '${name}'`)
      }
      edges[name] = { from: edge.from, to: `${ns}.${ref.node}`, on: edge.on }
    }
  }
  return { nodes: graph.nodes, edges }
}

/**
 * Validates the closure property of G = (V, E): every edge endpoint
 * must exist in V [E ⊆ V × V] and no `DepNodeRef` targets may remain.
 *
 * @param graph - G = (V, E), the IncidenceGraph to validate.
 * @throws If any edge has an endpoint outside V [∃ e = (v₁, v₂) ∈ E where v₁ ∉ V or v₂ ∉ V], or if any `DepNodeRef` is unresolved.
 */
export function validateClosure(
  graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>
): void {
  for (const [name, edge] of Object.entries(graph.edges)) {
    if (typeof edge.to !== 'string') {
      throw new Error(`Unresolved DepNodeRef in edge '${name}'`)
    }
    if (!(edge.from in graph.nodes)) {
      throw new Error(`Edge '${name}' references unknown source node '${edge.from}'`)
    }
    if (!(edge.to in graph.nodes)) {
      throw new Error(`Edge '${name}' references unknown target node '${edge.to}'`)
    }
  }
}

/**
 * Closes an open IncidenceGraph by resolving `DepNodeRef` targets,
 * unioning the namespaced subgraphs, and validating closure.
 *
 * Given G = (V, E) with possibly unresolved `DepNodeRef` targets
 * and the images of the namespaceFunctors { Gᵢ' = fᵢ(Gᵢ) }:
 *
 * 1. **Resolve** refs in E, replacing each `DepNodeRef` with fₖ(vₖ).
 * 2. **Union** into V' = V ∪ V₁' ∪ V₂' ∪ ..., E' = E ∪ E₁' ∪ E₂' ∪ ...
 * 3. **Validate** closure [E' ⊆ V' × V'].
 *
 * The result is a closed IncidenceGraph where every edge endpoint
 * exists in V' and no `DepNodeRef`s remain.
 *
 * @param graph - G = (V, E), the root IncidenceGraph, possibly open.
 * @param namespaceMap - M: K → NS, mapping dep keys to namespace prefixes.
 * @param subgraphs - { Gᵢ' = fᵢ(Gᵢ) }, the images of the namespaceFunctors.
 * @returns G' = (V', E'), the closed graph union.
 * @throws If closure fails [E' ⊄ V' × V'] or any `DepNodeRef` remains unresolved.
 */
export function closeGraph<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>
>(
  graph: IncidenceGraph<TNodes, TEdges>,
  namespaceMap: Record<string, string>,
  subgraphs: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>[]
): IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> {
  const resolved = resolveRefs(graph, namespaceMap)
  const merged = unionGraphs(resolved, ...subgraphs)
  validateClosure(merged)
  return merged
}

/**
 * A pair (ns, IMₖ) from the preorder traversal of the IncidenceMachine
 * composition tree, where ns is the fully qualified namespace path.
 */
export interface FlattenedIncidenceMachine {
  namespace: string
  incidenceMachine: IncidenceMachine<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>>
}

/**
 * Preorder traversal of the IncidenceMachine composition tree, restricted
 * to unioned branches (R ⊆ K at each level).
 *
 * Given a set of unioned IncidenceMachines { IMₖ }ₖ∈R rooted at
 * `parentNamespace`, produces:
 *
 *   [ (parentNamespace.k₁, IM₁), (parentNamespace.k₁.k₃, IM₃), ... ]
 *
 * where k₃ ∈ R' is a unioned dep of IM₁, and so on transitively. At each
 * level, `classifyDeps` partitions the dep keys into R (unioned, where
 * namespaceFunctor fₖ: Gₖ → G' will be applied) and K \ R (disjoint),
 * then recurses into R.
 *
 * Also builds a namespace map M: K → NS, used by `resolveRefs` to replace
 * `DepNodeRef` targets with their fully qualified names in V'.
 *
 * @param deps - { IMₖ }ₖ∈R, the unioned IncidenceMachines at this level.
 * @param unioned - R ⊆ K, the dep keys to traverse.
 * @param parentNamespace - The namespace prefix inherited from the parent in the tree.
 * @returns `{ flattened, namespaceMap }`, the preorder sequence and M: K → NS.
 */
export function flattenIncidenceMachines(
  deps: Record<string, IncidenceMachine<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>>>,
  unioned: string[],
  parentNamespace: string = ''
): { flattened: FlattenedIncidenceMachine[]; namespaceMap: Record<string, string> } {
  const flattened: FlattenedIncidenceMachine[] = []
  const namespaceMap: Record<string, string> = {}

  for (const key of unioned) {
    const ns = parentNamespace ? `${parentNamespace}.${key}` : key
    namespaceMap[key] = ns
    flattened.push({ namespace: ns, incidenceMachine: deps[key] })

    const childIM = deps[key]
    if (Object.keys(childIM.deps).length > 0) {
      const childClassification = classifyDeps(
        childIM.incidenceGraph.edges,
        childIM.deps
      )
      if (childClassification.unioned.length > 0) {
        const childResult = flattenIncidenceMachines(
          childIM.deps,
          childClassification.unioned,
          ns
        )
        flattened.push(...childResult.flattened)
        Object.assign(namespaceMap, childResult.namespaceMap)
      }
    }
  }

  return { flattened, namespaceMap }
}

/**
 * Derives correspondence metadata from a root incidence graph and a set of
 * flattened, namespaced incidence machines.
 *
 * For the root graph G = (V, E) at `ROOT`, and for each
 * unioned machine at namespace `ns` with namespaced graph
 * Gₙₛ = fₙₛ(Gₖ) = (Vₙₛ, Eₙₛ):
 *
 * - Each node v ∈ V maps to `{ namespace: '', localName: v }`.
 * - Each node ns.v ∈ Vₙₛ maps to `{ namespace: ns, localName: v }`.
 * - Same for edges.
 * - Each machine's transitions [δ = { δⱼ }] are indexed by namespace.
 *
 * @param rootGraph - The root incidence graph [G = (V, E)].
 * @param rootTransitions - The root machine's transition implementations [δ = { δⱼ }].
 * @param flattened - The flattened unioned IncidenceMachines with their namespaced graphs.
 * @returns A `MachineCorrespondence` mapping global names to their origins.
 */
export function buildMachineCorrespondence<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>
>(
  rootGraph: IncidenceGraph<TNodes, TEdges>,
  rootTransitions: Record<string, TransitionDef>,
  flattened: { namespace: string; namespacedGraph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>; transitions: Record<string, TransitionDef> }[]
): MachineCorrespondence {
  const correspondence: MachineCorrespondence = { nodes: {}, edges: {}, transitions: {} }

  for (const nodeName of Object.keys(rootGraph.nodes)) {
    correspondence.nodes[nodeName] = { namespace: ROOT, localName: nodeName }
  }
  for (const edgeName of Object.keys(rootGraph.edges)) {
    correspondence.edges[edgeName] = { namespace: ROOT, localName: edgeName }
  }
  correspondence.transitions[ROOT] = rootTransitions

  for (const { namespace: ns, namespacedGraph, transitions } of flattened) {
    correspondence.transitions[ns] = transitions
    for (const nodeName of Object.keys(namespacedGraph.nodes)) {
      correspondence.nodes[nodeName] = { namespace: ns, localName: nodeName.slice(ns.length + 1) }
    }
    for (const edgeName of Object.keys(namespacedGraph.edges)) {
      correspondence.edges[edgeName] = { namespace: ns, localName: edgeName.slice(ns.length + 1) }
    }
  }

  return correspondence
}

/**
 * Closes an IncidenceMachine, producing a `MachineSet`, a validated
 * collection of closed finite state machines.
 *
 * Given IM = (G, δ, { IMₖ }ₖ∈K):
 *
 * 1. **Classify** dep keys K into unioned R and disjoint K \ R
 *    via `classifyDeps`.
 * 2. **Flatten** the unioned tree via `flattenIncidenceMachines`,
 *    producing a preorder sequence with namespace paths.
 * 3. **Namespace** each flattened entry by applying namespaceFunctor
 *    fₖ: Gₖ → Gₖ' [injective graph homomorphism].
 * 4. **Close** the root graph via `closeGraph` with the images { Gₖ' }.
 * 5. **Correspondence** via `buildMachineCorrespondence`.
 * 6. **Close disjoint** machines recursively via `closeMachineSet`.
 *
 * Every graph in the resulting set is independently closed
 * [E ⊆ V × V]. If any graph fails, the whole set fails.
 *
 * @param incidenceMachine - IM = (G, δ, { IMₖ }ₖ∈K), the IncidenceMachine to close.
 * @returns A `MachineSet` with closed graphs, machines, and correspondence.
 * @throws If any constituent graph fails closure [E ⊄ V × V].
 */
export function closeMachineSet<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>,
  TTransitions extends Record<string, TransitionDef>
>(
  incidenceMachine: IncidenceMachine<TNodes, TEdges, TTransitions>
): MachineSet<TNodes> {
  const { incidenceGraph, deps } = incidenceMachine

  const { unioned, disjoint } = classifyDeps(incidenceGraph.edges, deps)

  const { flattened, namespaceMap } = unioned.length > 0
    ? flattenIncidenceMachines(deps, unioned)
    : { flattened: [] as FlattenedIncidenceMachine[], namespaceMap: {} as Record<string, string> }

  const namespacedEntries = flattened.map(({ namespace: ns, incidenceMachine: im }) => ({
    namespace: ns,
    namespacedGraph: namespaceFunctor(im.incidenceGraph, ns),
    transitions: im.transitions,
  }))

  const subgraphs = namespacedEntries.map(e => e.namespacedGraph)
  const rootGraph = closeGraph(incidenceGraph, namespaceMap, subgraphs)

  const correspondence = buildMachineCorrespondence(incidenceGraph, incidenceMachine.transitions, namespacedEntries)

  const graphs: Record<string, IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>> = {
    [ROOT]: rootGraph,
  }
  const machines: Record<string, Machine> = {
    [ROOT]: { graph: rootGraph, transitions: correspondence.transitions[ROOT] },
  }

  for (const key of disjoint) {
    const disjointIM = deps[key]
    const disjointSet = closeMachineSet(disjointIM)
    graphs[key] = disjointSet.graphs[ROOT]
    machines[key] = disjointSet.machines[ROOT]
  }

  return { graphs, machines, correspondence }
}

// --- Runtime ---

/**
 * A running collection of machines. Provides uniform `RunningMachine`
 * access for every namespace in the `MachineSet`:
 *
 * - `ROOT`: the root supergraph's full `state$`/`event$` streams.
 * - Unioned namespaces: filtered views of the root streams by prefix
 *   [each fₖ(Gₖ) contributes a namespace prefix to V'].
 * - Disjoint namespaces: the running instances passed in, stored as-is
 *   [Vₖ ∩ V' = ∅, runs independently].
 */
export interface RunningMachineSet extends RunningMachine {
  runningMachines: Record<string, RunningMachine>
}

/**
 * Starts a machine set, traversing the root supergraph G' = (V', E').
 *
 * On entry to a node v ∈ V', the runtime subscribes to the `$` observables
 * of all transitions whose edges leave v [Out(v) ⊆ E']. When an observable
 * emits, the corresponding transition function δⱼ (`next` or `error`)
 * runs, producing q(n+1). Previous subscriptions are torn down before
 * entering the new node.
 *
 * Transition resolution uses the correspondence lookup, indexed by namespace
 * then by local transition name [correspondence.transitions[ns][j] → δⱼ],
 * so no runtime tree-walking of the composition tree is required.
 *
 * @param machineSet - A `MachineSet` produced by `closeMachineSet()`.
 * @param entry - The starting node [v₀ ∈ V, the root machine's node set].
 * @param runningMachines - Running instances of disjoint machines [Vₖ ∩ V' = ∅].
 * @param initialNodeData - Partial map of nodes to partial data, amending any node in V'.
 * @returns A `RunningMachineSet`.
 */
export function startMachineSet<
  TNodes extends Record<string, NodeData>
>(
  machineSet: MachineSet<TNodes>,
  entry: Extract<keyof TNodes, string>,
  runningMachines?: Record<string, RunningMachine>,
  initialNodeData?: { [K in Extract<keyof TNodes, string>]?: Partial<Widen<TNodes[K]>> },
): RunningMachineSet {
  const rootGraph = machineSet.graphs[ROOT]
  const { correspondence } = machineSet
  const edgeSubject = new Subject<{ edge: string; from: string; to: string }>()

  const nodes: Record<string, NodeData> = {}
  for (const [name, data] of Object.entries(rootGraph.nodes)) {
    nodes[name] = { ...data, ...initialNodeData?.[name as Extract<keyof TNodes, string>] }
  }

  let current: { node: string; data: NodeData } = {
    node: entry,
    data: nodes[entry],
  }
  let subs: Subscription[] = []

  function teardown() {
    for (const s of subs) s.unsubscribe()
    subs = []
  }

  function parseEdgeOn(edgeDef: EdgeDef): { name: string; handler: 'next' | 'error' } {
    const [name, handler] = edgeDef.on.split('.') as [string, 'next' | 'error']
    return { name, handler }
  }

  function enter(namespacedNode: string, data: NodeData, subscriber: Subscriber<{ node: string; data: NodeData }>) {
    current = { node: namespacedNode, data }
    subscriber.next(current)

    const outgoing = Object.entries(rootGraph.edges).filter(([_, e]) => e.from === namespacedNode)
    if (outgoing.length === 0) {
      edgeSubject.complete()
      subscriber.complete()
      return
    }
    listen(outgoing, subscriber)
  }

  function listen(
    outgoing: [string, EdgeDef][],
    subscriber: Subscriber<{ node: string; data: NodeData }>
  ) {
    const grouped = new Map<string, { transitionName: string; namespace: string; edges: [string, EdgeDef, 'next' | 'error'][] }>()

    for (const [edgeName, edge] of outgoing) {
      const { name: transitionName, handler } = parseEdgeOn(edge)
      const ns = correspondence.edges[edgeName]?.namespace ?? ROOT
      const groupKey = `${ns}:${transitionName}`

      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, { transitionName, namespace: ns, edges: [] })
      }
      grouped.get(groupKey)!.edges.push([edgeName, edge, handler])
    }

    for (const { transitionName, namespace: ns, edges } of grouped.values()) {
      const tr = correspondence.transitions[ns]?.[transitionName]
      if (!tr) continue

      const sub = (tr.$(runningMachines ?? {}) as Observable<unknown>).subscribe({
        next: (value: unknown) => {
          const match = edges.find(([_, __, h]) => h === 'next')
          if (!match) return
          const [edgeName, edge] = match
          const to = edge.to as string
          teardown()
          const targetData = nodes[to]
          const newData = tr.next(value, targetData, current.data, edgeName) as NodeData
          edgeSubject.next({ edge: edgeName, from: edge.from, to })
          enter(to, newData, subscriber)
        },
        error: (err: unknown) => {
          const match = edges.find(([_, __, h]) => h === 'error')
          if (!match) {
            teardown()
            edgeSubject.error(err)
            subscriber.error(err)
            return
          }
          const [edgeName, edge] = match
          const to = edge.to as string
          teardown()
          const targetData = nodes[to]
          const newData = tr.error(err, targetData, current.data, edgeName) as NodeData
          edgeSubject.next({ edge: edgeName, from: edge.from, to })
          enter(to, newData, subscriber)
        },
      })
      subs.push(sub)
    }
  }

  const rootState$ = new Observable<{ node: string; data: NodeData }>((subscriber) => {
    subscriber.next(current)

    const outgoing = Object.entries(rootGraph.edges).filter(([_, e]) => e.from === entry)
    if (outgoing.length === 0) {
      edgeSubject.complete()
      subscriber.complete()
    } else {
      listen(outgoing, subscriber)
    }

    return () => {
      teardown()
      edgeSubject.complete()
    }
  })

  const rootEvent$ = edgeSubject.asObservable()

  const result: Record<string, RunningMachine> = {
    [ROOT]: { state$: rootState$, event$: rootEvent$ },
  }

  const absorbedNamespaces = new Set(
    Object.values(correspondence.nodes)
      .map(p => p.namespace)
      .filter(ns => ns !== ROOT)
  )
  for (const ns of absorbedNamespaces) {
    const prefix = `${ns}.`
    result[ns] = {
      state$: rootState$.pipe(filter(s => s.node.startsWith(prefix) || s.node === ns)),
      event$: rootEvent$.pipe(filter(e => e.edge.startsWith(prefix))),
    }
  }

  if (runningMachines) {
    for (const [key, rm] of Object.entries(runningMachines)) {
      result[key] = rm
    }
  }

  return { state$: rootState$, event$: rootEvent$, runningMachines: result }
}