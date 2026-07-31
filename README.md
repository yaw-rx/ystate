# YState

**Pure finite state machines for TypeScript and RxJS.**  
Write declarative, composable state graphs, with full compile-time verification and no mutable context.

## Why YState?

State machines are supposed to be pure: a set of states, a set of inputs, and a function that maps (state, input) -> (state).  
Most libraries (notably XState) add an imperative runtime, a mutable "context" bag, and actions that couple side-effects directly to transitions.  

**YState** strips that away. It gives you a graph of **nodes** with typed data, **edges** driven by RxJS observables, and **pure transition functions**.

*No interpreter dispatching event strings. No `assign()`. No `spawn()`/pseudo-actor model. Just typed, observable-powered graphs that compose like functions.*

## Quick look

Define the graph topology first. Then implement the transitions, with every parameter inferred from the structure.

```typescript
const Basket = define({
  nodes: {
    empty:      {},
    addingItem: { itemId: '' },
    hasItems:   { items: [] as string[] },
    addFailed:  { error: '', items: [] as string[] },
  },
  deps: {
    auth: Auth,
    payment: Payment,
  },
  edges: (refs) => ({
    addFromEmpty:    { from: 'empty',      to: 'addingItem', on: 'addItem.next' },
    addFromHasItems: { from: 'hasItems',   to: 'addingItem', on: 'addItem.next' },
    addError:        { from: 'addingItem', to: 'addFailed',  on: 'addItem.error' },
    retryAdd:        { from: 'addFailed',  to: 'addingItem', on: 'addItem.next' },
    added:           { from: 'addingItem', to: 'hasItems',   on: 'itemAdded.next' },
    checkout:        { from: 'hasItems',   to: refs.payment.nodes.processing, on: 'checkout.next' },
  }),
}).implement({
  // simulateAddItem() can throw 'item out of stock', so addItem needs
  // error edges in the graph to handle it.
  addItem: {
    $: () => simulateAddItem(),
    next: (result, _dest, _source, edge) => ({ itemId: `${result.itemId}-via-${edge}` }),
    error: (err, dest, _source, edge) => ({ error: `${edge}: ${String(err)}`, items: dest.items }),
  },
  // simulateItemConfirmation() is a simple timer that cannot error or
  // complete without emission, so no error or complete edges are needed.
  itemAdded: {
    $: () => simulateItemConfirmation(),
    next: (_result, dest, source) => ({ items: [...dest.items, source.itemId] }),
  },
  // checkout waits for auth to be authenticated before emitting. The
  // observable cannot error or complete, so no error or complete edges
  // are needed.
  checkout: {
    $: (deps) => timer(500).pipe(
      withLatestFrom(deps.auth.state$),
      filter(([_, auth]) => auth.node === 'authenticated'),
    ),
    next: (_result, _dest, _source, edge) => ({ orderId: `ORD-${Date.now()}-${edge}` }),
  },
})
```

The compiler enforces:

- Every `from` and `to` is a real node, including references to dependency (`deps`) machines' nodes.
- Each handler's `result` type flows from the `$` observable. `dest` and `source` types are derived from the edges. `edge` is the name of the edge being traversed.
- The handler must return exactly the target node's data shape.
- When `$` errors and no `error` handler exists, the machine errors `state$` and `event$` with `MachineUnhandledError` and stops. When `$` completes without emission and no `complete` handler exists, both streams error with `MachineCompletionError`.

No annotations needed. No codegen, no build step. Just TypeScript.

## How YState compares to XState

| Concern               | XState                                     | YState                                            |
|-----------------------|--------------------------------------------|---------------------------------------------------|
| **State + data**      | Named state + mutable `context` bag (which breaks the FSM formalism) | FSM 5-tuple (Q, Σ, δ, q₀, F); node name + typed data as one atomic unit |
| **Transitions**       | String event -> dispatch to interpreter     | Observable subscription -> pure handler            |
| **Side effects**      | `actions` inside the machine               | External subscribers to edge observables          |
| **Composition**       | Pseudo-actor model (`getSnapshot()` breaks isolation), `spawn`, string-based messages | Incidence machines with typed node references     |
| **Topology**          | Implicit in per-state event config         | Full graph G = (V, E) declared upfront, first-class     |
| **Graph validation**  | No structural graph validation             | `.close()` proves E ⊆ V × V before the machine can run |
| **Type safety**       | Build-time typegen step                    | Compile-time only, no codegen                     |
| **Call stack**        | Broken by interpreter, hard to debug       | Standard RxJS stack traces, debuggable            |
| **Boilerplate**       | Promise wrapper states (`pending`, ...)    | Async is just an observable; no extra states needed |

YState is a factory for pure, runnable, finite state machines: graphs of typed nodes and observable-driven edges, with side-effect-free transition functions and no hidden mutable state.

## Core concepts

### The formalism

A finite state machine is formally a 5-tuple (Q, Σ, δ, q₀, F). Most FSM libraries hide this behind imperative runtimes and mutable context bags. YState preserves the formalism:

| Symbol | Formal name          | Definition                                                                     |
|--------|----------------------|--------------------------------------------------------------------------------|
| Q      | State space          | A set of states.                                                               |
| Σ      | Input alphabet       | A set of inputs that drive transitions.                                        |
| δ      | Transition function  | δ: Q × Σ -> Q. Given a state and an input, produces the next state.           |
| q₀     | Start state          | q₀ ∈ Q. The initial state.                                                    |
| F      | Accepting states     | F ⊆ Q. States where the machine may halt.                                     |

YState uses a **data-on-node** model to realise this 5-tuple: each node v ∈ V carries its own typed data space Dv, so the state of the machine at any moment is the node it occupies paired with that node's data. This extends the classical formalism to a potentially infinite state space while keeping the graph topology and transition set finitely defined and fully typed at compile time.

| Symbol | YState                                                                         |
|--------|--------------------------------------------------------------------------------|
| Q      | Q = ∐v∈V Dv, the disjoint union of typed data spaces over V. Each state qᵢ = (vᵢ, dᵢ) where dᵢ ∈ Dvᵢ. Because each Dv can be infinite (e.g. `string`, a counter), Q may range over an infinite set. |
| Σ      | Σ = $ × ∐j∈E D_{target(j)}. `$` is the external environment modelled as an Observable monad; its emissions are outside the machine's control. The coproduct over E selects the edge and the target node's stored data from its last visit. Because that stored data is something the machine itself wrote on a prior visit, the machine's own past outputs feed back as future inputs through Σ, without expanding Q. |
| δ      | δ = { δⱼ }. Each δⱼ is a pure function `(result, dest, source, edge) -> targetNodeData`. The Observable monad `$` has three outcomes, each a handler direction: `next` (emission), `error` (failure), `complete` (completion without emission). |
| q₀     | The entry node and initial data for all nodes, passed to `.start()`.           |
| F      | F = { v ∈ V \| outdeg(v) = 0 }. Derived from the graph topology. When the machine reaches v ∈ F, `state$` completes. |

**The self-referential feedback loop.** The destination data dv' that δⱼ receives at step n is the value the machine wrote on its own last visit to v'. Σ depends on Q: each step reshapes the inputs available to future steps. For sufficiently rich transition functions the trajectory q(0), ..., q(N) is computationally irreducible; determining which states the machine visits, or whether N is finite, may require running it.

**Finite description, potentially infinite state space.** The graph topology (V, E) and transition set (δ) are finitely defined, but Q and Σ may range over infinite sets. Even without the environment, δ alone can produce infinitely many distinct states. The data-on-node model is a concise finite description of a potentially much larger (possibly infinite) state machine, all components fully typed at compile time. A context bag model abandons this: a single mutable store outside the graph makes Q undefined, severs the relationship between state and topology, and offers no honest accounting of the machine's behaviour.

### Pipeline

**Incidence graphs.** An incidence graph G = (V, E) is the developer's factorisation unit: you decompose your problem into a node set V with typed data shapes and an incidence relation E mapping edges to pairs of nodes. Each edge e = (v₁, v₂) ∈ E connects a source node to a target via an `on` field that binds it to a transition and handler direction (e.g. `'process.next'`, `'process.error'`). An incidence graph may be **open** (edges reference nodes outside V via `DepNodeRef`, creating cross-graph edges whose targets lie in another graph's node set) or **closed** (E ⊆ V × V). This is pure topology, not yet an FSM.

**IncidenceGraphSet.** When an incidence graph declares dependencies on other graphs, it becomes an IncidenceGraphSet: an incidence graph equipped with a K-indexed family of dependency graphs { Gk }k∈K. The deps record carries the graphs whose nodes may be referenced by open edges. An IncidenceGraphSet is itself an incidence graph; the set always contains at least one member (itself), so the minimum size is 1. Produced by `define()`.

**IncidenceMachine.** Calling `.implement()` equips an IncidenceGraphSet with transition functions δ = { δⱼ }, producing an IncidenceMachine. The K-indexed family of dependencies is narrowed from IncidenceGraphSets to IncidenceMachines, so each Gk also carries its own δk. The graph may still be open; it has not been validated.

**Closure.** Calling `.close()` on an IncidenceMachine transforms it into a validated MachineSet through graph closure and transition closure. First, the dependency keys K are partitioned into **unioned** R ⊆ K (dependencies whose nodes are referenced by edges) and **disjoint** K \ R (dependencies with Vk ∩ V' = ∅, observed independently). For each unioned dependency, a namespaceFunctor fk: Gk -> G' is applied: an injective graph homomorphism that maps Vk -> V' and Ek -> E' by prefix while preserving the incidence relation (V' = { ns.v | v ∈ Vk }, and for each edge e = (v₁, v₂) ∈ Ek, f(e) = (ns.v₁, ns.v₂) ∈ E'). The namespaced images { Gk' = fk(Gk) } are then unioned with the root graph into a single supergraph G' = (V', E') where V' = V ∪ V₁' ∪ V₂' ∪ ... and E' = E ∪ E₁' ∪ E₂' ∪ ... (the namespaceFunctor prefixing guarantees Vi ∩ Vj = ∅). Graph closure validates E' ⊆ V' × V': every edge endpoint must exist in V'. Transition closure validates that for every edge e ∈ E', the transition function δⱼ named by e exists in the corresponding namespace's δ, and that the direction d demanded by e is provided by δⱼ [d ∈ keys(δⱼ) \ {$}].

**Correspondence.** Closure also produces the correspondence: the forward and inverse maps of the namespaceFunctors. Since each fk is injective, its inverse fk⁻¹ is well-defined on im(fk), and the fibres are singletons, giving a clean 1:1 map between local and global names in both directions. The **image** maps local names to their namespaced global names (fk: Vk -> V', Ek -> E'). The **preimage** maps global names back to local names (fk⁻¹: im(fk) -> Vk). The correspondence also records the unioned/disjoint classification of K and the transition lookup: δ indexed by namespace so the runtime can resolve which δⱼ handles a given edge via `transitions[ns][j]` without walking the composition tree.

**FibredGraph.** The proven-closed supergraph G' equipped with its correspondence forms a FibredGraph: the fibre decomposition over the namespaceFunctors that built it, with every local/global name relationship recorded for both directions.

**Machine.** Each FibredGraph is then equipped with its transition functions δ and the terminal node set F = { v ∈ V | outdeg(v) = 0 }, producing a Machine: a single self-contained closed FSM carrying its own topology, fibres, implementations, and terminal set.

**MachineSet.** The collection of all Machines (the root supergraph plus any disjoint machines, each independently closed) forms the MachineSet. The supergraph G' lives at the root namespace with kind `'unioned'`. Disjoint machines live at their namespace key with kind `'disjoint'`. Every constituent graph satisfies E ⊆ V × V and δ is closed over E. If either closure fails, the whole set fails.

**RunningMachineSet.** Calling `.start()` on a MachineSet begins traversal, producing a RunningMachineSet. q₀ is the entry node; initial data can be supplied for any node in V'. Disjoint machines must already be running and are passed in so `$` factories can observe them. The runtime provides `state$` (emits `{ node, data }` on each state change) and `event$` (emits `{ edge, from, to }` on each edge firing) over G' and each independent machine. Each RunningMachine carries a `status$` observable over `MachineStatus`: `'running'`, `'complete'`, `'error'`, or `'stopped'`. The owner that called `.start()` can end the set externally with `.stop()` - the only way to end a machine whose graph has no terminal node [F = ∅].


Each stage of construction makes the formal components explicit:

```
IncidenceGraph -> IncidenceGraphSet -> IncidenceMachine -> FibredGraph -> Machine   -> MachineSet ->    RunningMachineSet
    (V, E)          (V, E, {Gk})       (V, E, δ, {IMk})    (G', corr)    (G', δ, F)    {Machineᵢ}           (MS, q₀ⁱ)
                                                            E ⊆ V × V                   E ⊆ V × V    {state$, event$, status$}ᵢ
                                                                                         for all
                                                                                         machines
```

### Topology first

YState separates the graph structure from the transition logic. You declare the topology first, nodes and edges, establishing which states exist and how they connect. Then you implement the transitions via `.implement({...})`, where every parameter type is derived from the graph structure. The topology is the contract; the type system enforces it.

### Nodes

Every node is a name plus a **typed data shape**.  
The complete state of the machine at any moment is `{ node: 'authenticated', data: { token: '...', authenticatedAt: ... } }`.  
No separate context bag that can get out of sync.

```typescript
...
  nodes: {
    empty:      {},
    addingItem: { itemId: '' },
    hasItems:   { items: [] as string[] },
  },
```

### Transitions

Transitions are defined in a second step via `.implement({...})`, one key per transition name extracted from the edges. Each key contextually types its handlers: `result` from the `$` observable's emission type, `dest` from the target node's data shape, `source` from the source node's data shape, and `edge` the name of the edge being traversed. A transition is an object with:

- `$` - an Observable factory over the external environment. When the incidence machine has dependencies (`deps`), the runtime passes their running instances so transitions can observe their state. It can be a timer, a DOM event, an HTTP call, a stream pipeline, anything reactive.
- `next` - a pure function `(result, dest, source, edge) -> targetNodeData`. The `result` type is inferred from `$`, `dest`/`source` types are derived from the edges, and `edge` is the name of the edge being traversed.
- `error` - a pure function `(error, dest, source, edge) -> targetNodeData` for the failure path. Required when error edges exist, optional otherwise. If omitted and `$` errors, the machine errors `state$` and `event$` with `MachineUnhandledError`.
- `complete` - a pure function `(result, dest, source, edge) -> targetNodeData` for when `$` completes without emitting. Required when complete edges exist, optional otherwise. If omitted and `$` completes without emission, the machine errors with `MachineCompletionError`.

Transitions themselves contain **no side effects**. Side effects happen when *you* subscribe to the edge observables, outside the machine.

```typescript
...
.implement({
  addItem: {
    $: () => simulateAddItem(),
    next: (result, _dest, _source, edge) => ({ itemId: `${result.itemId}-via-${edge}` }),
    error: (err, dest, _source, edge) => ({ error: `${edge}: ${String(err)}`, items: dest.items }),
  },
  itemAdded: {
    $: () => simulateItemConfirmation(),
    next: (_result, dest, source) => ({ items: [...dest.items, source.itemId] }),
  },
})
```

### Edges

An edge connects a source node to a target node via `on`, which names the transition and handler direction in a single field (e.g. `'process.next'`, `'process.error'`, or `'process.complete'`).  
The type system uses the edge's `from`/`to` and the referenced transition to verify that the handler returns exactly the correct shape.

Edges are defined as a plain record, or as a function over the dependency incidence machines { Gₖ }ₖ∈K when edges target nodes vₖ ∈ Vₖ outside V.

```typescript
...
  // Plain record when the graph is closed (E ⊆ V × V)
  edges: {
    approve: { from: 'processing', to: 'approved',  on: 'process.next' },
    decline: { from: 'processing', to: 'declined',  on: 'process.error' },
    stall:   { from: 'processing', to: 'stalled',   on: 'process.complete' },
  },
```

```typescript
...
  // Function when the graph is open (edges target nodes vₖ ∈ Vₖ in dependency incidence machines)
  edges: (refs) => ({
    addFromEmpty: { from: 'empty', to: 'addingItem', on: 'addItem.next' },
    checkout:     { from: 'hasItems', to: refs.payment.nodes.processing, on: 'checkout.next' },
  }),
```

### Composition (incidence machines)

Incidence machines can reference nodes in other incidence machines. Declare dependencies via `deps`, and the `refs` parameter in the `edges` callback gives you typed access to their nodes.

When `.close()` builds the machine set, it looks at the edges to determine which incidence machines are referenced. If any edge targets a node in another machine (via `refs`), that machine's nodes are merged into the graph, prefixed by key (e.g. `processing` becomes `payment.processing`). The result is a single graph G' = (V', E') where V' is the union of all referenced node sets and E' ⊆ V' × V'.

Incidence machines whose nodes are *not* referenced by any edge are validated independently by `.close()`. They run as their own machines, and their running instances are passed to `.start()` so that `$` factories can observe them.

In the Basket [example above](#quick-look), the checkout edge targets `refs.payment.nodes.processing`, which means Payment's incidence graph will be merged into the supergraph G' when `.close()` runs. Auth's nodes are not referenced by any edge, so `.close()` validates Auth as an independent machine.

```typescript
...
  deps: {
    auth: Auth,
    payment: Payment,
  },
  edges: (refs) => ({
    ...
    checkout: { from: 'hasItems', to: refs.payment.nodes.processing, on: 'checkout.next' },
  }),
```

The compiler checks that `processing` really exists in `Payment`, and that the handler's return type matches its data shape.

## Getting started

```
npm install @yaw-rx/ystate rxjs
```

1. Define your **nodes**, each with a typed data shape.
2. Optionally declare other incidence machines as dependencies via **`deps`**.
3. Define your **edges** with `from`, `to`, and `on`. A plain record for closed graphs, or a function `(refs) => ({...})` when edges target nodes in dependency incidence machines. This is the graph topology.
4. Chain `.implement({...})` to implement each transition, with full contextual typing derived from the graph.

## Runtime

The API chains naturally from definition to running instance:

```typescript
const auth = Auth.close().start('loggedOut')
```

### Closing

`.close()` takes an incidence machine and produces a `MachineSet`. For each dependency declared in `deps` whose nodes are referenced by edges, nodes and edges are prefixed by key and merged into a single supergraph G' = (V', E'). Cross-machine references are resolved to their prefixed names. Dependencies listed in `deps` but not referenced by any edge are validated as independent machines.

Closure runs two passes. Graph closure validates the topology (E' ⊆ V' × V') and throws `IncidenceGraphSetClosureError` on failure:

- `missing-dep`: an edge targets a dependency not declared in `deps`.
- `missing-dep-node`: an edge targets a node that doesn't exist in the dependency declared in `deps`.
- `missing-source`: an edge's `from` node doesn't exist in V'.
- `missing-target`: an edge's `to` node doesn't exist in V'.
- `namespace-collision`: two dependencies in `deps` produce the same prefixed node name.
- `multiple-graphs`: V' decomposes into disconnected components.

Transition closure validates that every edge is backed by an implemented transition, and throws `IncidenceMachineClosureError` on failure:

- `missing-transition`: an edge names a transition with no implementation in its namespace.
- `missing-handler`: an edge demands a handler direction (e.g. `error`) that the transition doesn't provide.
- `malformed-edge-on`: the edge's `on` field doesn't match the `transition.direction` format.
- `missing-namespace-transitions`: an edge belongs to a dependency namespace from `deps` that has no implemented transitions.

Both error types carry an `issues` array with diagnostic context. Type guards (`isGraphMissingDep`, `isGraphMissingDepNode`, `isGraphMissingSource`, `isGraphMissingTarget`, `isNamespaceCollision`, `isMultipleGraphs`, `isClosureMissingTransition`, `isClosureMissingHandler`, `isMalformedEdgeOn`, `isMissingNamespaceTransitions`) narrow issues to their variant.

```typescript
try {
  const authMachineSet = Auth.close()
} catch (err) {
  // Graph closure: topology violations (E' ⊆ V' × V')
  if (err instanceof IncidenceGraphSetClosureError) {
    console.error(err.message)

    // Type guards narrow issues for programmatic handling.
    // Each variant carries the fields needed to diagnose and respond.
    for (const issue of err.issues) {
      if (isGraphMissingDep(issue)) {
        // A dependency referenced by an edge doesn't exist in deps.
        // issue.dep is the missing key, issue.availableDeps lists what's in deps.
        suggestDep(issue.edge, issue.dep, issue.availableDeps)
      } else if (isGraphMissingDepNode(issue)) {
        // A dependency declared in deps doesn't have the referenced node.
        // issue.dep is the dependency key in deps, issue.node is the missing node.
        suggestNode(issue.edge, issue.dep, issue.node, issue.availableNodes)
      } else if (isGraphMissingSource(issue) || isGraphMissingTarget(issue)) {
        // An edge's from or to node doesn't exist in V'.
        // issue.node is the missing endpoint, issue.namespace identifies which graph.
        suggestEndpoint(issue.edge, issue.node, issue.namespace, issue.availableNodes)
      } else if (isNamespaceCollision(issue)) {
        // Two dependencies in deps produce the same prefixed node name.
        // issue.namespace and issue.existingNamespace identify the collision.
        reportCollision(issue.node, issue.namespace, issue.existingNamespace)
      } else if (isMultipleGraphs(issue)) {
        // V' decomposes into disconnected components.
        // issue.graphs contains each component as a separate IncidenceGraph.
        reportDisconnected(issue.graphs)
      }
    }
  }

  // Transition closure: every edge must be backed by δⱼ
  if (err instanceof IncidenceMachineClosureError) {
    console.error(err.message)

    for (const issue of err.issues) {
      if (isClosureMissingTransition(issue)) {
        // An edge names a transition with no implementation in its namespace.
        // issue.transition is the missing name, issue.availableTransitions lists what exists.
        suggestTransition(issue.edge, issue.transition, issue.namespace, issue.availableTransitions)
      } else if (isClosureMissingHandler(issue)) {
        // An edge demands a handler direction that the transition doesn't provide.
        // issue.direction is the missing handler (e.g. 'error'), issue.availableHandlers lists what exists.
        suggestHandler(issue.edge, issue.transition, issue.direction, issue.availableHandlers)
      } else if (isMalformedEdgeOn(issue)) {
        // The edge's on field doesn't match the 'transition.direction' format.
        // issue.on is the malformed value.
        reportMalformed(issue.edge, issue.on)
      } else if (isMissingNamespaceTransitions(issue)) {
        // An edge belongs to a dependency namespace from deps that has no transitions.
        // issue.namespace is the empty namespace, issue.availableNamespaces lists what has transitions.
        suggestNamespace(issue.edge, issue.namespace, issue.availableNamespaces)
      }
    }
  }
}
```

### Validating

`.validate()` on a closed `MachineSet` returns non-blocking warnings. Closure errors are hard failures; validation warnings flag things that may need attention:

- `missing-handler`: a transition implements `next` but not `error` or `complete`. Whether `$` will error or complete can't be determined statically: a timer won't error, an HTTP request might. If `$` errors at runtime without an error handler, a `MachineUnhandledError` is thrown. If `$` completes without emitting and no complete handler exists, a `MachineCompletionError` is thrown.
- `unused-transition`: a transition is implemented but no edge references it. Dead code. TypeScript catches this at compile time via `TransitionNames<TEdges>`, but plain JavaScript won't see it until `.validate()`.

Type guards `isMissingHandler` and `isUnusedTransition` narrow validation issues.

```typescript
const issues = authMachineSet.validate()
for (const issue of issues.filter(isMissingHandler)) {
  console.warn(`${issue.transition}: missing ${issue.handlers.join(', ')}`)
}
```

### Starting

`.start(entry, runningMachines?, initialNodeData?)` begins traversal from the given entry node:

- `entry` - the starting node.
- `runningMachines` - running instances of independently validated machines, passed to `$` factories so transitions can observe their state.
- `initialNodeData` - partial map of nodes to partial data, amending any node's defaults in V'.

### Observing state

`state$` emits `{ node, data }` on each state change. `event$` emits `{ edge, from, to }` on each edge firing. `status$` emits the machine's lifecycle state: `'running'`, `'complete'`, `'error'`, or `'stopped'`.

```typescript
// .close() validates Auth's graph satisfies E ⊆ V × V -
// every edge's from and to exist in the node set. Throws if not.
const authMachineSet = Auth.close()

// .start() begins traversal from q₀ and returns a RunningMachineSet.
// state$ emits { node, data } on each transition,
// event$ emits { edge, from, to } on each edge firing.
// status$ emits the machine's lifecycle state.
const auth = authMachineSet.start('loggedOut')

// state$ emits { node, data } whenever the machine transitions.
auth.state$.subscribe({
  next: (state) => console.log(`[${state.node}]`, state.data),
  complete: () => console.log('auth complete'),
  error: (err) => {
    if (err instanceof MachineUnhandledError) {
      console.error(err.message, { node: err.node, transition: err.transition, namespace: err.namespace, cause: err.cause })
    } else if (err instanceof MachineCompletionError) {
      console.error(err.message, { node: err.node, transition: err.transition, namespace: err.namespace })
    }
  },
})

// event$ emits { edge, from, to } on each edge firing.
auth.event$.subscribe(event =>
  console.log(`${event.edge}: ${event.from} -> ${event.to}`)
)

// status$ emits the machine's lifecycle state: 'running', 'complete', 'error', or 'stopped'.
auth.status$.subscribe(status => console.log(`auth status: ${status}`))
```

### Stopping

A machine ends itself by reaching a terminal node [v ∈ F, outdeg(v) = 0] - entering it tears down all subscriptions and completes `state$`/`event$`. But a graph with no terminal node [F = ∅] - a thermostat, a session loop - can never end itself. `.stop()` is the external counterpart: the owner that called `.start()` tears the set down from outside.

```typescript
const heater = Heater.close().start('off')

// .stop() unsubscribes every active transition's $ observable
// (the machine stops listening to its environment), completes
// state$ and event$ (including the namespace-filtered views),
// and status$ reports 'stopped'.
heater.stop()

// Idempotent: stopping an already-ended machine (terminal,
// errored, or stopped twice) is a no-op - a 'complete' status
// never regresses to 'stopped'.
heater.stop()
```

Disjoint machines passed into `.start()` are not stopped - they were started by their own owner, and ownership of a machine's lifetime never transfers:

```typescript
const auth = Auth.close().start('loggedOut')
const basket = Basket.close().start('empty', { auth })

basket.stop() // basket's traversal ends; auth keeps running
auth.stop()   // auth's owner ends it separately
```

### Machine sets with multiple machines

Basket's edges reference Payment's nodes (via `refs.payment.nodes.processing`) but not Auth's. So `.close()` merges Payment's incidence graph into the supergraph G' and validates Auth as an independent machine. At `.start()` time, Auth must already be running:

```typescript
const auth = Auth.close().start('loggedOut')

// Basket:
//   - Payment's nodes are referenced by edges, so its graph
//     is merged into the supergraph G'
//   - Auth's nodes are not referenced by any edge, so Auth
//     is validated independently by .close()
//
// .close():
//   - merges Basket and Payment into the supergraph G'
//   - validates Auth independently
//
// .start(entry, runningMachines, initialNodeData):
//   - entry: the starting node in G'
//   - runningMachines: running instances of independently validated machines,
//     passed to transition $ factories for observation
//   - initialNodeData: partial map of nodes to partial data, amending any node in G'
const basket = Basket.close().start('empty', { auth }, { hasItems: { items: ['item-0'] } })
```

### Root streams

`state$` and `event$` fire for all nodes and edges in the root supergraph (Basket + Payment merged). `state$` completes when the machine reaches a terminal node (no outgoing edges). Here that's `payment.approved`, `payment.declined`, or `payment.stalled`.

```typescript
// state$ fires for all nodes in G' (basket + payment merged).
// Completes when a terminal node is reached (no outgoing edges) -
// here that's payment.approved, payment.declined, or payment.stalled.
basket.state$.subscribe({
  next: (state) => console.log(`[${state.node}]`, state.data),
  complete: () => console.log('basket complete'),
})

// event$ emits { edge, from, to } on each edge firing.
auth.event$.subscribe(event =>
  console.log(`${event.edge}: ${event.from} -> ${event.to}`)
)
```

### Error handling

Machine errors (`MachineUnhandledError`, `MachineCompletionError`) propagate to both `state$` and `event$`. You can handle them on either stream.

```typescript
// Machine errors propagate to state$. Handle on auth via state$.
auth.state$.subscribe({
  next: (state) => console.log(`[${state.node}]`, state.data),
  complete: () => console.log('auth complete'),
  error: (err) => {
    if (err instanceof MachineUnhandledError) {
      console.error(err.message, { node: err.node, transition: err.transition, namespace: err.namespace, cause: err.cause })
    } else if (err instanceof MachineCompletionError) {
      console.error(err.message, { node: err.node, transition: err.transition, namespace: err.namespace })
    }
  },
})

// Machine errors also propagate to event$. Handle on basket via event$.
basket.event$.subscribe({
  next: (event) => console.log(`${event.edge}: ${event.from} -> ${event.to}`),
  error: (err) => {
    if (err instanceof MachineUnhandledError) {
      console.error(err.message, { node: err.node, transition: err.transition, namespace: err.namespace, cause: err.cause })
    } else if (err instanceof MachineCompletionError) {
      console.error(err.message, { node: err.node, transition: err.transition, namespace: err.namespace })
    }
  },
})
```

### Machine lifecycle

`status$` emits the machine's lifecycle state: `'running'`, `'complete'`, `'error'`, or `'stopped'`.

```typescript
// status$ emits the machine's lifecycle state: 'running', 'complete', 'error', or 'stopped'.
auth.status$.subscribe(status => console.log(`auth status: ${status}`))

// Each running machine has its own status$.
basket.status$.subscribe(status => console.log(`basket status: ${status}`))
```

### Per-machine access

Each machine whose graph was merged into G' has its own `RunningMachine` view, filtered from the root streams by namespace:

```typescript
// Each machine whose graph was merged into G' has its own
// RunningMachine view, filtered from the root streams by namespace.
basket.runningMachines['payment'].state$.subscribe(state =>
  console.log(`[payment:${state.node}]`, state.data)
)
```

### How traversal works

On entry to a node, the runtime subscribes to the `$` observables of all outgoing transitions, passing the running machines. When an observable emits, it runs the pure handler, transitions to the target node, and unsubscribes from the old transitions.

No interpreter, no event matching, no message bus, just observable subscriptions and pure function calls.

## Coupled systems

Real systems are coupled. A thermostat reacts to the room it heats. A checkout flow observes authentication state. A robot arm reads sensors that its own motion changes. The hard part is not the coupling itself but keeping each process isolated, pure, and auditable while they influence each other.

YState machines are observables. They expose `state$` and consume through `$`. Coupling two systems is standard RxJS composition: connect one machine's output to another's input, or to a shared subject that both can see. Each machine remains a closed, validated graph with no knowledge of what drives it or what subscribes to it. The topology stays honest, the transitions stay pure, and every coupling point is visible in the stream wiring.

### A heater FSM

A thermostat and the room it heats are a coupled system: the heater raises the temperature, and the temperature triggers the heater on and off.

```typescript
// Current room temperature (degrees C)
const temperature$ = new BehaviorSubject(10);

// The thermostat cycles between power (heating) and idle based on
// room temperature. It can be turned on from off, and turned off
// from either power or idle.
const Heater = define({
    nodes: {
        on: {},
        off: {},
        power: {},
        idle: {}
    },
    edges: {
        turnOn: {from: 'off', to: 'on', on: 'onSignal.next'},
        onToPower: {from: 'on', to: 'power', on: 'belowLowerLimit.next'},
        onToIdle: {from: 'on', to: 'idle', on: 'atOrAboveLowerLimit.next'},
        powerToIdle: {from: 'power', to: 'idle', on: 'aboveUpperLimit.next'},
        idleToPower: {from: 'idle', to: 'power', on: 'belowLowerLimit.next'},
        powerToOff: {from: 'power', to: 'off', on: 'offSignal.next'},
        idleToOff: {from: 'idle', to: 'off', on: 'offSignal.next'},
    }
}).implement({
    onSignal: {
        $: () => turnOnSignal,
        next: () => ({}),
    },
    offSignal: {
        $: () => turnOffSignal,
        next: () => ({}),
    },
    // Fires on entry to 'on' if temperature is already at or above the lower limit
    atOrAboveLowerLimit: {
        $: () => temperature$.pipe(filter((T) => T >= lowerLimitT)),
        next: () => ({}),
    },
    // Fires when temperature drops below the lower threshold, triggering heating
    belowLowerLimit: {
        $: () => temperature$.pipe(filter((T) => T < lowerLimitT)),
        next: () => ({}),
    },
    // Fires when temperature rises above the upper threshold, stopping heating
    aboveUpperLimit: {
        $: () => temperature$.pipe(filter((T) => T > upperLimitT)),
        next: () => ({}),
    },
});

const heater = Heater.close().start('on');
const heaterState$ = heater.state$;
```

### A Physics simulation

The heater influences the environment (heat output raises temperature)and the environment influences the heater (temperature crosses thresholds that trigger transitions between power and idle). Neither side owns the loop; they are coupled through shared observables.

```typescript
// Physics simulation outside the machine.
// Each tick applies dT = (q_heater - k * (roomT - environmentT)) / mC
timer(0, 1000).pipe(
    mergeMap(() => combineLatest([temperature$, heaterState$]).pipe(take(1))),
    map(([roomT, heaterState]) => {
        const heatLoss = wallConductance * (roomT - environmentT);
        const heaterOutput = heaterState.node === 'power' ? heaterPower : 0;
        return roomT + (heaterOutput - heatLoss) / mC;
    })
).subscribe(newT => temperature$.next(newT))
```

The machine has no side effects. It transitions between `power` and `idle`, but it doesn't touch the temperature. The physics simulation reads `state$` and does the maths. The machine owns the state, the simulation owns the physics.

The graph topology is the complete specification of the thermostat's behaviour. Every state it can be in and every transition it can make is visible in the edges. `.close()` validates the graph before it runs, so you know that every edge references a real state. The topology is an honest audit of the machine.

The machine and the simulation are just observables. Neither knows the other exists. `temperature$` feeds into the machine through `$`, `state$` feeds back into the simulation. You could swap the physics for a test harness or a real sensor and the machine wouldn't change.

## License

MIT
