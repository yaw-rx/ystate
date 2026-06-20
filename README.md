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
const BasketGraph = defineMachine({
  nodes: {
    empty:      {},
    addingItem: { itemId: '' },
    hasItems:   { items: [] as string[] },
  },
  context: {
    auth: AuthGraph,
    payment: PaymentGraph,
  },
  edges: (refs) => ({
    addFromEmpty:    { from: 'empty',      to: 'addingItem', on: 'addItem',   handler: 'next' },
    addFromHasItems: { from: 'hasItems',   to: 'addingItem', on: 'addItem',   handler: 'next' },
    added:           { from: 'addingItem', to: 'hasItems',   on: 'itemAdded', handler: 'next' },
    checkout:        { from: 'hasItems',   to: refs.payment.nodes.processing, on: 'checkout', handler: 'next' },
  }),
}).implement(on => ({
  addItem: on.addItem({
    $: () => timer(500),
    next: (result, destNode, sourceNode) => ({ itemId: String(result) }), // addingItem
    error: (error, destNode, sourceNode) => ({}), // empty | hasItems
  }),
  itemAdded: on.itemAdded({
    $: () => timer(1000),
    next: (result, destNode) => { // hasItems
      const existing = destNode?.items ?? []
      return { items: [...existing, `item-${existing.length + 1}`] }
    },
    error: (error, destNode, sourceNode) => ({ itemId: '' }), // addingItem
  }),
  checkout: on.checkout({
    $: (ctx) => timer(500).pipe(
      withLatestFrom(ctx.auth.state$),
      filter(([_, auth]) => auth.node === 'authenticated'),
    ),
    next: (result, destNode, sourceNode) => ({ orderId: 'ORD-001' }), // PaymentGraph.processing
    error: (error, destNode, sourceNode) => ({ items: [] as string[] }), // hasItems
  }),
}))
```

The compiler enforces:

- Every `from` and `to` is a real node, including cross-machine references.
- Each handler's `result` type flows from the `$` observable. `dest` and `source` types are derived from the edges.
- The handler must return exactly the target node's data shape.
- No annotations needed. No codegen, no build step. Just TypeScript.

---

## How YState compares to XState

| Concern               | XState                                     | YState                                            |
|-----------------------|--------------------------------------------|---------------------------------------------------|
| **State + data**      | Named state + mutable `context` bag        | Node name + typed data as one atomic unit         |
| **Transitions**       | String event -> dispatch to interpreter     | Observable subscription -> pure handler            |
| **Side effects**      | `actions` inside the machine               | External subscribers to edge observables          |
| **Composition**       | Actor model, `spawn`, string-based messages | Direct node references + observable wiring        |
| **Type safety**       | Build-time typegen step                    | Compile-time only, no codegen                     |
| **Call stack**        | Broken by interpreter, hard to debug       | Standard RxJS stack traces, debuggable            |
| **Boilerplate**       | Promise wrapper states (`pending`, ...)    | Async is just an observable; no extra states needed |

YState is a pure finite state machine: a graph of typed nodes and observable-driven edges, with side-effect-free transition functions and no hidden mutable state.

---

## Core concepts

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

- `$` - an Observable factory (the input alphabet). The runtime passes the machine's context, so transitions that depend on other machines receive it as a parameter. It can be a timer, a DOM event, an HTTP call, a stream pipeline, anything reactive.
- `next` - a pure function `(result, dest?, source?) -> targetNodeData`. The `result` type is inferred from `$`, and `dest`/`source` types are derived from the edges.
- `error` - a pure function `(error, dest?, source?) -> targetNodeData` for the failure path.

Transitions themselves contain **no side effects**. Side effects happen when *you* subscribe to the edge observables, outside the machine.

```typescript
.implement(on => ({
  process: on.process({
    $: () => timer(3000),
    next: (result, destNode, sourceNode) => ({ confirmedAt: Date.now() }),
    error: (result, destNode, sourceNode) => ({ reason: String(result) }),
  }),
}))
```

### Edges

An edge connects a source node to a target node and says **which transition** powers the move (via `on`) and **which branch** (`'next'` or `'error'`).  
The type system uses the edge's `from`/`to` and the referenced transition to verify that the handler returns exactly the correct shape.

Edges are defined as a function that receives typed context refs, so cross-machine node references are checked at compile time.

```typescript
edges: (refs) => ({
  approve: { from: 'processing', to: 'approved',  on: 'process', handler: 'next' },
  decline: { from: 'processing', to: 'declined',  on: 'process', handler: 'error' },
}),
```

### Composition (cross-machine references)

Graphs can reference nodes in other machines directly. Pass other machines via `context`, and the `refs` parameter in the `edges` callback gives you typed access to their nodes.

```typescript
const BasketGraph = defineMachine({
  nodes: { ... },
  context: {
    auth:    AuthGraph,
    payment: PaymentGraph,
  },
  edges: (refs) => ({
    checkout: { from: 'hasItems', to: refs.payment.nodes.processing, on: 'checkout', handler: 'next' },
  }),
}).implement(on => ({
  checkout: on.checkout({
    $: (ctx) => timer(500).pipe(
      withLatestFrom(ctx.auth.state$),
      filter(([_, auth]) => auth.node === 'authenticated'),
    ),
    next: (result, destNode, sourceNode) => ({ orderId: 'ORD-001' }), // PaymentGraph.processing
    error: (error, destNode, sourceNode) => ({ items: [] as string[] }), // hasItems
  }),
}))
```

The compiler checks that `processing` really exists in `PaymentGraph`, and that the handler's return type matches its data shape.

---

## Getting started

```
npm install @yaw-rx/ystate rxjs
```

1. Define your **nodes**, each with a typed data shape.
2. Optionally pass other machines via **context**.
3. Define your **edges** as a function, `(refs) => ({...})` with `from`, `to`, `on`, and `handler`. This is the graph topology.
4. Chain `.implement(on => ({...}))` to implement each transition. `on` provides full contextual typing derived from the graph.

*A thin runtime API is on the way; the type system already guarantees correctness.*

---

## Runtime (planned)

The runtime will be tiny:

- `start(machine, entryNode)` creates an instance.
- On entry to a node, it subscribes to the `$` observables of all outgoing edges, passing the machine's context.
- When an observable emits, it runs the pure `on` handler, transitions to the target node, and unsubscribes from the old edges.
- `machine.state$` exposes an observable of `{ node, data }`.

No interpreter, no event matching, no message bus, just observable subscriptions and pure function calls.

---

## License

MIT
