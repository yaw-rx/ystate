import * as monaco from 'monaco-editor'

/**
 * The single URI convention for addressing a workspace file's Monaco model.
 * Anything that needs to look up an existing model (or create one) must go
 * through this so the two can never drift apart.
 */
export function toModelUri(workspaceName: string, fileName: string): monaco.Uri {
    return monaco.Uri.parse(`file:///${workspaceName}/${fileName}`)
}

/**
 * A form's template/styles section models, addressed as siblings of the
 * script model. The extensions give Monaco the right language services
 * (html/css) without any explicit language wiring at creation sites.
 */
export function toSectionUri(workspaceName: string, fileName: string, section: 'template' | 'styles'): monaco.Uri {
    const ext = section === 'template' ? 'html' : 'css'
    return monaco.Uri.parse(`file:///${workspaceName}/${fileName}.${section}.${ext}`)
}
