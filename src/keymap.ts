import type { KeyEvent } from "@opentui/core";
import { batch } from "solid-js";

import { nextScope, scopeLabel } from "./cli";
import { formatCopyReference } from "./clipboard/reference";
import { latestActivity } from "./git/activity";
import type { Worktree } from "./git/model";
import { lineReference } from "./git/patch";
import { firstFileInNode } from "./git/tree";
import { state } from "./state";
import { nextFindingPath, orderedFindingPaths } from "./ui-helpers";

interface KeyHandlerCtx {
  quit: () => void;
  switchWorktree: (worktree: Worktree) => void;
}

// One handler routes every key through the modal-precedence chain
// (help > worktree > palette > global > pane-specific). The order of the early
// Returns is load-bearing: an open overlay must swallow keys before any later
// Branch can act on them. Reads use the live signal values (not a render
// Snapshot); writes are wrapped in one `batch` so a keypress is one update.
export function createKeyHandler(ctx: KeyHandlerCtx) {
  const cycleFind = (direction: number) => {
    const matches = state.findMatches();
    if (matches.length === 0) {
      return;
    }
    const pos = (state.findMatchPos() + direction + matches.length) % matches.length;
    const target = matches[pos];
    if (target !== undefined) {
      state.setFindMatchPos(pos);
      state.setCursorIndex(target);
    }
  };

  return (key: KeyEvent) => {
    batch(() => {
      if (key.ctrl && key.name === "c") {
        ctx.quit();
        return;
      }

      if (state.helpOpen()) {
        if (key.name === "escape" || key.name === "?" || key.name === "q") {
          state.setHelpOpen(false);
        }
        return;
      }

      if (state.worktreeOpen()) {
        const worktrees = state.worktrees();
        const lastIndex = Math.max(0, (worktrees?.length ?? 1) - 1);
        if (key.name === "escape" || key.name === "w") {
          state.setWorktreeOpen(false);
        } else if (key.name === "j" || key.name === "down") {
          state.setWorktreeIndex(Math.min(state.worktreeIndex() + 1, lastIndex));
        } else if (key.name === "k" || key.name === "up") {
          state.setWorktreeIndex(Math.max(state.worktreeIndex() - 1, 0));
        } else if (key.name === "return") {
          const worktree = worktrees?.[state.worktreeIndex()];
          if (worktree !== undefined) {
            ctx.switchWorktree(worktree);
          }
        }
        return;
      }

      if (state.paletteOpen()) {
        if (key.name === "escape") {
          state.setPaletteOpen(false);
        } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
          state.setPaletteIndex(
            Math.min(state.paletteIndex() + 1, Math.max(0, state.paletteResults().length - 1)),
          );
        } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
          state.setPaletteIndex(Math.max(state.paletteIndex() - 1, 0));
        }
        return;
      }

      // The search panel owns the keyboard while open: nav + scope toggle here,
      // Text and submit (the jump) are the input element's job (like the palette).
      if (state.searchOpen()) {
        if (key.name === "escape") {
          state.setSearchOpen(false);
        } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
          state.setSearchIndex(
            Math.min(state.searchIndex() + 1, Math.max(0, state.searchResults().length - 1)),
          );
        } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
          state.setSearchIndex(Math.max(state.searchIndex() - 1, 0));
        } else if (key.ctrl && key.name === "a") {
          state.setSearchScope(state.searchScope() === "changed" ? "repo" : "changed");
          state.setSearchIndex(0);
        }
        return;
      }

      // The find bar owns the keyboard while open: only escape cancels it; text
      // And submit are the input element's job (same split as the palette).
      if (state.findOpen()) {
        if (key.name === "escape") {
          state.resetFind();
        }
        return;
      }

      // A committed find rebinds n/N to cycle matches and esc to clear it; every
      // Other key falls through so diff navigation still works over the highlights.
      if (state.findActive()) {
        if (key.name === "escape") {
          state.resetFind();
          return;
        }
        if (key.name === "n" && !key.shift) {
          cycleFind(1);
          return;
        }
        if (key.name === "N" || (key.name === "n" && key.shift)) {
          cycleFind(-1);
          return;
        }
      }

      if (key.ctrl && key.name === "p") {
        state.setPaletteOpen(true);
        state.setPaletteQuery("");
        state.setPaletteIndex(0);
        return;
      }

      if (key.ctrl && key.name === "f") {
        state.setSearchOpen(true);
        state.setSearchQuery("");
        state.setSearchIndex(0);
        return;
      }

      if (key.name === "/" && state.diffView() !== undefined) {
        // Solid mounts and focuses the find input within this same key event, so
        // Without preventDefault the triggering "/" would be typed into it.
        key.preventDefault();
        state.resetFind();
        state.setFindOpen(true);
        state.setFocusedPane("diff");
        return;
      }

      if (key.name === "q") {
        ctx.quit();
        return;
      }

      if (key.name === "escape") {
        if (state.problemsOpen()) {
          state.setProblemsOpen(false);
          if (state.focusedPane() === "problems") {
            state.setFocusedPane("tree");
          }
        } else {
          ctx.quit();
        }
        return;
      }

      if (key.name === "tab") {
        state.setFocusedPane(state.focusedPane() === "diff" ? "tree" : "diff");
        return;
      }

      if (key.name === "p") {
        const open = state.problemsOpen();
        state.setFocusedPane(open ? "tree" : "problems");
        state.setProblemsOpen(!open);
        return;
      }

      if (key.name === "b") {
        if (state.sidebarOpen()) {
          state.collapseSidebar();
        } else {
          state.setSidebarOpen(true);
        }
        return;
      }

      if (state.sidebarOpen() && (key.name === "]" || key.name === "[" || key.name === "\\")) {
        if (key.name === "]") {
          state.nudgeSidebarWidth(2);
        } else if (key.name === "[") {
          state.nudgeSidebarWidth(-2);
        } else {
          state.resetSidebarWidth();
        }
        return;
      }

      if (key.name === "?") {
        state.setHelpOpen(true);
        return;
      }

      if (key.name === "w") {
        state.setWorktreeOpen(true);
        state.setWorktreeIndex(0);
        state.setWorktrees(undefined);
        state.loadWorktrees(state.gitModel().repoRoot);
        return;
      }

      if (key.name === "s") {
        const current = state.scope();
        const next = { ...current, kind: nextScope(current.kind) };
        state.setScope(next);
        state.setStatus(`scope: ${scopeLabel(next)}`);
        return;
      }

      if (key.name === "c") {
        const current = state.changesOnly();
        state.setChangesOnly(!current);
        state.setStatus(current ? "showing all files" : "showing changes only");
        return;
      }

      if (key.name === "z") {
        const wrapping = state.overflow() === "wrap";
        state.setOverflow(wrapping ? "scroll" : "wrap");
        state.setStatus(wrapping ? "long lines: scroll" : "long lines: wrap");
        return;
      }

      if (key.name === ".") {
        const latest = latestActivity(state.activityLog());
        if (latest !== undefined) {
          state.selectFile(latest.path);
        }
        return;
      }

      const selectedPath = state.selectedPath();

      if (key.name === "v" && state.selectedFile() !== undefined && selectedPath !== undefined) {
        const line = state.navigableLines()[state.cursorIndex()];
        const lineNumber = line?.newLine ?? line?.oldLine;
        if (lineNumber !== undefined) {
          state.setJumpTarget({ escalate: false, line: lineNumber, path: selectedPath });
        }
        state.setFileView(!state.fileView());
        return;
      }

      if (key.name === "n") {
        const next = nextFindingPath(orderedFindingPaths(state.problems()), selectedPath);
        if (next !== undefined) {
          state.selectFile(next);
        }
        return;
      }

      if (key.name === "r") {
        void state.runChecks(state.gitModel());
        return;
      }

      if (key.name === "f" && selectedPath !== undefined) {
        state.setFullContentPaths(new Set(state.fullContentPaths()).add(selectedPath));
        state.setStatus(`loaded full content for ${selectedPath}`);
        return;
      }

      if (key.name === "y" && selectedPath !== undefined) {
        const line = state.navigableLines()[state.cursorIndex()];
        const reference =
          line === undefined ? { path: selectedPath } : lineReference(selectedPath, line);
        state.copy(formatCopyReference(reference));
        return;
      }

      const focusedPane = state.focusedPane();

      if (focusedPane === "problems") {
        const items = state.allProblemItems();
        if (key.name === "j" || key.name === "down") {
          state.setProblemIndex(Math.min(state.problemIndex() + 1, Math.max(0, items.length - 1)));
        } else if (key.name === "k" || key.name === "up") {
          state.setProblemIndex(Math.max(state.problemIndex() - 1, 0));
        } else if (key.name === "return") {
          const item = items[state.problemIndex()];
          if (item?.kind === "problem") {
            const { problem } = item;
            state.selectFile(problem.path);
            if (problem.line !== undefined) {
              state.setJumpTarget({ escalate: true, line: problem.line, path: problem.path });
            }
            state.setFocusedPane("diff");
          }
        }
        return;
      }

      if (focusedPane === "diff") {
        const last = state.navigableLines().length - 1;
        const halfPage = Math.max(1, Math.floor(state.viewerHeight() / 2));
        if (key.name === "j" || key.name === "down") {
          state.setCursorIndex(Math.max(0, Math.min(state.cursorIndex() + 1, last)));
        } else if (key.name === "k" || key.name === "up") {
          state.setCursorIndex(Math.max(state.cursorIndex() - 1, 0));
        } else if (key.ctrl && key.name === "d") {
          state.setCursorIndex(Math.max(0, Math.min(state.cursorIndex() + halfPage, last)));
        } else if (key.ctrl && key.name === "u") {
          state.setCursorIndex(Math.max(state.cursorIndex() - halfPage, 0));
        } else if (key.name === "g" && !key.shift) {
          state.setCursorIndex(0);
        } else if (key.name === "g" || key.name === "G") {
          state.setCursorIndex(Math.max(0, last));
        } else if (key.name === "h" || key.name === "left") {
          state.setFocusedPane("tree");
        }
        return;
      }

      if (key.name === "j" || key.name === "down") {
        state.moveFocus(1);
        return;
      }

      if (key.name === "k" || key.name === "up") {
        state.moveFocus(-1);
        return;
      }

      const treeRows = state.treeRows();
      const focusedRowIndex = state.focusedRowIndex();

      if (key.name === "l" || key.name === "right") {
        const row = treeRows[focusedRowIndex];
        if (row?.node.type === "directory") {
          state.setExpandedDirectories(new Set(state.expandedDirectories()).add(row.node.id));
        } else if (row?.node.type === "file") {
          state.selectFile(row.node.path);
        }
        return;
      }

      if (key.name === "h" || key.name === "left") {
        const row = treeRows[focusedRowIndex];
        if (row?.node.type === "directory") {
          const next = new Set(state.expandedDirectories());
          next.delete(row.node.id);
          state.setExpandedDirectories(next);
        }
        return;
      }

      if (key.name === "return") {
        const row = treeRows[focusedRowIndex];
        if (row !== undefined) {
          const file = firstFileInNode(row.node);
          if (file !== undefined) {
            state.selectFile(file.path);
          }
        }
      }
    });
  };
}
