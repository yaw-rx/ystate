import * as monaco from 'monaco-editor'

/**
 * The single URI convention for addressing a workspace file's Monaco model.
 * Anything that needs to look up an existing model (or create one) must go
 * through this so the two can never drift apart.
 *
 * The script model is always addressed as a `.ts` module so Monaco's TS
 * services resolve it - a form's `panel.form` becomes `panel.form.ts`, which
 * is exactly how a sibling form imports it (`./panel.form.js`). A plain `.ts`
 * file already ends in `.ts` and is left untouched.
 */
export function toModelUri(workspaceName: string, fileName: string): monaco.Uri {
    const path = fileName.endsWith('.ts') ? fileName : `${fileName}.ts`
    return monaco.Uri.parse(`file:///${workspaceName}/${path}`)
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
