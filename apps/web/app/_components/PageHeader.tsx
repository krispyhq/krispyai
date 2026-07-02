export function PageHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-8 flex flex-col gap-2">
      <span className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-crust">
        {eyebrow}
      </span>
      <h1 className="font-display text-4xl font-black tracking-tight sm:text-5xl">{title}</h1>
      {subtitle && <p className="max-w-xl text-muted-foreground">{subtitle}</p>}
    </div>
  );
}
