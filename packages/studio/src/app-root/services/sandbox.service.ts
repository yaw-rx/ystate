import type { NodeData } from '@yaw-rx/ystate'

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

export interface SandboxResult {
    exports: Record<string, SerializedGraphSet>
}

interface SandboxError {
    error: string
}

type SandboxResponse =
    | { kind: 'result'; data: SandboxResult }
    | { kind: 'error'; data: SandboxError }

export interface WorkspaceFile {
    name: string
    content: string
}

export class SandboxService {
    private worker: Worker | null = null

    private getWorker(): Worker {
        if (!this.worker) {
            this.worker = new Worker(
                new URL('../workers/sandbox.worker.ts', import.meta.url),
                { type: 'module' },
            )
        }
        return this.worker
    }

    evaluate(files: WorkspaceFile[]): Promise<SandboxResult> {
        return new Promise((resolve, reject) => {
            const worker = this.getWorker()
            const handler = (event: MessageEvent<SandboxResponse>) => {
                worker.removeEventListener('message', handler)
                worker.removeEventListener('error', errorHandler)
                if (event.data.kind === 'result') {
                    resolve(event.data.data)
                } else {
                    reject(new Error(event.data.data.error))
                }
            }
            const errorHandler = (event: ErrorEvent) => {
                worker.removeEventListener('message', handler)
                worker.removeEventListener('error', errorHandler)
                reject(new Error(event.message))
            }
            worker.addEventListener('message', handler)
            worker.addEventListener('error', errorHandler)
            worker.postMessage({ files })
        })
    }

    dispose(): void {
        this.worker?.terminate()
        this.worker = null
    }
}
