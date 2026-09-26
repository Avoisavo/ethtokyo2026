import s from "./world.module.css";

export type Status = "pass" | "fail" | "idle" | "info";

export function Section({
  n,
  title,
  status,
  statusText,
  children,
}: {
  n: number;
  title: string;
  status: Status;
  statusText: string;
  children: React.ReactNode;
}) {
  return (
    <section id={`s${n}`} className={s.section}>
      <header className={s.sectionHead}>
        <span className={s.bigNum}>{n}</span>
        <h2>{title}</h2>
        <span className={`${s.badge} ${s[`badge_${status}`]}`}>
          <Dot status={status} />
          {statusText}
        </span>
      </header>
      <div className={s.body}>{children}</div>
    </section>
  );
}

export function Dot({ status }: { status: Status }) {
  const glyph = { pass: "✓", fail: "✕", info: "!", idle: "·" }[status];
  return (
    <span className={`${s.dot} ${s[`dot_${status}`]}`} aria-hidden="true">
      {glyph}
    </span>
  );
}

export function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>
        <code>{v}</code>
      </dd>
    </>
  );
}
