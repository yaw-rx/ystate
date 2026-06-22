# YState

**Pure finite state machines for TypeScript and RxJS.**  
Write declarative, composable state graphs, with full compile-time verification and no mutable context.

---

## Why YState?

State machines are supposed to be pure: a set of states, a set of inputs, and a function that maps (state, input) -> (state).  
Most libraries (notably XState) add an imperative runtime, a mutable "context" bag, and actions that couple side-effects directly to transitions.  

**YState** strips that away. It gives you a graph of **nodes** with typed data, **edges** driven by RxJS observables, and **pure transition functions**.

*No interpreter dispatching event strings. No `assign()`. No `spawn()`/actor model. Just typed, observable-powered graphs that compose like functions.*

---

## Quick look

Define the graph topology first. Then implement the transitions, with every parameter inferred from the structure.

```typescript
const Basket = defineIncidenceGraph({
  nodes: {
    empty:      {},
    addingItem: { itemId: '' },
    hasItems:   { items: [] as string[] },
  },
  incidenceMachines: {
    auth: Auth,
    payment: Payment,
  },
  edges: (refs) => ({
    addFromEmpty:    { from: 'empty',      to: 'addingItem', on: 'addItem.next' },
    addFromHasItems: { from: 'hasItems',   to: 'addingItem', on: 'addItem.next' },
    added:           { from: 'addingItem', to: 'hasItems',   on: 'itemAdded.next' },
    checkout:        { from: 'hasItems',   to: refs.payment.nodes.processing, on: 'checkout.next' },
  }),
}).implement(on => ({
  addItem: on.addItem({
    $: () => timer(500),
    next: (result, dest, source) => ({ itemId: String(result) }),
    error: (result) => ({}),
  }),
  itemAdded: on.itemAdded({
    $: () => timer(1000),
    next: (result, dest) => {
      const existing = dest?.items ?? []
      return { items: [...existing, `item-${existing.length + 1}`] }
    },
    error: (result) => ({ itemId: '' }),
  }),
  checkout: on.checkout({
    $: (ctx) => timer(500).pipe(
      withLatestFrom(ctx.auth.node$),
      filter(([_, auth]) => auth.node === 'authenticated'),
    ),
    next: (result) => ({ orderId: 'ORD-001' }),
    error: (result) => ({ items: [] as string[] }),
  }),
}))
```

The compiler enforces:

- Every `from` and `to` is a real node, including references to other incidence machines' nodes.
- Each handler's `result` type flows from the `$` observable. `dest` and `source` types are derived from the edges.
- The handler must return exactly the target node's data shape.
- No annotations needed. No codegen, no build step. Just TypeScript.

---

## How YState compares to XState

| Concern               | XState                                     | YState                                            |
|-----------------------|--------------------------------------------|---------------------------------------------------|
| **State + data**      | Named state + mutable `context` bag (which breaks the FSM formalism) | FSM 5-tuple (Q, Σ, δ, q₀, F); node name + typed data as one atomic unit |
| **Transitions**       | String event -> dispatch to interpreter     | Observable subscription -> pure handler            |
| **Side effects**      | `actions` inside the machine               | External subscribers to edge observables          |
| **Composition**       | Actor model, `spawn`, string-based messages | Incidence machines with typed node references     |
| **Graph validation**  | No structural graph validation             | `.close()` proves E ⊆ V × V before the machine can run |
| **Type safety**       | Build-time typegen step                    | Compile-time only, no codegen                     |
| **Call stack**        | Broken by interpreter, hard to debug       | Standard RxJS stack traces, debuggable            |
| **Boilerplate**       | Promise wrapper states (`pending`, ...)    | Async is just an observable; no extra states needed |

YState is a pure finite state machine: a graph of typed nodes and observable-driven edges, with side-effect-free transition functions and no hidden mutable state.

---

## Core concepts

### Pipeline

A finite state machine is formally a 5-tuple (Q, Σ, δ, q₀, F): a set of states Q, an input alphabet Σ, a transition function δ, a start state q₀, and a set of final states F. Most FSM libraries hide this behind imperative runtimes and mutable context bags. YState preserves the formalism and makes each stage of construction explicit:

```
IncidenceGraph -> IncidenceMachine  -> MachineSet    -> RunningMachineSet
   (V, E)          (V, E, δ,           (closed,         (live observable
                    incidence            validated         streams)
                    machines)            machines)
```

- **IncidenceGraph** - the topology: nodes V and an incidence relation E. May be open (edges can reference nodes in other incidence machines). This is the developer's factorisation unit, not yet an FSM.
- **IncidenceMachine** - an incidence graph equipped with transition functions δ and optionally other incidence machines whose nodes it references. Produced by `defineIncidenceGraph().implement()`. Still not a valid FSM because the graph may be open.
- **Machine** - a single closed FSM: Q = nodes, Σ = observable emissions, δ = transition functions, F = nodes with no outgoing edges (derived). The graph satisfies E ⊆ V × V. Produced internally during `.close()`.
- **MachineSet** - a validated collection of Machines, produced by `.close()`. Referenced incidence machines are merged and prefixed into a single closed graph G' = (V', E'). Unreferenced incidence machines are validated independently. Each machine in the set satisfies E ⊆ V × V.
- **RunningMachineSet** - the live runtime, produced by `.start()`. q₀ is the entry node passed to start. Observable streams over G' and each independent machine.

### Topology first

YState separates the graph structure from the transition logic. You declare the topology first, nodes and edges, establishing which states exist and how they connect. Then you implement the transitions via `.implement(on => ({...}))`, where `on` derives every parameter type from the graph structure. The topology is the contract; the type system enforces it.

### Nodes

Every node is a name plus a **typed data shape**.  
The complete state of the machine at any moment is `{ node: 'authenticated', data: { token: '...', authenticatedAt: ... } }`.  
No separate context bag that can get out of sync.

```typescript
nodes: {
  empty:      {},
  addingItem: { itemId: '' },
  hasItems:   { items: [] as string[] },
},
```

### Transitions

Transitions are defined in a second step via `.implement(on => ({...}))`. `on` provides one factory per transition name extracted from the edges. Each factory contextually types its handlers: `result` from the `$` observable's emission type, `dest` from the target node's data shape, and `source` from the source node's data shape. A transition is an object with:

- `$` - an Observable factory (the input alphabet). When the incidence machine references other incidence machines, the runtime passes their running instances so transitions can observe their state. It can be a timer, a DOM event, an HTTP call, a stream pipeline, anything reactive.
- `next` - a pure function `(result, dest?, source?) -> targetNodeData`. The `result` type is inferred from `$`, and `dest`/`source` types are derived from the edges.
- `error` - a pure function `(error, dest?, source?) -> targetNodeData` for the failure path.

Transitions themselves contain **no side effects**. Side effects happen when *you* subscribe to the edge observables, outside the machine.

```typescript
.implement(on => ({
  process: on.process({
    $: () => timer(3000),
    next: (result, dest, source) => ({ confirmedAt: Date.now() }),
    error: (result, dest, source) => ({ reason: String(result) }),
  }),
}))
```

### Edges

An edge connects a source node to a target node via `on`, which names the transition and branch in a single field (e.g. `'process.next'` or `'process.error'`).  
The type system uses the edge's `from`/`to` and the referenced transition to verify that the handler returns exactly the correct shape.

Edges are defined as a function that receives typed refs from the incidence machines, so references to other incidence machines' nodes are checked at compile time.

```typescript
  edges: (refs) => ({
    approve: { from: 'processing', to: 'approved',  on: 'process.next' },
    decline: { from: 'processing', to: 'declined',  on: 'process.error' },
  }),
```

### Composition (incidence machines)

Incidence machines can reference nodes in other incidence machines. Pass them via `incidenceMachines`, and the `refs` parameter in the `edges` callback gives you typed access to their nodes.

When `.close()` builds the machine set, it looks at the edges to determine which incidence machines are referenced. If any edge targets a node in another machine (via `refs`), that machine's nodes are merged into the graph, prefixed by key (e.g. `processing` becomes `payment.processing`). The result is a single graph G' = (V', E') where V' is the union of all referenced node sets and E' ⊆ V' × V'.

Incidence machines whose nodes are *not* referenced by any edge are validated independently by `.close()`. They run as their own machines, and their running instances are passed to `.start()` so that `$` factories can observe them.

```typescript
const Basket = defineIncidenceGraph({
  nodes: { ... },
  incidenceMachines: {
    auth:    Auth,       // no edges target auth nodes, so it runs independently
    payment: Payment,    // checkout targets payment.processing, so it merges in
  },
  edges: (refs) => ({
    checkout: { from: 'hasItems', to: refs.payment.nodes.processing, on: 'checkout.next' },
  }),
}).implement(on => ({
  checkout: on.checkout({
    $: (ctx) => timer(500).pipe(
      withLatestFrom(ctx.auth.node$),
      filter(([_, auth]) => auth.node === 'authenticated'),
    ),
    next: (result) => ({ orderId: 'ORD-001' }),
    error: (result) => ({ items: [] as string[] }),
  }),
}))
```

The compiler checks that `processing` really exists in `Payment`, and that the handler's return type matches its data shape.

---

## Getting started

```
npm install @yaw-rx/ystate rxjs
```

1. Define your **nodes**, each with a typed data shape.
2. Optionally pass other incidence machines via **incidenceMachines**.
3. Define your **edges** as a function, `(refs) => ({...})` with `from`, `to`, and `on`. This is the graph topology.
4. Chain `.implement(on => ({...}))` to implement each transition. `on` provides full contextual typing derived from the graph.

---

## Runtime

The API chains naturally from definition to running instance:

```typescript
const auth = Auth.close().start('loggedOut')
```

### Closing

`.close()` takes an incidence machine and produces a `MachineSet`, a validated collection of closed finite state machines. For each referenced incidence machine, its nodes and edges are prefixed by key and merged into a single graph G' = (V', E'). Cross-machine references are resolved to their prefixed names. The closure property is then verified: every edge endpoint must exist in V' (E' ⊆ V' × V'). Incidence machines not referenced by any edge are validated as independent machines.

The result is a set of machines where every graph is closed. If any graph fails validation, `.close()` throws.

### Starting

`.start(entry, runningMachines?, initialNodeData?)` begins traversal from the given entry node:

- `entry` - the starting node (q₀).
- `runningMachines` - running instances of independently validated machines, passed to `$` factories so transitions can observe their state.
- `initialNodeData` - optional partial that overrides the entry node's default data shape.

### Observing state

`node$` emits `{ node, data }` on each state change. `edge$` emits `{ edge, from, to }` on each edge firing.

```typescript
// .close() validates Auth's graph satisfies E ⊆ V × V -
// every edge's from and to exist in the node set. Throws if not.
const authMachineSet = Auth.close()

// .start() begins traversal from q₀ and returns a RunningMachineSet.
// node$ emits { node, data } on each transition,
// edge$ emits { edge, from, to } on each edge firing.
const auth = authMachineSet.start('loggedOut')

// node$ emits { node, data } whenever the machine transitions.
auth.node$.subscribe(state => console.log(`[${state.node}]`, state.data))

// edge$ emits { edge, from, to } on each edge firing.
auth.edge$.subscribe(event =>
  console.log(`${event.edge}: ${event.from} -> ${event.to}`)
)
```

### Machine sets with multiple machines

Basket's edges reference Payment's nodes (via `refs.payment.nodes.processing`) but not Auth's. So `.close()` merges Payment's incidence graph into the supergraph G' and validates Auth as an independent machine. At `.start()` time, Auth must already be running:

```typescript
const auth = Auth.close().start('loggedOut')

// Basket:
//   - Payment's nodes are referenced by edges, so its incidence graph
//     is merged into the supergraph G'
//   - Auth's nodes are not referenced by any edge, so Auth is
//     validated independently by .close()
//
// .close():
//   - merges Basket and Payment into the supergraph G'
//   - validates Auth independently
//
// .start(entry, runningMachines, initialNodeData):
//   - entry: the starting node in G'
//   - runningMachines: running instances of independently validated machines,
//     passed to transition $ factories for observation
//   - initialNodeData: optional partial state for any node in G'
const basket = Basket.close().start('empty', { auth }, { items: ['item-0'] })
```

### Root streams

`node$` and `edge$` fire for all nodes and edges in the root supergraph (Basket + Payment merged). `node$` completes when the machine reaches a terminal node (no outgoing edges). Here that's `payment.approved` or `payment.declined`.

```typescript
// node$ fires for all nodes in G' (basket + payment merged).
// Completes when a terminal node is reached (no outgoing edges) -
// here that's payment.approved or payment.declined.
basket.node$.subscribe({
  next: (state) => console.log(`[${state.node}]`, state.data),
  complete: () => console.log('basket complete'),
})

// edge$ fires for all edges in G'.
basket.edge$.subscribe(event =>
  console.log(`${event.edge}: ${event.from} -> ${event.to}`)
)
```

### Per-machine access

Each incidence machine whose graph was merged into G' has its own `RunningMachine` view, filtered from the supergraph's streams by namespace prefix:

```typescript
// Each incidence machine whose graph was merged into G' has its own
// RunningMachine, filtered from the supergraph's streams by namespace prefix.
basket.runningMachines['payment'].node$.subscribe(state =>
  console.log(`[payment:${state.node}]`, state.data)
)
```

### How traversal works

On entry to a node, the runtime subscribes to the `$` observables of all outgoing transitions, passing the running machines. When an observable emits, it runs the pure handler, transitions to the target node, and unsubscribes from the old transitions.

No interpreter, no event matching, no message bus, just observable subscriptions and pure function calls.

---

## License

MIT
