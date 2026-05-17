/**
 * Renders every module from MODULE_CATEGORIES as a card, grouped by
 * category. Hover (desktop) and tap (mobile) reveals the example finding
 * via a native <details> element — zero JavaScript framework overhead.
 */

import { MODULE_CATEGORIES, totalModuleCount } from "./modules-data";

export default function ModuleGrid() {
  const total = totalModuleCount();
  return (
    <div className="space-y-14">
      <p className="text-sm text-white/45 mt-2">
        {total} modules total. Every Full scan ($99) runs the developer suite. URL scans run the
        live-site subset. Quick scan runs the highest-signal four.
      </p>

      {MODULE_CATEGORIES.map((category) => (
        <div key={category.id} id={`modules-${category.id}`} className="scroll-mt-24">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 mb-4">
            <h3 className="text-xl font-semibold text-white">
              {category.title}
              <span className="ml-2 text-sm text-white/40 font-normal font-mono">
                {category.modules.length} {category.modules.length === 1 ? "module" : "modules"}
              </span>
            </h3>
            <p className="text-sm text-white/50 max-w-md">{category.blurb}</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {category.modules.map((mod) => (
              <details
                key={mod.name}
                className="group rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 transition-colors hover:border-white/15 hover:bg-white/[0.035] open:border-teal-500/30 open:bg-teal-500/[0.04]"
              >
                <summary className="cursor-pointer list-none flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-sm font-semibold text-white">{mod.name}</div>
                    <p className="text-xs text-white/55 mt-1 leading-relaxed">{mod.description}</p>
                  </div>
                  <span
                    aria-hidden="true"
                    className="text-white/30 text-xs font-mono shrink-0 mt-0.5 group-open:rotate-45 transition-transform"
                  >
                    +
                  </span>
                </summary>
                <div className="mt-3 pt-3 border-t border-white/[0.06]">
                  <div className="text-[10px] uppercase tracking-wider text-teal-400/70 font-semibold mb-1.5">
                    Example finding
                  </div>
                  <code className="block text-xs text-white/70 font-mono leading-relaxed break-words">
                    {mod.example}
                  </code>
                </div>
              </details>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
