import { BehaviorSubject, Observable, ReplaySubject, Subject, filter, type Subscription } from 'rxjs';
import type { NodeData, EdgeDef, TransitionDef, HandlerDirection, NamespaceKind, Widen } from './graph.js';
import { ROOT } from './graph.js';
import type { MachineStatus, MachineSet, RunningMachine } from './machine.js';

// --- Runtime errors ---

/**
 * The environment Observable returned by a transition's '$' factory
 * errored and no 'error' handler or error edge exists. The machine
 * cannot recover.
 */
export class MachineUnhandledError extends Error {
  node: string
  transition: string
  namespace: string
  cause: unknown
  constructor(node: string, transition: string, namespace: string, cause: unknown) {
    super(`Transition '${transition}' environment Observable errored at node '${node}'${namespace ? ` (namespace '${namespace}')` : ''}: no error handler or error edge`)
    this.node = node
    this.transition = transition
    this.namespace = namespace
    this.cause = cause
  }
}

/**
 * The environment Observable returned by a transition's '$' factory
 * completed without emission and no 'complete' handler or complete
 * edge exists. The machine is stuck on a non-terminal node with no
 * way to progress.
 */
export class MachineCompletionError extends Error {
  node: string
  transition: string
  namespace: string
  constructor(node: string, transition: string, namespace: string) {
    super(`Transition '${transition}' environment Observable completed without emission at node '${node}'${namespace ? ` (namespace '${namespace}')` : ''}: no complete handler or complete edge`)
    this.node = node
    this.transition = transition
    this.namespace = namespace
  }
}

/**
 * A running collection of machines. Provides uniform `RunningMachine`
 * access for every namespace in the `MachineSet`:
 *
 * - `ROOT`: the supergraph's full `state$`/`event$` streams,
 *   kind `'unioned'`.
 * - Unioned namespaces: filtered views of the root streams by prefix
 *   [each fₖ(Gₖ) contributes a namespace prefix to V'], kind `'unioned'`.
 * - Disjoint namespaces: independent running instances passed in
 *   [Vₖ ∩ V' = ∅], kind `'disjoint'`.
 *
 * @template TNodes - V = { vᵢ }, the node set of the root IncidenceMachine.
 * @template TEdges - The incidence relation [E = { eᵢ }].
 * @template TTransitions - The transition implementations [δ = { δⱼ }].
 */
export interface RunningMachineSet<
  TNodes extends Record<string, NodeData> = Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>> = Record<string, EdgeDef<TNodes>>,
  TTransitions extends Record<string, TransitionDef> = Record<string, TransitionDef>
> extends RunningMachine {
  runningMachines: Record<string, RunningMachine & { kind: NamespaceKind }>
  source: MachineSet<TNodes, TEdges, TTransitions>
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
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>,
  TTransitions extends Record<string, TransitionDef>
>(
machineSet: MachineSet<TNodes, TEdges, TTransitions>,
  entry: Extract<keyof TNodes, string>,
  runningMachines?: Record<string, RunningMachine>,
  initialNodeData?: { [K in Extract<keyof TNodes, string>]?: Partial<Widen<TNodes[K]>> },
): RunningMachineSet<TNodes, TEdges, TTransitions> {
  const rootGraph = machineSet.graphs[ROOT].graph
  const { correspondence } = machineSet
  const edgeSubject = new Subject<{ edge: string; from: string; to: string }>()

  const edgeNamespace: Record<string, string> = {}
  for (const [ns, maps] of Object.entries(correspondence.preimage)) {
    for (const globalEdge of Object.keys(maps.edges)) {
      edgeNamespace[globalEdge] = ns
    }
  }
  const nodeNamespace: Record<string, string> = {}
  for (const [ns, maps] of Object.entries(correspondence.preimage)) {
    for (const globalNode of Object.keys(maps.nodes)) {
      nodeNamespace[globalNode] = ns
    }
  }

  const nodes: Record<string, NodeData> = {}
  for (const [name, data] of Object.entries(rootGraph.nodes)) {
    nodes[name] = { ...data, ...initialNodeData?.[name as Extract<keyof TNodes, string>] }
  }

  const status$ = new BehaviorSubject<MachineStatus>('running')
  let current: { node: string; data: NodeData } = {
    node: entry,
    data: nodes[entry],
  }
  let subs: Subscription[] = []

  function teardown() {
    for (const s of subs) s.unsubscribe()
    subs = []
  }

  function parseEdgeOn(edgeDef: EdgeDef): { name: string; handler: HandlerDirection } {
    const [name, handler] = edgeDef.on.split('.') as [string, HandlerDirection]
    return { name, handler }
  }

  const stateSubject = new ReplaySubject<{ node: string; data: NodeData }>(1)

  function enter(namespacedNode: string, data: NodeData) {
    current = { node: namespacedNode, data }

    const outgoing = Object.entries(rootGraph.edges).filter(([_, e]) => e.from === namespacedNode)
    if (outgoing.length === 0) {
      stateSubject.next(current)
      status$.next('complete')
      edgeSubject.complete()
      stateSubject.complete()
      return
    }
    listen(outgoing)
    stateSubject.next(current)
  }

  function listen(
    outgoing: [string, EdgeDef][],
  ) {
    const grouped = new Map<string, { transitionName: string; namespace: string; edges: [string, EdgeDef, HandlerDirection][] }>()

    for (const [edgeName, edge] of outgoing) {
      const { name: transitionName, handler } = parseEdgeOn(edge)
      const ns = edgeNamespace[edgeName] ?? ROOT
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
          enter(to, newData)
        },
        error: (err: unknown) => {
          const match = edges.find(([_, __, h]) => h === 'error')
          if (!match || !tr.error) {
            const wrapped = new MachineUnhandledError(current.node, transitionName, ns, err)
            status$.next('error')
            teardown()
            edgeSubject.error(wrapped)
            stateSubject.error(wrapped)
            return
          }
          const [edgeName, edge] = match
          const to = edge.to as string
          teardown()
          const targetData = nodes[to]
          const newData = tr.error(err, targetData, current.data, edgeName) as NodeData
          edgeSubject.next({ edge: edgeName, from: edge.from, to })
          enter(to, newData)
        },
        complete: () => {
          const match = edges.find(([_, __, h]) => h === 'complete')
          if (!match || !tr.complete) {
            const wrapped = new MachineCompletionError(current.node, transitionName, ns)
            status$.next('error')
            teardown()
            edgeSubject.error(wrapped)
            stateSubject.error(wrapped)
            return
          }
          const [edgeName, edge] = match
          const to = edge.to as string
          teardown()
          const targetData = nodes[to]
          const newData = tr.complete(undefined, targetData, current.data, edgeName) as NodeData
          edgeSubject.next({ edge: edgeName, from: edge.from, to })
          enter(to, newData)
        },
      })
      subs.push(sub)
    }
  }

  const outgoing = Object.entries(rootGraph.edges).filter(([_, e]) => e.from === entry)
  if (outgoing.length === 0) {
    stateSubject.next(current)
    status$.next('complete')
    edgeSubject.complete()
    stateSubject.complete()
  } else {
    listen(outgoing)
    stateSubject.next(current)
  }

  const rootState$ = stateSubject.asObservable()
  const rootEvent$ = edgeSubject.asObservable()

  function withStatus$<T extends object>(obj: T): T & { status$: Observable<MachineStatus> } {
    return Object.assign(obj, { status$: status$.asObservable() })
  }

  const result: Record<string, RunningMachine & { kind: NamespaceKind }> = {
    [ROOT]: withStatus$({ state$: rootState$, event$: rootEvent$, kind: 'unioned' as const }),
  }

  for (const ns of correspondence.unioned) {
    const prefix = `${ns}.`
    result[ns] = withStatus$({
      state$: rootState$.pipe(filter(s => s.node.startsWith(prefix) || s.node === ns)),
      event$: rootEvent$.pipe(filter(e => e.edge.startsWith(prefix))),
      kind: 'unioned' as const,
    })
  }

  if (runningMachines) {
    for (const [key, rm] of Object.entries(runningMachines)) {
      result[key] = { ...rm, kind: 'disjoint' }
    }
  }

  return withStatus$({ state$: rootState$, event$: rootEvent$, runningMachines: result, source: machineSet })
}