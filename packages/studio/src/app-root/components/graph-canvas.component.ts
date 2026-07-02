import { Component, RxElement, state } from '@yaw-rx/core'
import type { LayoutResult, PositionedNode, PositionedEdge, PositionedGroup } from '../services/elk-layout.service.js'

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

    viewport!: HTMLDivElement
    private svg: SVGSVGElement | null = null

    override onRender(): void {
        this.layout$.subscribe(l => this.render(l))
    }

    private render(layout: LayoutResult | null): void {
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

        this.appendDefs(svg)
        for (const group of layout.groups) this.appendGroup(svg, group)
        for (const edge of layout.edges) this.appendEdge(svg, edge, layout)
        for (const node of layout.nodes) this.appendNode(svg, node)

        this.viewport.appendChild(svg)
        this.svg = svg
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

    private appendGroup(svg: SVGSVGElement, group: PositionedGroup): void {
        const g = this.svgEl('g')

        const rect = this.svgEl('rect')
        this.setAttrs(rect, {
            x: group.x, y: group.y,
            width: group.width, height: group.height,
            rx: 6, fill: 'none',
            stroke: '#333', 'stroke-width': 1, 'stroke-dasharray': '4 3',
        })
        g.appendChild(rect)

        const text = this.svgEl('text')
        this.setAttrs(text, {
            x: group.x + 12, y: group.y + 18,
            fill: '#808080', 'font-family': 'monospace', 'font-size': 11,
        })
        text.textContent = group.label
        g.appendChild(text)

        svg.appendChild(g)
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

    private appendEdge(svg: SVGSVGElement, edge: PositionedEdge, layout: LayoutResult): void {
        const cross = this.isCrossGraph(edge, layout)
        const edgeColor = cross ? '#8af' : '#9a9a9a'

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
            const charWidth = 6.5
            const onText = `(${edge.on})`
            const widest = Math.max(edge.edgeName.length, onText.length)
            const labelWidth = widest * charWidth + 8

            const bg = this.svgEl('rect')
            this.setAttrs(bg, {
                x: edge.labelX - labelWidth / 2, y: edge.labelY - 12,
                width: labelWidth, height: 28,
                rx: 3, fill: '#111', opacity: 0.9,
            })
            g.appendChild(bg)

            const nameText = this.svgEl('text')
            this.setAttrs(nameText, {
                x: edge.labelX, y: edge.labelY, 'text-anchor': 'middle',
                fill: cross ? '#8af' : '#c0c0c0',
                'font-family': 'monospace', 'font-size': 10,
            })
            nameText.textContent = edge.edgeName
            g.appendChild(nameText)

            const onLabel = this.svgEl('text')
            this.setAttrs(onLabel, {
                x: edge.labelX, y: edge.labelY + 12, 'text-anchor': 'middle',
                fill: cross ? '#6af' : '#888',
                'font-family': 'monospace', 'font-size': 8,
                'font-style': 'italic',
            })
            onLabel.textContent = onText
            g.appendChild(onLabel)

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
