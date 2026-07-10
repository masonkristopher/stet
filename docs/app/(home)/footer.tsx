import { Logo } from "@/components/logo";

const links = [
  { label: "GitHub", href: "https://github.com/jimmy-guzman/stet" },
  { label: "npm", href: "https://npmx.dev/package/@jimmy.codes/stet" },
  { label: "Changelog", href: "/changelog" },
  {
    label: "MIT License",
    href: "https://github.com/jimmy-guzman/stet/blob/main/LICENSE",
  },
];

export function Footer({ version }: { version?: string }) {
  return (
    <footer className="mt-auto border-t border-fd-border">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-fd-muted-foreground sm:flex-row">
        <div className="flex flex-col items-center gap-1 sm:items-start">
          <div className="flex items-center gap-3">
            <Logo />
            {version ? (
              <span className="font-mono text-xs text-fd-muted-foreground">v{version}</span>
            ) : null}
          </div>
          <span className="text-xs">
            Built by{" "}
            <a href="https://jimmy.codes" className="transition-colors hover:text-fd-foreground">
              Jimmy Guzman Moreno
            </a>
          </span>
        </div>
        <nav className="flex items-center gap-6">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="transition-colors hover:text-fd-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
