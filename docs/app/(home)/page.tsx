import { Eye, GitBranch, ListTree, Search, TriangleAlert, Waypoints } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { siteUrl } from "@/lib/site";

import { InstallCommand } from "./install-command";

const features = [
  {
    icon: ListTree,
    title: "Live repo tree",
    body: "The git-backed tree renders first: tracked and untracked files, with staged, unstaged, mixed, and untracked marked in place.",
  },
  {
    icon: Eye,
    title: "Read-only viewer",
    body: "Open any file with syntax highlighting, or a changed file as a diff. Fold by structure, expand git gaps, toggle the full file.",
  },
  {
    icon: Search,
    title: "Find and search",
    body: "Find within the open file, or search file contents across the repo, scoped to the changes or the whole tree.",
  },
  {
    icon: GitBranch,
    title: "Scopes and worktrees",
    body: "Compare against any ref, drill into recent commits, and switch between git worktrees in place without leaving the view.",
  },
  {
    icon: TriangleAlert,
    title: "Diagnostics",
    body: "Type errors and lint findings stream into the tree, the viewer, and a problems panel as the repo's language servers finish.",
  },
  {
    icon: Waypoints,
    title: "Code intel",
    body: "Read-only language-server pulls: go to definition, find references and implementations, call hierarchy, hover, and symbol outline.",
  },
];

export default function Page() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto flex w-full max-w-5xl flex-col items-center gap-8 px-4 pt-20 pb-16 text-center sm:pt-28">
        <p className="font-mono text-sm text-fd-primary">read-only companion TUI</p>
        <h1 className="max-w-3xl font-mono text-4xl leading-tight font-bold tracking-tight text-balance sm:text-6xl">
          Inspect an agent's changes as they happen
        </h1>
        <p className="max-w-2xl text-lg text-fd-muted-foreground text-balance">
          Run an agent in one terminal pane and stet in another. See the repo tree, diffs, problems,
          and latest activity, without putting stet in the agent loop.
        </p>
        <InstallCommand command={`curl -fsSL ${siteUrl}/install | bash`} />
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
          <a
            href="https://github.com/jimmy-guzman/stet"
            className="rounded-lg border border-fd-border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            View on GitHub
          </a>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-16">
        <Image
          src="/screenshots/stet.png"
          alt="stet showing the repository tree beside a diff of a changed file"
          width={2560}
          height={1520}
          priority
          sizes="(max-width: 1152px) 100vw, 1152px"
          className="h-auto w-full rounded-xl border border-fd-border shadow-2xl shadow-black/20"
        />
      </section>

      <section className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-px overflow-hidden rounded-xl border border-fd-border bg-fd-border px-0 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <div
            key={feature.title}
            className="flex flex-col gap-3 bg-fd-background p-6 transition-colors hover:bg-fd-muted"
          >
            <feature.icon className="size-5 text-fd-primary" />
            <h2 className="font-mono text-base font-semibold">{feature.title}</h2>
            <p className="text-sm text-fd-muted-foreground">{feature.body}</p>
          </div>
        ))}
      </section>

      <section className="mx-auto w-full max-w-3xl px-4 py-20 text-center">
        <h2 className="font-mono text-2xl font-bold tracking-tight">It only inspects</h2>
        <p className="mx-auto mt-4 max-w-xl text-fd-muted-foreground text-balance">
          No approvals, no accept/reject protocol, no generated reviews, no PR workflow, no
          database. The agent never hears from stet, only from you.
        </p>
        <p className="mx-auto mt-6 max-w-xl font-mono text-sm text-fd-muted-foreground text-balance">
          Stet is the proofreader's mark for "let it stand": strike a word out, add dots beneath,
          and it stays.
        </p>
        <div className="mt-8">
          <Link
            href="/docs"
            className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Read the docs
          </Link>
        </div>
      </section>
    </main>
  );
}
