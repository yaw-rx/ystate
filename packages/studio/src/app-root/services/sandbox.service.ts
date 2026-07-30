import { Injectable } from '@yaw-rx/core'
import type { NodeData, IncidenceGraphSetClosureIssue, IncidenceMachineClosureIssue, MachineSetValidationIssue } from '@yaw-rx/ystate'
import type { QualifiedName } from '../types/runtime-filesystem.types.js'
import { createSandboxWorkerMachine } from '../machines/sandbox-worker.machine.js'
import { logMachineFailures } from '../utils/log-machine-failures.js'
export type { MachineSetValidationIssue } from '@yaw-rx/ystate'

// --- Shared types ---

export interface SerializedEdge {
    from: string
    to: string | { __brand: 'depNodeRef'; dep: string; node: string }
    on: string
}

export interface SerializedGraphSet {
    nodes: Record<string, NodeData>
    edges: Record<string, SerializedEdge>
    deps: Record<string, SerializedGraphSet>
}

export type GraphKind = 'graph-set' | 'machine'

// Every export the sandbox evaluates gets classified as one of these at runtime,
// via guards on the live value. Only 'graph-set'/'machine' carry serialized graph
// data and participate in closure. Static type info (signatures, generic args) is
// a separate, compile-time concern - see TypeAnalysisService.
export type RuntimeKind = GraphKind | 'observable' | 'function' | 'plain-value'

export type ClosureIssue = IncidenceGraphSetClosureIssue | IncidenceMachineClosureIssue

export type ClosureResult =
    | { success: true; warnings: MachineSetValidationIssue[] }
    | { success: false; issues: ClosureIssue[] }

export interface WorkspaceFile {
    name: QualifiedName
    content: string
}

// --- Command / Response protocol ---

export type SandboxCommand =
    | { id: number; command: 'evaluate'; files: WorkspaceFile[] }
    | { id: number; command: 'close'; key: string }

export type SandboxResponse =
    | { id: number; command: 'evaluate'; runtimeKinds: Record<string, RuntimeKind>; graphs: Record<string, SerializedGraphSet>; graphKinds: Record<string, GraphKind>; transitionKeys: Record<string, string[]> }
    | { id: number; command: 'close'; key: string; result: ClosureResult }
    | { id: number; command: 'error'; error: string }

// --- Public result types ---

export type SandboxResult =
    | { ok: true; runtimeKinds: Record<string, RuntimeKind>; graphs: Record<string, SerializedGraphSet>; graphKinds: Record<string, GraphKind>; transitionKeys: Record<string, string[]>; closureResults: Record<string, ClosureResult> }
    | { ok: false; error: string }

// --- Service ---

@Injectable()
export class SandboxService {
    private readonly worker = createSandboxWorkerMachine()
    private readonly failureLog = logMachineFailures('sandbox-worker', this.worker.runningMachine.state$, 'crashed')

    /**
     * Turns one worker round-trip (`evaluate`) plus N more (`close`, one
     * per graph/machine export found) into a single `SandboxResult` - this
     * composition is a domain-level concern, not a transport one, so it
     * stays here rather than inside the worker machine.
     */
    async evaluate(files: WorkspaceFile[]): Promise<SandboxResult> {
        try {
            const response = await this.worker.send<Extract<SandboxResponse, { command: 'evaluate' }>>({ command: 'evaluate', files })
            const closureResults: Record<string, ClosureResult> = {}
            await Promise.all(
                Object.keys(response.graphs).map(async key => {
                    closureResults[key] = await this.close(key)
                }),
            )
            return { ok: true, runtimeKinds: response.runtimeKinds, graphs: response.graphs, graphKinds: response.graphKinds, transitionKeys: response.transitionKeys, closureResults }
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
    }

    private async close(key: string): Promise<ClosureResult> {
        const response = await this.worker.send<Extract<SandboxResponse, { command: 'close' }>>({ command: 'close', key })
        return response.result
    }

    dispose(): void {
        this.worker.dispose()
    }
}
