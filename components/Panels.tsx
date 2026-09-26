"use client";

import { useState, type ReactNode } from "react";

export interface PanelDef { id: string; label: string; hint: string; content: ReactNode }

/**
 * Press a chip to open its panel. Press it again to close. One panel at a time.
 * `leads` are extra first chips for the selected version: Propose, Verify and Buy.
 */
export function Panels({ panels, leads = [] }: { panels: PanelDef[]; leads?: PanelDef[] }) {
  const all = [...leads, ...panels];
  // The first chip is open by default, so the tab bar never shows an empty page.
  const [open, setOpen] = useState<string | null>(all[0]?.id ?? null);
  // A lead chip, such as Buy, leaves when another version is selected. Its panel falls back to the first.
  const active = open === null ? null : all.find((p) => p.id === open) ?? all[0] ?? null;

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
