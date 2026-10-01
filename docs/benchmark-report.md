# SciDigitizer 0.20 accuracy benchmark

## Purpose

This benchmark answers three practical questions: whether an ordinary curve still works with one click, which difficult plots need guidance, and whether a code change silently makes extraction worse. It measures image-space accuracy; it does not replace validation against the original scientific data.

## Reproducible test set

`tools/accuracy-fixtures.mjs` generates 30 deterministic raster fixtures entirely in memory. `tools/parametric-fixtures.mjs` adds twelve ordered two-dimensional paths. No third-party figures or downloaded data are used.

- 27 line series: simple solid, thick antialiased, patterned, close-colour, same-colour crossing, same-colour overlap, occluded, noisy experimental, and raster-degraded curves;
- 3 black marker series;
- grids, frames, nearby distractors, legends, blur, quantisation, and seeded noise;
- 6 rotated-frame cases and 3 perspective-frame cases.
- 12 parametric paths: thin and thick closed loops, an automatic open hairpin, an explicitly guided figure-eight, a guided hairpin with an irrelevant spur, an automatically recovered masked loop, a dashed closed loop, explicit dotted and dash-dot hairpins, plus blurred, quantised-noisy, and low-resolution variants.

Every fixture retains its exact pixel-space ground truth. The benchmark samples the target colour from a clear rendered point, just as a careful user would, rather than passing the known source colour to the extractor.

## Interaction protocols

| Protocol | Canvas actions | Meaning |
| --- | ---: | --- |
| One click | 1 | one click on a clear target point |
| One guide | 2 | target click plus one authoritative guide |
| Three guides | 4 | target click plus three distributed guides |
| Masked occlusion | 2 | target click plus one drag around the covering object; measured on the three occlusion fixtures |

The table counts canvas clicks. Selecting the explicit `Noisy / experimental` type remains one additional UI action. A clear repeated marker series is now recognized directly from the target click; unusually small or weak marker evidence retains the explicit marker-and-guides fallback.

Coloured-series discovery is measured separately because it does not trace or alter data by itself. It must find the rendered target colour while rejecting neutral axes and grids; choosing a proposed colour remains one deliberate user action.

## Metrics

- **NRMSE**: vertical pixel RMSE divided by plot height, plus a penalty for missing horizontal span;
- **P95 NRMSE**: the 95th percentile across series, so a few hard failures remain visible;
- **Full span**: fraction of series covering at least 95% of the ground-truth X range;
- **Wrong branch**: fraction of series for which more than 8% of output points are closer to a distractor than to the target;
- **Marker F1**: detection precision/recall balance using an 8 px matching radius;
- **Plot IoU**: overlap between suggested and true plot rectangles;
- **Geometry error**: absolute skew-angle error and perspective-corner pixel error.
- **Colour discovery**: target-colour recall across all coloured line fixtures and composited RGB error after antialias shades are merged.
- **Parametric geometry**: symmetric pixel-to-path error, ground-truth coverage within 2.5 px, path-length ratio, topology/review classification, exact-guide retention, and maximum step continuity.
- **Ordinary fast path**: exact result equivalence between automatic and forced-horizontal modes, plus a warmed, alternating nine-run median slowdown ratio on six ordinary fixtures.

## Baseline results

Baseline version: `0.20.0-preview.3.19`.

### Continuous curves

| Protocol | Mean NRMSE | P95 NRMSE | Full span | NRMSE ≤ 2% | Wrong branch |
| --- | ---: | ---: | ---: | ---: | ---: |
| One click | 0.0238 | 0.1418 | 88.9% | 81.5% | 7.4% |
| One guide | 0.0074 | 0.0432 | 100.0% | 88.9% | 7.4% |
| Three guides | 0.0059 | 0.0265 | 100.0% | 88.9% | 0.0% |

The six ordinary solid/thick fixtures have one-click mean NRMSE `0.0008`, 100% full-span coverage, and zero wrong-branch failures. This is the primary regression guard for the simple workflow.

On the three long-occlusion fixtures, a target click plus one mask drag gives mean NRMSE `0.0042`, P95 NRMSE `0.0046`, 100% full-span coverage, and zero wrong-branch failures. The mask contains no hidden ground truth and supplies no far-side guide: it only identifies pixels that must be ignored. The tracer reconnects to compatible target pixels beyond the mask, then the local model ensemble reconstructs the unsupported interval. Unmasked one-click results remain reported separately because an unexplained blank and a truly hidden curve are not distinguishable in general.

| Category | One click NRMSE | One guide NRMSE | Three guides NRMSE |
| --- | ---: | ---: | ---: |
| Simple solid | 0.0006 | 0.0006 | 0.0006 |
| Thick antialiased | 0.0010 | 0.0010 | 0.0010 |
| Raster artefacts | 0.0009 | 0.0009 | 0.0009 |
| Noisy experimental | 0.0023 | 0.0023 | 0.0022 |
| Close colour | 0.0023 | 0.0023 | 0.0023 |
| Same-colour crossing | 0.0020 | 0.0020 | 0.0020 |
| Occluded curve | 0.1427 | 0.0042 | 0.0042 |
| Same-colour overlap | 0.0023 | 0.0023 | 0.0022 |
| Patterned line with same-colour distractor | 0.0596 | 0.0511 | 0.0373 |

Continuous and automatically classified curves use a whole-tail beam search that retains multiple colour, position, recent-slope, and long-term trajectory hypotheses through a crossing. Up to 180 competing states can survive a column; later pixels or authoritative guides decide which history wins. An explicit occlusion mask can now suspend the ordinary gap limit and reconnect a compatible hypothesis on the far side. Discontinuous and noisy evidence retains the established specialised fallback when a global beam cannot reach as far.

Long inferred spans compare linear, regularized-smooth, Hermite, and robust quadratic continuations. The regularized model gains influence when endpoint support is short or noisy, while short dash/antialias gaps retain the previous ensemble. Every inferred point records model weights, disagreement, distance to the nearest observed or guided boundary, and an uncertainty that grows toward the unsupported centre. Exact guide coordinates are never moved.

Compared with the first `0.20` baseline, one-click mean NRMSE fell from `0.0751` to `0.0238`, while wrong-branch rate fell from 37.0% to 7.4%. Close-colour crossings and continuous same-colour overlaps no longer fail in this suite. A low-confidence patterned diagnosis is also checked against a continuous global hypothesis, preventing crossings from making an ordinary curve look dashed. Same-colour patterned distractors remain the dominant unresolved one-click and one-guide branch case; this limitation stays visible rather than being averaged away. Three distributed guides now reduce their mean NRMSE to `0.0373` with zero wrong-branch classifications in the deterministic category, and category-level absolute gates protect that result.

### Two-dimensional paths

The twelve deterministic parametric fixtures all recover the expected topology, with mean truth-path coverage `99.96%` and minimum coverage `99.50%`. Mean centreline RMSE is `0.239 px`, P95 series RMSE is `0.409 px`, exact-guide retention is 100%, and the mean absolute path-length ratio error is `0.053`. The masked-loop case reconnects automatically from one target click plus the declared occlusion, and every hidden point retains tangent-model provenance and distance-aware uncertainty. Its inferred bridge is also invariant when pixels inside the declared mask are replaced, preventing hidden-image truth leakage. Declared dashed, dotted, and dash-dot paths reconnect only after short gaps form a consistent spacing fingerprint; compact dash-dot points combine positional evidence with adjacent stroke direction, and every interpolated point retains distinct patterned-gap provenance. The three degraded fixtures—blurred antialiasing, seeded quantisation noise, and low resolution—retain 100% topology/coverage with P95 series RMSE `0.211 px`. The suite exercises automatic selection only when it adds necessary topology: a single-valued hairpin may intentionally remain on the simpler vertical engine, while explicit 2D mode reconstructs and orders its full patterned path. Self-intersections and branched paths remain deliberate, review-required operations.

Automatic mode remains byte-for-byte equivalent to forced-horizontal mode on all six ordinary fixtures. After two warm-up runs per mode and nine alternating measurements, its median slowdown ratio is approximately `1.03×`. CI gates the within-process ratio rather than absolute milliseconds, which protects the one-click fast path without assuming a particular runner speed.

### Markers and geometry

| Measurement | Result |
| --- | ---: |
| Black-marker F1, one click | 1.000 |
| Black-marker F1, one guide | 0.843 |
| Black-marker F1, three guides | 0.901 |
| One-click marker-series detection rate | 100% |
| Line-series marker false-positive rate | 0% |
| Coloured target discovery rate | 100% (27 / 27) |
| Mean discovered target-colour error | 0.236 |
| Plot rectangle mean / minimum IoU | 0.9755 / 0.9574 |
| Skew mean / maximum absolute error | 0.083° / 0.250° |
| Perspective detection rate | 100% |
| Perspective mean corner error | 1.27 px |

Core tracing runtime is also recorded in `benchmarks/baseline.json`, but is not a CI gate because shared-runner timing varies. Accuracy and coverage are the release criteria.

## Regression gates

`npm run benchmark:check` compares a fresh deterministic run with `benchmarks/baseline.json`. CI fails on material regressions in:

- plot-area IoU;
- ordinary one-click NRMSE;
- overall one-click and guided NRMSE/P95;
- three-guide patterned-curve mean/P95 NRMSE, full-span coverage, and zero wrong-branch classification;
- full-span and wrong-branch rates;
- masked-occlusion NRMSE and full-span recovery;
- one-click marker detection rate, line false-positive rate, and marker F1;
- coloured-target discovery rate and representative-colour error;
- parametric centreline error, full-path coverage, length fidelity, topology/review classification, degraded-raster stability, occlusion and patterned-gap provenance, exact-guide retention, and path continuity;
- ordinary automatic/forced-horizontal result equivalence and warmed median slowdown ratio;
- skew and perspective detection.

Small absolute and relative tolerances prevent harmless floating-point noise from blocking a change. Updating the baseline is an explicit maintainer action, never part of the normal test command.

## Reproduce

```bash
npm run benchmark          # print the current report
npm run benchmark:check    # compare with the committed baseline
npm run benchmark:update   # deliberately accept the current result as a new baseline
```

The previous Matplotlib benchmark remains available as a broad offline audit:

```bash
npm run benchmark:legacy:generate
npm run benchmark:legacy
```

## Limits

Synthetic ground truth makes regressions measurable but cannot represent every publication style or camera artefact. The retained `fig1.png` real-figure smoke test complements it, but that image has no original numerical ground truth. Fully hidden or pixel-identical branches remain intrinsically ambiguous and must be reported as inferred or resolved with user guidance.
