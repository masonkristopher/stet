import type { KeyEvent } from "@opentui/core";
import { batch } from "solid-js";

import { scopeKinds } from "./cli";
import { formatCopyReference } from "./clipboard/reference";
import { isNavigableProblemItem } from "./diagnostics/problems";
import { latestActivity } from "./git/activity";
import { firstFileInNode } from "./git/tree";
import { state } from "./state";
import { nextFindingPath, orderedFindingPaths } from "./ui-helpers";
import { isNavigableSearchItem } from "./viewer/search-items";

/**
 * The injection seam for the keymap's irreversible host side-effects (`quit` tears down the
 * renderer and exits the process; `openInEditor` suspends/resumes it around a subprocess). Both
 * need the `renderer` (a render-tree resource that must not leak into the global `state`
 * singleton), and injection keeps the otherwise-pure keymap testable without a real renderer or
 * `process.exit`. Data actions never belong here; they live in `state`.
 */
interface HostEffects {
  quit: () => void;
  openInEditor: (path: string, line: number | undefined, mode: "terminal" | "ide") => Promise<void>;
}

// One handler routes every key through the modal-precedence chain
// (help > worktree > palette > global > pane-specific). The order of the early
// Returns is load-bearing: an open overlay must swallow keys before any later
// Branch can act on them. Reads use the live signal values (not a render
// Snapshot); writes are wrapped in one `batch` so a keypress is one update.
export function createKeyHandler(host: HostEffects) {
  const cycleFind = (direction: number) => {
    const matches = state.findMatches();
    if (matches.length === 0) {
      return;
    }
    const pos = (state.findMatchPos() + direction + matches.length) % matches.length;
    const target = matches[pos];
    if (target !== undefined) {
      state.setFindMatchPos(pos);
      state.setCursorRow(target);
    }
  };

  // Open the scope picker on the kinds level, reading as "where am I now": on the
  // Active kind, or the "commits" drill-down row when a commit scope is active (its
  // SHA is not a top-level kind, so indexOf is a benign -1).
  const openScopeMenu = () => {
    state.setScopeMenuView("kinds");
    state.setScopeMenuIndex(
      state.scope().kind === "commit"
        ? scopeKinds.length
        : Math.max(0, scopeKinds.indexOf(state.scope().kind)),
    );
    state.setScopeMenuOpen(true);
  };

  return (key: KeyEvent) => {
    batch(() => {
      if (key.ctrl && key.name === "c") {
        host.quit();
        return;
      }

      if (state.helpDialogOpen()) {
        if (key.name === "escape" || key.name === "?" || key.name === "q") {
          state.setHelpDialogOpen(false);
        }
        return;
      }

      // The worktree picker owns the keyboard while open (like the palette): nav
      // Here, text and submit (the switch) are the input element's job. Escape
      // Closes; enter (the input's onSubmit) switches to the highlighted worktree.
      if (state.worktreeComboboxOpen()) {
        if (key.name === "escape") {
          state.setWorktreeComboboxOpen(false);
        } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
          state.setWorktreeComboboxIndex(
            Math.min(
              state.worktreeComboboxIndex() + 1,
              Math.max(0, (state.worktreeComboboxResults()?.length ?? 0) - 1),
            ),
          );
        } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
          state.setWorktreeComboboxIndex(Math.max(state.worktreeComboboxIndex() - 1, 0));
        }
        return;
      }

      if (state.scopeMenuOpen()) {
        const inCommits = state.scopeMenuView() === "commits";
        // Level 1 is the kinds plus a trailing "commits" drill-down row (at index
        // ScopeKinds.length); level 2 is the loaded commit list.
        const lastIndex = inCommits ? Math.max(0, state.commits().length - 1) : scopeKinds.length;
        const onCommitsRow = !inCommits && state.scopeMenuIndex() === scopeKinds.length;
        if (key.name === "escape" || (key.name === "left" && inCommits)) {
          // Esc (or left) backs out of the drill-down first, then closes the picker.
          if (inCommits) {
            state.setScopeMenuView("kinds");
            state.setScopeMenuIndex(scopeKinds.length);
          } else {
            state.setScopeMenuOpen(false);
          }
        } else if (key.name === "s") {
          // `s` opened the picker, so it closes it from either level.
          state.setScopeMenuOpen(false);
        } else if (key.name === "j" || key.name === "down") {
          state.setScopeMenuIndex(Math.min(state.scopeMenuIndex() + 1, lastIndex));
        } else if (key.name === "k" || key.name === "up") {
          state.setScopeMenuIndex(Math.max(state.scopeMenuIndex() - 1, 0));
        } else if ((key.name === "return" || key.name === "right") && onCommitsRow) {
          // Drill into the commit list rather than applying a scope.
          state.setScopeMenuView("commits");
          state.setScopeMenuIndex(0);
          state.loadCommits(state.gitModel().repoRoot);
        } else if (key.name === "return") {
          if (inCommits) {
            // Only close on a real selection; Enter on a loading/empty list is a no-op.
            if (state.selectCommit(state.scopeMenuIndex())) {
              state.setScopeMenuOpen(false);
            }
          } else {
            const kind = scopeKinds[state.scopeMenuIndex()];
            if (kind !== undefined) {
              state.selectScope(kind);
            }
            state.setScopeMenuOpen(false);
          }
        }
        return;
      }

      // The context menu owns the keyboard while open (it can cover either pane, so
      // It gates ahead of the pane-specific branches). j/k/arrows move the highlight;
      // Return runs the highlighted action (editor opens through the host, like e/o).
      if (state.commandMenuOpen()) {
        const items = state.commandMenuItems();
        if (key.name === "escape") {
          state.closeCommandMenu();
        } else if (key.name === "j" || key.name === "down") {
          state.setCommandMenuIndex(Math.min(state.commandMenuIndex() + 1, items.length - 1));
        } else if (key.name === "k" || key.name === "up") {
          state.setCommandMenuIndex(Math.max(state.commandMenuIndex() - 1, 0));
        } else if (key.name === "return") {
          const item = items[state.commandMenuIndex()];
          if (item !== undefined) {
            if (item.action.kind === "openEditor") {
              void host.openInEditor(item.action.path, item.action.line, item.action.mode);
            } else {
              state.dispatchCommandAction(item.action);
            }
          }
          state.closeCommandMenu();
        }
        return;
      }

      if (state.fileComboboxOpen()) {
        if (key.name === "escape") {
          state.setFileComboboxOpen(false);
        } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
          state.setFileComboboxIndex(
            Math.min(
              state.fileComboboxIndex() + 1,
              Math.max(0, state.fileComboboxResults().length - 1),
            ),
          );
        } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
          state.setFileComboboxIndex(Math.max(state.fileComboboxIndex() - 1, 0));
        }
        return;
      }

      // The theme picker owns the keyboard while open (like the palette): nav here
      // Previews live, text/submit are the input's job. Escape reverts to the
      // Theme open captured; enter (the input's onSubmit) commits the highlighted one.
      if (state.themeComboboxOpen()) {
        if (key.name === "escape") {
          state.closeThemePicker(false);
        } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
          state.setThemeComboboxIndex(
            Math.min(
              state.themeComboboxIndex() + 1,
              Math.max(0, state.themeComboboxResults().length - 1),
            ),
          );
        } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
          state.setThemeComboboxIndex(Math.max(state.themeComboboxIndex() - 1, 0));
        }
        return;
      }

      // The search view's sub-focus routing while it is the focused pane: esc,
      // The tab cycle, and the query toggles are handled for every sub-focus;
      // Text and submit (the jump) are the input elements' job (like the
      // Palette). Only the input sub-focuses swallow the remaining keys (they
      // Own printable characters); results focus has no input, so unhandled
      // Keys fall through and the global bindings (q, ?, ctrl-p, p...) keep
      // Working, matching the problems pane. With the tree focused, keys fall
      // Through to the tree branch while the view stays on screen.
      if (state.mainView() === "search" && state.focusedPane() === "search") {
        if (key.name === "escape") {
          state.closeSearch();
          return;
        }
        if (key.name === "tab") {
          // The focused input would swallow the tab as text otherwise.
          key.preventDefault();
          const order = ["query", "glob", "results"] as const;
          const step = key.shift ? -1 : 1;
          const at = order.indexOf(state.searchFocus());
          state.setSearchFocus(order[(at + step + order.length) % order.length] ?? "query");
          return;
        }
        // Toggle chords live on keys the input's readline set does not own
        // (ctrl-a/ctrl-e stay line home/end for editing): ctrl-r regex,
        // Ctrl-x exact case, ctrl-g changes<->repo, ctrl-s the scope picker.
        if (key.ctrl && key.name === "r") {
          state.toggleSearchRegex();
          return;
        }
        if (key.ctrl && key.name === "x") {
          state.toggleSearchCase();
          return;
        }
        if (key.ctrl && key.name === "g") {
          state.toggleSearchScope();
          return;
        }
        // The diff scope (which changes "changed" means) is pickable without
        // Leaving the pane; the ScopeMenu branch earlier in the chain owns the
        // Keys once open, and a pick reruns the search via the git-model dep.
        if (key.ctrl && key.name === "s") {
          openScopeMenu();
          return;
        }
        if (state.searchFocus() !== "results") {
          // Query/glob focus: down enters the results; ctrl-b still reaches the
          // Sidebar (VS Code precedent, preventDefault stops the input's
          // Move-left); ctrl-p falls through to the palette; everything else
          // Is the input's (its readline chords included).
          if (key.name === "down" || (key.ctrl && key.name === "n")) {
            state.setSearchFocus("results");
            return;
          }
          if (key.ctrl && key.name === "b") {
            key.preventDefault();
            state.toggleSidebar();
            return;
          }
          if (!(key.ctrl && key.name === "p")) {
            return;
          }
        }
        if (state.searchFocus() === "results") {
          const items = state.searchItems();
          if (key.name === "j" || key.name === "down" || (key.ctrl && key.name === "n")) {
            state.moveSearchSelection(1);
            return;
          }
          if (key.name === "k" || key.name === "up" || (key.ctrl && key.name === "p")) {
            // At the first navigable row, up returns to the query field.
            const current = state.searchIndex();
            const previous = items.findLastIndex(
              (item, index) => index < current && isNavigableSearchItem(item),
            );
            if (previous === -1) {
              state.setSearchFocus("query");
            } else {
              state.moveSearchSelection(-1);
            }
            return;
          }
          if (key.ctrl && key.name === "d") {
            state.pageSearchSelection(1);
            return;
          }
          if (key.ctrl && key.name === "u") {
            state.pageSearchSelection(-1);
            return;
          }
          if (key.name === "return") {
            const item = items[state.searchIndex()];
            if (item?.kind === "header") {
              state.toggleSearchGroup(item.path);
            } else {
              state.jumpToSearchItem(state.searchIndex());
            }
            return;
          }
          if (key.name === "h" || key.name === "left" || key.name === "l" || key.name === "right") {
            const item = items[state.searchIndex()];
            if (item !== undefined && item.kind !== "gap") {
              const collapse = key.name === "h" || key.name === "left";
              // A visible line row means its group is expanded; only headers can
              // Already be collapsed.
              const collapsed = item.kind === "header" && item.collapsed;
              if (collapse !== collapsed) {
                state.toggleSearchGroup(item.path);
              }
            }
            return;
          }
          if (key.name === "g" && !key.shift) {
            const first = items.findIndex(isNavigableSearchItem);
            if (first !== -1) {
              state.setSearchSelection(first);
            }
            return;
          }
          if (key.name === "G" || (key.name === "g" && key.shift)) {
            const last = items.findLastIndex(isNavigableSearchItem);
            if (last !== -1) {
              state.setSearchSelection(last);
            }
            return;
          }
          // E/o and y retarget from the hidden viewer to the selected result: open
          // It in the editor, or copy its reference (a match carries its column).
          if (key.name === "e" || key.name === "o") {
            const item = items[state.searchIndex()];
            if (item !== undefined && item.kind !== "gap") {
              void host.openInEditor(
                item.path,
                item.kind === "line" ? item.line : undefined,
                key.name === "e" ? "terminal" : "ide",
              );
            }
            return;
          }
          if (key.name === "y" && !key.shift) {
            const item = items[state.searchIndex()];
            if (item?.kind === "header") {
              state.copy(formatCopyReference({ path: item.path }));
            } else if (item?.kind === "line") {
              state.copy(
                formatCopyReference({
                  column: item.match?.column,
                  line: item.line,
                  path: item.path,
                }),
              );
            }
            return;
          }
          // Unhandled in results focus: fall through to the global bindings.
        }
      }

      // The references overlay owns the keyboard while open. It has no input, so Enter
      // Jumps to the highlighted result here (the search overlay delegates that to its
      // Input's onSubmit); nav clamps over the result set, escape closes.
      if (state.referencesOpen()) {
        if (key.name === "escape") {
          state.closeReferences();
        } else if (key.name === "return") {
          state.jumpToReference(state.referencesIndex());
        } else if (key.name === "tab") {
          // Flip a call hierarchy's direction (incoming↔outgoing) in place; a no-op for
          // References/definitions, which carry no direction.
          state.toggleReferencesDirection();
        } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
          state.setReferencesIndex(
            Math.min(
              state.referencesIndex() + 1,
              Math.max(0, state.referencesResults().length - 1),
            ),
          );
        } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
          state.setReferencesIndex(Math.max(state.referencesIndex() - 1, 0));
        }
        return;
      }

      // The symbol outline overlay owns the keyboard while open, mirroring the references
      // Overlay: no input, so Enter jumps to the highlighted symbol; nav clamps, escape closes.
      if (state.symbolsOpen()) {
        if (key.name === "escape") {
          state.closeSymbols();
        } else if (key.name === "return") {
          state.jumpToSymbol(state.symbolsIndex());
        } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
          state.setSymbolsIndex(
            Math.min(state.symbolsIndex() + 1, Math.max(0, state.symbolsResults().length - 1)),
          );
        } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
          state.setSymbolsIndex(Math.max(state.symbolsIndex() - 1, 0));
        }
        return;
      }

      // A caret-anchored decoration (the hover card) is dismiss-on-esc, claiming the
      // Key before the find and global esc handlers; any caret move already closes it.
      if (state.viewerDecoration() !== undefined && key.name === "escape") {
        state.closeViewerDecoration();
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
      // Only while the file view is showing: with the search view up, cycling
      // Would move the cursor of a diff that isn't on screen.
      if (state.findActive() && state.mainView() === "file") {
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
        state.openFileCombobox();
        return;
      }

      // Opens (or refocuses) the search view; the query and results persist, so
      // Reopening after a jump restores the result set instead of clearing it.
      if (key.ctrl && key.name === "f") {
        state.openSearch();
        return;
      }

      // Only while the file view is showing: the find bar's input lives inside
      // The Viewer's file branch, so opening it under the search view would
      // Focus an unmounted input and wedge the keyboard.
      if (key.name === "/" && state.diffView() !== undefined && state.mainView() === "file") {
        // Solid mounts and focuses the find input within this same key event, so
        // Without preventDefault the triggering "/" would be typed into it.
        key.preventDefault();
        state.resetFind();
        state.setFindOpen(true);
        state.setFocusedPane("diff");
        return;
      }

      if (key.name === "q") {
        host.quit();
        return;
      }

      if (key.name === "escape") {
        // Esc closes panels innermost-first: the problems panel, then the
        // Search view left on screen with the tree focused, then the app.
        if (state.problemsOpen()) {
          state.setProblemsOpen(false);
          if (state.focusedPane() === "problems") {
            state.setFocusedPane("tree");
          }
          return;
        }
        if (state.mainView() === "search") {
          state.closeSearch();
          return;
        }
        host.quit();
        return;
      }

      if (key.name === "tab") {
        // From the tree, tab lands on whichever view the main area shows.
        state.setFocusedPane(
          state.focusedPane() === "tree"
            ? state.mainView() === "search"
              ? "search"
              : "diff"
            : "tree",
        );
        return;
      }

      if (key.name === "p") {
        const open = state.problemsOpen();
        state.setFocusedPane(open ? "tree" : "problems");
        state.setProblemsOpen(!open);
        if (!open) {
          state.setProblemIndex(state.firstNavigableProblemIndex());
        }
        return;
      }

      // Ctrl-b (not a plain b) so the toggle also works while the search pane's
      // Inputs own the printable keys.
      if (key.ctrl && key.name === "b") {
        state.toggleSidebar();
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
        state.setHelpDialogOpen(true);
        return;
      }

      // Tabs. ctrl-t/ctrl-w must precede the plain t (theme) and w (worktree)
      // Handlers below, which match on name without excluding ctrl. Both gate on
      // The file view: they mutate a tab strip the search view hides (the pure
      // Navigations { and } stay live, since cycling reveals the file view).
      if (key.ctrl && key.name === "t" && state.mainView() === "file") {
        state.togglePinActiveTab();
        return;
      }

      if (key.ctrl && key.name === "w" && state.mainView() === "file") {
        state.closeActiveTab();
        return;
      }

      if (key.name === "{") {
        state.cycleTab(-1);
        return;
      }

      if (key.name === "}") {
        state.cycleTab(1);
        return;
      }

      if (key.name === "w") {
        // Solid mounts and focuses the picker's filter input within this same key
        // Event, so without preventDefault the triggering "w" would be typed into it.
        key.preventDefault();
        state.setWorktreeComboboxOpen(true);
        state.setWorktreeComboboxIndex(0);
        state.setWorktreeComboboxQuery("");
        state.setWorktrees(undefined);
        state.loadWorktrees(state.gitModel().repoRoot);
        return;
      }

      // Find symbols in the open file, an outline overlay. A bare uppercase S ("Symbols"), not the
      // IDE-standard Ctrl+Shift+O: a control key can't reliably carry Shift across terminals (a bare
      // 0x0F on Terminal.app/VHS, an unsolicited CSI-u on cmux), so the Shift is lost, whereas a
      // Plain letter always arrives. It sits immediately ahead of the plain-s scope picker so it
      // Wins Shift+S where a terminal reports it as { name: "s", shift }; a plain s, or a Shift+S
      // Outside the file view, falls through to the scope picker below. The action guards itself.
      if ((key.name === "S" || (key.name === "s" && key.shift)) && state.mainView() === "file") {
        void state.findSymbols();
        return;
      }

      if (key.name === "s") {
        openScopeMenu();
        return;
      }

      if (key.name === "t") {
        // Solid mounts and focuses the picker's filter input within this same key
        // Event, so without preventDefault the triggering "t" would be typed into it.
        key.preventDefault();
        state.openThemePicker();
        return;
      }

      if (key.name === "c") {
        const current = state.changesOnly();
        state.setChangesOnly(!current);
        state.notify(current ? "all files" : "changes only");
        return;
      }

      if (key.name === "x" && !key.ctrl && state.mainView() === "file") {
        const wrapping = state.overflow() === "wrap";
        state.setOverflow(wrapping ? "scroll" : "wrap");
        state.notify(wrapping ? "wrap off" : "wrap on");
        return;
      }

      if (key.name === ".") {
        const latest = latestActivity(state.activityLog());
        if (latest !== undefined) {
          state.selectFile(latest.path);
        }
        return;
      }

      if (key.name === "<") {
        state.goBack();
        return;
      }

      if (key.name === ">") {
        state.goForward();
        return;
      }

      // Open the context menu on the focused pane (Shift+F10, the IDE-standard "show
      // Context menu" key). The tree menu works from tree focus; the viewer menu only
      // While the file view is on screen (its intel/copy actions need a caret).
      if (key.name === "f10" && key.shift) {
        const pane = state.focusedPane();
        if (pane === "tree") {
          state.openCommandMenu("tree");
        } else if (pane === "diff" && state.mainView() === "file") {
          state.openCommandMenu("viewer");
        }
        return;
      }

      const selectedPath = state.selectedPath();

      // File-view keys act only while the file view is on screen: with the
      // Search view up they would mutate or read a viewer the user cannot see
      // (the results branch above retargets e/o/y to the selected result).
      const fileViewShowing = state.mainView() === "file";

      if (
        key.name === "v" &&
        fileViewShowing &&
        state.selectedFile() !== undefined &&
        selectedPath !== undefined
      ) {
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

      if (key.name === "f" && fileViewShowing && selectedPath !== undefined) {
        state.loadFullContent();
        return;
      }

      if (key.name === "e" && fileViewShowing && selectedPath !== undefined) {
        const line = state.navigableLines()[state.cursorIndex()];
        const lineNumber = line?.newLine ?? line?.oldLine;
        void host.openInEditor(selectedPath, lineNumber, "terminal");
        return;
      }

      if (key.name === "o" && fileViewShowing && selectedPath !== undefined) {
        const line = state.navigableLines()[state.cursorIndex()];
        const lineNumber = line?.newLine ?? line?.oldLine;
        void host.openInEditor(selectedPath, lineNumber, "ide");
        return;
      }

      // Go to definition of the symbol under the caret (IDE-standard F12). The action reads the
      // Caret from state and guards itself, so it's safe to dispatch globally.
      if (key.name === "f12" && !key.shift && fileViewShowing) {
        void state.goToDefinition();
        return;
      }

      // Find references to the symbol under the caret (IDE-standard Shift+F12). Opens the
      // Results overlay; the action reads the caret from state and guards itself.
      if (key.name === "f12" && key.shift && fileViewShowing) {
        void state.findReferences();
        return;
      }

      // Hover (type + docs) for the symbol under the caret, in a caret-anchored card
      // (Shift+K, the established LSP hover key). The action reads the caret and guards itself.
      if ((key.name === "K" || (key.name === "k" && key.shift)) && fileViewShowing) {
        void state.showHover();
        return;
      }

      // Call hierarchy for the symbol under the caret (Shift+H): who calls this / what this calls,
      // In the references overlay with a Tab direction toggle. Bare uppercase like Shift+K, chosen
      // Over Ctrl+F12 since modified F-keys aren't portably delivered. The action guards itself.
      if ((key.name === "H" || (key.name === "h" && key.shift)) && fileViewShowing) {
        state.callHierarchy();
        return;
      }

      // Find implementations for the symbol under the caret (Shift+I): a concrete symbol jumps to its
      // Single implementation, an interface/abstract member lists every concrete body in the
      // References overlay. Bare uppercase like Shift+K/Shift+H. The action guards itself.
      if ((key.name === "I" || (key.name === "i" && key.shift)) && fileViewShowing) {
        void state.findImplementations();
        return;
      }

      if ((key.name === "Y" || (key.name === "y" && key.shift)) && fileViewShowing) {
        state.copyFileContents();
        return;
      }

      if (key.name === "y" && !key.shift) {
        if (state.focusedPane() === "tree") {
          const row = state.treeRows()[state.focusedRowIndex()];
          if (row !== undefined) {
            state.copy(formatCopyReference({ path: row.node.path }));
          }
          return;
        }
        if (selectedPath !== undefined && fileViewShowing) {
          const line = state.navigableLines()[state.cursorIndex()];
          const lineNumber = line?.newLine ?? line?.oldLine;
          state.copy(
            formatCopyReference({
              // Emit the exact column unless the caret is line-level (a gutter
              // Click), which copies path:line. `caretColumn` keeps the precise
              // Column even when it lands in a gap.
              column: lineNumber === undefined ? undefined : state.caretColumn(),
              line: lineNumber,
              path: selectedPath,
            }),
          );
        }
        return;
      }

      const focusedPane = state.focusedPane();

      if (focusedPane === "problems") {
        const items = state.allProblemItems();
        const current = state.problemIndex();
        if (key.name === "j" || key.name === "down") {
          const next = items.findIndex(
            (item, index) => index > current && isNavigableProblemItem(item),
          );
          if (next !== -1) {
            state.setProblemIndex(next);
          }
        } else if (key.name === "k" || key.name === "up") {
          const previous = items.findLastIndex(
            (item, index) => index < current && isNavigableProblemItem(item),
          );
          if (previous !== -1) {
            state.setProblemIndex(previous);
          }
        } else if (key.name === "return") {
          const item = items[state.problemIndex()];
          if (item?.kind === "problem") {
            const { problem } = item;
            state.selectFile(
              problem.path,
              problem.line === undefined
                ? undefined
                : { column: problem.column, escalate: true, line: problem.line },
            );
            state.setFocusedPane("diff");
          }
        }
        return;
      }

      if (focusedPane === "diff") {
        const last = state.navigableLines().length - 1;
        const halfPage = Math.max(1, Math.floor(state.viewerHeight() / 2));
        if (key.name === "j" || key.name === "down") {
          state.setCursorRow(Math.max(0, Math.min(state.cursorIndex() + 1, last)));
        } else if (key.name === "k" || key.name === "up") {
          state.setCursorRow(Math.max(state.cursorIndex() - 1, 0));
        } else if (key.ctrl && key.name === "d") {
          state.setCursorRow(Math.max(0, Math.min(state.cursorIndex() + halfPage, last)));
        } else if (key.ctrl && key.name === "u") {
          state.setCursorRow(Math.max(state.cursorIndex() - halfPage, 0));
        } else if (key.name === "g" && !key.shift) {
          state.setCursorRow(0);
        } else if (key.name === "g" || key.name === "G") {
          state.setCursorRow(Math.max(0, last));
        } else if (key.name === "l" || key.name === "right") {
          state.caretNextWord();
        } else if (key.name === "h" || key.name === "left") {
          // The caret hops words; `tab` is the way back to the tree (a no-op here
          // At the first word). h no longer focuses the tree.
          state.caretPrevWord();
        } else if (key.name === "z") {
          // Fold/unfold the region at the caret (an indent block or a git-elided gap).
          state.toggleRegionAtCaret();
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
