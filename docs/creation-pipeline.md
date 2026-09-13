# Guided dance creation: implementation and next stages

## Experience

An unbranded entrance offers two equally valid routes. Guided creation walks
through Character → Sound → Motion → Frame → Create. The classic workspace keeps
its existing model, generation, LoRA, data and training controls. Shared dark blue,
silver borders, glass surfaces and restrained neon highlights connect both routes.
The generated welcome-stage image is decorative; it is not a selectable character.

## Working in this change

- Character references: upload, select an encrypted image asset, or generate a
  full-body anchor through an existing image engine. A compatible installed LoRA
  can condition anchor generation. Outfit presets are prompt suggestions.
- Solo/duo direction: a prompt option; for two consistent identities the reference
  must contain both. This is not a multi-character identity guarantee.
- Motion: the configured Wan image-to-video engine accepts the anchor and composed
  prompt. Wan Animate/VACE also accept a user-provided driving MP4. No curated
  choreography library is bundled.
- Framing: 9:16 and 16:9 output dimensions fit the configured tier/latent grid.
  Wan I2V centre-crops the anchor. The first guided render uses 480p; advanced
  settings remain in the classic workspace.
- Audio: bounded MP3/WAV input, chosen start time, CPU FFmpeg assembly, original
  generated audio discarded. This overlays music; it does not beat-condition motion.
- Output: the existing queue and progress events, browser encryption, shared result
  saving, preview and download. Mock mode is labelled and produces test media.

## Memory and execution

`jobs.py` already serializes generation jobs. `runner_manager.py` stops the previous
model subprocess before starting a different model, releasing its allocations.
Guided jobs request process teardown after each stage (before CPU audio mixing).
Classic jobs retain the configured warm-runner policy. The configured Wan profiles
use CPU offload.
This change preserves their 80–96 GB deployment assumptions and does not claim
that clearing a CUDA cache alone frees live model tensors.

The image is completed before video submission. Audio mixing happens after the
video result exists and uses CPU only. Captioning and training have their own
lifecycle managers: the generation queue is not a global GPU admission controller.
Do not run those heavy workloads concurrently on a capacity-constrained GPU.

Audio/video assembly uses permission-restricted OS temporary directories, cleaned
on normal completion and exceptions. An abrupt host crash can leave temporary
files; use an ephemeral/encrypted scratch volume for a hosted deployment. Results
are stored persistently only after browser encryption.

## Remaining pipeline integrations

1. Add a CPU audio-analysis job with word timestamps, beat times and a reviewed
   transcript editor. Separate uploaded lyrics from detected lyrics and show
   confidence/unaligned sections. Choose the actual aligner against test tracks.
2. Add choreography references with explicit licences, BPM ranges, framing and
   tested identity retention. Text prompts alone cannot promise beat-accurate motion.
3. Add vocal isolation and a tested face/lip-sync stage. Verify occlusion, profile
   faces, full-body shots and temporal blending before exposing Dance + Lip-sync.
4. Add a server-side Higgsfield adapter only after selecting the supported endpoint,
   account credentials, pricing and media-retention policy. Keep keys out of client
   bundles and show provider failure/cancellation states. No speculative API contract
   or paid job is created by this change.
5. Add GPU admission across generation, captioning and training, with measured peak
   memory per profile. Terminate/release one stage before admitting the next.

## Website scaling, when needed

Keep the static frontend and authenticated API separate from GPU workers. Introduce
user-scoped accounts and authorization first: the current single-account server is
not a public multi-tenant service. Replace the in-memory queue with a durable queue
and persist job ownership/state. Store encrypted assets in object storage and use
short-lived authorized transfers. Dispatch one active model stage per worker,
reusing weights on persistent cache storage. Add quotas, idempotent submissions,
retry limits, cancellation, completion recovery and cost limits before autoscaling.

Do not run several API replicas against today's in-memory queue: they do not share
jobs, authentication sessions or outbox results. Keep the existing single-process
local deployment until those concrete requirements are implemented.

## Verification

`tests/api_test.py` covers existing API behavior in mock mode; crypto and runner
checks remain available. `tests/journey_test.py` exercises portrait/landscape sizing,
invalid audio/start rejection, transient input cleanup and an FFmpeg output with
both audio and video streams. The guided browser walkthrough uses mock generation;
real GPU quality, VRAM peaks, motion fidelity and model compatibility still require
representative RunPod runs.
