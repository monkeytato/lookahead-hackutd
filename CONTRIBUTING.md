# Working on Lookahead together

Up to four people work in parallel. The repo is split so that slices rarely touch the same files.

## Ownership (suggested)

| Slice | Paths | Owner |
| --- | --- | --- |
| Engine and data | `src/domain/**`, `tests/engine/**`, `docs/ENGINE_CONTRACT.md` | backend / twin engine |
| 3D twin | `src/twin/**` | 3D and water |
| Dashboard | `src/views/**`, `src/app/**`, `src/components/**`, `src/state/**` | dashboard |
| Landing and pitch | `src/landing/**`, `docs/**` | pitch |
| Hardware + bridge | `hardware/**`, `server/**` (except `server/director`), `src/domain/rig/**`, `src/scan/**` | hardware |
| Nemotron director | `server/director/**`, `tests/director/**` | AI |

`src/domain/types.ts` is the **shared contract**. Change it in its own small PR and tell the team.

## Flow

1. `git switch -c <your-name>/<short-topic>` from an up-to-date `main`.
2. Keep PRs small, one vertical slice each.
3. Before you push, run `npm run typecheck && npm test && npm run build`. CI (`docs/ci-workflow.yml`) runs the same checks once enabled; see the note at the top of that file.
4. Open a PR using the template. One teammate reviews. Squash-merge.
5. Never commit secrets. `NVIDIA_API_KEY` belongs in `.env.local` (git-ignored); see `.env.example`.

## Rules the product depends on (from the handoff)

- The LLM explains numbers but never produces them. Engine outputs are deterministic and seeded.
- The sensor link is USB serial JSON (`src/domain/rig/protocol.ts`). Change the protocol in firmware, bridge and simulator together, and bump `v`.
- Show freshness and source on every reading. Missing is never zero, and stale is never shown as live.
- A disagreement reading is a verification task, not proof the sensor is broken. No corroboration does not mean the equipment is safe.
- Completing a task does not resolve an incident.
- Color is for abnormal state only (ISA-101). Use Carbon tokens from `src/styles/tokens.css`, and don't add a new palette.
- Label every simulated, replayed or fixture value as such.
