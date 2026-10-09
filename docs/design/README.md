# Design system files

`design-system.md` is a verbatim copy of `references/design-system.md` from the
`flock-design-system` skill (Flock Design System v1.1). The runtime copies live in:

- `src/styles/flock/tokens.css` — verbatim copy of the skill's `assets/tokens.css`.
- `public/brand/flock-logo.svg`, `flock-mark.svg`, `flock-mark-white.svg` — verbatim logo copies.

Do not edit these copies by hand; refresh them from the skill instead.

`src/styles/flock/tokens-app.css` is the only app-owned token file. It names, as CSS variables,
values that the reference documents only in comments or component specs (state triplets,
button hover colors, type scale, spacing, radius scale). It adds no new design values.
