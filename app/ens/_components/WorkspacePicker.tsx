"use client";

import { type WorkspaceKind, useWorkspace } from "@/app/ens/_lib/hooks/useWorkspace";

/** Chips for values saved in the workspace; clicking one calls `onPick`. */
export function WorkspacePicker({ kind, onPick }: { kind: WorkspaceKind; onPick: (value: string) => void }) {
  const { workspace, remove } = useWorkspace();
  const entries = workspace[kind];
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-zinc-500">Saved:</span>
      {entries.slice(0, 8).map((e) => (
        <span key={e.value} className="inline-flex items-center rounded-full border border-zinc-300 dark:border-zinc-700">
          <button type="button" onClick={() => onPick(e.value)} className="px-2 py-0.5 font-mono hover:text-sky-600" title={e.value}>
            {e.label ?? (e.value.startsWith("0x") ? `${e.value.slice(0, 6)}…${e.value.slice(-4)}` : e.value)}
          </button>
          <button type="button" onClick={() => remove(kind, e.value)} className="pr-2 text-zinc-400 hover:text-red-500" aria-label="Remove">
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
