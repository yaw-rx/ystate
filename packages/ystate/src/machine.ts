import { Observable } from 'rxjs';
import type { NodeData, EdgeDef, IncidenceGraph, IncidenceGraphSet, FibredGraph, Correspondence, IncidenceGraphSetCorrespondence, NamespaceKind, TransitionDef } from './graph.js';
import { HANDLER_DIRECTIONS, ROOT } from './graph.js';
import { classifyDeps } from './graph.js';
import type { StateUnion } from './transitions.js';

/**
 * The lifecycle state of a RunningMachine. Starts as 'running' when
 * created by 'start()'. Transitions to 'complete' when a terminal
 * node is reached [v ∈ F, outdeg(v) = 0], or 'error' when an
 * unhandled error propagates from a transition's '$' observable.
 */
export type MachineStatus = 'running' | 'complete' | 'error'


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
  source: IncidenceGraphSet<TNodes, TEdges>
}

/**
 * Correspondence extended with the transition lookup. Produced by
 * `IncidenceMachine.close()`. Collects the transition functions
 * [δ = { δⱼ }] from the root machine and all unioned deps, indexed
 * by the namespace assigned by each namespaceFunctor fₖ so the
 * runtime can resolve which δⱼ handles a given edge via
 * `transitions[fₖ(ns)][j]` without walking the composition tree.
 * Root machine transitions live under `transitions[ROOT]`.
 */
export interface MachineCorrespondence extends IncidenceGraphSetCorrespondence {
  transitions: Record</* namespace */ string, Record</* local transition name */ string, TransitionDef>>
}

/**
 * An IncidenceMachine closure issue. Variants are either
 * transition-scoped or edge-scoped:
 *
 * Transition-scoped (per δⱼ):
 * - `incomplete-transition`: δⱼ is missing a required field
 *   [$ ∉ keys(δⱼ) or next ∉ keys(δⱼ)]. Every transition must
 *   provide both the observable factory [$] and the [next] handler.
 *
 * Edge-scoped (per e ∈ E):
 * - `missing-transition`: edge e references a transition δⱼ that
 *   does not exist at its namespace [δⱼ ∉ δₙₛ(e)].
 * - `missing-handler`: edge e demands a handler direction that δⱼ
 *   does not implement [d ∉ keys(δⱼ) \ {$}].
 * - `malformed-edge-on`: edge e has an unparseable `on` field.
 * - `missing-namespace-transitions`: edge e belongs to a namespace
 *   with no collected transitions.
 */
export type IncidenceMachineClosureIssue =
  | { kind: 'incomplete-transition'; transition: string; field: string; namespace: string; formattedNamespace: string; availableFields: string[] }
  | { kind: 'missing-transition'; edge: string; transition: string; namespace: string; formattedNamespace: string; availableTransitions: string[] }
  | { kind: 'missing-handler'; edge: string; transition: string; direction: string; namespace: string; formattedNamespace: string; availableHandlers: string[] }
  | { kind: 'malformed-edge-on'; edge: string; on: string }
  | { kind: 'missing-namespace-transitions'; edge: string; namespace: string; formattedNamespace: string; availableNamespaces: string[] }

export function isIncompleteTransition(issue: IncidenceMachineClosureIssue): issue is Extract<IncidenceMachineClosureIssue, { kind: 'incomplete-transition' }> {
  return issue.kind === 'incomplete-transition'
}

export function isClosureMissingTransition(issue: IncidenceMachineClosureIssue): issue is Extract<IncidenceMachineClosureIssue, { kind: 'missing-transition' }> {
  return issue.kind === 'missing-transition'
}

export function isClosureMissingHandler(issue: IncidenceMachineClosureIssue): issue is Extract<IncidenceMachineClosureIssue, { kind: 'missing-handler' }> {
  return issue.kind === 'missing-handler'
}

export function isMalformedEdgeOn(issue: IncidenceMachineClosureIssue): issue is Extract<IncidenceMachineClosureIssue, { kind: 'malformed-edge-on' }> {
  return issue.kind === 'malformed-edge-on'
}

export function isMissingNamespaceTransitions(issue: IncidenceMachineClosureIssue): issue is Extract<IncidenceMachineClosureIssue, { kind: 'missing-namespace-transitions' }> {
  return issue.kind === 'missing-namespace-transitions'
}

/**
 * A diagnostic issue found by `validate()` on a closed MachineSet.
 * These are non-blocking warnings: the MachineSet is already closed
 * [E ⊆ V × V] and all edge-demanded handlers exist, but the
 * transition may not handle all observable outcomes.
 *
 * - `missing-handler`: transition δⱼ does not implement one or
 *   more optional handlers [keys(δⱼ) \ {$, next} ⊂ {error, complete}].
 *   Whether the observable factory [$] errors or completes without
 *   emitting cannot be inferred statically. If $ errors without
 *   an `error` handler, a `MachineUnhandledError` is thrown. If
 *   $ completes without emitting and no `complete` handler exists,
 *   a `MachineCompletionError` is thrown. The `handlers` array
 *   lists which are absent.
 * - `unused-transition`: transition δⱼ is implemented but no edge
 *   in E references it [∄ e ∈ E where parse(on(e)).name = j].
 *   Dead code. Caught at compile time in TypeScript by
 *   `TransitionNames<TEdges>`, but not in plain JavaScript.
 */
export type MachineSetValidationIssue =
  | { kind: 'missing-handler'; transition: string; namespace: string; formattedNamespace: string; handlers: string[] }
  | { kind: 'unused-transition'; transition: string; namespace: string; formattedNamespace: string }

export function isMissingHandler(issue: MachineSetValidationIssue): issue is Extract<MachineSetValidationIssue, { kind: 'missing-handler' }> {
  return issue.kind === 'missing-handler'
}

export function isUnusedTransition(issue: MachineSetValidationIssue): issue is Extract<MachineSetValidationIssue, { kind: 'unused-transition' }> {
  return issue.kind === 'unused-transition'
}

/**
 * IncidenceMachine closure failed. Either a transition δⱼ is missing
 * a required field [$ ∉ keys(δⱼ) or next ∉ keys(δⱼ)], an edge
 * references a transition that does not exist [δⱼ ∉ δₙₛ(e)], or an
 * edge demands a handler direction that δⱼ does not implement
 * [d ∉ keys(δⱼ) \ {$}].
 */
export class IncidenceMachineClosureError extends Error {
  issues: IncidenceMachineClosureIssue[]
  constructor(issues: IncidenceMachineClosureIssue[]) {
    const lines = issues.map(i => {
      switch (i.kind) {
        case 'incomplete-transition':
          return `  transition '${i.transition}': missing required field '${i.field}' at ${i.formattedNamespace}. Available fields [${i.availableFields.join(', ')}]`
        case 'missing-transition':
          return `  edge '${i.edge}': transition '${i.transition}' not in δ at namespace '${i.namespace}'. Available [δ = {${i.availableTransitions.join(', ')}}]`
        case 'missing-handler':
          return `  edge '${i.edge}': transition '${i.transition}' has no '${i.direction}' handler at namespace '${i.namespace}'. Available handlers [${i.availableHandlers.join(', ')}]`
        case 'malformed-edge-on':
          return `  edge '${i.edge}': malformed on field '${i.on}', expected '{name}.{${HANDLER_DIRECTIONS.join('|')}}'`
        case 'missing-namespace-transitions':
          return `  edge '${i.edge}': no transitions at namespace '${i.namespace}'. Available namespaces [{${i.availableNamespaces.join(', ')}}]`
      }
    })
    super(`IncidenceMachine closure failed:\n${lines.join('\n')}`)
    this.issues = issues
  }
}

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
 * A Machine extends `FibredGraph`: it is a proven-closed graph with
 * its fibre decomposition, equipped with transition functions [δ] and
 * the terminal node set [F]. Each Machine is self-contained, carrying
 * its own topology, fibres, and implementations.
 *
 * Produced internally by `closeMachineSet()`, not constructed directly.
 */
export interface Machine extends FibredGraph<Record<string, NodeData>, Record<string, EdgeDef>> {
  transitions: Record<string, TransitionDef>
  /** The terminal node set [F = { v ∈ V | outdeg(v) = 0 }]. */
  F: string[]
}

/**
 * A validated collection of closed finite state machines produced by
 * `closeMachineSet()`. Every constituent graph satisfies closure
 * [E ⊆ V × V].
 *
 * - `graphs`: all closed graphs keyed by namespace, each labelled with
 *   its `NamespaceKind`. The supergraph [G' = (V', E'), the graph
 *   union after namespaceFunctor] lives at `ROOT` (`''`) with kind
 *   `'unioned'`. Disjoint machines live at their namespace key with
 *   kind `'disjoint'`.
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
 * @template TEdges - The incidence relation [E = { eᵢ }].
 * @template TTransitions - The transition implementations [δ = { δⱼ }].
 */
export interface MachineSet<
  TNodes extends Record<string, NodeData> = Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>> = Record<string, EdgeDef<TNodes>>,
  TTransitions extends Record<string, TransitionDef> = Record<string, TransitionDef>
> {
  graphs: Record<string, { graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>; kind: NamespaceKind }>
  machines: Record<string, Machine>
  correspondence: MachineCorrespondence
  source: IncidenceMachine<TNodes, TEdges, TTransitions>
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
  status$: Observable<MachineStatus>
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
        childIM.edges,
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
  flattened: { namespace: string; namespacedGraph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>; transitions: Record<string, TransitionDef> }[],
  unioned: string[],
  disjoint: string[]
): MachineCorrespondence {
  const preimage: Correspondence['preimage'] = {}
  const image: Correspondence['image'] = {}
  const transitions: MachineCorrespondence['transitions'] = {}

  preimage[ROOT] = { nodes: {}, edges: {} }
  image[ROOT] = { nodes: {}, edges: {} }
  for (const nodeName of Object.keys(rootGraph.nodes)) {
    preimage[ROOT].nodes[nodeName] = nodeName
    image[ROOT].nodes[nodeName] = nodeName
  }
  for (const edgeName of Object.keys(rootGraph.edges)) {
    preimage[ROOT].edges[edgeName] = edgeName
    image[ROOT].edges[edgeName] = edgeName
  }
  transitions[ROOT] = rootTransitions

  for (const { namespace: ns, namespacedGraph, transitions: tr } of flattened) {
    preimage[ns] = { nodes: {}, edges: {} }
    image[ns] = { nodes: {}, edges: {} }
    transitions[ns] = tr
    for (const nodeName of Object.keys(namespacedGraph.nodes)) {
      const localName = nodeName.slice(ns.length + 1)
      preimage[ns].nodes[nodeName] = localName
      image[ns].nodes[localName] = nodeName
    }
    for (const edgeName of Object.keys(namespacedGraph.edges)) {
      const localName = edgeName.slice(ns.length + 1)
      preimage[ns].edges[edgeName] = localName
      image[ns].edges[localName] = edgeName
    }
  }

  return { preimage, image, transitions, unioned, disjoint }
}
