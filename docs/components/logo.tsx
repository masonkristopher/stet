export function Logo({ version }: { version?: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="stet-mark relative inline-block font-mono text-base leading-none font-semibold">
        stet
        <span aria-hidden className="absolute inset-x-0 top-[0.9375em] flex justify-around">
          <span className="size-[0.1875em] rounded-full bg-fd-primary" />
          <span className="size-[0.1875em] rounded-full bg-fd-primary" />
          <span className="size-[0.1875em] rounded-full bg-fd-primary" />
          <span className="size-[0.1875em] rounded-full bg-fd-primary" />
        </span>
      </span>
      {version ? (
        <span className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-[0.65rem] text-fd-muted-foreground">
          v{version}
        </span>
      ) : null}
    </span>
  );
}
