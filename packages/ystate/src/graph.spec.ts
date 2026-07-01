import { defineDeps, namespaceFunctor, unionGraphs, resolveRefs, validateClosure, classifyDeps, isGraphMissingDep, isGraphMissingTarget, isGraphMissingSource, isMultipleGraphs } from './graph.js';
import type { IncidenceGraph, NodeData, EdgeDef } from './graph.js';

describe('defineDeps', () => {
  it('produces branded DepNodeRef proxies for each dep node', () => {
    const refs = defineDeps({
      auth: { nodes: { loggedIn: {}, loggedOut: {} }, edges: {}, deps: {}, transitions: {}, source: {} as any },
    });
    expect(refs.auth.nodes.loggedIn).toEqual({ __brand: 'depNodeRef', dep: 'auth', node: 'loggedIn' });
    expect(refs.auth.nodes.loggedOut).toEqual({ __brand: 'depNodeRef', dep: 'auth', node: 'loggedOut' });
  });
});

describe('classifyDeps', () => {
  const makeDep = () => ({ nodes: { a: {} }, edges: {}, deps: {}, transitions: {}, source: {} as any });

  it('classifies deps referenced by DepNodeRef as unioned', () => {
    const edges = {
      e1: { from: 'x', to: { __brand: 'depNodeRef' as const, dep: 'payment', node: 'processing' }, on: 't.next' as const },
    };
    const result = classifyDeps(edges, { payment: makeDep(), auth: makeDep() });
    expect(result.unioned).toEqual(['payment']);
    expect(result.disjoint).toEqual(['auth']);
  });

  it('classifies all deps as disjoint when no DepNodeRef targets exist', () => {
    const edges = {
      e1: { from: 'x', to: 'y', on: 't.next' as const },
    };
    const result = classifyDeps(edges, { auth: makeDep() });
    expect(result.unioned).toEqual([]);
    expect(result.disjoint).toEqual(['auth']);
  });
});

describe('namespaceFunctor', () => {
  it('prefixes all nodes and edges with the namespace', () => {
    const graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {}, b: {} },
      edges: { e1: { from: 'a', to: 'b', on: 't.next' } },
    };
    const result = namespaceFunctor(graph, 'ns');
    expect(Object.keys(result.nodes)).toEqual(['ns.a', 'ns.b']);
    expect(result.edges['ns.e1']).toEqual({ from: 'ns.a', to: 'ns.b', on: 't.next' });
  });

  it('leaves DepNodeRef targets unresolved', () => {
    const ref = { __brand: 'depNodeRef' as const, dep: 'other', node: 'x' };
    const graph = {
      nodes: { a: {} },
      edges: { e1: { from: 'a', to: ref, on: 't.next' as const } },
    };
    const result = namespaceFunctor(graph, 'ns');
    expect(result.edges['ns.e1'].to).toEqual(ref);
  });
});

describe('unionGraphs', () => {
  it('merges node and edge sets', () => {
    const g1: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {} },
      edges: { e1: { from: 'a', to: 'a', on: 't.next' } },
    };
    const g2: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { b: {} },
      edges: { e2: { from: 'b', to: 'b', on: 't.next' } },
    };
    const result = unionGraphs(g1, g2);
    expect(Object.keys(result.nodes).sort()).toEqual(['a', 'b']);
    expect(Object.keys(result.edges).sort()).toEqual(['e1', 'e2']);
  });
});

describe('resolveRefs', () => {
  it('replaces DepNodeRef targets with namespaced names', () => {
    const ref = { __brand: 'depNodeRef' as const, dep: 'pay', node: 'done' };
    const graph = {
      nodes: { a: {} },
      edges: { e1: { from: 'a' as const, to: ref, on: 't.next' as const } },
    };
    const { graph: resolved, issues } = resolveRefs(graph, { pay: 'payment' });
    expect(issues).toHaveLength(0);
    expect(resolved.edges['e1'].to).toBe('payment.done');
  });

  it('returns missing-dep issue for unknown dep reference', () => {
    const ref = { __brand: 'depNodeRef' as const, dep: 'unknown', node: 'x' };
    const graph = {
      nodes: { a: {} },
      edges: { e1: { from: 'a' as const, to: ref, on: 't.next' as const } },
    };
    const { issues } = resolveRefs(graph, {});
    expect(issues).toHaveLength(1);
    const dep = issues.filter(isGraphMissingDep);
    expect(dep).toHaveLength(1);
    expect(dep[0].edge).toBe('e1');
    expect(dep[0].dep).toBe('unknown');
    expect(dep[0].availableDeps).toEqual([]);
  });
});

describe('validateClosure', () => {
  it('returns no issues for a valid connected graph', () => {
    const graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {}, b: {}, c: {} },
      edges: {
        e1: { from: 'a', to: 'b', on: 't.next' },
        e2: { from: 'b', to: 'c', on: 't.next' },
      },
    };
    expect(validateClosure(graph)).toHaveLength(0);
  });

  it('returns no issues for a single node with no edges', () => {
    const graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {} },
      edges: {},
    };
    expect(validateClosure(graph)).toHaveLength(0);
  });

  it('returns missing-source when an edge references an unknown source node', () => {
    const graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {} },
      edges: { e1: { from: 'missing', to: 'a', on: 't.next' } },
    };
    const issues = validateClosure(graph);
    expect(issues).toHaveLength(1);
    const sources = issues.filter(isGraphMissingSource);
    expect(sources).toHaveLength(1);
    expect(sources[0].edge).toBe('e1');
    expect(sources[0].node).toBe('missing');
    expect(sources[0].availableNodes).toEqual(['a']);
  });

  it('returns missing-target when an edge references an unknown target node', () => {
    const graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {} },
      edges: { e1: { from: 'a', to: 'missing', on: 't.next' } },
    };
    const issues = validateClosure(graph);
    expect(issues).toHaveLength(1);
    const targets = issues.filter(isGraphMissingTarget);
    expect(targets).toHaveLength(1);
    expect(targets[0].edge).toBe('e1');
    expect(targets[0].node).toBe('missing');
    expect(targets[0].availableNodes).toEqual(['a']);
  });

  it('returns multiple-graphs when the graph is disconnected', () => {
    const graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {}, b: {}, c: {}, d: {} },
      edges: {
        e1: { from: 'a', to: 'b', on: 't.next' },
        e2: { from: 'c', to: 'd', on: 't.next' },
      },
    };
    const issues = validateClosure(graph);
    const mg = issues.filter(isMultipleGraphs);
    expect(mg).toHaveLength(1);
    expect(mg[0].graphs).toHaveLength(2);
  });

  it('reports each disjoint graph in the multiple-graphs issue', () => {
    const graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {}, b: {}, c: {}, d: {} },
      edges: {
        e1: { from: 'a', to: 'b', on: 't.next' },
        e2: { from: 'c', to: 'd', on: 't.next' },
      },
    };
    const issues = validateClosure(graph);
    const mg = issues.filter(isMultipleGraphs);
    expect(mg).toHaveLength(1);
    expect(mg[0].graphs).toHaveLength(2);
    const nodeSets = mg[0].graphs.map(g => Object.keys(g.nodes).sort());
    expect(nodeSets).toContainEqual(['a', 'b']);
    expect(nodeSets).toContainEqual(['c', 'd']);
  });

  it('detects three disjoint graphs', () => {
    const graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {}, b: {}, c: {} },
      edges: {},
    };
    const issues = validateClosure(graph);
    const mg = issues.filter(isMultipleGraphs);
    expect(mg).toHaveLength(1);
    expect(mg[0].graphs).toHaveLength(3);
  });

  it('treats edges as undirected for connectivity', () => {
    const graph: IncidenceGraph<Record<string, NodeData>, Record<string, EdgeDef>> = {
      nodes: { a: {}, b: {}, c: {} },
      edges: {
        e1: { from: 'a', to: 'b', on: 't.next' },
        e2: { from: 'c', to: 'b', on: 't.next' },
      },
    };
    expect(validateClosure(graph)).toHaveLength(0);
  });
});
