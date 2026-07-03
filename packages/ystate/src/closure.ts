import type { NodeData, EdgeDef, IncidenceGraph, FibredGraph, IncidenceGraphSetCorrespondence, IncidenceGraphSetClosureIssue, NamespaceKind, TransitionDef } from './graph.js';
import { resolveRefs, unionGraphs, validateClosure, classifyDeps, namespaceFunctor, ROOT, HANDLER_DIRECTIONS, IncidenceGraphSetClosureError } from './graph.js';
import type { IncidenceMachine, Machine, MachineSet, MachineCorrespondence, FlattenedIncidenceMachine, IncidenceMachineClosureIssue } from './machine.js';
import { flattenIncidenceMachines, buildMachineCorrespondence, IncidenceMachineClosureError } from './machine.js';

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
 * 4. **Validate** connectivity [|{Gᵢ}| = 1].
 *
 * The result is a single connected graph where every edge endpoint
 * exists in V' and all targets are concrete node names.
 *
 * @param graph - G = (V, E), the root IncidenceGraph, possibly open.
 * @param namespaceMap - M: K → NS, mapping dep keys to namespace prefixes.
 * @param subgraphs - { Gᵢ' = fᵢ(Gᵢ) }, the images of the namespaceFunctors.
 * @returns G' = (V', E'), the closed graph union.
 * @throws If any edge has an endpoint outside V'
 *   [∃ e = (v₁, v₂) ∈ E' where v₁ ∉ V' or v₂ ∉ V'], if any edge
 *   target is not a concrete node name [∃ e ∈ E' where target(e) ∉ V'],
 *   or if the graph is not connected [|{Gᵢ}| > 1].
 */
export function closeGraph<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>
>(
  graph: IncidenceGraph<TNodes, TEdges>,
  namespaceMap: Record<string, string>,
  subgraphs: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>[]
): IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> {
  const { graph: resolved, issues: refIssues } = resolveRefs(graph, namespaceMap)
  const merged = unionGraphs(resolved, ...subgraphs)
  const closureIssues = validateClosure(merged)
  const allIssues: IncidenceGraphSetClosureIssue[] = [...refIssues, ...closureIssues]
  if (allIssues.length > 0) {
    throw new IncidenceGraphSetClosureError(allIssues)
  }
  return merged
}

/**
 * The result of closing an IncidenceGraphSet via `closeGraphSet`.
 * Carries the `FibredGraph`, the closed root graph G' = (V', E'),
 * and the intermediate products of closure so `closeMachineSet`
 * can layer transition validation without re-deriving them.
 *
 * @template TNodes - The node set [V = { vᵢ }].
 * @template TEdges - The incidence relation [E = { eᵢ }].
 */
export interface GraphSetClosureResult<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>
> {
  fibredGraph: FibredGraph<TNodes, TEdges>
  closedGraph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>
  namespacedEntries: { namespace: string; namespacedGraph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>; incidenceMachine: IncidenceMachine<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>> }[]
  unioned: string[]
  disjoint: string[]
}

/**
 * Closes an IncidenceGraphSet G = (V, E, { Gₖ }ₖ∈K), producing a
 * `FibredGraph` with proven closure [E ⊆ V x V] and the fibre
 * decomposition over the namespaceFunctors [{ fₖ, fₖ⁻¹ }].
 *
 * 1. **Classify** dep keys K into unioned R and disjoint K \ R
 *    via `classifyDeps`.
 * 2. **Flatten** the unioned tree via `flattenIncidenceMachines`,
 *    producing a preorder sequence with namespace paths.
 * 3. **Namespace** each flattened entry by applying namespaceFunctor
 *    fₖ: Gₖ → Gₖ' [injective graph homomorphism].
 * 4. **Close** the root graph via `closeGraph` with the images { Gₖ' }.
 * 5. **Correspondence** builds the preimage [fₖ⁻¹] and image [fₖ]
 *    maps for the root graph and each namespaced subgraph.
 *
 * @param graphSet - G = (V, E, { Gₖ }ₖ∈K), the IncidenceGraphSet to close.
 *   Deps must be IncidenceMachines at runtime (as produced by `define()`).
 * @returns A `GraphSetClosureResult` containing the `FibredGraph`, the
 *   closed root graph, and the intermediate products of closure.
 * @throws `IncidenceGraphSetClosureError` if closure fails [E ⊄ V x V]
 *   or the graph is not connected [|{Gᵢ}| > 1].
 */
export function closeGraphSet<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>
>(
  graphSet: { nodes: TNodes; edges: TEdges; deps: Record<string, any> }
): GraphSetClosureResult<TNodes, TEdges> {
  const deps = graphSet.deps as Record<string, IncidenceMachine<Record<string, NodeData>, Record<string, EdgeDef>, Record<string, TransitionDef>>>
  const { unioned, disjoint } = classifyDeps(graphSet.edges, deps)

  const { flattened, namespaceMap } = unioned.length > 0
    ? flattenIncidenceMachines(deps, unioned)
    : { flattened: [] as FlattenedIncidenceMachine[], namespaceMap: {} as Record<string, string> }

  const namespacedEntries = flattened.map(({ namespace: ns, incidenceMachine: im }) => ({
    namespace: ns,
    namespacedGraph: namespaceFunctor(im, ns),
    incidenceMachine: im,
  }))

  const subgraphs = namespacedEntries.map(e => e.namespacedGraph)
  const closedGraph = closeGraph(graphSet, namespaceMap, subgraphs)

  const preimage: IncidenceGraphSetCorrespondence['preimage'] = {}
  const image: IncidenceGraphSetCorrespondence['image'] = {}

  preimage[ROOT] = { nodes: {}, edges: {} }
  image[ROOT] = { nodes: {}, edges: {} }
  for (const n of Object.keys(graphSet.nodes)) {
    preimage[ROOT].nodes[n] = n
    image[ROOT].nodes[n] = n
  }
  for (const e of Object.keys(graphSet.edges)) {
    preimage[ROOT].edges[e] = e
    image[ROOT].edges[e] = e
  }

  for (const { namespace: ns, namespacedGraph } of namespacedEntries) {
    preimage[ns] = { nodes: {}, edges: {} }
    image[ns] = { nodes: {}, edges: {} }
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

  const correspondence: IncidenceGraphSetCorrespondence = { preimage, image, unioned, disjoint }

  return {
    fibredGraph: { ...graphSet, correspondence } as FibredGraph<TNodes, TEdges>,
    closedGraph,
    namespacedEntries,
    unioned,
    disjoint,
  }
}

/**
 * Closes an IncidenceMachine, producing a `MachineSet`, a validated
 * collection of closed finite state machines.
 *
 * Given IM = (G, δ, { IMₖ }ₖ∈K):
 *
 * 1. **Graph closure** via `closeGraphSet`:
 *    - **Classify** dep keys K into unioned R and disjoint K \ R
 *      via `classifyDeps`.
 *    - **Flatten** the unioned tree via `flattenIncidenceMachines`,
 *      producing a preorder sequence with namespace paths.
 *    - **Namespace** each flattened entry by applying namespaceFunctor
 *      fₖ: Gₖ → Gₖ' [injective graph homomorphism].
 *    - **Close** the root graph via `closeGraph` with the images { Gₖ' }.
 *    - **Correspondence** builds the preimage [fₖ⁻¹] and image [fₖ]
 *      maps for the root graph and each namespaced subgraph.
 * 2. **Transition correspondence** via `buildMachineCorrespondence`:
 *    extends the graph-level correspondence with δ indexed by namespace.
 * 3. **Validate required fields** on every transition δⱼ in every
 *    namespace: [$ ∈ keys(δⱼ) and next ∈ keys(δⱼ)]. These are
 *    structurally required by `TransitionDef`.
 * 4. **Validate edges**: every edge's `on` field is well-formed
 *    [`on = name.direction` where direction ∈ {next, error, complete}],
 *    references a transition that exists in the edge's namespace
 *    [∀ e ∈ E', parse(on(e)) = (δⱼ, d) implies δⱼ ∈ δₙₛ(e)], and
 *    the demanded direction exists [d ∈ keys(δⱼ) \ {$}].
 * 5. **Close disjoint** machines recursively via `closeMachineSet`.
 *
 * Every graph in the resulting set is independently closed
 * [E ⊆ V × V] and connected [|{Gᵢ}| = 1], and every edge
 * references a valid transition [∀ e ∈ E', δⱼ ∈ δₙₛ(e)].
 * If any graph or transition validation fails, the whole set fails.
 *
 * @param incidenceMachine - IM = (G, δ, { IMₖ }ₖ∈K), the IncidenceMachine to close.
 * @returns A `MachineSet` with closed graphs, machines, and correspondence.
 * @throws `IncidenceGraphSetClosureError` if any constituent graph
 *   fails closure [E ⊄ V × V] or is not connected [|{Gᵢ}| > 1].
 * @throws `IncidenceMachineClosureError` if any transition is missing
 *   a required field [$ ∉ keys(δⱼ) or next ∉ keys(δⱼ)], any edge
 *   has a malformed `on` field, or references a missing transition
 *   [δⱼ ∉ δₙₛ(e)].
 */
export function closeMachineSet<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>,
  TTransitions extends Record<string, TransitionDef>
>(
  incidenceMachine: IncidenceMachine<TNodes, TEdges, TTransitions>
): MachineSet<TNodes, TEdges, TTransitions> {
  const { closedGraph: rootGraph, namespacedEntries, unioned, disjoint } = closeGraphSet(incidenceMachine)

  const correspondence = buildMachineCorrespondence(
    incidenceMachine,
    incidenceMachine.transitions,
    namespacedEntries.map(e => ({ namespace: e.namespace, namespacedGraph: e.namespacedGraph, transitions: e.incidenceMachine.transitions })),
    unioned,
    disjoint,
  )

  const machineIssues: IncidenceMachineClosureIssue[] = []

  for (const [ns, transitions] of Object.entries(correspondence.transitions)) {
    const formattedNs = ns === '' ? 'ROOT' : `'${ns}'`
    for (const [name, handler] of Object.entries(transitions)) {
      for (const required of ['$', 'next'] as const) {
        if (!(required in handler)) {
          machineIssues.push({ kind: 'incomplete-transition', transition: name, field: required, namespace: ns, formattedNamespace: formattedNs, availableFields: Object.keys(handler) })
        }
      }
    }
  }

  const validDirections = new Set<string>(HANDLER_DIRECTIONS)
  for (const [edgeName, edge] of Object.entries(rootGraph.edges)) {
    const dotIdx = edge.on.indexOf('.')
    if (dotIdx === -1 || !validDirections.has(edge.on.slice(dotIdx + 1))) {
      machineIssues.push({ kind: 'malformed-edge-on', edge: edgeName, on: edge.on })
      continue
    }
    const transitionName = edge.on.slice(0, dotIdx)
    let ns = ROOT
    for (const [namespace, mapping] of Object.entries(correspondence.preimage)) {
      if (edgeName in mapping.edges) {
        ns = namespace
        break
      }
    }
    const formattedNs = ns === '' ? 'ROOT' : `'${ns}'`
    const nsTransitions = correspondence.transitions[ns]
    if (!nsTransitions) {
      machineIssues.push({ kind: 'missing-namespace-transitions', edge: edgeName, namespace: ns, formattedNamespace: formattedNs, availableNamespaces: Object.keys(correspondence.transitions) })
    } else if (!(transitionName in nsTransitions)) {
      machineIssues.push({ kind: 'missing-transition', edge: edgeName, transition: transitionName, namespace: ns, formattedNamespace: formattedNs, availableTransitions: Object.keys(nsTransitions) })
    } else {
      const direction = edge.on.slice(dotIdx + 1)
      const handler = nsTransitions[transitionName]
      if (!(direction in handler)) {
        const availableHandlers = Object.keys(handler).filter(k => k !== '$')
        machineIssues.push({ kind: 'missing-handler', edge: edgeName, transition: transitionName, direction, namespace: ns, formattedNamespace: formattedNs, availableHandlers })
      }
    }
  }
  if (machineIssues.length > 0) {
    throw new IncidenceMachineClosureError(machineIssues)
  }

  function computeF(graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>): string[] {
    const sources = new Set(Object.values(graph.edges).map(e => e.from))
    return Object.keys(graph.nodes).filter(n => !sources.has(n))
  }

  const rootCorrespondence: IncidenceGraphSetCorrespondence = {
    preimage: correspondence.preimage,
    image: correspondence.image,
    unioned,
    disjoint,
  }

  const graphs: Record<string, { graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>>; kind: NamespaceKind }> = {
    [ROOT]: { graph: rootGraph, kind: 'unioned' },
  }
  const machines: Record<string, Machine> = {
    [ROOT]: {
      nodes: rootGraph.nodes,
      edges: rootGraph.edges,
      deps: {},
      correspondence: rootCorrespondence,
      transitions: correspondence.transitions[ROOT],
      F: computeF(rootGraph),
    },
  }

  for (const key of disjoint) {
    const disjointIM = incidenceMachine.deps[key]
    const disjointSet = closeMachineSet(disjointIM)
    graphs[key] = { graph: disjointSet.graphs[ROOT].graph, kind: 'disjoint' }
    machines[key] = disjointSet.machines[ROOT]

    correspondence.preimage[key] = { nodes: {}, edges: {} }
    correspondence.image[key] = { nodes: {}, edges: {} }
    const disjointGraph = disjointSet.graphs[ROOT].graph
    for (const nodeName of Object.keys(disjointGraph.nodes)) {
      correspondence.preimage[key].nodes[nodeName] = nodeName
      correspondence.image[key].nodes[nodeName] = nodeName
    }
    for (const edgeName of Object.keys(disjointGraph.edges)) {
      correspondence.preimage[key].edges[edgeName] = edgeName
      correspondence.image[key].edges[edgeName] = edgeName
    }
    correspondence.transitions[key] = disjointSet.correspondence.transitions[ROOT]
  }

  return { graphs, machines, correspondence, source: incidenceMachine }
}
