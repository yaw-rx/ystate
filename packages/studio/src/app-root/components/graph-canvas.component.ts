import { Component, RxElement, state } from '@yaw-rx/core'
import type { LayoutResult, PositionedNode, PositionedEdge, PositionedGroup } from '../services/elk-layout.service.js'
import type { ClosureResult, GraphKind } from '../services/sandbox.service.js'
import { ROOT, type RunningMachineSet } from '@yaw-rx/ystate'
import { combineLatest, tap, take, type Subscription } from 'rxjs'

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
    template: `
        <div #viewport onwheel="onWheel($event)" onpointerdown="onPointerDown($event)" onpointermove="onPointerMove($event)" onpointerup="onPointerUp($event)" onpointercancel="onPointerUp($event)"></div>
        <button class="fullscreen-btn" onclick="toggleFullscreen">⛶</button>
    `,
    styles: `
        :host {
            display: block;
            position: relative;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: var(--bg-3);
        }
        /* The current node stays highlighted (.active). When traversed it
           loses .active and .firing fades it back to its own base over 2s.
           Edges flash + fade the same way. Node stroke width is animated directly,
           while edges use a drop-shadow glow so stroke width and the arrow marker
           are never touched. */
        .node { transition: stroke 0.2s ease, fill 0.2s ease, stroke-width 0.2s ease; }
        .node.active { stroke: #8af; fill: #1c2740; stroke-width: 3px; }
        .node.firing { animation: nodeFire 2s ease-out; }
        .edge.firing { animation: edgeFire 2s ease-out; }
        @keyframes nodeFire {
            from { stroke: #8af; fill: #1c2740; stroke-width: 3px; }
            to { stroke: var(--base-stroke, #444); fill: #1a1a1a; stroke-width: 1px; }
        }
        @keyframes edgeFire {
            from { stroke: #8af; filter: drop-shadow(0 0 3px #8af) drop-shadow(0 0 5px #8af); }
            to { stroke: var(--base-stroke, #9a9a9a); filter: drop-shadow(0 0 0 transparent); }
        }
        div {
            width: 100%;
            height: 100%;
            touch-action: none;
        }
        .fullscreen-btn {
            position: absolute;
            bottom: 8px;
            right: 8px;
            width: 28px;
            height: 28px;
            background: var(--bg-1);
            border: 1px solid var(--border);
            border-radius: 4px;
            color: var(--dim);
            font-size: 16px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: color 0.1s, background 0.1s;
        }
        .fullscreen-btn:hover {
            color: var(--text);
            background: var(--bg-4);
        }
    `,
})
export class GraphCanvas extends RxElement {
    @state layout: LayoutResult | null = null
    @state closureResults: Record<string, ClosureResult> = {}
    @state graphKinds: Record<string, GraphKind> = {}
    @state transitionKeys: Record<string, string[]> = {}
    // Live machines from running forms - drive node highlight / edge flash
    // over the static layout, never rebuilding it (see animate()).
    @state runningMachines: RunningMachineSet[] = []
    @state viewScale = 1
    @state viewTx = 0
    @state viewTy = 0
    viewport!: HTMLDivElement
    private svg: SVGSVGElement | null = null
    private contentGroup: SVGGElement | null = null
    private viewState: 'initial' | 'fitted' | 'user' = 'initial'
    private contentWidth = 0
    private contentHeight = 0
    private pointers = new Map<number, { x: number; y: number }>()
    private lastPinchDist = 0
    private panStart: { x: number; y: number; tx: number; ty: number } | null = null
    private preFullscreenScale = 0
    private preFullscreenTx = 0
    private preFullscreenTy = 0
    private preFullscreenScreenX = 0
    private preFullscreenScreenY = 0
    private subs: Subscription[] = []
    // Captured per render() so animation can address SVG elements by their
    // ELK id (`${graphKey}:${localName}`) without rebuilding the diagram.
    private nodeEls = new Map<string, SVGRectElement>()
    private edgeEls = new Map<string, SVGPathElement[]>()
    private animSubs: Subscription[] = []
    // The currently-active (highlighted) node per ELK graph group.
    private activeNode = new Map<string, string>()

    override onRender(): void {
        this.addEventListener('fullscreenchange', () => this.onFullscreenChange())
        this.subs.push(combineLatest([this.layout$, this.closureResults$, this.graphKinds$, this.transitionKeys$]).pipe(
            tap(([layout, closureResults, graphKinds, transitionKeys]) => this.render(layout, closureResults, graphKinds, transitionKeys)),
        ).subscribe())
        this.subs.push(combineLatest([this.viewScale$, this.viewTx$, this.viewTy$]).pipe(
            tap(([s, tx, ty]) => {
                if (this.contentGroup) this.contentGroup.setAttribute('transform', `translate(${tx},${ty}) scale(${s})`)
            }),
        ).subscribe())
        // Animation is a second pass over the same SVG, re-armed whenever the
        // layout is rebuilt or the running machines change. On stop
        // (runningMachines empties) it clears highlights, reverting to the
        // static closure-coloured diagram without a rebuild.
        this.subs.push(combineLatest([this.runningMachines$, this.layout$]).pipe(
            tap(([machines]) => this.driveAnimation(machines)),
        ).subscribe())
    }

    private driveAnimation(machines: RunningMachineSet[]): void {
        for (const s of this.animSubs) s.unsubscribe()
        this.animSubs = []
        this.clearHighlights()
        this.activeNode.clear()

        for (const machine of machines) {
            const graphKey = this.correlate(machine)
            if (!graphKey) continue
            // Node sequence is driven by EDGE events, not state$: during a
            // synchronous burst (off->on->power in one tick) the runtime
            // emits state$ in reverse as the recursive enter()s unwind, so
            // state$ would skip the middle node. Each edge's `to` is the
            // true next node, in order. state$ is used once, only for the
            // entry node.
            this.animSubs.push(machine.state$.pipe(take(1)).subscribe(s => this.enterNode(graphKey, s.node)))
            this.animSubs.push(machine.event$.subscribe(e => {
                this.fire(this.edgeEls.get(`${graphKey}:${e.edge}`))
                this.enterNode(graphKey, e.to)
            }))
        }
    }

    // The current node stays highlighted (`active`); when the machine moves
    // on, the node just left flashes and fades over 2s (`firing`). A node
    // active for only one tick (a burst) still flashes, because leaving it
    // starts the keyframe regardless of how long `active` was set.
    private enterNode(graphKey: string, node: string): void {
        const prev = this.activeNode.get(graphKey)
        if (prev !== undefined && prev !== node) {
            const prevEl = this.nodeEls.get(`${graphKey}:${prev}`)
            if (prevEl) {
                prevEl.classList.remove('active')
                this.fire(prevEl)
            }
        }
        const el = this.nodeEls.get(`${graphKey}:${node}`)
        if (el) {
            el.classList.remove('firing')
            el.classList.add('active')
        }
        this.activeNode.set(graphKey, node)
    }

    private clearHighlights(): void {
        for (const el of this.nodeEls.values()) el.classList.remove('active', 'firing')
    }

    /** Match a running machine to an ELK group by node-set identity - the same structural trick elk-layout uses to match dep graphs to groups. */
    private correlate(machine: RunningMachineSet): string | undefined {
        const rootNodes = Object.keys(machine.source.graphs[ROOT]?.graph.nodes ?? {}).sort().join(',')
        if (!rootNodes) return undefined

        const groupNodes = new Map<string, string[]>()
        for (const node of this.layout?.nodes ?? []) {
            const local = node.id.slice(node.graphKey.length + 1)
            const list = groupNodes.get(node.graphKey) ?? []
            list.push(local)
            groupNodes.set(node.graphKey, list)
        }
        for (const [graphKey, names] of groupNodes) {
            if (names.sort().join(',') === rootNodes) return graphKey
        }
        return undefined
    }

    /** (Re)start the `firing` decay animation on an element (or an edge's path segments) - remove + reflow + add so a repeat fire replays. */
    private fire(target: SVGElement | SVGElement[] | undefined): void {
        if (!target) return
        for (const el of Array.isArray(target) ? target : [target]) {
            el.classList.remove('firing')
            void el.getBoundingClientRect()
            el.classList.add('firing')
        }
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
            this.contentGroup = null
        }
        this.nodeEls.clear()
        this.edgeEls.clear()
        if (!layout || layout.nodes.length === 0) return

        this.contentWidth = layout.width
        this.contentHeight = layout.height

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.setAttribute('width', '100%')
        svg.setAttribute('height', '100%')
        svg.style.display = 'block'

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
        this.contentGroup = g

        this.viewport.appendChild(svg)
        this.svg = svg

        this.appendDefs(g)
        for (const group of layout.groups) this.appendGroup(g, group, closureResults, graphKinds)
        for (const edge of layout.edges) this.appendEdge(g, edge, layout, graphKinds, transitionKeys, closureResults)
        for (const node of layout.nodes) this.appendNode(g, node, closureResults)

        svg.appendChild(g)
        if (this.viewState === 'initial') {
            this.fitToViewport()
            this.viewState = 'fitted'
        } else if (this.viewState === 'fitted') {
            this.viewTx = (this.viewport.clientWidth - this.contentWidth * this.viewScale) / 2
            this.viewTy = (this.viewport.clientHeight - this.contentHeight * this.viewScale) / 2
            this.contentGroup.setAttribute('transform', `translate(${this.viewTx},${this.viewTy}) scale(${this.viewScale})`)
        } else {
            this.contentGroup.setAttribute('transform', `translate(${this.viewTx},${this.viewTy}) scale(${this.viewScale})`)
        }
    }

    private fitToViewport(): void {
        if (!this.svg || !this.contentGroup) return
        const vw = this.viewport.clientWidth
        const vh = this.viewport.clientHeight
        if (vw === 0 || vh === 0) return
        const margin = 40
        this.viewScale = Math.min((vw - margin * 2) / this.contentWidth, (vh - margin * 2) / this.contentHeight, 1)
        this.viewTx = (vw - this.contentWidth * this.viewScale) / 2
        this.viewTy = (vh - this.contentHeight * this.viewScale) / 2
    }

    onWheel(e: WheelEvent): void {
        e.preventDefault()
        const factor = Math.pow(0.995, e.deltaY)
        this.zoomAt(e.offsetX, e.offsetY, factor)
    }

    onPointerDown(e: PointerEvent): void {
        this.viewport.setPointerCapture(e.pointerId)
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (this.pointers.size === 1) {
            this.panStart = { x: e.clientX, y: e.clientY, tx: this.viewTx, ty: this.viewTy }
        } else if (this.pointers.size === 2) {
            this.panStart = null
            const [a, b] = [...this.pointers.values()]
            this.lastPinchDist = Math.hypot(b.x - a.x, b.y - a.y)
        }
    }

    onPointerMove(e: PointerEvent): void {
        if (!this.pointers.has(e.pointerId)) return
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

        if (this.pointers.size === 1 && this.panStart) {
            this.viewState = 'user'
            this.viewTx = this.panStart.tx + (e.clientX - this.panStart.x)
            this.viewTy = this.panStart.ty + (e.clientY - this.panStart.y)
        } else if (this.pointers.size === 2) {
            const [a, b] = [...this.pointers.values()]
            const dist = Math.hypot(b.x - a.x, b.y - a.y)
            const cx = (a.x + b.x) / 2
            const cy = (a.y + b.y) / 2
            const rect = this.viewport.getBoundingClientRect()
            this.zoomAt(cx - rect.left, cy - rect.top, dist / this.lastPinchDist)
            this.lastPinchDist = dist
        }
    }

    onPointerUp(e: PointerEvent): void {
        this.pointers.delete(e.pointerId)
        if (this.pointers.size === 0) this.panStart = null
    }

    toggleFullscreen(): void {
        if (document.fullscreenElement) {
            document.exitFullscreen()
        } else {
            const rect = this.getBoundingClientRect()
            this.preFullscreenScale = this.viewScale
            this.preFullscreenTx = this.viewTx
            this.preFullscreenTy = this.viewTy
            this.preFullscreenScreenX = window.screenX + rect.left
            this.preFullscreenScreenY = window.screenY + rect.top
            this.requestFullscreen()
        }
    }

    private onFullscreenChange(): void {
        const entering = !!document.fullscreenElement

        if (entering) {
            // component moved on screen - offset so content stays at same screen position
            // after fullscreen the component is at screen (window.screenX, window.screenY)
            const dx = this.preFullscreenScreenX - window.screenX
            const dy = this.preFullscreenScreenY - window.screenY
            this.viewTx = this.viewTx + dx
            this.viewTy = this.viewTy + dy
            // TODO: add scale once center point is confirmed correct
        } else {
            this.viewScale = this.preFullscreenScale
            this.viewTx = this.preFullscreenTx
            this.viewTy = this.preFullscreenTy
        }
    }

    private zoomAt(cx: number, cy: number, factor: number): void {
        this.viewState = 'user'
        const newScale = Math.min(Math.max(this.viewScale * factor, 0.1), 5)
        const ratio = newScale / this.viewScale
        this.viewTx = cx - ratio * (cx - this.viewTx)
        this.viewTy = cy - ratio * (cy - this.viewTy)
        this.viewScale = newScale
    }

    private appendDefs(container: SVGElement): void {
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

        const errorArrow = this.svgEl('marker')
        errorArrow.setAttribute('id', 'arrow-error')
        errorArrow.setAttribute('viewBox', '0 0 10 10')
        errorArrow.setAttribute('refX', '10')
        errorArrow.setAttribute('refY', '5')
        errorArrow.setAttribute('markerWidth', '8')
        errorArrow.setAttribute('markerHeight', '8')
        errorArrow.setAttribute('orient', 'auto-start-reverse')
        const errorPath = this.svgEl('path')
        errorPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 Z')
        errorPath.setAttribute('fill', '#c55')
        errorArrow.appendChild(errorPath)

        defs.appendChild(arrow)
        defs.appendChild(crossArrow)
        defs.appendChild(errorArrow)
        container.appendChild(defs)
    }

    private appendGroup(
        container: SVGElement,
        group: PositionedGroup,
        closureResults: Record<string, ClosureResult>,
        graphKinds: Record<string, GraphKind>,
    ): void {
        const g = this.svgEl('g')

        // Same traffic light as the export badge in file-tree-entry: red on
        // closure error, amber on warnings, green only when closed clean.
        const result = closureResults[group.graphKey]
        const borderColor = !result ? '#333'
            : result.success === false ? '#a44'
                : result.warnings.length > 0 ? '#da0'
                    : '#4a4'

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
            const squigglyWidth = measureText(this.svg!, labelText, GROUP_LABEL_FONT)
            const squiggly = this.svgEl('path')
            squiggly.setAttribute('d', this.squigglyPath(squigglyX, squigglyY, squigglyWidth))
            this.setAttrs(squiggly, {
                fill: 'none', stroke: '#c55', 'stroke-width': 1,
            })
            g.appendChild(squiggly)
        }

        container.appendChild(g)
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

    private appendNode(container: SVGElement, node: PositionedNode, closureResults: Record<string, ClosureResult>): void {
        const g = this.svgEl('g')
        g.style.cursor = 'pointer'

        const cr = closureResults[node.graphKey]
        const nodeLocal = node.id.slice(node.graphKey.length + 1)
        let isMissingNode = false
        if (cr?.success === false) {
            isMissingNode = cr.issues.some(i =>
                (i.kind === 'missing-target' || i.kind === 'missing-source') && i.node === nodeLocal
            )
        }

        const rect = this.svgEl('rect')
        const baseStroke = isMissingNode ? '#c55' : '#444'
        this.setAttrs(rect, {
            x: node.x, y: node.y,
            width: node.width, height: node.height,
            rx: 4, fill: '#1a1a1a', stroke: baseStroke, 'stroke-width': 1,
        })
        rect.classList.add('node')
        // The firing decay animation fades stroke/fill back to this node's
        // own base (which varies - red for a missing node), carried in a
        // CSS var so one keyframe works for every node.
        rect.style.setProperty('--base-stroke', baseStroke)
        this.nodeEls.set(node.id, rect)
        g.appendChild(rect)

        const text = this.svgEl('text')
        this.setAttrs(text, {
            x: node.x + node.width / 2, y: node.y + node.height / 2 + 4,
            'text-anchor': 'middle',
            fill: '#e5e5e5', 'font-family': 'monospace', 'font-size': 12,
        })
        text.textContent = node.label
        g.appendChild(text)

        container.appendChild(g)
    }

    private appendEdge(
        container: SVGElement,
        edge: PositionedEdge,
        layout: LayoutResult,
        graphKinds: Record<string, GraphKind>,
        transitionKeys: Record<string, string[]>,
        closureResults: Record<string, ClosureResult>,
    ): void {
        const cross = this.isCrossGraph(edge, layout)
        const kind = graphKinds[edge.graphKey]

        const transitionName = edge.edgeName && edge.on.indexOf('.') !== -1 ? edge.on.slice(0, edge.on.indexOf('.')) : edge.on
        const keys = transitionKeys[edge.graphKey]
        const cr = closureResults[edge.graphKey]
        const direction = edge.on.indexOf('.') !== -1 ? edge.on.slice(edge.on.indexOf('.') + 1) : ''
        let hasEdgeIssue = false
        if (cr?.success === false) {
            hasEdgeIssue = cr.issues.some(i =>
                ('edge' in i && i.edge === edge.edgeName) ||
                (i.kind === 'incomplete-transition' && i.transition === transitionName && (i.field === '$' || i.field === direction))
            )
        }
        const squiggly = kind === 'graph-set' || (keys && !keys.includes(transitionName)) || hasEdgeIssue
        const edgeColor = hasEdgeIssue ? '#c55' : cross ? '#8af' : '#9a9a9a'

        const paths: SVGPathElement[] = []
        for (const section of edge.sections) {
            const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
            const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')

            const path = this.svgEl('path')
            this.setAttrs(path, {
                d, fill: 'none',
                stroke: edgeColor,
                'stroke-width': 1.5,
                'marker-end': hasEdgeIssue ? 'url(#arrow-error)' : cross ? 'url(#arrow-cross)' : 'url(#arrow)',
            })
            path.classList.add('edge')
            // Firing fades the colour back to this edge's base - width and
            // arrow marker are never touched.
            path.style.setProperty('--base-stroke', edgeColor)
            paths.push(path)
            container.appendChild(path)
        }
        if (edge.edgeName) this.edgeEls.set(edge.id, paths)

        if (edge.edgeName) {
            const g = this.svgEl('g')
            const onText = `(${edge.on})`
            const nameWidth = measureText(this.svg!, edge.edgeName, EDGE_NAME_FONT)
            const onWidth = measureText(this.svg!, onText, EDGE_ON_FONT, true)
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
                fill: hasEdgeIssue ? '#c55' : cross ? '#8af' : '#c0c0c0',
                'font-family': 'monospace', 'font-size': EDGE_NAME_FONT,
            })
            nameText.textContent = edge.edgeName
            g.appendChild(nameText)

            const onLabel = this.svgEl('text')
            this.setAttrs(onLabel, {
                x: edge.labelX, y: edge.labelY + EDGE_LABEL_LINE_HEIGHT - 2, 'text-anchor': 'middle',
                fill: hasEdgeIssue ? '#c55' : cross ? '#6af' : '#888',
                'font-family': 'monospace', 'font-size': EDGE_ON_FONT,
                'font-style': 'italic',
            })
            onLabel.textContent = onText
            g.appendChild(onLabel)
            if (squiggly) {
                const innerWidth = measureText(this.svg!, edge.on, EDGE_ON_FONT, true)
                const squigglyX = edge.labelX - innerWidth / 2
                const squigglyY = edge.labelY + EDGE_LABEL_LINE_HEIGHT + 1
                const squiggly = this.svgEl('path')
                squiggly.setAttribute('d', this.squigglyPath(squigglyX, squigglyY, innerWidth))
                this.setAttrs(squiggly, { fill: 'none', stroke: '#c55', 'stroke-width': 1 })
                g.appendChild(squiggly)
            }

            container.appendChild(g)
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

    override onDestroy(): void {
        for (const s of this.subs) s.unsubscribe()
        for (const s of this.animSubs) s.unsubscribe()
        this.subs = []
        this.animSubs = []
    }
}
