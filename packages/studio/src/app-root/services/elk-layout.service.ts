import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkNode, ElkExtendedEdge, ElkEdgeSection, ElkLabel } from 'elkjs/lib/elk-api.js'
import type { SerializedGraphSet, SerializedEdge } from './sandbox.service.js'

export interface PositionedNode {
    id: string
    graphKey: string
    label: string
    x: number
    y: number
    width: number
    height: number
}

export interface PositionedEdge {
    id: string
    graphKey: string
    edgeName: string
    on: string
    labelX: number
    labelY: number
    from: string
    to: string
    sections: ElkEdgeSection[]
}

export interface PositionedGroup {
    id: string
    graphKey: string
    label: string
    x: number
    y: number
    width: number
    height: number
}

export interface LayoutResult {
    nodes: PositionedNode[]
    edges: PositionedEdge[]
    groups: PositionedGroup[]
    width: number
    height: number
}

const NODE_WIDTH = 140
const NODE_HEIGHT = 40
const GROUP_PADDING = 40
const LABEL_CHAR_WIDTH = 6.5
const LABEL_HEIGHT = 16
const LABEL_PAD = 8

export class ElkLayoutService {
    private readonly elk = new ELK()

    async layout(
        graphs: Record<string, SerializedGraphSet>,
    ): Promise<LayoutResult> {
        const root = this.buildElkGraph(graphs)
        const laid = await this.elk.layout(root)
        return this.extractPositions(laid)
    }

    private buildElkGraph(
        graphs: Record<string, SerializedGraphSet>,
    ): ElkNode {
        const children: ElkNode[] = []
        const rootEdges: ElkExtendedEdge[] = []

        for (const [graphKey, gs] of Object.entries(graphs)) {
            const groupId = `group:${graphKey}`
            const groupChildren: ElkNode[] = []
            const groupEdges: ElkExtendedEdge[] = []

            for (const nodeName of Object.keys(gs.nodes)) {
                const nodeId = `${graphKey}:${nodeName}`
                groupChildren.push({
                    id: nodeId,
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    labels: [{ text: nodeName }],
                })
            }

            for (const [edgeName, edge] of Object.entries(gs.edges)) {
                const edgeId = `${graphKey}:${edgeName}`
                const fromId = `${graphKey}:${edge.from}`

                if (typeof edge.to === 'string') {
                    const toId = `${graphKey}:${edge.to}`
                    groupEdges.push({
                        id: edgeId,
                        sources: [fromId],
                        targets: [toId],
                        labels: [this.edgeLabelShape(edgeName, edge)],
                    })
                } else {
                    const targetGraphKey = this.findGraphKeyForDep(
                        graphs, graphKey, edge.to.dep,
                    )
                    if (targetGraphKey) {
                        const toId = `${targetGraphKey}:${edge.to.node}`
                        rootEdges.push({
                            id: edgeId,
                            sources: [fromId],
                            targets: [toId],
                            labels: [this.edgeLabelShape(edgeName, edge)],
                        })
                    }
                }
            }

            children.push({
                id: groupId,
                children: groupChildren,
                edges: groupEdges,
                labels: [{ text: this.groupLabel(graphKey) }],
                layoutOptions: {
                    'elk.padding': `[top=${GROUP_PADDING},left=20,bottom=20,right=20]`,
                    'elk.algorithm': 'layered',
                    'elk.direction': 'RIGHT',
                    'elk.spacing.nodeNode': '50',
                    'elk.spacing.edgeNode': '30',
                    'elk.spacing.edgeEdge': '25',
                    'elk.layered.spacing.nodeNodeBetweenLayers': '80',
                    'elk.layered.spacing.edgeNodeBetweenLayers': '30',
                },
            })
        }

        return {
            id: 'root',
            children,
            edges: rootEdges,
            layoutOptions: {
                'elk.algorithm': 'layered',
                'elk.direction': 'DOWN',
                'elk.spacing.nodeNode': '60',
                'elk.spacing.componentSpacing': '60',
                'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            },
        }
    }

    private findGraphKeyForDep(
        graphs: Record<string, SerializedGraphSet>,
        sourceGraphKey: string,
        depName: string,
    ): string | undefined {
        const sourceFile = sourceGraphKey.split(':')[0]
        const gs = graphs[sourceGraphKey]
        if (!gs) return undefined

        const depGs = gs.deps[depName]
        if (!depGs) return undefined

        for (const key of Object.keys(graphs)) {
            if (key === sourceGraphKey) continue
            const candidate = graphs[key]
            if (this.nodesMatch(candidate.nodes, depGs.nodes)) return key
        }
        return undefined
    }

    private nodesMatch(
        a: Record<string, unknown>,
        b: Record<string, unknown>,
    ): boolean {
        const aKeys = Object.keys(a).sort()
        const bKeys = Object.keys(b).sort()
        return aKeys.length === bKeys.length && aKeys.every((k, i) => k === bKeys[i])
    }

    private groupLabel(graphKey: string): string {
        const sep = graphKey.indexOf(':')
        if (sep === -1) return graphKey
        const exportName = graphKey.slice(sep + 1)
        const file = graphKey.slice(0, sep).replace(/\.ts$/, '')
        return `${file} (${exportName})`
    }

    private edgeLabelShape(edgeName: string, edge: SerializedEdge): ElkLabel {
        const topLine = edgeName
        const bottomLine = `(${edge.on})`
        const widest = Math.max(topLine.length, bottomLine.length)
        return {
            text: `${topLine}\n${bottomLine}`,
            width: widest * LABEL_CHAR_WIDTH + LABEL_PAD,
            height: LABEL_HEIGHT * 2,
            layoutOptions: { 'org.eclipse.elk.edgeLabels.placement': 'CENTER' },
        }
    }

    private extractPositions(laid: ElkNode): LayoutResult {
        const nodes: PositionedNode[] = []
        const edges: PositionedEdge[] = []
        const groups: PositionedGroup[] = []

        for (const group of laid.children ?? []) {
            const graphKey = group.id.replace('group:', '')

            groups.push({
                id: group.id,
                graphKey,
                label: group.labels?.[0]?.text ?? graphKey,
                x: group.x ?? 0,
                y: group.y ?? 0,
                width: group.width ?? 0,
                height: group.height ?? 0,
            })

            const gx = group.x ?? 0
            const gy = group.y ?? 0

            for (const child of group.children ?? []) {
                nodes.push({
                    id: child.id,
                    graphKey,
                    label: child.labels?.[0]?.text ?? child.id,
                    x: gx + (child.x ?? 0),
                    y: gy + (child.y ?? 0),
                    width: child.width ?? NODE_WIDTH,
                    height: child.height ?? NODE_HEIGHT,
                })
            }

            for (const edge of group.edges ?? []) {
                const lbl = edge.labels?.[0]
                const [eName, eOn] = (lbl?.text ?? '').split('\n')
                edges.push({
                    id: edge.id,
                    graphKey,
                    edgeName: eName,
                    on: eOn?.slice(1, -1) ?? '',
                    labelX: gx + (lbl?.x ?? 0) + (lbl?.width ?? 0) / 2,
                    labelY: gy + (lbl?.y ?? 0) + (lbl?.height ?? 0) / 2,
                    from: edge.sources[0],
                    to: edge.targets[0],
                    sections: (edge.sections ?? []).map(s => ({
                        ...s,
                        startPoint: { x: s.startPoint.x + gx, y: s.startPoint.y + gy },
                        endPoint: { x: s.endPoint.x + gx, y: s.endPoint.y + gy },
                        bendPoints: s.bendPoints?.map(p => ({ x: p.x + gx, y: p.y + gy })),
                    })),
                })
            }
        }

        for (const edge of laid.edges ?? []) {
            const lbl = edge.labels?.[0]
            const [eName, eOn] = (lbl?.text ?? '').split('\n')
            edges.push({
                id: edge.id,
                graphKey: '',
                edgeName: eName,
                on: eOn?.slice(1, -1) ?? '',
                labelX: (lbl?.x ?? 0) + (lbl?.width ?? 0) / 2,
                labelY: (lbl?.y ?? 0) + (lbl?.height ?? 0) / 2,
                from: edge.sources[0],
                to: edge.targets[0],
                sections: edge.sections ?? [],
            })
        }

        return {
            nodes,
            edges,
            groups,
            width: laid.width ?? 0,
            height: laid.height ?? 0,
        }
    }
}
