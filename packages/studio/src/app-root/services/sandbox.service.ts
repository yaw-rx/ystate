import type { NodeData, IncidenceGraphSetClosureIssue, IncidenceMachineClosureIssue } from '@yaw-rx/ystate'

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

export type ClosureIssue = IncidenceGraphSetClosureIssue | IncidenceMachineClosureIssue

export type ClosureResult =
    | { success: true }
    | { success: false; issues: ClosureIssue[] }

export interface WorkspaceFile {
    name: string
    content: string
}

// --- Command / Response protocol ---

export type SandboxCommand =
    | { id: number; command: 'evaluate'; files: WorkspaceFile[] }
    | { id: number; command: 'close'; key: string }

export type SandboxResponse =
    | { id: number; command: 'evaluate'; exports: Record<string, SerializedGraphSet>; graphKinds: Record<string, GraphKind>; transitionKeys: Record<string, string[]> }
    | { id: number; command: 'close'; key: string; result: ClosureResult }
    | { id: number; command: 'error'; error: string }

// --- Public result types ---

export type SandboxResult =
    | { ok: true; exports: Record<string, SerializedGraphSet>; graphKinds: Record<string, GraphKind>; transitionKeys: Record<string, string[]>; closureResults: Record<string, ClosureResult> }
    | { ok: false; error: string }

// --- Service ---

export class SandboxService {
    private worker: Worker | null = null
    private nextId = 0
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

    private getWorker(): Worker {
        if (!this.worker) {
            this.worker = new Worker(
                new URL('../workers/sandbox.worker.ts', import.meta.url),
                { type: 'module' },
            )
            this.worker.addEventListener('message', (event: MessageEvent<SandboxResponse>) => {
                const response = event.data
                const entry = this.pending.get(response.id)
                if (!entry) return
                this.pending.delete(response.id)
                if (response.command === 'error') {
                    entry.reject(new Error(response.error))
                } else {
                    entry.resolve(response)
                }
            })
            this.worker.addEventListener('error', (event: ErrorEvent) => {
                for (const [, { reject }] of this.pending) {
                    reject(new Error(event.message))
                }
                this.pending.clear()
            })
        }
        return this.worker
    }

    private send<T extends SandboxResponse>(command: Record<string, unknown>): Promise<T> {
        const id = this.nextId++
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject })
            this.getWorker().postMessage({ id, ...command })
        })
    }

    async evaluate(files: WorkspaceFile[]): Promise<SandboxResult> {
        try {
            const response = await this.send<Extract<SandboxResponse, { command: 'evaluate' }>>({ command: 'evaluate', files })
            const closureResults: Record<string, ClosureResult> = {}
            await Promise.all(
                Object.keys(response.exports).map(async key => {
                    closureResults[key] = await this.close(key)
                }),
            )
            return { ok: true, exports: response.exports, graphKinds: response.graphKinds, transitionKeys: response.transitionKeys, closureResults }
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
    }

    private async close(key: string): Promise<ClosureResult> {
        const response = await this.send<Extract<SandboxResponse, { command: 'close' }>>({ command: 'close', key })
        return response.result
    }

    dispose(): void {
        this.worker?.terminate()
        this.worker = null
        this.pending.clear()
    }
}
