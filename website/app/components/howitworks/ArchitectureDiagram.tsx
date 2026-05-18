/**
 * Hand-rolled SVG architecture diagram. No external dependencies.
 *
 * Renders the full GateTest scan pipeline as a vertical flow with labelled
 * boxes and arrows. Designed to be scannable in ~5 seconds.
 */

type Node = {
  id: string;
  label: string;
  detail?: string;
  y: number;
  variant?: "input" | "queue" | "engine" | "fix" | "review" | "nuclear" | "output";
};

const NODES: Node[] = [
  { id: "push", label: "Customer push", detail: "git push / merge", y: 40, variant: "input" },
  { id: "host", label: "GitHub App webhook  OR  Gluecron Signal Bus", detail: "HMAC-verified, fail-closed", y: 130, variant: "input" },
  { id: "queue", label: "scan_queue (Postgres)", detail: "idempotent via delivery id", y: 220, variant: "queue" },
  { id: "engine", label: "Worker fetches job  →  Gate runs 102 modules", detail: "deterministic, no AI by default", y: 310, variant: "engine" },
  { id: "cluster", label: "Findings clustered, ranked, capped per tier", detail: "root causes first, info-severity dropped", y: 410, variant: "engine" },
  { id: "fix", label: "Flywheel  ·  AST → Rule → Recipe → Claude", detail: "first layer that wins ships the patch", y: 510, variant: "fix" },
  { id: "gate", label: "Test gen  +  syntax gate  +  scanner re-validation", detail: "broken fixes never reach the PR", y: 610, variant: "fix" },
  { id: "review", label: "Pair review  +  architecture annotation  ·  Tier 2+", detail: "second Claude critiques every fix", y: 700, variant: "review" },
  { id: "nuclear", label: "Correlation  +  Claude diagnosis  +  executive summary  ·  Tier 3", detail: "attack chains across findings, per-finding diagnosis, CISO report (mutation + chaos run via GitHub Action)", y: 790, variant: "nuclear" },
  { id: "pr", label: "PR composed and opened", detail: "before/after table, advisory, regression tests", y: 890, variant: "output" },
];

const VARIANT_STYLES: Record<NonNullable<Node["variant"]>, { fill: string; stroke: string; label: string; detail: string }> = {
  input:   { fill: "rgba(20, 184, 166, 0.10)", stroke: "rgba(45, 212, 191, 0.55)", label: "#5eead4", detail: "rgba(94, 234, 212, 0.55)" },
  queue:   { fill: "rgba(99, 102, 241, 0.10)", stroke: "rgba(129, 140, 248, 0.55)", label: "#a5b4fc", detail: "rgba(165, 180, 252, 0.55)" },
  engine:  { fill: "rgba(255, 255, 255, 0.04)", stroke: "rgba(255, 255, 255, 0.20)", label: "#ffffff", detail: "rgba(255, 255, 255, 0.50)" },
  fix:     { fill: "rgba(245, 158, 11, 0.08)", stroke: "rgba(251, 191, 36, 0.45)", label: "#fcd34d", detail: "rgba(252, 211, 77, 0.55)" },
  review:  { fill: "rgba(168, 85, 247, 0.10)", stroke: "rgba(192, 132, 252, 0.50)", label: "#d8b4fe", detail: "rgba(216, 180, 254, 0.55)" },
  nuclear: { fill: "rgba(236, 72, 153, 0.10)", stroke: "rgba(244, 114, 182, 0.50)", label: "#f9a8d4", detail: "rgba(249, 168, 212, 0.55)" },
  output:  { fill: "rgba(16, 185, 129, 0.10)", stroke: "rgba(52, 211, 153, 0.55)", label: "#6ee7b7", detail: "rgba(110, 231, 183, 0.55)" },
};

const BOX_WIDTH = 720;
const BOX_HEIGHT = 64;
const CENTER_X = 400;
const SVG_WIDTH = 820;
const SVG_HEIGHT = 980;

export default function ArchitectureDiagram() {
  return (
    <div className="w-full overflow-x-auto -mx-2 px-2">
      <svg
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        role="img"
        aria-label="GateTest scan pipeline architecture: customer push enters via GitHub App or Gluecron Signal Bus, lands in a Postgres scan queue, runs through 102 deterministic modules, clusters and ranks findings, applies the AST/Rule/Recipe/Claude flywheel, validates each fix through a syntax gate and scanner re-validation, adds pair review and architecture annotation for Tier 2 and up, adds cross-finding correlation, per-finding Claude diagnosis, and executive summary for Tier 3 (mutation testing and chaos / fuzz pass are available via the GitHub Action where a CI runner is present), and finally opens a pull request."
        className="w-full h-auto min-w-[640px]"
      >
        <defs>
          <marker
            id="arrow-head"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 Z" fill="rgba(255, 255, 255, 0.35)" />
          </marker>
        </defs>

        {/* Arrows */}
        {NODES.map((node, index) => {
          if (index === NODES.length - 1) return null;
          const next = NODES[index + 1];
          const startY = node.y + BOX_HEIGHT;
          const endY = next.y;
          return (
            <line
              key={`arrow-${node.id}`}
              x1={CENTER_X}
              y1={startY}
              x2={CENTER_X}
              y2={endY - 2}
              stroke="rgba(255, 255, 255, 0.18)"
              strokeWidth="2"
              markerEnd="url(#arrow-head)"
            />
          );
        })}

        {/* Nodes */}
        {NODES.map((node) => {
          const v = VARIANT_STYLES[node.variant ?? "engine"];
          const x = CENTER_X - BOX_WIDTH / 2;
          return (
            <g key={node.id}>
              <rect
                x={x}
                y={node.y}
                width={BOX_WIDTH}
                height={BOX_HEIGHT}
                rx={10}
                ry={10}
                fill={v.fill}
                stroke={v.stroke}
                strokeWidth="1.25"
              />
              <text
                x={CENTER_X}
                y={node.y + 26}
                textAnchor="middle"
                fontFamily="ui-monospace, 'SF Mono', Menlo, monospace"
                fontSize="14"
                fontWeight="600"
                fill={v.label}
              >
                {node.label}
              </text>
              {node.detail && (
                <text
                  x={CENTER_X}
                  y={node.y + 47}
                  textAnchor="middle"
                  fontFamily="ui-monospace, 'SF Mono', Menlo, monospace"
                  fontSize="11.5"
                  fill={v.detail}
                >
                  {node.detail}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
