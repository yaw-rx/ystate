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
 * A branded reference to a node in a different machine.
 * Carries the foreign machine's node map for compile-time validation.
 *
 * @template TNodeMap - The `nodes` record of the foreign machine.
 * @template TNode - The specific node name being referenced.
 */
export interface ContextNodeRef<
  TNodeMap extends Record<string, NodeData> = Record<string, NodeData>,
  TNode extends Extract<keyof TNodeMap, string> = Extract<keyof TNodeMap, string>
> { __brand: 'contextNodeRef'; context: string; node: TNode }

/**
 * From a context mapping (symbol -> machine definition), produces a proxy
 * that exposes the foreign machines' nodes as branded `ContextNodeRef`s.
 *
 * @template T - Mapping of context keys to machine definitions.
 */
export type ContextProxy<T> = {
  [K in keyof T]: T[K] extends { incidenceGraph: { nodes: infer N } }
    ? { nodes: { readonly [NodeName in Extract<keyof N, string>]: ContextNodeRef<N extends Record<string, NodeData> ? N : never, NodeName> } }
    : never
}

/**
 * Creates a proxy that provides typed node references for cross-machine edges.
 *
 * @param mapping - A record of context keys to machine definitions.
 * @returns A `ContextProxy` that maps each key to its machine's node references.
 */
export function defineContext<T extends Record<string, any>>(mapping: T): ContextProxy<T> {
  return new Proxy({} as any, {
    get(_, sym) {
      return {
        nodes: new Proxy({}, { get(_, node) { return { __brand: 'contextNodeRef', context: String(sym), node } } }),
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
 * Resolves the data type of a target node, whether it's a local node name or a `ContextNodeRef`.
 *
 * @template TNodeMap - The local machine's node map.
 * @template TTo - The target node key or `ContextNodeRef`.
 */
export type ResolveNodeData<TNodeMap extends Record<string, NodeData>, TTo> =
  TTo extends keyof TNodeMap ? Widen<TNodeMap[TTo]> :
  TTo extends ContextNodeRef<infer ForeignMap, infer ForeignNode> ? Widen<ForeignMap[ForeignNode]> :
  never

/**
 * Resolves the data type of a source node (the `from` of an edge).
 *
 * @template TNodeMap - The local machine's node map.
 * @template TFrom - The source node key.
 */
export type SourceNodeData<TNodeMap extends Record<string, NodeData>, TFrom> =
  TFrom extends keyof TNodeMap ? Widen<TNodeMap[TFrom]> : never

/**
 * Describes an edge connecting a source node to a target node via a transition handler.
 *
 * @template TNodes - The machine's node map, used to narrow `from` and `to`.
 */
export interface EdgeDef<TNodes extends Record<string, NodeData> = Record<string, NodeData>> {
  from: Extract<keyof TNodes, string>
  to: Extract<keyof TNodes, string> | ContextNodeRef
  on: `${string}.${'next' | 'error'}`
}

/** Describes a transition with an observable factory, a success handler, and an error handler. */
export interface TransitionDef {
  $: Function
  next: Function
  error: Function
}

/**
 * The pure topology of a finite state machine: a set of nodes V and an
 * incidence relation E that maps edges to pairs of nodes.
 *
 * An incidence graph may be **open** - edges reference nodes outside V via
 * `ContextNodeRef` - or **closed** - all edge endpoints resolve within V.
 *
 * @template TNodes - The node set V, a record of node names to data shapes.
 * @template TEdges - The incidence relation E, a record of edge names to `EdgeDef`s.
 */
export interface IncidenceGraph<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>
> {
  nodes: TNodes
  edges: TEdges
}

/**
 * An incidence graph equipped with transition functions δ and optionally
 * other incidence machines whose graphs can resolve open edges.
 *
 * Produced by `define().implement()`. The incidence graph defines
 * the topology (which states exist and how they connect), the transitions
 * define the behaviour (observable triggers and pure state mappers), and the
 * incidence machines supply the foreign graphs referenced by any
 * `ContextNodeRef` edges.
 *
 * Not yet a valid FSM - the graph may be open and has not been validated.
 * Call `closeMachineSet()` to validate and produce a `MachineSet`.
 *
 * @template TNodes - The node set V.
 * @template TEdges - The incidence relation E.
 * @template TTransitions - The transition implementations δ.
 */
export interface IncidenceMachine<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>,
  TTransitions extends Record<string, TransitionDef>
> {
  incidenceGraph: IncidenceGraph<TNodes, TEdges>
  transitions: TTransitions
  incidenceMachines?: Record<string, IncidenceMachine<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>>>
}

/**
 * Metadata for a closed machine's supergraph G' = (V', E').
 *
 * **Graph provenance** - maps each namespaced node and edge in G' back
 * to its origin: the namespace it was absorbed from and its local name.
 * Root-level elements have `namespace: ''` and `localName` equal to the
 * global name. Absorbed elements have `namespace: 'payment'` (or deeper
 * paths like `'payment.sub'`) and the original unqualified name.
 *
 * **Transition lookup** - collects the transition implementations δ
 * from the root machine and all absorbed context machines, indexed by
 * namespace so the runtime can resolve which δ handles a given edge
 * without walking the context tree.
 */
export interface MachineProvenance {
  // --- Graph provenance: where each element in G' came from ---

  /** Maps each namespaced node in V' to its source namespace and local name. */
  nodes: Record<string, { namespace: string; localName: string }>
  /** Maps each namespaced edge in E' to its source namespace and local name. */
  edges: Record<string, { namespace: string; localName: string }>

  // --- Transition lookup: δ collected from root + absorbed machines ---

  /** Transition implementations δ indexed by namespace, then by local
   *  transition name within that namespace's machine.
   *  e.g. `transitions['payment']['process']` is PaymentGraph's `process` transition.
   *  Root machine transitions live under `transitions['']`. */
  transitions: Record</* namespace */ string, Record</* local transition name */ string, TransitionDef>>
}

export const ROOT_NAMESPACE = ''

/**
 * A single closed finite state machine: (Q, Σ, δ, F).
 * Q = the node set, Σ = observable emissions, δ = transition functions,
 * F = nodes with no outgoing edges (derived from the graph).
 *
 * The `graph` field holds a closed incidence graph (E ⊆ V × V) - every
 * edge endpoint exists in V, with no unresolved `ContextNodeRef`s.
 *
 * Produced internally by `closeMachineSet()`, not constructed directly.
 */
export interface Machine {
  graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>
  transitions: Record<string, TransitionDef>
}

/**
 * A validated collection of closed finite state machines produced by
 * `closeMachineSet()`. Every constituent graph satisfies E ⊆ V × V.
 *
 * - `graphs` - all closed graphs keyed by namespace. The root supergraph
 *   (root + absorbed incidence machines, merged and namespaced) lives at
 *   `ROOT_NAMESPACE` (`''`). Disconnected machines live at their namespace key.
 * - `machines` - the `Machine` instances keyed by namespace, each owning
 *   its closed graph and transition implementations δ.
 * - `provenance` - metadata mapping namespaced names back to their source
 *   incidence graphs, plus the collected transition lookup.
 *
 * `startMachineSet()` requires a `MachineSet` - an unclosed incidence
 * machine cannot be started because its edge set may reference nodes
 * outside V.
 *
 * @template TNodes - The node set V of the root incidence machine.
 */
export interface MachineSet<TNodes extends Record<string, NodeData> = Record<string, NodeData>> {
  graphs: Record<string, IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>>
  machines: Record<string, Machine>
  provenance: MachineProvenance
}

/**
 * A running instance of a closed machine. Provides observable streams
 * over the supergraph's state changes and edge firings.
 *
 * - `node$` emits `{ node, data }` on every state change across V'.
 *   Completes when the current node is terminal (no outgoing edges in E').
 *   Errors when a transition's `$` observable errors with no error edge.
 * - `edge$` emits `{ edge, from, to }` on every edge firing across E'.
 *   All names are namespaced, so filtering by prefix yields a subgraph's events.
 */
export interface RunningMachine {
  node$: Observable<{ node: string; data: NodeData }>
  edge$: Observable<{ edge: string; from: string; to: string }>
}

/**
 * Maps a record of incidence machines to the running machine interfaces
 * the `$` factory receives at runtime. Each entry's `node$` is typed
 * with the specific `StateUnion` of that incidence machine's nodes.
 *
 * @template T - Record of incidence machines.
 */
export type RunningMachinesOf<T> = {
  [K in keyof T]: T[K] extends IncidenceMachine<infer TNodes, any, any>
    ? { node$: Observable<StateUnion<TNodes>>; edge$: Observable<{ edge: string; from: string; to: string }> }
    : never
}

// --- Edge + transition inference ---

/**
 * Extracts the union of transition names referenced in a set of edges.
 *
 * @template TEdges - The edges record.
 */
export type TransitionNames<TEdges> = {
  [K in keyof TEdges]: TEdges[K] extends { on: `${infer U}.${string}` } ? U : never
}[keyof TEdges]

/**
 * Collects all target nodes for a given transition and handler direction.
 *
 * @template TEdges - The edges record.
 * @template TOn - The transition name.
 * @template THandler - The handler direction (`'next'` or `'error'`).
 */
export type CollectTargets<TEdges, TOn extends string, THandler extends string> = {
  [K in keyof TEdges]: TEdges[K] extends { on: `${TOn}.${THandler}`; to: infer To } ? To : never
}[keyof TEdges]

/**
 * Collects all source nodes for a given transition and handler direction.
 *
 * @template TEdges - The edges record.
 * @template TOn - The transition name.
 * @template THandler - The handler direction (`'next'` or `'error'`).
 */
export type CollectSources<TEdges, TOn extends string, THandler extends string> = {
  [K in keyof TEdges]: TEdges[K] extends { on: `${TOn}.${THandler}`; from: infer From } ? From : never
}[keyof TEdges]

/**
 * Derives the expected signature for a transition handler based on the edges
 * that reference it. The handler's parameters and return type are inferred
 * from the union of source and target node data shapes.
 *
 * @template TNodes - The machine's node map.
 * @template TEdges - The edges record.
 * @template TOn - The transition name.
 * @template THandler - The handler direction (`'next'` or `'error'`).
 * @template TResult - The emission type of the transition's `$` observable.
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
      source?: SourceNodeData<TNodes, CollectSources<TEdges, TOn, THandler>>
    ) => ResolveNodeData<TNodes, CollectTargets<TEdges, TOn, THandler>>

/**
 * The shape of a transition definition within the `implement()` callback.
 *
 * @template TNodes - The machine's node map.
 * @template TIncidenceMachines - The incidence machines record (if any).
 * @template TEdges - The edges record.
 * @template TOn - The transition name.
 * @template TResult - The emission type of the `$` observable.
 */
export type TransitionShape<TNodes extends Record<string, NodeData>, TIncidenceMachines, TEdges, TOn extends string, TResult> = {
  /** Observable factory that triggers the transition. Receives the running machines. */
  $: (runningMachines: RunningMachinesOf<TIncidenceMachines>) => Observable<TResult>
  /** Success handler, called when `$` emits. */
  next: ExpectedHandler<TNodes, TEdges, TOn, 'next', TResult>
  /** Error handler, called when `$` errors. */
  error: ExpectedHandler<TNodes, TEdges, TOn, 'error', TResult>
}

/**
 * A builder function that accepts a transition definition and returns it
 * (pass-through for type inference).
 *
 * @template TNodes - The machine's node map.
 * @template TIncidenceMachines - The incidence machines record (if any).
 * @template TEdges - The edges record.
 * @template TOn - The transition name.
 */
export type TransitionBuilder<TNodes extends Record<string, NodeData>, TIncidenceMachines, TEdges, TOn extends string> =
  <TResult>(def: TransitionShape<TNodes, TIncidenceMachines, TEdges, TOn, TResult>) => TransitionShape<TNodes, TIncidenceMachines, TEdges, TOn, TResult>

/**
 * A mapping of transition names to their respective `TransitionBuilder` functions.
 *
 * @template TNodes - The machine's node map.
 * @template TIncidenceMachines - The incidence machines record (if any).
 * @template TEdges - The edges record.
 */
export type TransitionBuilders<TNodes extends Record<string, NodeData>, TIncidenceMachines, TEdges> = {
  [TrName in TransitionNames<TEdges>]: TransitionBuilder<TNodes, TIncidenceMachines, TEdges, TrName>
}

/**
 * Extracts the concrete function type of a handler (`'next'` or `'error'`) from a transition object.
 *
 * @template T - The transition object.
 * @template H - The handler key (`'next'` or `'error'`).
 */
export type GetHandler<T, H extends string> = T extends { [K in H]: infer F } ? F : never

/**
 * The union of all possible state values `{ node, data }` for a machine.
 *
 * @template TNodes - The machine's node map.
 */
export type StateUnion<TNodes extends Record<string, NodeData>> = {
  [K in keyof TNodes]: { node: K; data: Widen<TNodes[K]> }
}[keyof TNodes]

// --- Factory (two-step) ---

/**
 * Defines an incidence graph - a set of nodes V and an incidence
 * relation E. The graph may be open: edges can reference nodes outside
 * V via `ContextNodeRef`, with the incidence machines supplying the
 * foreign graphs that resolve those references.
 *
 * Returns the `IncidenceGraph` G = (V, E) and an `implement()` method
 * to supply transition functions δ, producing an `IncidenceMachine`.
 *
 * @param def - The incidence graph definition.
 * @param def.nodes - The node set V, with typed data shapes.
 * @param def.incidenceMachines - (Optional) Other incidence machines
 *   whose nodes may be referenced by edges via `ContextNodeRef`.
 * @param def.edges - A function that receives a `ContextProxy` and
 *   returns the incidence relation E.
 * @returns `{ incidenceGraph, implement() }`.
 */
export function define<
  TNodes extends Record<string, NodeData>,
  TIncidenceMachines extends Record<string, any>,
  const TEdges extends Record<string, EdgeDef<TNodes>>,
>(def: {
  nodes: TNodes
  incidenceMachines?: TIncidenceMachines
  edges: (refs: ContextProxy<TIncidenceMachines>) => TEdges
}) {
  const contextRefs = def.incidenceMachines ? defineContext(def.incidenceMachines as any) : ({} as ContextProxy<TIncidenceMachines>)
  const edgeDefs = def.edges(contextRefs)

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
      factory: (t: TransitionBuilders<TNodes, TIncidenceMachines, TEdges>) => TTransitions
    ): IncidenceMachine<TNodes, TEdges, TTransitions> & {
      /**
       * Closes the incidence machine by validating all constituent graphs.
       * Delegates to `closeMachineSet`. See its docstring for the full
       * algorithm: classify, flatten, namespace, close, provenance.
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

      const im: IncidenceMachine<TNodes, TEdges, TTransitions> = { incidenceGraph, transitions, incidenceMachines: def.incidenceMachines }
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
 * Partitions a machine's context keys into two disjoint sets based on
 * whether the machine's edges reference their nodes:
 *
 * Let C = { k₁, k₂, ... } be the set of context keys, and let
 * R ⊆ C be the keys referenced by at least one `ContextNodeRef` in E.
 *
 * - **absorbed** = R - these machines' graphs will be merged into
 *   the supergraph, namespaced by their key.
 * - **disconnected** = C \ R - these machines are observed only.
 *   A running instance must be provided at start time.
 *
 * @param edges - The incidence machine's edge record E.
 * @param incidenceMachines - The incidence machines record (if any).
 * @returns `{ absorbed: R, disconnected: C \ R }`.
 */
export function classifyContext<TNodes extends Record<string, NodeData>>(
  edges: Record<string, EdgeDef<TNodes>>,
  incidenceMachines?: Record<string, IncidenceMachine<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>>>
): { absorbed: string[]; disconnected: string[] } {
  const referencedKeys = new Set<string>()
  for (const edge of Object.values(edges)) {
    if (typeof edge.to !== 'string' && edge.to.__brand === 'contextNodeRef') {
      referencedKeys.add(edge.to.context)
    }
  }
  const keys = incidenceMachines ? Object.keys(incidenceMachines) : []
  return {
    absorbed: keys.filter(k => referencedKeys.has(k)),
    disconnected: keys.filter(k => !referencedKeys.has(k)),
  }
}

/**
 * Maps an incidence graph G = (V, E) to G' = (V', E') by prefixing all
 * node names with `namespace`, producing V' = { ns.v | v ∈ V }. The
 * incidence relation is preserved: for each edge (v₁, v₂) ∈ E, the
 * corresponding edge (ns.v₁, ns.v₂) ∈ E'. `ContextNodeRef` targets
 * are left unresolved - they reference nodes outside this graph and
 * will be resolved during merge.
 *
 * Edge keys are also prefixed to prevent collisions in the merged graph.
 *
 * @param graph - The incidence graph G = (V, E) to namespace.
 * @param namespace - The prefix to apply (e.g. `'payment'`).
 * @returns A new incidence graph G' = (V', E') with namespaced names.
 */
export function namespaceGraph(
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
 * Computes the union of incidence graphs G₁ = (V₁, E₁), G₂ = (V₂, E₂), ...
 * producing G' = (V', E') where V' = V₁ ∪ V₂ ∪ ... and E' = E₁ ∪ E₂ ∪ ...
 *
 * The caller is responsible for namespacing graphs before merging to
 * ensure V₁ ∩ V₂ = ∅ (disjoint node sets). If node sets overlap, later
 * graphs overwrite earlier ones.
 *
 * @param graphs - The incidence graphs to union.
 * @returns The merged incidence graph G' = (V', E').
 */
export function mergeGraphs(
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
 * Resolves open edges in an incidence graph G = (V, E). For each edge
 * e ∈ E whose target is a `ContextNodeRef` (a reference outside V),
 * replaces the ref with the namespaced node name `ns.node`, where `ns`
 * is looked up from the provided mapping.
 *
 * After resolution, every edge target is a concrete node name. The
 * graph may still be open if those names are not yet in V - call
 * `mergeGraphs` to bring them in, then `validateClosure` to verify.
 *
 * @param graph - The incidence graph with possibly unresolved edges.
 * @param namespaceMap - Maps context keys to their namespace prefixes.
 * @returns A new incidence graph with all `ContextNodeRef` targets
 *   replaced by namespaced node name strings.
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
      const ref = edge.to as ContextNodeRef
      const ns = namespaceMap[ref.context]
      if (ns === undefined) {
        throw new Error(`Unresolved context reference: '${ref.context}' in edge '${name}'`)
      }
      edges[name] = { from: edge.from, to: `${ns}.${ref.node}`, on: edge.on }
    }
  }
  return { nodes: graph.nodes, edges }
}

/**
 * Validates the closure property of an incidence graph G = (V, E):
 * for every edge e = (v₁, v₂) ∈ E, both v₁ ∈ V and v₂ ∈ V. A graph
 * satisfying this property is a valid graph by definition - E ⊆ V × V.
 *
 * Also asserts that no `ContextNodeRef` targets remain unresolved.
 * An unresolved ref means the graph is still open and cannot be
 * traversed.
 *
 * @param graph - The incidence graph G = (V, E) to validate.
 * @throws If ∃ e ∈ E where an endpoint ∉ V, or if any `ContextNodeRef` remains.
 */
export function validateClosure(
  graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>
): void {
  for (const [name, edge] of Object.entries(graph.edges)) {
    if (typeof edge.to !== 'string') {
      throw new Error(`Unresolved ContextNodeRef in edge '${name}'`)
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
 * Closes an open incidence graph by resolving external references,
 * merging absorbed subgraphs, and validating the closure property.
 *
 * Given G = (V, E) with possibly unresolved `ContextNodeRef` targets
 * and a set of subgraphs { G₁', G₂', ... } (already namespaced):
 *
 * 1. **Resolve** - replace every `ContextNodeRef` in E with its
 *    namespaced node name from the namespace map.
 * 2. **Merge** - V' = V ∪ V₁' ∪ V₂' ∪ ...
 *               E' = E ∪ E₁' ∪ E₂' ∪ ...
 * 3. **Validate** - assert E' ⊆ V' × V' (closure).
 *
 * The result is a closed incidence graph: every edge endpoint exists
 * in V', no `ContextNodeRef`s remain.
 *
 * @param graph - The root incidence graph G = (V, E), possibly open.
 * @param namespaceMap - Maps context keys to namespace prefixes for ref resolution.
 * @param subgraphs - Already-namespaced incidence graphs to merge in.
 * @returns A closed incidence graph G' = (V', E').
 * @throws If E' ⊄ V' × V' or any `ContextNodeRef` remains unresolved.
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
  const merged = mergeGraphs(resolved, ...subgraphs)
  validateClosure(merged)
  return merged
}

/**
 * A flattened entry from a composition tree of incidence machines.
 * Each entry carries the fully qualified namespace path and the
 * incidence machine at that position in the tree.
 */
export interface FlattenedIncidenceMachine {
  namespace: string
  incidenceMachine: IncidenceMachine<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>>
}

/**
 * Recursively flattens a composition tree of incidence machines into a
 * linear sequence with fully qualified namespace paths.
 *
 * Given a set of absorbed incidence machines { k₁: IM₁, k₂: IM₂, ... }
 * rooted at namespace `parentNamespace`, produces a flat sequence:
 *
 *   [ (parentNamespace.k₁, IM₁), (parentNamespace.k₁.k₃, IM₃), ... ]
 *
 * where k₃ is an absorbed child of IM₁, and so on transitively. At each
 * level, `classifyContext` determines which of a machine's own incidence
 * machines are absorbed (their nodes are referenced by edges) and recurses
 * into those.
 *
 * Also builds a namespace map M: contextKey → fullyQualifiedNamespace,
 * used by `resolveRefs` to replace `ContextNodeRef` targets.
 *
 * @param incidenceMachines - The absorbed incidence machines at this level.
 * @param absorbed - The keys within `incidenceMachines` to flatten.
 * @param parentNamespace - The namespace prefix inherited from the parent.
 * @returns `{ flattened, namespaceMap }` - the linear sequence and the ref resolution map.
 */
export function flattenIncidenceMachines(
  incidenceMachines: Record<string, IncidenceMachine<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>>>,
  absorbed: string[],
  parentNamespace: string = ''
): { flattened: FlattenedIncidenceMachine[]; namespaceMap: Record<string, string> } {
  const flattened: FlattenedIncidenceMachine[] = []
  const namespaceMap: Record<string, string> = {}

  for (const key of absorbed) {
    const ns = parentNamespace ? `${parentNamespace}.${key}` : key
    namespaceMap[key] = ns
    flattened.push({ namespace: ns, incidenceMachine: incidenceMachines[key] })

    const childIM = incidenceMachines[key]
    if (childIM.incidenceMachines) {
      const childClassification = classifyContext(
        childIM.incidenceGraph.edges,
        childIM.incidenceMachines
      )
      if (childClassification.absorbed.length > 0) {
        const childResult = flattenIncidenceMachines(
          childIM.incidenceMachines,
          childClassification.absorbed,
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
 * Derives provenance metadata from a root incidence graph and a set of
 * flattened, namespaced incidence machines.
 *
 * For the root graph G = (V, E) at `ROOT_NAMESPACE`, and for each
 * absorbed machine at namespace `ns` with namespaced graph Gₙₛ = (Vₙₛ, Eₙₛ):
 *
 * - Each node v ∈ V maps to `{ namespace: '', localName: v }`.
 * - Each node ns.v ∈ Vₙₛ maps to `{ namespace: ns, localName: v }`.
 * - Same for edges.
 * - Each machine's transitions δ are indexed by namespace.
 *
 * @param rootGraph - The root incidence graph G = (V, E).
 * @param rootTransitions - The root machine's transition implementations δ.
 * @param flattened - The flattened absorbed incidence machines with their namespaced graphs.
 * @returns A `MachineProvenance` mapping global names to their origins.
 */
export function buildMachineProvenance<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>
>(
  rootGraph: IncidenceGraph<TNodes, TEdges>,
  rootTransitions: Record<string, TransitionDef>,
  flattened: { namespace: string; namespacedGraph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>; transitions: Record<string, TransitionDef> }[]
): MachineProvenance {
  const provenance: MachineProvenance = { nodes: {}, edges: {}, transitions: {} }

  for (const nodeName of Object.keys(rootGraph.nodes)) {
    provenance.nodes[nodeName] = { namespace: ROOT_NAMESPACE, localName: nodeName }
  }
  for (const edgeName of Object.keys(rootGraph.edges)) {
    provenance.edges[edgeName] = { namespace: ROOT_NAMESPACE, localName: edgeName }
  }
  provenance.transitions[ROOT_NAMESPACE] = rootTransitions

  for (const { namespace: ns, namespacedGraph, transitions } of flattened) {
    provenance.transitions[ns] = transitions
    for (const nodeName of Object.keys(namespacedGraph.nodes)) {
      provenance.nodes[nodeName] = { namespace: ns, localName: nodeName.slice(ns.length + 1) }
    }
    for (const edgeName of Object.keys(namespacedGraph.edges)) {
      provenance.edges[edgeName] = { namespace: ns, localName: edgeName.slice(ns.length + 1) }
    }
  }

  return provenance
}

/**
 * Closes an incidence machine, producing a `MachineSet` - a validated
 * collection of closed finite state machines.
 *
 * Given an incidence machine IM = (G, δ, { k₁: IM₂, k₂: IM₃, ... }):
 *
 * 1. **Classify** - partition incidence machine keys into absorbed (R)
 *    and disconnected (D) via `classifyContext`.
 * 2. **Flatten** - recursively traverse absorbed incidence machines
 *    via `flattenIncidenceMachines`, producing namespaced entries.
 * 3. **Namespace** - apply `namespaceGraph` to each flattened entry.
 * 4. **Close root graph** - call `closeGraph` on the root incidence
 *    graph with the namespaced subgraphs.
 * 5. **Provenance** - derive metadata via `buildMachineProvenance`.
 * 6. **Close disconnected** - recursively `closeMachineSet` each
 *    disconnected incidence machine.
 *
 * Machine-level closure means every graph in the set is independently
 * closed. If any graph fails, the whole set fails.
 *
 * @param incidenceMachine - The incidence machine to close.
 * @returns A `MachineSet` with closed graphs, machines, and provenance.
 * @throws If any constituent graph cannot be closed.
 */
export function closeMachineSet<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>,
  TTransitions extends Record<string, TransitionDef>
>(
  incidenceMachine: IncidenceMachine<TNodes, TEdges, TTransitions>
): MachineSet<TNodes> {
  const { incidenceGraph, incidenceMachines } = incidenceMachine

  const { absorbed, disconnected } = classifyContext(incidenceGraph.edges, incidenceMachines) // distinct is probably a better name

  const { flattened, namespaceMap } = incidenceMachines && absorbed.length > 0
    ? flattenIncidenceMachines(incidenceMachines, absorbed)
    : { flattened: [] as FlattenedIncidenceMachine[], namespaceMap: {} as Record<string, string> }

  const namespacedEntries = flattened.map(({ namespace: ns, incidenceMachine: im }) => ({
    namespace: ns,
    namespacedGraph: namespaceGraph(im.incidenceGraph, ns),
    transitions: im.transitions,
  }))

  const subgraphs = namespacedEntries.map(e => e.namespacedGraph)
  const rootGraph = closeGraph(incidenceGraph, namespaceMap, subgraphs)

  const provenance = buildMachineProvenance(incidenceGraph, incidenceMachine.transitions, namespacedEntries)

  const graphs: Record<string, IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>> = {
    [ROOT_NAMESPACE]: rootGraph,
  }
  const machines: Record<string, Machine> = {
    [ROOT_NAMESPACE]: { graph: rootGraph, transitions: provenance.transitions[ROOT_NAMESPACE] },
  }

  for (const key of disconnected) {
    const disconnectedIM = incidenceMachines![key]
    const disconnectedSet = closeMachineSet(disconnectedIM)
    graphs[key] = disconnectedSet.graphs[ROOT_NAMESPACE]
    machines[key] = disconnectedSet.machines[ROOT_NAMESPACE]
  }

  return { graphs, machines, provenance }
}

// --- Runtime ---

/**
 * A running collection of machines. Provides uniform `RunningMachine`
 * access for every namespace in the `MachineSet`:
 *
 * - `ROOT_NAMESPACE` - the root supergraph's full `node$`/`edge$` streams.
 * - Absorbed namespaces - filtered views of the root streams by prefix.
 * - Disconnected namespaces - the running instances passed in, stored as-is.
 */
export interface RunningMachineSet extends RunningMachine {
  runningMachines: Record<string, RunningMachine>
}

/**
 * Starts a machine set, traversing the root supergraph G' = (V', E').
 *
 * On entry to a node v ∈ V', the runtime subscribes to the `$` observables
 * of all transitions whose edges leave v. When an observable emits, the
 * corresponding `next` or `error` handler runs, producing the target node's
 * data, and the machine transitions to the target node. Previous subscriptions
 * are torn down before entering the new node.
 *
 * Transition resolution uses `provenance.transitions[namespace][name]` -
 * no runtime tree-walking required.
 *
 * @param machineSet - A `MachineSet` produced by `closeMachineSet()`.
 * @param entry - The starting node (must be a node in the root machine's V).
 * @param runningMachines - Running instances of disconnected machines.
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
  const rootGraph = machineSet.graphs[ROOT_NAMESPACE]
  const { provenance } = machineSet
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
      const ns = provenance.edges[edgeName]?.namespace ?? ROOT_NAMESPACE
      const groupKey = `${ns}:${transitionName}`

      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, { transitionName, namespace: ns, edges: [] })
      }
      grouped.get(groupKey)!.edges.push([edgeName, edge, handler])
    }

    for (const { transitionName, namespace: ns, edges } of grouped.values()) {
      const tr = provenance.transitions[ns]?.[transitionName]
      if (!tr) continue

      const sub = (tr.$(runningMachines ?? {}) as Observable<unknown>).subscribe({
        next: (value: unknown) => {
          const match = edges.find(([_, __, h]) => h === 'next')
          if (!match) return
          const [edgeName, edge] = match
          const to = edge.to as string
          teardown()
          const targetData = nodes[to]
          const newData = tr.next(value, targetData, current.data) as NodeData
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
          const newData = tr.error(err, targetData, current.data) as NodeData
          edgeSubject.next({ edge: edgeName, from: edge.from, to })
          enter(to, newData, subscriber)
        },
      })
      subs.push(sub)
    }
  }

  const rootNode$ = new Observable<{ node: string; data: NodeData }>((subscriber) => {
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

  const rootEdge$ = edgeSubject.asObservable()

  const result: Record<string, RunningMachine> = {
    [ROOT_NAMESPACE]: { node$: rootNode$, edge$: rootEdge$ },
  }

  const absorbedNamespaces = new Set(
    Object.values(provenance.nodes)
      .map(p => p.namespace)
      .filter(ns => ns !== ROOT_NAMESPACE)
  )
  for (const ns of absorbedNamespaces) {
    const prefix = `${ns}.`
    result[ns] = {
      node$: rootNode$.pipe(filter(s => s.node.startsWith(prefix) || s.node === ns)),
      edge$: rootEdge$.pipe(filter(e => e.edge.startsWith(prefix))),
    }
  }

  if (runningMachines) {
    for (const [key, rm] of Object.entries(runningMachines)) {
      result[key] = rm
    }
  }

  return { node$: rootNode$, edge$: rootEdge$, runningMachines: result }
}