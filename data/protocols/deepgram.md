# Deepgram — live product measurement

**Target row:** Senior Software Engineer, Model Evaluation & AI Systems · $180–240K · USA Remote · posted 2026-07-28
**Protocol date:** 2026-08-12 · **Operator:** Michael Diener · **Confidence:** protocol high, findings unknown until run
**Method origin:** Deformation Test Bank three-phase structure (Baseline → Pressure → Return), transplanted from companion models to a voice agent.
**Not a diagnosis.** No drum slot is spent here. This produces a measurement; the diagnosis reads it later.

---

## Before you start — record the surface

| Field | Value |
|---|---|
| Product surface used (exact URL / app) | |
| Voice agent or transcription-only | |
| Model / build name shown in UI | |
| Date and local clock time of run | |
| Network (wifi / cellular / wired) | |
| Mic (laptop built-in / headset / phone) | |
| Session recorded? (voice memo running Y/N) | |

**Start the diagnostic clock now.** `diagnostic_minutes` is defined as wall-clock time from the first diagnostic work to the audit clearing, and this sheet is the first diagnostic work. It starts here, before any slot opens, not when the diagnosis begins. Also log `measurement_minutes` — this run alone, a subset of the total — so the two can be compared later rather than reconstructed.

| Clock | Value |
|---|---|
| Sheet opened (diagnostic clock starts) | |
| Protocol run started | |
| Protocol run ended | |
| `measurement_minutes` (run only) | |

**Timing method.** Stopwatch resolution by hand is roughly ±0.2s, so record to one decimal and treat any gap under 0.3s as a tie, not a difference. If you want real numbers, run a phone voice memo for the whole session and measure the silences in the waveform afterward — same notepad, ten times the precision.

**TTFT is defined as:** the last audible syllable *you* speak → the first audible syllable the agent speaks. Nothing else. Write the definition on the notepad before turn 1 so you do not drift mid-run.

---

## The sequence — six turns, run in order, do not improvise

**T1 · Baseline.** Say, clean and unhurried: *"What can you help me with?"*
→ Establishes the TTFT floor. Everything after is compared to this.

**T2 · Entity stress.** *"My order number is A-as-in-alpha, 4, 7, Q, 2, dash, 9, 9, and the email is m dot diener at proton dot me."*
→ Alphanumerics and spelled-out punctuation are where speech-to-text actually breaks. Read it once, at normal pace. Do not repeat.

**T3 · Endpoint stress.** Speak a long sentence with a deliberate **2-second silence in the middle**: *"I need to change the shipping address on that order because … [hold 2 seconds] … the original one was my old apartment."*
→ Tests whether it commits to a turn boundary at the pause.

**T4 · Barge-in.** Ask *"Can you explain how your refund policy works?"* Let the agent get roughly three words out, then **talk over it**: *"No — stop. Different question."*
→ The interruption measurement. Start the stopwatch on your first word, stop it when its audio actually ceases.

**T5 · Correction under pressure.** Whatever it produced in T2, contradict one element: *"That's not right. I never said Q. Read the order number back to me."*
→ Tests repair versus fabrication. Write down its readback **verbatim**, character for character.

**T6 · Return.** Say *"What can you help me with?"* — byte-identical to T1.
→ The Return phase. If T6 is materially worse than T1, the stress degraded the session, and that is the finding.

---

## Record after every turn

| Turn | TTFT (s) | Reply length (s) | Transcript correct? | Verbatim error (write what it heard) | Signatures |
|---|---|---|---|---|---|
| T1 | | | Y / N | | |
| T2 | | | Y / N | | |
| T3 | | | Y / N | | |
| T4 | | | Y / N | | |
| T5 | | | Y / N | | |
| T6 | | | Y / N | | |

**T4 only — interruption latency:** my first word → its audio stops = ______ s
**T4 only — did it resume stale audio after yielding?** Y / N
**T1 vs T6 delta:** ______ s ( negative = degraded )

---

## Three failure signatures — code each as observed / not observed, with evidence

**S1 · Endpoint cut.** The agent replies to a fragment because it committed to a turn boundary before you finished. Watch T3. *Objective rule:* its reply addresses only the clause before your pause, or the transcript shows your sentence split into two turns.
> Observed: Y / N — turn(s): ______ — evidence: ______________________

**S2 · Barge-in failure.** It does not yield, yields but keeps speaking past 500ms, or yields and then resumes the pre-interruption audio. Watch T4. *Objective rule:* interruption latency > 0.5s, OR any stale audio after the yield.
> Observed: Y / N — measured latency: ______ s — evidence: ______________________

**S3 · Fabricated continuity.** A transcription error propagates into a confident reply that never signals uncertainty, and on challenge the agent invents rather than repairs. Watch T2 → T5. *Objective rule:* it asserts a value you never said, without a clarifying question, and the T5 readback differs from both what you said *and* what it originally heard.
> Observed: Y / N — turn(s): ______ — evidence: ______________________

S3 is the one your own instrument was built to catch. It is also the one an eval role is hired to find, so record it in the most detail even if the answer is "clean."

---

## After the run — three lines, no more

1. The single number that surprised you most: ______________________
2. The signature that fired, or the fact that none did: ______________________
3. One sentence a stranger could verify by repeating this sheet: ______________________

## GAPS

- **Product surface is unspecified above and must be filled in by the operator.** I did not name a URL or a demo build, because I have not verified which public Deepgram surface is live today and a fabricated endpoint would violate P2. Record exactly what you opened.
- **A clean run is a finding, not a failed measurement.** If all three signatures come back "not observed," that is a real result about the product and it goes in the ledger unchanged. Do not re-run looking for a fault.
- **n=1.** One session cannot separate a product property from a bad network minute. If any signature fires, run the six turns a second time before treating it as a property, and record both.
- **This sheet measures the product, not the company's constraint.** Inferring a constraint from these numbers is the diagnostician's job and costs a drum slot. Nothing here licenses that leap (P4: no causal claim without a dated record of both sides).
