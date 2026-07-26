import * as monaco from 'monaco-editor'

/**
 * The single URI convention for addressing a workspace file's Monaco model.
 * Anything that needs to look up an existing model (or create one) must go
 * through this so the two can never drift apart.
 */
export function toModelUri(workspaceName: string, fileName: string): monaco.Uri {
    return monaco.Uri.parse(`file:///${workspaceName}/${fileName}`)
}
