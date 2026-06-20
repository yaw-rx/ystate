import { Observable } from 'rxjs';

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
> { __brand: 'contextNodeRef'; node: TNode }

/**
 * From a context mapping (symbol -> machine definition), produces a proxy
 * that exposes the foreign machines' nodes as branded `ContextNodeRef`s.
 *
 * @template T - Mapping of context keys to machine definitions.
 */
export type ContextProxy<T> = {
  [K in keyof T]: T[K] extends { nodes: infer N }
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
        nodes: new Proxy({}, { get(_, node) { return { __brand: 'contextNodeRef', node } } }),
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

// --- Edge + transition inference ---

/**
 * Extracts the union of transition names referenced in a set of edges.
 *
 * @template TEdges - The edges record.
 */
export type TransitionNames<TEdges> = {
  [K in keyof TEdges]: TEdges[K] extends { on: infer U extends string } ? U : never
}[keyof TEdges]

/**
 * Collects all target nodes for a given transition and handler direction.
 *
 * @template TEdges - The edges record.
 * @template TOn - The transition name.
 * @template THandler - The handler direction (`'next'` or `'error'`).
 */
export type CollectTargets<TEdges, TOn extends string, THandler extends string> = {
  [K in keyof TEdges]: TEdges[K] extends { on: TOn; handler: THandler; to: infer To } ? To : never
}[keyof TEdges]

/**
 * Collects all source nodes for a given transition and handler direction.
 *
 * @template TEdges - The edges record.
 * @template TOn - The transition name.
 * @template THandler - The handler direction (`'next'` or `'error'`).
 */
export type CollectSources<TEdges, TOn extends string, THandler extends string> = {
  [K in keyof TEdges]: TEdges[K] extends { on: TOn; handler: THandler; from: infer From } ? From : never
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
 * @template TContext - The context record (if any).
 * @template TEdges - The edges record.
 * @template TOn - The transition name.
 * @template TResult - The emission type of the `$` observable.
 */
export type TransitionShape<TNodes extends Record<string, NodeData>, TContext, TEdges, TOn extends string, TResult> = {
  /** Observable factory that triggers the transition. Receives the machine's context. */
  $: (ctx: TContext) => Observable<TResult>
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
 * @template TContext - The context record (if any).
 * @template TEdges - The edges record.
 * @template TOn - The transition name.
 */
export type TransitionBuilder<TNodes extends Record<string, NodeData>, TContext, TEdges, TOn extends string> =
  <TResult>(def: TransitionShape<TNodes, TContext, TEdges, TOn, TResult>) => TransitionShape<TNodes, TContext, TEdges, TOn, TResult>

/**
 * A mapping of transition names to their respective `TransitionBuilder` functions.
 *
 * @template TNodes - The machine's node map.
 * @template TContext - The context record (if any).
 * @template TEdges - The edges record.
 */
export type TransitionBuilders<TNodes extends Record<string, NodeData>, TContext, TEdges> = {
  [TrName in TransitionNames<TEdges>]: TransitionBuilder<TNodes, TContext, TEdges, TrName>
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
 * First step of machine definition: declares the topology (nodes + edges)
 * and optionally a context for cross-machine references.
 *
 * Returns an object with `implement()` to supply the transition logic.
 *
 * @param def - The machine definition object.
 * @param def.nodes - Named nodes with their initial/expected data shapes.
 * @param def.context - (Optional) Mapping of context keys to other machine definitions.
 * @param def.edges - A function that receives a `refs` proxy and returns the edge declarations.
 * @returns An object with an `implement()` method.
 */
export function defineMachine<
  TNodes extends Record<string, NodeData>,
  TContext extends Record<string, any>,
  const TEdges extends Record<string, {
    from: Extract<keyof TNodes, string>
    to: Extract<keyof TNodes, string> | ContextNodeRef
    on: string
    handler: 'next' | 'error'
  }>,
>(def: {
  nodes: TNodes
  context?: TContext
  edges: (refs: ContextProxy<TContext>) => TEdges
}) {
  const contextRefs = def.context ? defineContext(def.context as any) : ({} as ContextProxy<TContext>)
  const edgeDefs = def.edges(contextRefs)

  return {
    /**
     * Second step: provides the transition implementations.
     *
     * @param factory - A callback that receives a `TransitionBuilders` object
     * (one builder per transition name) and returns the transitions record.
     * @returns The complete machine with nodes, transitions, edges, and a `state$` observable.
     */
    implement<TTransitions extends Record<TransitionNames<TEdges>, { $: Function; next: Function; error: Function }>>(
      factory: (t: TransitionBuilders<TNodes, TContext, TEdges>) => TTransitions
    ): {
      nodes: TNodes
      transitions: TTransitions
      edges: { [K in keyof TEdges]: {
        from: TEdges[K] extends { from: infer F } ? F : never
        to: TEdges[K] extends { to: infer T } ? T : never
        on: TEdges[K] extends { on: infer U extends string; handler: infer H extends string }
          ? GetHandler<TTransitions[U & keyof TTransitions], H>
          : never
      } }
      state$: Observable<StateUnion<TNodes>>
    } {
      const builders = new Proxy({} as any, {
        get(_, name) { return (transitionDef: any) => transitionDef }
      })
      const transitions = factory(builders)

      const edges: any = {}
      for (const key of Object.keys(edgeDefs)) {
        const e = edgeDefs[key]
        const t = (transitions as any)[e.on]
        edges[key] = { from: e.from, to: e.to, on: e.handler === 'next' ? t.next : t.error }
      }

      return { nodes: def.nodes, transitions, edges, state$: new Observable() as any }
    }
  }
}