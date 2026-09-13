# Guided experience design QA

## Comparison target

- Source visual truth: `frontend/images/stage.png` (1536 × 1024 PNG), the
  generated midnight-blue stage image used by the welcome screen.
- Implementation: browser-rendered welcome screen at `http://localhost:3220/`,
  captured in the in-app browser on 2026-09-13. The local browser screenshot is
  not persisted to the repository.
- Viewport: 1440 × 960 CSS pixels at device scale factor 1. The source image is
  displayed as a cover background with a dark left-to-right overlay, which is an
  intentional crop/tone treatment for readable copy.
- State: initial welcome screen before authentication; guided/classic route
  choices visible.

## Evidence and visual check

The source stage asset and rendered welcome screen were both opened and inspected.
The rendered page preserves the source focal point: dancer, metallic columns and
electric-blue stage lighting sit to the right; the left side remains clear for the
headline and route choices. The midnight background, pale-blue accent, silver
borders and glass-like controls carry into the authenticated workspace.

Focused regions were the welcome headline/choice cards and the source dancer/crop.
The full source and implementation could not be joined into a single comparison
image: the browser security policy rejected the temporary comparison-page URL.
That limitation prevents a compliant final visual-comparison pass.

## Required fidelity surfaces

- **Fonts and typography:** System UI type is consistent and legible. The welcome
  headline has a stronger display scale and tracking; eyebrow labels use tighter,
  higher-contrast small caps. No clipping or wrapping issue was observed at the
  verified desktop or 390 px mobile viewport.
- **Spacing and layout rhythm:** The hero maintains a clear left copy/right art
  split. The two entrance panels share alignment, padding and radius. The guided
  five-step navigation and classic workspace both fit within the checked mobile
  width without horizontal overflow.
- **Colors and visual tokens:** The midnight-blue background, pale text, electric
  blue primary action and silver-blue borders align with the stage image. Existing
  semantic success/warning/error colors remain readable in the classic workspace.
- **Image quality and asset fidelity:** The implementation uses the original
  generated stage raster at its intended full-bleed position. No placeholder or
  code-drawn replacement is used for the visible scene.
- **Copy and content:** The welcome copy describes the actual path. Guided controls
  explicitly distinguish implemented audio mixing from unimplemented beat matching,
  lyric alignment, lip-sync and Higgsfield integration.

## Findings

No actionable P0, P1 or P2 issue was observed in the separate rendered checks.

- [P3] A persisted implementation screenshot would make future pixel-level design
  comparisons repeatable.
  Location: QA evidence workflow.
  Evidence: the browser capture can be viewed during the session but was not saved
  as a workspace artifact.
  Impact: no product behavior or user-facing layout issue.
  Fix: add a permitted browser-capture export route when repeatable design QA is
  needed.

## Primary interactions checked

- Welcome → Guided experience → password gate → Character → Sound → Motion →
  Frame → Create.
- Character generation, encrypted asset save, MP3/WAV upload, landscape framing,
  mock video completion, library save and video download.
- Guided → Classic workspace, and the classic workspace controls remained usable.
- Mobile viewport at 390 px: page width matched viewport width and no broken images
  were reported.

## Implementation checklist

- [x] Preserve the classic workspace behind its own entrance.
- [x] Add the guided five-stage flow and its working queue integration.
- [x] Use the stage asset at the welcome route and the shared visual tokens.
- [x] Validate desktop/mobile behavior and primary interactions in the browser.
- [ ] Repeat the comparison with a browser-exported implementation image if
  pixel-level visual sign-off is required.

## Comparison history

- 2026-09-13: separate source and implementation inspection found no actionable
  visual defect. A composite comparison was blocked by browser URL policy, so no
  design fix iteration could be completed.

final result: blocked
