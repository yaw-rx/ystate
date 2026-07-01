import { Observable } from 'rxjs';
import type { IncidenceMachine } from './machine.js';

/**
 * Core library for defining pure finite state machines with typed nodes,
 * observable-driven edges, and compile-time edge validation.
 *
 * @packageDocumentation
 */

// --- Type primitives ---

/**
 * The classification of a machine within a MachineSet. Unioned machines
 * have been merged into the supergraph via namespaceFunctors
 * [fₖ: Gₖ → G']. Disjoint machines have node sets disjoint from the
 * supergraph [Vₖ ∩ V' = ∅] and run independently.
 */
export type NamespaceKind = 'unioned' | 'disjoint'

/**
 * The three responses to an Observable monad '$': 'next' when '$'
 * emits a value, 'error' when '$' errors, 'complete' when '$'
 * completes without emitting.
 */
export const HANDLER_DIRECTIONS = ['next', 'error', 'complete'] as const
export type HandlerDirection = typeof HANDLER_DIRECTIONS[number]

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
  [K in keyof T]: T[K] extends { nodes: infer N }
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
  readonly from: Extract<keyof TNodes, string>
  readonly to: Extract<keyof TNodes, string> | DepNodeRef
  readonly on: `${string}.${HandlerDirection}`
}

/**
 * Describes a transition: an observable factory '$', a success handler
 * 'next', and optional 'error' and 'complete' handlers. If 'error' is
 * omitted and '$' errors, the error propagates as a machine error:
 * all subscriptions are torn down, 'state$' and 'event$' error, and
 * the machine stops. If 'complete' is provided, it is called when '$'
 * completes without emitting.
 */
export interface TransitionDef {
  $: Function
  next: Function
  error?: Function
  complete?: Function
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
  | { kind: 'multiple-graphs'; graphs: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>[] }

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
        case 'multiple-graphs':
          return `  closure produced ${i.graphs.length} disjoint graphs instead of one graph:\n` + i.graphs.map((g: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>, idx: number) =>
            `    ${idx + 1}: V = {${Object.keys(g.nodes).join(', ')}}, E = {${Object.keys(g.edges).join(', ')}}`
          ).join('\n')
      }
    })
    super(`IncidenceGraphSet closure failed [E ⊄ V × V]:\n${lines.join('\n')}`)
    this.issues = issues
  }
}

/** The namespace key for the root supergraph G' in a MachineSet, Correspondence, and RunningMachineSet. */
export const ROOT = ''

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
