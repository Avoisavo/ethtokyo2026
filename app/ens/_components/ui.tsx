// Presentational building blocks shared by every feature page. No hooks, so
// these work in both Server and Client Components.

import { explorerAddress } from "@/app/ens/_lib/ens/contracts";
import { stringify } from "@/app/ens/_lib/ens/errors";

type Children = { children?: React.ReactNode };

export function Card({
  title,
  description,
  actions,
  children,
}: Children & { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      {(title || actions) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: Children & { label: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

const control =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${control} ${props.className ?? ""}`} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${control} min-h-24 ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${control} ${props.className ?? ""}`} />;
}

const buttonVariants = {
  primary: "bg-sky-600 text-white hover:bg-sky-500",
  secondary:
    "border border-zinc-300 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800",
  danger: "bg-red-600 text-white hover:bg-red-500",
};

export function Button({
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof buttonVariants }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${buttonVariants[variant]} ${props.className ?? ""}`}
    />
  );
}

const tones = {
  neutral: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  info: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  danger: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export type Tone = keyof typeof tones;

export function Badge({ tone = "neutral", children }: Children & { tone?: Tone }) {
  return <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function Notice({ tone = "info", title, children }: Children & { tone?: Tone; title?: React.ReactNode }) {
  return (
    <div className={`rounded-lg px-4 py-3 text-sm ${tones[tone]}`}>
      {title && <div className="mb-1 font-semibold">{title}</div>}
      {children}
    </div>
  );
}

export function Mono({ children }: Children) {
  return <code className="break-all rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800">{children}</code>;
}

/** Two-column key/value table. */
export function KV({ rows }: { rows: [React.ReactNode, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(8rem,max-content)_1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-zinc-500">{k}</dt>
          <dd className="min-w-0 break-all font-mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Pretty-printed JSON with bigint support. */
export function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs text-zinc-100">
      {stringify(value, 2)}
    </pre>
  );
}

export function AddressLink({ address, short = false }: { address?: string | null; short?: boolean }) {
  if (!address) return <span className="text-zinc-500">—</span>;
  const text = short ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
  return (
    <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="font-mono text-sky-600 hover:underline dark:text-sky-400">
      {text}
    </a>
  );
}

export function ErrorText({ children }: Children) {
  if (!children) return null;
  return <p className="break-words text-sm text-red-600 dark:text-red-400">{children}</p>;
}

export function Row({ children }: Children) {
  return <div className="flex flex-wrap items-end gap-3">{children}</div>;
}

export function Grid({ children }: Children) {
  return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}
