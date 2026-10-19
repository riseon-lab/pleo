# Character Studio design QA

**final result: passed**

## Evidence and comparison state

- Source visual truth: `/Users/danielgerry/.codex/generated_images/01a09b8d-c0e2-75d0-9d74-36d7eb1b5dff/exec-c2607be6-d5ae-4db8-899c-180defad3981.png` (the user's selected option 3, 1487 × 1058 pixels).
- Implementation: `http://127.0.0.1:3220/#/running`, isolated local mock data, authenticated.
- Final desktop capture: `/tmp/pleo-studio-desktop-final.png` (1440 × 1015 pixels). Browser CSS viewport 1440 × 1024, device pixel ratio 1. The browser capture omits the bottom 9 pixels; the visible Generate button is complete. The source has effectively the same aspect ratio as the requested CSS viewport. Comparison uses relative layout at the same display width, without attributing the capture margin to design drift.
- Phone captures: `/tmp/pleo-studio-mobile-final.png` and `/tmp/pleo-studio-mobile-workbench-final.png` (390 × 844 pixels; CSS viewport 390 × 844; density 1).
- Additional fit checks: 320 × 740 and 768 × 1024 CSS pixels. Document width matched viewport width at all four widths.
- Desktop state: Image, full-body/three-quarter/standing, tailored outfit, soft daylight, two LoRA entries (one paused), one saved direction, portrait 4:5. The central portrait is explicitly an example, not a result of those controls. The mock's character identity and Qwen selection are conceptual; the implementation displays the actual selected local model.

The source and rendered desktop captures were opened together in the same comparison input, first before the spacing fix and again after it. Typography, navigation, left controls, right summary and selector labels were readable in those full-resolution inputs, so separate cropped region comparisons were unnecessary. The phone's preview and workbench were inspected in separate native-resolution captures because they occupy different scroll positions.

## Findings and comparison history

1. **[P2, resolved] Generation action fell below the desktop viewport.**
   - Evidence: `/tmp/pleo-studio-desktop-qa-before.png`. The source presents Generate in its bottom strip, while the implementation's full stack and saved direction expanded the stage enough to push that strip below the screen.
   - Fix: compact desktop character fields, remove redundant visible helper copy, reduce workbench spacing, and keep the command strip sticky. The trigger explanation remains on the input's title. Phone controls retain their larger sizes and fixed bottom bar.
   - Post-fix evidence: `/tmp/pleo-studio-desktop-final.png`; Generate is visible, both stack entries and the saved direction remain visible, and the page has no horizontal overflow.
2. **Pre-comparison functional issues, resolved:** ARIA boolean attributes initially lacked explicit true/false strings, and inherited phone navigation ordering placed the header below content. Fixed in the shared element helper and theme respectively. The final phone capture shows the header at the top and generation controls at the bottom; selected options have visible cobalt borders and explicit accessible selected state.

No actionable P0/P1/P2 differences remain within the agreed design direction and preserved-feature scope.

## Required fidelity surfaces

- **Fonts and typography:** editorial Georgia display heading, lighter system sans-serif controls, restrained uppercase navigation, and a clear display/control hierarchy. The mock does not identify its exact font. System fonts are an intentional dependency-free approximation of its editorial typography. Phone headings fit at 320 pixels without clipping.
- **Spacing and layout rhythm:** the three-column stage, centered portrait, direction rail, horizontal category bar and bottom command strip preserve the selected composition. Extra trigger, stack and preset controls are required functional additions. Phone layout prioritizes the portrait, then character controls, then the selector grid; tablet uses two stage columns.
- **Colors and tokens:** silver-gray canvas, light panels, ink text and cobalt selection accents follow the source. Shared tokens and controls also restyle Models, Library, LoRA library, Data Studio, Training, Settings and login.
- **Image quality and assets:** one compressed 1086 × 1448 editorial JPEG, approximately 190 KB, preserves a sharp full-body portrait without cutting off the feet. The example has its own matte studio backdrop rather than the source's full-width floor. Selector photographs and casting headshots are intentionally replaced by local official Tabler vector icons and named presets, following the user's request. The sprite is approximately 32 KB and includes its MIT license; no runtime icon service is used.
- **Copy and content:** specific pose and camera language accompanies each icon; there are 160 choices across eight categories. The exact assembled prompt is available for inspection. Save direction explains browser-local persistence and does not imply that saving trains a character. The example label avoids presenting the opening artwork as a live render.
- **Accessibility and states:** controls have names, visible focus styles, explicit selected states, keyboard-operable category tabs, reduced-motion support and readable labels. Add/remove/pause LoRA controls remain accessible. This was a focused interaction check, not a full assistive-technology audit.

## Primary interactions and regression evidence

- Selected directions, searched within a category, inspected the exact prompt, switched between manual and builder modes, and added extra instructions.
- Confirmed a coffee action clears conflicting hands-in-pockets instructions.
- Added two image LoRAs, changed strength, paused one, saved a direction, reloaded and restored its model, recipe and full stack.
- Added two Wan LoRAs; verified separate High/motion and Low/detail sliders, the four-slot limit display and pause/remove controls.
- Generated a mock image through the real UI flow and verified encrypted asset storage and queue history.
- Opened every workspace on a phone; checked Settings on phone and tablet. Existing reference-image, driving-video, framing, duration, frame-rate and advanced controls remain in the generation view.
- Browser console errors checked after interaction: none.
- API regression suite: **178/178 passed** against a separate fresh mock server.
- Prompt-builder checks passed for composition, garment overrides, selection conflicts, persisted recipes, malformed saved choices, ARIA booleans and local icon references.
- Existing environment-manager, toolkit, runner and crypto checks passed. Changed JavaScript syntax and diff whitespace checks passed.

## Accepted differences and remaining test limits

- Model selection reflects the installed model catalog, rather than forcing the mock's Qwen model. Manual prompts and all existing tools remain available.
- Queue and generation settings use expandable sections so the enlarged existing feature set remains available without filling the main stage.
- Named directions live in this browser and are lost if its storage is cleared. The original per-model prompt and stack persistence keys remain supported.
- No live GPU generation or RunPod deployment was performed. LoRA test files were disposable mock fixtures, not real weights. The updated standalone UI test script was syntax-checked; browser interaction checks were performed through the in-app browser instead of running that script.

## Implementation checklist

- [x] Preserve generation, encryption, queue, reference and training functionality.
- [x] Preserve full LoRA stacking and Wan expert strengths.
- [x] Implement lightweight selectors and deterministic prompt composition.
- [x] Verify desktop, tablet and phone layout.
- [x] Compare the selected source and final rendered evidence together.
- [x] Leave the work local on main; no push or pod changes.
