"use client";

import { useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { NodeRunState, WorkflowDefinition, WorkflowNodeDefinition, WorkflowRun } from "@flowpilot/contracts";

interface GraphNodeData extends Record<string, unknown> {
  definition: WorkflowNodeDefinition;
  state?: NodeRunState;
  selected: boolean;
  active: boolean;
  onSelect: (nodeId: string) => void;
}

function WorkflowNodeCard({ data }: NodeProps<Node<GraphNodeData>>) {
  const { definition, state, selected, active, onSelect } = data;
  const status = state?.status ?? "pending";
  const statusLabel = status === "success" ? "completed" : status;

  return (
    <button
      type="button"
      className={`workflow-node node-${status} ${selected ? "is-selected" : ""} ${active ? "is-active" : ""}`}
      onClick={() => onSelect(definition.id)}
    >
      <Handle type="target" position={Position.Left} className="workflow-handle" />
      <span className="node-icon" aria-hidden="true">
        {definition.kind === "trigger" ? "↗" : definition.kind === "ai" ? "✦" : definition.kind === "decision" ? "◇" : definition.kind === "approval" ? "◷" : definition.kind === "integration" ? "⇄" : definition.kind === "audit" ? "▤" : "·"}
      </span>
      <span className="node-copy">
        <span className="node-title">{definition.label}</span>
        <span className="node-meta">
          <span className="status-dot" />
          {statusLabel}
          {state?.durationMs !== undefined ? ` · ${state.durationMs}ms` : ""}
        </span>
      </span>
      <span className="node-integration">{definition.integration}</span>
      <Handle type="source" position={Position.Right} className="workflow-handle" />
    </button>
  );
}

const nodeTypes = { workflow: WorkflowNodeCard };

export function WorkflowGraph({
  definition,
  run,
  selectedNodeId,
  onSelectNode,
}: {
  definition: WorkflowDefinition;
  run?: WorkflowRun;
  selectedNodeId?: string;
  onSelectNode: (nodeId: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const activeBranches = new Set(run?.selectedBranches ?? []);
    const graphNodes: Node<GraphNodeData>[] = definition.nodes.map((definitionNode) => ({
      id: definitionNode.id,
      type: "workflow",
      position: definitionNode.position,
      data: {
        definition: definitionNode,
        state: run?.nodes[definitionNode.id],
        selected: selectedNodeId === definitionNode.id,
        active: (run?.nodes[definitionNode.id]?.status ?? "pending") === "running",
        onSelect: onSelectNode,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    }));
    const graphEdges: Edge[] = definition.edges.map((edge) => {
      const branchActive = edge.branch ? activeBranches.has(edge.branch) : false;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        type: "smoothstep",
        animated: branchActive || run?.nodes[edge.target]?.status === "running",
        markerEnd: { type: MarkerType.ArrowClosed, color: branchActive ? "#e0a55b" : "#9a9da8" },
        style: {
          stroke: branchActive ? "#e0a55b" : "#3a3d48",
          strokeWidth: branchActive ? 2.2 : 1.25,
        },
        labelStyle: { fill: branchActive ? "#f6c57d" : "#9498a5", fontSize: 10, fontWeight: 700 },
        labelBgStyle: { fill: "#15161b", fillOpacity: 0.92, color: "#15161b" },
      };
    });
    return { nodes: graphNodes, edges: graphEdges };
  }, [definition, onSelectNode, run, selectedNodeId]);

  return (
    <div className="graph-shell">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12, minZoom: 0.35, maxZoom: 1.25 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        zoomOnDoubleClick={false}
      >
        <Background color="#262832" gap={24} size={1} />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => {
            const status = (node.data as GraphNodeData | undefined)?.state?.status;
            if (status === "success") return "#4ea87e";
            if (status === "running") return "#e0a55b";
            if (status === "failed") return "#d36a6a";
            if (status === "waiting") return "#b69a5d";
            return "#414550";
          }}
          maskColor="rgba(10, 11, 15, 0.68)"
          position="bottom-left"
        />
      </ReactFlow>
    </div>
  );
}
