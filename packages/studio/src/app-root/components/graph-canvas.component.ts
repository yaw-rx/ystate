import { Component, RxElement, state } from '@yaw-rx/core'
import type { LayoutResult, PositionedNode, PositionedEdge, PositionedGroup } from '../services/elk-layout.service.js'
import type { ClosureResult, GraphKind } from '../services/sandbox.service.js'
import { combineLatest } from 'rxjs'

const EDGE_NAME_FONT = 10
const EDGE_ON_FONT = 8
const EDGE_LABEL_PAD = 8
const EDGE_LABEL_LINE_HEIGHT = 14
const GROUP_LABEL_FONT = 11

function measureText(svg: SVGSVGElement, text: string, fontSize: number, italic = false): number {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    el.setAttribute('font-family', 'monospace')
    el.setAttribute('font-size', String(fontSize))
    if (italic) el.setAttribute('font-style', 'italic')
    el.textContent = text
    svg.appendChild(el)
    const width = el.getComputedTextLength()
    el.remove()
    return width
}

@Component({
    selector: 'graph-canvas',
    template: `<div #viewport></div>`,
    styles: `
        :host {
            display: block;
            width: 100%;
            height: 100%;
            overflow: auto;
            background: var(--bg-3);
        }
        div {
            min-width: 100%;
            min-height: 100%;
        }
    `,
})
export class GraphCanvas extends RxElement {
    @state layout: LayoutResult | null = null
    @state closureResults: Record<string, ClosureResult> = {}
    @state graphKinds: Record<string, GraphKind> = {}
    @state transitionKeys: Record<string, string[]> = {}
    viewport!: HTMLDivElement
    private svg: SVGSVGElement | null = null

    override onRender(): void {
        combineLatest([this.layout$, this.closureResults$, this.graphKinds$, this.transitionKeys$]).subscribe(
            ([layout, closureResults, graphKinds, transitionKeys]) => this.render(layout, closureResults, graphKinds, transitionKeys),
        )
    }

    private render(
        layout: LayoutResult | null,
        closureResults: Record<string, ClosureResult>,
        graphKinds: Record<string, GraphKind>,
        transitionKeys: Record<string, string[]>,
    ): void {
        if (this.svg) {
            this.svg.remove()
            this.svg = null
        }
        if (!layout || layout.nodes.length === 0) return

        const pad = 60
        const w = layout.width + pad * 2
        const h = layout.height + pad * 2

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.setAttribute('width', String(w))
        svg.setAttribute('height', String(h))
        svg.setAttribute('viewBox', `${-pad} ${-pad} ${w} ${h}`)
        svg.style.display = 'block'

        this.viewport.appendChild(svg)
        this.svg = svg

        this.appendDefs(svg)
        for (const group of layout.groups) this.appendGroup(svg, group, closureResults, graphKinds)
        for (const edge of layout.edges) this.appendEdge(svg, edge, layout, graphKinds, transitionKeys)
        for (const node of layout.nodes) this.appendNode(svg, node)
    }

    private appendDefs(svg: SVGSVGElement): void {
        const defs = this.svgEl('defs')

        const arrow = this.svgEl('marker')
        arrow.setAttribute('id', 'arrow')
        arrow.setAttribute('viewBox', '0 0 10 10')
        arrow.setAttribute('refX', '10')
        arrow.setAttribute('refY', '5')
        arrow.setAttribute('markerWidth', '8')
        arrow.setAttribute('markerHeight', '8')
        arrow.setAttribute('orient', 'auto-start-reverse')
        const arrowPath = this.svgEl('path')
        arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 Z')
        arrowPath.setAttribute('fill', '#9a9a9a')
        arrow.appendChild(arrowPath)

        const crossArrow = this.svgEl('marker')
        crossArrow.setAttribute('id', 'arrow-cross')
        crossArrow.setAttribute('viewBox', '0 0 10 10')
        crossArrow.setAttribute('refX', '10')
        crossArrow.setAttribute('refY', '5')
        crossArrow.setAttribute('markerWidth', '8')
        crossArrow.setAttribute('markerHeight', '8')
        crossArrow.setAttribute('orient', 'auto-start-reverse')
        const crossPath = this.svgEl('path')
        crossPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 Z')
        crossPath.setAttribute('fill', '#8af')
        crossArrow.appendChild(crossPath)

        defs.appendChild(arrow)
        defs.appendChild(crossArrow)
        svg.appendChild(defs)
    }

    private appendGroup(
        svg: SVGSVGElement,
        group: PositionedGroup,
        closureResults: Record<string, ClosureResult>,
        graphKinds: Record<string, GraphKind>,
    ): void {
        const g = this.svgEl('g')

        const result = closureResults[group.graphKey]
        const borderColor = result
            ? (result.success ? '#4a4' : '#a44')
            : '#333'

        const kind = graphKinds[group.graphKey]

        const rect = this.svgEl('rect')
        this.setAttrs(rect, {
            x: group.x, y: group.y,
            width: group.width, height: group.height,
            rx: 6, fill: 'none',
            stroke: borderColor, 'stroke-width': 1.5,
        })
        if (kind !== 'machine') rect.setAttribute('stroke-dasharray', '4 3')
        g.appendChild(rect)
        const prefix = kind === 'machine' ? 'M' : 'G'
        const labelText = `${prefix} ${group.label}`

        const text = this.svgEl('text')
        this.setAttrs(text, {
            x: group.x + 12, y: group.y + 18,
            fill: '#808080', 'font-family': 'monospace', 'font-size': GROUP_LABEL_FONT,
        })
        const boldSpan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan')
        boldSpan.setAttribute('font-weight', 'bold')
        boldSpan.textContent = prefix
        const restSpan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan')
        restSpan.textContent = ` ${group.label}`
        text.appendChild(boldSpan)
        text.appendChild(restSpan)
        g.appendChild(text)

        if (!(kind === 'machine' && result?.success)) {
            const squigglyX = group.x + 12
            const squigglyY = group.y + 21
            const squigglyWidth = measureText(svg, labelText, GROUP_LABEL_FONT)
            const squiggly = this.svgEl('path')
            squiggly.setAttribute('d', this.squigglyPath(squigglyX, squigglyY, squigglyWidth))
            this.setAttrs(squiggly, {
                fill: 'none', stroke: '#c55', 'stroke-width': 1,
            })
            g.appendChild(squiggly)
        }

        svg.appendChild(g)
    }

    private squigglyPath(x: number, y: number, width: number): string {
        const step = 4
        let d = `M ${x} ${y}`
        let up = true
        let drawn = 0
        while (drawn < width) {
            const seg = Math.min(step, width - drawn)
            const dy = up ? -2 : 2
            d += ` q ${seg / 2} ${dy} ${seg} 0`
            up = !up
            drawn += seg
        }
        return d
    }

    private appendNode(svg: SVGSVGElement, node: PositionedNode): void {
        const g = this.svgEl('g')
        g.style.cursor = 'pointer'

        const rect = this.svgEl('rect')
        this.setAttrs(rect, {
            x: node.x, y: node.y,
            width: node.width, height: node.height,
            rx: 4, fill: '#1a1a1a', stroke: '#444', 'stroke-width': 1,
        })
        g.appendChild(rect)

        const text = this.svgEl('text')
        this.setAttrs(text, {
            x: node.x + node.width / 2, y: node.y + node.height / 2 + 4,
            'text-anchor': 'middle',
            fill: '#e5e5e5', 'font-family': 'monospace', 'font-size': 12,
        })
        text.textContent = node.label
        g.appendChild(text)

        svg.appendChild(g)
    }

    private appendEdge(
        svg: SVGSVGElement,
        edge: PositionedEdge,
        layout: LayoutResult,
        graphKinds: Record<string, GraphKind>,
        transitionKeys: Record<string, string[]>,
    ): void {
        const cross = this.isCrossGraph(edge, layout)
        const edgeColor = cross ? '#8af' : '#9a9a9a'
        const kind = graphKinds[edge.graphKey]

        for (const section of edge.sections) {
            const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
            const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')

            const path = this.svgEl('path')
            this.setAttrs(path, {
                d, fill: 'none',
                stroke: edgeColor,
                'stroke-width': 1.5,
                'marker-end': cross ? 'url(#arrow-cross)' : 'url(#arrow)',
            })
            svg.appendChild(path)
        }

        if (edge.edgeName) {
            const g = this.svgEl('g')
            const onText = `(${edge.on})`
            const nameWidth = measureText(svg, edge.edgeName, EDGE_NAME_FONT)
            const onWidth = measureText(svg, onText, EDGE_ON_FONT, true)
            const labelWidth = Math.max(nameWidth, onWidth) + EDGE_LABEL_PAD
            const labelHeight = EDGE_LABEL_LINE_HEIGHT * 2

            const bg = this.svgEl('rect')
            this.setAttrs(bg, {
                x: edge.labelX - labelWidth / 2, y: edge.labelY - EDGE_LABEL_LINE_HEIGHT,
                width: labelWidth, height: labelHeight,
                rx: 3, fill: '#111', opacity: 0.9,
            })
            g.appendChild(bg)

            const nameText = this.svgEl('text')
            this.setAttrs(nameText, {
                x: edge.labelX, y: edge.labelY, 'text-anchor': 'middle',
                fill: cross ? '#8af' : '#c0c0c0',
                'font-family': 'monospace', 'font-size': EDGE_NAME_FONT,
            })
            nameText.textContent = edge.edgeName
            g.appendChild(nameText)

            const onLabel = this.svgEl('text')
            this.setAttrs(onLabel, {
                x: edge.labelX, y: edge.labelY + EDGE_LABEL_LINE_HEIGHT - 2, 'text-anchor': 'middle',
                fill: cross ? '#6af' : '#888',
                'font-family': 'monospace', 'font-size': EDGE_ON_FONT,
                'font-style': 'italic',
            })
            onLabel.textContent = onText
            g.appendChild(onLabel)

            const transitionName = edge.on.indexOf('.') !== -1 ? edge.on.slice(0, edge.on.indexOf('.')) : edge.on
            const keys = transitionKeys[edge.graphKey]
            const missing = kind === 'graph-set' || (keys && !keys.includes(transitionName))
            if (missing) {
                const innerWidth = measureText(svg, edge.on, EDGE_ON_FONT, true)
                const squigglyX = edge.labelX - innerWidth / 2
                const squigglyY = edge.labelY + EDGE_LABEL_LINE_HEIGHT + 1
                const squiggly = this.svgEl('path')
                squiggly.setAttribute('d', this.squigglyPath(squigglyX, squigglyY, innerWidth))
                this.setAttrs(squiggly, { fill: 'none', stroke: '#c55', 'stroke-width': 1 })
                g.appendChild(squiggly)
            }

            svg.appendChild(g)
        }
    }

    private isCrossGraph(edge: PositionedEdge, layout: LayoutResult): boolean {
        const fromGk = layout.nodes.find(n => n.id === edge.from)?.graphKey
        const toGk = layout.nodes.find(n => n.id === edge.to)?.graphKey
        return fromGk !== toGk
    }

    private svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
        return document.createElementNS('http://www.w3.org/2000/svg', tag)
    }

    private setAttrs(el: SVGElement, attrs: Record<string, string | number>): void {
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
    }
}
