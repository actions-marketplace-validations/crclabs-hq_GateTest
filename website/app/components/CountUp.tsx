"use client";

import { useEffect, useRef, useState } from "react";

interface CountUpProps {
  value: string;
  duration?: number;
  className?: string;
}

// Resolve the OS-level "reduced motion" preference at module scope so the
// useState initialiser below doesn't need to inspect window during SSR.
// WCAG 2.3.3 + the a11y:reduced-motion rule.
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export default function CountUp({ value, duration = 1600, className = "" }: CountUpProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  // Lazy initialisers so the prefers-reduced-motion check happens once at
  // mount instead of inside the effect (avoids react-hooks/set-state-in-effect
  // violation while still honouring the OS preference).
  const [display, setDisplay] = useState(value);
  const [animated, setAnimated] = useState(() => prefersReducedMotion());

  const match = value.match(/^(\$?)(\d+(?:\.\d+)?)(.*)$/);
  const prefix = match ? match[1] : "";
  const target = match ? parseFloat(match[2]) : NaN;
  const suffix = match ? match[3] : "";

  useEffect(() => {
    if (!ref.current || isNaN(target) || animated) {
      return;
    }
    const node = ref.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !animated) {
          setAnimated(true);
          const start = performance.now();
          const tick = (now: number) => {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = target * eased;
            const rounded = target < 10 ? current.toFixed(0) : Math.round(current).toString();
            setDisplay(`${prefix}${rounded}${suffix}`);
            if (progress < 1) {
              requestAnimationFrame(tick);
            } else {
              setDisplay(value);
            }
          };
          requestAnimationFrame(tick);
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [target, duration, prefix, suffix, value, animated]);

  if (isNaN(target)) {
    return <span className={className}>{value}</span>;
  }

  return (
    <span ref={ref} className={className}>
      {display}
    </span>
  );
}
