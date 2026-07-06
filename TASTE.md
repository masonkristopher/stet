# TASTE.md

The README is the source of truth for what stet does, AGENTS.md holds the code and UI conventions, and SPEC.md the behavioral invariants. This file holds the craft bar every interface surface clears: how it should feel, not what it does. Read it before adding or reworking any UI surface.

The rules are stack-agnostic. Where one is specific to a graphical or web platform, it is restated for stet's medium: a terminal of fixed monospace cells, theme tokens, no shadows or blur, keyboard-first with the mouse as enhancement. Optimize for one outcome: the result should feel inevitable, as if it was always meant to look this way.

## 0. Operating principles

- Make it fast, consistent, careful, timeless, soulful.
- The last 5% is the work. If the polish is not shipped, it is not shipped.
- Default to less. Add nothing that does not earn its place. Then remove one more thing.
- Design against the trend cycle. It should look right in five years, not this quarter.
- Feeling is a spec. If it feels off, it is off, even when you cannot name why. Fix it.
- Taste is judgment under constraint. When unsure, choose the more restrained option.
- Consistency beats cleverness. The same problem gets the same solution everywhere.

## 1. Typography

- Type carries the interface. Get it right before anything else.
- In a terminal the typeface is the user's monospace, not yours to choose. You control weight, color, and spacing; lean on those, never on a font swap.
- Build a clear hierarchy from a small set of moves (weight, color, spacing), not from sizes a fixed cell will not give you.
- Keep lines readable. Do not stretch prose to the full pane width; reserve space at the edges.
- One or two weights cover most UI. Regular and medium. Reserve bold for rare emphasis.
- Use tabular figures for anything that aligns in columns or updates in place; in a monospace this is free, so never break the column.
- Left-align text. Never justify. Never center long text.

## 2. Color

- Start in grayscale. If it works with color off, color is enhancement, not a crutch.
- Few colors. One accent. Neutrals do the heavy lifting.
- Define color by role, not by hue: background, surface, border, text, muted, accent, danger. These are theme tokens in `src/theme`, never hardcoded hex at a call site.
- Build ramps in a perceptual color space so steps feel evenly spaced.
- Keep text and UI marks legible against their surface; treat a comfortable contrast as a floor, not a target.
- Borders and dividers should be barely there. Low-contrast separation reads as calm.
- Dark mode is not inverted light mode. Re-derive it. Soften white text, lower saturation.
- Never signal state by color alone. Pair it with a glyph, text, or shape, so it reads under `NO_COLOR` and for colorblind users.

## 3. Space and layout

- All spacing comes from one scale. No arbitrary one-off gaps.
- Whitespace is a material. Generous negative space is a feature, not waste.
- Separate with space before reaching for borders or boxes. Proximity groups; lines clutter.
- Align everything to the cell grid. Optical nudges are allowed, random offsets are not.
- Keep rhythm: the gap between related items is smaller than the gap between groups.
- Match density to the task. Dense for the tree and problems list, calmer for overlays. Do not mix the two in one surface.
- Keep chrome consistent: the overlay family shares one box, one width, one footer hint.

## 4. Motion

- Motion serves meaning. It shows where something came from or where it went. If it does neither, cut it.
- A terminal has little motion to spend, so default to none and add deliberately. Most state changes are a clean swap, not an animation.
- Keep any motion fast. Slower feels broken.
- Move what carries meaning, and leave layout fixed. Never resize or reflow as an effect: a width or gutter that oscillates frame to frame thrashes layout and can wedge the renderer's scheduler (the fixed-width diff gutter exists for exactly this).
- Motion is interruptible. A new user action redirects it, it does not queue behind it.
- Motion is always optional. Honor a reduced-motion intent and keep a non-motion path; in a terminal that path is the default.

## 5. Interaction and state

- Every interactive element has all states designed: default, hover, focus, active, disabled, loading, error.
- Empty states are real screens. Design them. Never leave a blank pane.
- Show structure immediately rather than a spinner. stet paints its shell from the empty model and fills it in as git resolves; follow that pattern for any async surface.
- Focus is non-negotiable and keyboard-first. The focused pane, row, or input is always visibly marked (a caret, a selection highlight, focused input colors), never left to guess.
- Make hit targets generous. The whole row or cell is clickable, not just the glyph; pad the interactive area beyond the visible mark.
- Acknowledge every action right away, even when the result takes longer.
- Preserve selection, cursor, and scroll position. Never make someone redo work after a refresh or an error.
- Disabled is a last resort. Prefer explaining why an action is unavailable over silently graying it out.
- Do not rely on hover for anything essential. It is a mouse-only enhancement, and the keyboard must reach everything without it.

## 6. Performance

- Performance is part of the design. A slow interface is an ugly interface.
- Budget the critical path. The first interaction should feel immediate; the git-backed tree renders before any checker resolves.
- Stay within the frame budget or do not animate. Drop the effect before you ship jank.
- Reserve space for async content. No layout shift.
- Render only what is visible plus a small overscan; window long content rather than building every row.
- Debounce and throttle expensive handlers. Input must never feel laggy.

## 7. Copy

- Write the UI like a person wrote it. Plain, direct, short.
- Label actions with the verb of what happens. "Switch scope," not "OK."
- Error messages say what went wrong and what to do next. No codes, no blame.
- Use sentence case almost everywhere. Title Case reads as marketing.
- Cut words. If a sentence works without a word, remove it.
- Tone is calm and competent. No jargon, no cleverness that costs clarity.

## 8. Detail and polish

- Sweat alignment to the cell. Columns, gutters, and glyphs line up exactly; misalignment is the most common tell of low craft.
- Check every state at every terminal size. The bug lives in the narrow pane and the collapsed sidebar as much as the wide one.
- Test with real content: the longest path, the empty list, the binary file, the missing target.
- Icons share one weight and size, optically centered. A mixed glyph set breaks the spell.
- Keep spacing, borders, and chrome identical across the whole product.
- A terminal has no shadows or blur to lean on. Separate with space and a barely-there border, and build hierarchy from contrast, weight, and position.
- If a choice draws attention to itself, question it. The interface should feel inevitable.

## 9. Accessibility

- Keyboard-operable end to end. Focus order follows visual order.
- There is no DOM or ARIA in a terminal. The accessibility surface is `NO_COLOR`, `FORCE_COLOR`, and the absence of a Nerd Font; carry meaning in text and glyphs so it survives all three.
- Meaningful glyphs and icons carry a text fallback (stet's icons are monochrome and `--no-icons` drops them); decorative ones add nothing a reader must announce.
- Trap focus only in overlays, and return it to where it came from on close.
- Test each surface with color and icons off (`NO_COLOR=1`, `--no-icons`) at least once. If it still reads, it is accessible.

## What not to do

- Do not reach for color, a louder glyph, or a heavier border to make something pop. Fix the hierarchy with space and weight instead.
- Do not ship five accent colors, mismatched glyph sets, and inconsistent spacing.
- Do not animate everything.
- Do not center or justify body text.
- Do not take away the focus or selection mark and leave nothing in its place.
- Do not chase the current trend. It dates the fastest.
