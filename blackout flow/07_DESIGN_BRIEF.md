# BLACKOUT — design direction (not copied from reference)

## Intent

Design a distinctive, clean, editorial product rather than a generic AI dashboard or cyberpunk interface. The user shared four visual reference screenshots only to demonstrate the level of composition/polish, **not** to reproduce layouts, copy, colors, brand, or imagery. Professional, engaging, purposeful.

## Positive principles

- Strong typography and alignment; generous but controlled negative space; clear content hierarchy.
- Functional information density during gameplay, calm restraint on landing/report screens.
- Small coherent color system; accents correspond to interaction or severity, not decoration.
- Cards/panels only where they group meaningful content; avoid dashboard card proliferation.
- Consistent grid, optical icon stroke weight, alpha borders, concentric radius for nesting.
- Responsive heading sizes via `clamp`; predictable line height, sensible truncation and underlines.
- Motion only for feedback and transitions; 150–250ms typical entry, quicker exits; no bouncy routine controls; reduced-motion support.
- Effective empty/loading/offline/permission states, readable contrast, tab order and focus rings.

## Negative rules

- No neon green matrix aesthetic, glowing charts, purple/blue gradients by default, fake threat graphs, decorative floating particles, excessive glassmorphism or terminal filler.
- No direct imitation of supplied reference screenshot or recognizable third-party brand layout.
- No mandatory animation for vital alerts or color-only status indication.

## Layout concepts requiring design approval

1. Landing: short premise, large typographic focal point, restrained invitation to create or join.
2. Lobby: roster and role selection as primary content, room info secondary.
3. Simulation: time/action hierarchy + event timeline + evidence/role information; adapt mobile via progressive disclosure.
4. Report: outcome first, then annotated timeline and consequences; support reading/printing without gimmicks.

## Resources user provided

A 141-line note detailing 43 typography, color, layout and animation rules (four @charles.unemployed videos). Treat as **heuristics**, not mandatory code on every surface. Notably: concentric radius, alpha borders, matched icon weight, dynamic viewport units, reserved bold width, underline offset, fluid type, attention to temperature contrast, short natural easing, no bounce, reduced motion.

## Design approval check

Do not proceed to broad UI production until the owner has seen the initial visual direction from real local screens. Avoid asking approval for every component.
