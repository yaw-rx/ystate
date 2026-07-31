/**
 * The studio's standard-library components. Importing this module for its
 * side effects runs each `@Component` decorator, which calls
 * `customElements.define` - so every tag here is globally registered before
 * any form is compiled, and a generated form template can reference
 * `<rx-slider>`/`<rx-graph>` with no import of its own.
 *
 * The list of tags a form is allowed to use is exactly this file: adding a
 * standard component is adding one import here.
 */
import './rx-slider.component.js'
import './rx-graph.component.js'

export const STD_COMPONENT_TAGS = ['rx-slider', 'rx-graph'] as const
