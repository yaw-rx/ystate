import type { NodeData, EdgeDef, TransitionDef } from './graph.js';
import type { MachineSet, MachineSetValidationIssue } from './machine.js';

/**
 * Validates a closed MachineSet for handler coverage and unused
 * transitions. Returns non-blocking diagnostic warnings; the
 * MachineSet is already closed [E ⊆ V × V] and all edge-demanded
 * handlers exist.
 *
 * For each namespace ns and each transition δⱼ ∈ δₙₛ:
 *
 * 1. If δⱼ is missing optional handlers, warn `missing-handler`
 *    with the absent handlers listed
 *    [keys(δⱼ) \ {$, next} ⊂ {error, complete}]. Whether the
 *    observable factory [$] errors or completes without emitting
 *    cannot be inferred statically. If $ errors without an
 *    `error` handler, the error propagates as a
 *    `MachineUnhandledError`: all subscriptions are torn down
 *    and the machine stops. If $ completes without emitting and
 *    no `complete` handler exists, a `MachineCompletionError`
 *    is thrown: the machine is stuck on a non-terminal node
 *    with no way to progress.
 * 2. If no edge in E references δⱼ
 *    [∄ e ∈ E where parse(on(e)).name = j], warn
 *    `unused-transition`. Dead code; caught at compile time in
 *    TypeScript but not in plain JavaScript.
 *
 * @template TNodes - The node set [V = { vᵢ }].
 * @template TEdges - The incidence relation [E = { eᵢ }].
 * @template TTransitions - The transition implementations [δ = { δⱼ }].
 * @param machineSet - A closed MachineSet to validate.
 * @returns A list of diagnostic issues (may be empty).
 */
export function validateMachineSet<
  TNodes extends Record<string, NodeData>,
  TEdges extends Record<string, EdgeDef<TNodes>>,
  TTransitions extends Record<string, TransitionDef>
>(
  machineSet: MachineSet<TNodes, TEdges, TTransitions>
): MachineSetValidationIssue[] {
  const issues: MachineSetValidationIssue[] = []

  for (const [ns, transitions] of Object.entries(machineSet.correspondence.transitions)) {
    const formattedNamespace = ns === '' ? 'ROOT' : `'${ns}'`
    const machine = machineSet.machines[ns]
    const referencedTransitions = new Set<string>()
    if (machine) {
      for (const edge of Object.values(machine.edges)) {
        const dotIdx = edge.on.indexOf('.')
        if (dotIdx !== -1) {
          referencedTransitions.add(edge.on.slice(0, dotIdx))
        }
      }
    }

    for (const [name, def] of Object.entries(transitions)) {
      const missing: string[] = []
      if (!('error' in def)) missing.push('error')
      if (!('complete' in def)) missing.push('complete')
      if (missing.length > 0) {
        issues.push({ kind: 'missing-handler', transition: name, namespace: ns, formattedNamespace, handlers: missing })
      }
      if (!referencedTransitions.has(name)) {
        issues.push({ kind: 'unused-transition', transition: name, namespace: ns, formattedNamespace })
      }
    }
  }

  return issues
}
