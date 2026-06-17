# Market Prism — Design & Development Standards

## Visual Design Language — MANDATORY

These rules apply to ALL UI work. Never deviate without explicit user approval.

### Display / Hero Font — CRITICAL
- **NEVER use a serif font ANYWHERE on the product** — not for hero titles, headings, accents, body, or fallbacks. No `Instrument Serif`, no `DM Serif Display`, no `Georgia`, no generic `serif`. See Banned Fonts below.
- Font: `'Inter', 'DM Sans', system-ui, sans-serif`
- Use for: page hero titles, section headers, any large editorial headline
- Style: font-weight 600–700 (Inter carries display weight through size + weight, never a serif face)
- Accent lines (e.g. "Every morning."): brand cyan `#4DC8F0`, weight 600 — do NOT use an italic serif
- Size: `clamp(28px, 3.2vw, 42px)` for primary, `clamp(32px, 3.8vw, 50px)` for large accent
- Letter-spacing: `-0.025em` (tight tracking for editorial feel)
- Section titles within pages: Inter at 24px, weight 700
- Panel titles: Inter at 18px, weight 600

### Font Stack
| Role | Font | Fallback |
|------|------|----------|
| Display / Hero | `Inter` (weight 600–700) | `DM Sans`, system-ui, sans-serif |
| Body / UI | `Inter` | `DM Sans`, system-ui, sans-serif |
| ~~Mono / Data~~ | **BANNED** — do not use `Geist Mono`, `DM Mono`, or any monospace font. Use `Inter` for all data/numbers. |
| Card Commands | `Anton` | Impact, sans-serif |

### Banned Fonts — NEVER USE
- **Any serif font — NEVER, ANYWHERE.** Specifically `Instrument Serif`, `DM Serif Display`, `Georgia`, and the generic `serif` family. Do not use them as a `font-family`, a fallback in a stack, or in a Google Fonts import. All headings/display use `Inter` (weight 600–700).
- `Geist Mono` — removed from codebase, do not reintroduce
- `DM Mono` — removed from codebase, do not reintroduce
- Any `monospace` font-family — all data, labels, badges, chart axes, and canvas text must use `Inter` or `var(--font-body)`
- Do not add serif or monospace fonts to Google Fonts imports
- Do not use `var(--font-mono)`, `var(--mono)`, or `var(--font-m)` CSS variables

### Font Size Minimums — NO EXCEPTIONS
- Body text / descriptions: minimum **13px**
- Labels / eyebrows / meta: minimum **11px**
- Numbers / values / prices: minimum **16px**
- Section headers: minimum **14px**
- Badges / tags: minimum **10px**
- ABSOLUTE MINIMUM: **10px** — nothing below this, ever
- When in doubt, go LARGER not smaller

### Card / Box Pattern (standard for all data containers)
- Background: `var(--mp-surface)` (`#0C1018`)
- Subtle grid-line overlay: 48px crosshatch at `rgba(255,255,255,0.03)`
- Border: `1px solid rgba(255,255,255,0.06)`, `border-radius: 16px`
- Colored accent bar: 2px strip at top edge, color = sentiment/category
- Padding: 20px (16px minimum on compact views)
- Drop shadow: `drop-shadow(0 4px 12px rgba(0,0,0,0.4))`
- Hover: border brightens to 0.14, shadow deepens, `-4px translateY`

### Color System

#### Background Tiers
```
--mp-obsidian:     #080B11    /* page bg */
--mp-surface:      #0C1018    /* card bg / panels */
--mp-surface2:     #111927    /* elevated surface */
--mp-border:       rgba(255,255,255,0.06)   /* default borders */
--mp-border-hover: rgba(255,255,255,0.14)   /* hover borders */
```

#### Text Hierarchy
```
--mp-text-primary:   #FFFFFF
--mp-text-secondary: rgba(255,255,255,0.7)
--mp-text-tertiary:  #A0A8B0
--mp-text-muted:     rgba(255,255,255,0.3)
```

#### Brand Accents
```
--mp-cyan:    #00AEFF    /* primary brand / neutral sentiment */
--mp-teal:    #38C8B8    /* epic rarity / supported */
--mp-green:   #00DE94    /* bullish / surging */
--mp-red:     #FF4D4D    /* bearish / breaking */
--mp-amber:   #FFB800    /* common rarity / caution */
--mp-violet:  #7B61FF    /* uncommon rarity */
```

#### Sentiment System
```
Bull:    border #00DE94, glow rgba(0,222,148,0.12)
Bear:    border #FF4D4D, glow rgba(255,77,77,0.12)
Neutral: border #00AEFF, glow rgba(0,174,255,0.12)
```

#### Rarity System
```
Common:   #A0A8B0  (muted gray)
Uncommon: #00AEFF  (cyan-blue)
Rare:     #38C8B8  (teal)
Epic:     #00DE94  (green)
```

### Layout Principles
- Single-column flow within cards (no side-by-side cramming)
- Clear visual hierarchy: identity → data → action → context → status
- Use small horizontal dividers to separate sections, not just spacing
- Stat grids: equal-width CSS grid columns, generous gap (16px+)
- No overlapping — if elements don't fit, stack them vertically
- Card padding: minimum 16px (20px preferred)
- Section gaps: minimum 20px
- Line height for body text: minimum 1.5

### Trading Card Specifics
- Card width: minimum 260px
- Ticker: 18px bold
- Company name: 13px
- Price: 18px mono
- Change %: 12px
- Command/bias: 18px semibold uppercase
- Meta line: 12px
- Context: 13px with line-height 1.5
- Rarity badge: 10px with adequate padding (4px 10px)
- State tag: 11px
- View button: 11px

### Light Theme
- When overriding for `[data-theme="light"]`, maintain the same size minimums
- Card backgrounds become `var(--mp-surface)` with subtle box-shadow instead of border glow
- Text colors invert appropriately but hierarchy stays the same

## Development Practices

### File Structure
- `_template.html` — Daily dashboard (main template)
- `_ticker.html` — Individual ticker pages
- `_home.html` — Landing / marketing page
- All CSS is inline within each HTML file (no external stylesheets)

### When Modifying CSS
- Always read the existing styles before changing them
- Bump font sizes UP to meet minimums, never shrink them
- If increasing a font causes overflow, fix the container — don't reduce the font
- Test changes don't break responsive breakpoints (@media queries)
- Preserve existing animations, transitions, and hover effects
