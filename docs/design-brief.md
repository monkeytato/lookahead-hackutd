# Design brief — Carbon × ISA-101 × 3D twin

Research pass, 2026-11-07. Each rule cites where it came from. Devpost pages for prior
Northmark winners (DataDriver, TaskFlow, DCDaddy) returned 403 to automated fetches;
open them in a browser before borrowing patterns.

## The three questions the screen answers, in order
1. **What is wrong, or about to be?** One incident, not forty alerts.
2. **How long do I have?** A countdown with a range and the assumption it rests on.
3. **What do I do, and who owns it?** Next action, owner, what the last shift tried.

## HMI rules (ISA-101 high-performance)
- About 90 % of pixels stay neutral. Color is reserved for abnormal states and interaction. Never fill "normal" with green. (open-exam-prep ISA-CAP guide; Inductive Automation HPHMI)
- **Alarm markers are redundant:** P1 is a red `#da1e28` square with "1", P2 an orange `#ff832b` triangle with "2", P3 a yellow `#f1c21b` circle with "3". Place the marker *next to* the object, not as a fill, and add a text label. Flash only while unacknowledged. (docs.inductiveautomation.com HPHMI techniques; Carbon status palette)
- **Analog bar-and-band:** shade the normal band in Gray 20 and draw the value as a Gray 100 tick. Show limits as ticks, and color a zone only once it is exceeded. Align bands in stacked rows so outliers pop at a squint. (Tatsoft ISA-101 how-to)
- **Sparklines** sit inline with the value, with no gridlines. Show "now" as a dot and the forecast past now as a dashed segment.
- **Hierarchy:** L1 overview → L2 hall → L3 equipment → L4 diagnostic/handoff. Every screen is within 3 clicks of the overview, with fewer than 200 dynamic objects per view.
- **Type:** process values in Plex Mono 14–16. Labels 12. Alarm text 12–14 semibold.

## Ops-UI patterns
- Separate surfaces with 1px Gray 20 borders and no shadows. The Gray 100 inverse surface is only for chrome and the active incident. Keep blue for interaction. (Linear UI redesign write-up)
- **Countdown with a range:** show the p50 large in Mono (`T−14 min`), the range `(9–22)` beside it at label size, and a bar underneath: a light band for p10–p90, a darker likely band, and a "now" tick. Never show a precise number without its range.
- **Freshness:** every value carries an age. When data is older than 2× its interval, apply a 45° hatch, a `STALE 14m` tag, and keep the last value in Gray 50. **Never show missing as 0 or bridge gaps.** (Grafana statusmap #154, Grafana discussion #38224)
- **Incident header:** severity tag, title, owner, elapsed Mono time. Below it, a timeline with handoffs as first-class events. (PagerDuty / incident.io conventions)
- **Alert budget:** a meter of incidents raised this hour against a target of a handful. EEMUA 191 puts about 6 per hour as the healthy rate, and ISA-18.2 calls 10 in 10 min a flood.

## 3D scene recipe (R3F)
- **Camera:** perspective, FOV 35, about 35° elevation and 45° azimuth. Damped orbit, polar clamp, fly-to on select.
- **Lights:** a hemisphere light (#fff / #c6c6c6, 0.6–0.7) plus one soft directional key. Three to four lights total.
- **Racks:** instanced matte boxes, Gray 80–90, roughness 0.8. A thin emissive front strip carries the alarm color only.
- **Floor:** Gray 10 with contact shadows and a subtle grid at tile size 0.6 m. Linear fog matches the background.
- **Water:** a floor decal in Blue 60 at about 40 % opacity, plus the predicted extent. Label it "approximation".
- **Heat:** one translucent slice at 1.2 m using the Carbon diverging cyan→red palette. Label it "indicative, not CFD".
- **Labels:** drei `Html`, tiny, only for selected or abnormal objects.
- **Postprocessing:** at most SMAA and subtle AO. No bloom.

## Avoid
1. Green fills for normal.
2. Coloring equipment instead of placing a marker.
3. Null shown as 0, or bridged data gaps.
4. Bloom, neon, or a dark sci-fi twin.
5. Always-on label soup, or more than 200 animated objects.
6. Reusing an alarm color for a process state.
