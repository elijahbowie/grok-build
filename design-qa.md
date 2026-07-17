# New Agent Design QA

- Source visual truth: `web/design-audit/new-agent/04-cursor-reference.png`
- Implementation screenshots: `web/design-audit/new-agent/11-cursor-final-1280.png`, `web/design-audit/new-agent/12-cursor-final-724.png`, `web/design-audit/new-agent/10-cursor-final-390.png`
- Full-view comparison: `web/design-audit/new-agent/13-reference-vs-final.png`
- Viewports: 1280 × 720, 724 × 858, and 390 × 844
- State: empty New Agent composer, default Build now / grok-4.5 / Isolated write / This Mac configuration

## Comparison Scope

The Cursor source is an active-agent screen rather than its empty New Agent state. It is therefore the visual-language target for shell density, bottom composer placement, control treatment, contrast, and quiet-workspace hierarchy—not a pixel-identical content target.

## Findings

No actionable P0, P1, or P2 mismatches remain.

- Fonts and typography: Inter/system UI treatment, compact 11–14px control/body roles, and subdued metadata match the reference's editor-native density. The scope note remains legible at the tested narrow view.
- Spacing and layout rhythm: the desktop composer is 134px tall and bottom anchored; the 724px configuration reflows into a separate compact row; the 390px configuration becomes a 2 × 2 grid without horizontal overflow.
- Colors and visual tokens: near-black canvas, quiet gray borders, pale focus ring, and monochrome control hierarchy track the Cursor source without decorative gradients or shadows.
- Image quality and asset fidelity: no raster imagery is required on this screen. Existing product icons are preserved; no placeholder or CSS-drawn visual assets were introduced.
- Copy and content: the task prompt is primary. Repository, branch, mode, model, access, compute, and bounded-autonomy consequences remain visible before submission.
- Interaction/accessibility: the textarea and submit control retain accessible names, selects remain semantic comboboxes, keyboard clearing restores the disabled submit state, focus remains visible, and reduced-motion behavior is preserved.

Focused-region comparison was not needed because the composer and all controls are fully visible in the full-view comparison and the separate 724px/390px captures provide readable responsive evidence.

## Comparison History

### Revision 1 — 84/100, blocked

- Composer was approximately 210px tall and split into three visually heavy bands.
- Submit target was 30 × 30px and operational copy was too small.
- Configuration roles depended too heavily on prior knowledge.

### Revision 2 — fixes and post-fix evidence

- Reduced the desktop composer to 134px and merged configuration, repository context, and submit into a compact footer.
- Increased submit diameter to 36px desktop and 40px mobile while preserving its Cursor-like circular treatment.
- Increased scope and repository text sizes and added descriptive control titles without adding resting chrome.
- Added four-column → separate four-column → 2 × 2 responsive configuration behavior at the tested breakpoints.
- Independent fresh-agent score: 92/100, with no critical usability or accessibility blocker.

## Verification

- Prompt entry enables Start agent; keyboard clearing disables it again.
- Mode selection changes to Plan, then approve and returns to Build now.
- JavaScript syntax check passed.
- CSS parse/minification check passed.
- Browser console warnings/errors: none.

## Follow-up Polish

- P3: enlarge the invisible hit area around the circular submit control to 44 × 44px without changing its visual diameter.
- P3: add hover/focus tooltips for configuration roles if first-use testing shows ambiguity.

final result: passed
