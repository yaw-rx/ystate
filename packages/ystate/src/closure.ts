import type { NodeData, EdgeDef, IncidenceGraph, IncidenceGraphSetCorrespondence, NamespaceKind, TransitionDef } from './graph.js';
import { resolveRefs, unionGraphs, validateClosure, classifyDeps, namespaceFunctor, ROOT } from './graph.js';
import type { IncidenceMachine, Machine, MachineSet, MachineCorrespondence, FlattenedIncidenceMachine } from './machine.js';
import { flattenIncidenceMachines, buildMachineCorrespondence } from './machine.js';

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
): MachineSet<TNodes, TEdges, TTransitions> {
  const { deps } = incidenceMachine

  const { unioned, disjoint } = classifyDeps(incidenceMachine.edges, deps)

  const { flattened, namespaceMap } = unioned.length > 0
    ? flattenIncidenceMachines(deps, unioned)
    : { flattened: [] as FlattenedIncidenceMachine[], namespaceMap: {} as Record<string, string> }

  const namespacedEntries = flattened.map(({ namespace: ns, incidenceMachine: im }) => ({
    namespace: ns,
    namespacedGraph: namespaceFunctor(im, ns),
    transitions: im.transitions,
  }))

  const subgraphs = namespacedEntries.map(e => e.namespacedGraph)
  const rootGraph = closeGraph(incidenceMachine, namespaceMap, subgraphs)

  const correspondence = buildMachineCorrespondence(incidenceMachine, incidenceMachine.transitions, namespacedEntries, unioned, disjoint)

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
    const disjointIM = deps[key]
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
