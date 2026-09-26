"use client";

import { useState, type ReactNode } from "react";

export interface PanelDef { id: string; label: string; hint: string; content: ReactNode }

/**
 * Press a chip to open its panel. Press it again to close. One panel at a time.
 * `lead` is an extra first chip for the selected version, such as Buy.
 */
export function Panels({ panels, lead = null }: { panels: PanelDef[]; lead?: PanelDef | null }) {
  // The first tree panel is open by default, so the tab bar never shows an empty page.
  const [open, setOpen] = useState<string | null>(panels[0]?.id ?? null);
  const all = lead ? [lead, ...panels] : panels;
  // A lead chip leaves when another version is selected. Its panel falls back to the first.
  const active = open === null ? null : all.find((p) => p.id === open) ?? panels[0] ?? null;

  return (
    <div className="panels">
      <div className="chips" role="toolbar" aria-label="Tree information">
        {all.map((p) => (
          <button
            key={p.id}
            type="button"
            id={`chip-${p.id}`}
            className="chip"
            aria-expanded={active?.id === p.id}
            aria-controls={`panel-${p.id}`}
            onClick={() => setOpen(active?.id === p.id ? null : p.id)}
          >
            <span className="chip-label">{p.label}</span>
            <span className="chip-hint">{p.hint}</span>
          </button>
        ))}
      </div>
      {active && (
        <section id={`panel-${active.id}`} className="panel" aria-labelledby={`chip-${active.id}`}>
          {active.content}
        </section>
      )}
    </div>
  );
}
