/**
 * Hand-rolled SVG cost-trend chart for the flywheel section.
 *
 * Sketches the Claude-call-ratio curve over time as recipes accumulate.
 * No real metrics — this is illustrative, plotted from a logistic decay
 * that matches the architectural intent described in try-fix.js.
 */

const POINTS = [
  { x: 0,   y: 100, label: "Scan 1" },
  { x: 12,  y: 78,  label: "" },
  { x: 25,  y: 58,  label: "Scan 25" },
  { x: 38,  y: 40,  label: "" },
  { x: 50,  y: 28,  label: "Scan 50" },
  { x: 65,  y: 18,  label: "" },
  { x: 80,  y: 11,  label: "" },
  { x: 100, y: 5,   label: "Scan 100+" },
];

const WIDTH = 720;
const HEIGHT = 220;
const PADDING_X = 56;
const PADDING_Y = 32;
const PLOT_WIDTH = WIDTH - PADDING_X * 2;
const PLOT_HEIGHT = HEIGHT - PADDING_Y * 2;

function toSvgX(x: number) {
  return PADDING_X + (x / 100) * PLOT_WIDTH;
}

function toSvgY(y: number) {
  return PADDING_Y + ((100 - y) / 100) * PLOT_HEIGHT;
}

export default function CostTrendChart() {
  const linePath = POINTS.map((p, i) => `${i === 0 ? "M" : "L"} ${toSvgX(p.x)} ${toSvgY(p.y)}`).join(" ");
  const areaPath = `${linePath} L ${toSvgX(100)} ${toSvgY(0)} L ${toSvgX(0)} ${toSvgY(0)} Z`;

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Cost trend: percentage of fixes served by Claude. Starts near 100 percent on early scans, drops below 30 percent after roughly 50 scans, trends toward 5 percent after 100-plus scans as the recipe layer accumulates."
        className="w-full h-auto min-w-[480px]"
      >
        <defs>
          <linearGradient id="cost-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(45, 212, 191, 0.35)" />
            <stop offset="100%" stopColor="rgba(45, 212, 191, 0.02)" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {[0, 25, 50, 75, 100].map((y) => (
          <line
            key={`grid-${y}`}
            x1={PADDING_X}
            x2={WIDTH - PADDING_X}
            y1={toSvgY(y)}
            y2={toSvgY(y)}
            stroke="rgba(255, 255, 255, 0.06)"
            strokeWidth="1"
          />
        ))}

        {/* Y-axis labels */}
        {[0, 25, 50, 75, 100].map((y) => (
          <text
            key={`y-${y}`}
            x={PADDING_X - 10}
            y={toSvgY(y) + 4}
            textAnchor="end"
            fontFamily="ui-monospace, 'SF Mono', Menlo, monospace"
            fontSize="11"
            fill="rgba(255, 255, 255, 0.40)"
          >
            {y}%
          </text>
        ))}

        {/* Area under curve */}
        <path d={areaPath} fill="url(#cost-area)" />

        {/* Line */}
        <path
          d={linePath}
          fill="none"
          stroke="#2dd4bf"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Endpoint dots and labels */}
        {POINTS.filter((p) => p.label).map((p) => (
          <g key={`pt-${p.x}`}>
            <circle cx={toSvgX(p.x)} cy={toSvgY(p.y)} r="4" fill="#2dd4bf" />
            <text
              x={toSvgX(p.x)}
              y={toSvgY(p.y) - 14}
              textAnchor={p.x > 80 ? "end" : p.x < 20 ? "start" : "middle"}
              fontFamily="ui-monospace, 'SF Mono', Menlo, monospace"
              fontSize="11"
              fill="rgba(94, 234, 212, 0.85)"
            >
              {p.label} · {p.y}%
            </text>
          </g>
        ))}

        {/* X-axis label */}
        <text
          x={WIDTH / 2}
          y={HEIGHT - 6}
          textAnchor="middle"
          fontFamily="ui-monospace, 'SF Mono', Menlo, monospace"
          fontSize="11"
          fill="rgba(255, 255, 255, 0.40)"
        >
          Scans completed  →
        </text>

        {/* Y-axis label */}
        <text
          x={14}
          y={HEIGHT / 2}
          transform={`rotate(-90, 14, ${HEIGHT / 2})`}
          textAnchor="middle"
          fontFamily="ui-monospace, 'SF Mono', Menlo, monospace"
          fontSize="11"
          fill="rgba(255, 255, 255, 0.40)"
        >
          % fixes served by Claude
        </text>
      </svg>
      <p className="text-xs text-white/40 italic mt-2 px-2">
        Illustrative — actual ratio depends on codebase shape and recipe-hit rate. The architectural goal is that
        repeat patterns stop reaching Claude entirely.
      </p>
    </div>
  );
}
