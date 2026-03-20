/**
 * Focus Time Timeline – Looker Custom Visualization
 *
 * PURPOSE
 * ───────
 * Renders a representative "day in the life" timeline for a typical employee,
 * derived from aggregate Worklytics metrics. The goal is to make abstract
 * productivity numbers tangible: instead of showing "5.7 meeting hours/week",
 * the chart shows a simulated workday bar with meetings, emails and chat
 * messages placed realistically across it, with focus time visible as the
 * continuous uninterrupted blocks in between.
 *
 * VISUAL STRUCTURE
 * ────────────────
 *  • Horizontal bar       – the workday (e.g. 8 am–6 pm), coloured by segment type:
 *                             Blue   = uninterrupted time (focus or fragmented)
 *                             Red    = meeting
 *                             Green  = email cluster
 *                             Amber  = chat cluster
 *  • Shapes above the bar – height encodes the value of each uninterrupted block:
 *                             Blue plateau = focus block (≥ 2 h uninterrupted)
 *                             Pink arch    = fragmented block (< 2 h uninterrupted)
 *  • Stats line           – interruption count, total focus time, total fragmented time
 *  • Clickable legend     – toggle email / chat / meetings on or off to show "what if"
 *
 * SUPPORTED DATA LAYOUTS
 * ──────────────────────
 * The visualization accepts Worklytics data in any of three Looker layouts:
 *
 *   Layout A – Multiple measure columns (one per metric), single row
 *              Column order: meetings attended, meeting hours, emails sent,
 *              chat messages sent, focus hours, fragmented hours
 *
 *   Layout B – Key-value rows: one dimension column (metric key) + one measure column (value)
 *              e.g. People Metrics Typical Metric Key | P50
 *
 *   Layout C – Pivoted: a single measure column pivoted on metric key
 *              e.g. worklytics:hours:in:focus:blocks:v3_5:flow | P50
 *              This is the most common layout when using Worklytics' People Metrics explore.
 *
 * DETERMINISM
 * ───────────
 * The schedule is generated with a seeded pseudo-random number generator, so the
 * same input metric values always produce the same representative day layout.
 * This prevents the chart from "jumping" on every Looker data refresh.
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Xorshift32 seeded pseudo-random number generator.
   * Returns a function that produces floats in [0, 1).
   *
   * Used instead of Math.random() so the same input metrics always produce
   * the same schedule layout — i.e. the visualization is deterministic.
   */
  function makeRNG(seed) {
    let s = (Math.abs(Math.round(seed)) >>> 0) || 1_234_567;
    return () => {
      s ^= s << 13;
      s ^= s >> 17;
      s ^= s << 5;
      return (s >>> 0) / 0x1_0000_0000;
    };
  }

  /** Format a number to one decimal place — used for SVG coordinate strings. */
  const f = v => Number(v).toFixed(1);

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Schedule generation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Generates a representative list of events for a single workday using a
   * deterministic seeded RNG, based on the employee's weekly aggregate metrics.
   *
   * ALGORITHM
   * ─────────
   * 1. If daily focus hours ≥ 2 h, reserve a contiguous focus block in the
   *    middle portion of the day. Meetings are placed in the windows on either
   *    side of it; this ensures meetings don't fragment the focus block.
   * 2. Meetings are distributed proportionally across the available windows,
   *    then de-overlapped with a 15-minute gap between them.
   * 3. Email and chat clusters are scattered freely across the entire day
   *    (including within the focus block), because real-world messages arrive
   *    throughout the day and are precisely what Worklytics measures as
   *    fragmenting focus time.
   *
   * All times are in minutes from midnight.
   *
   * @param {object} opts
   * @param {number} opts.meetingMinutes    – total meeting time per day (minutes)
   * @param {number} opts.numMeetings       – number of distinct meetings per day
   * @param {number} opts.numChat           – number of chat message clusters per day
   * @param {number} opts.numEmails         – number of email clusters per day
   * @param {number|null} opts.focusHoursDaily – measured daily focus hours (null = unknown)
   * @param {number} opts.workStart         – day start in minutes from midnight (e.g. 480 = 8 am)
   * @param {number} opts.workEnd           – day end   in minutes from midnight (e.g. 1080 = 6 pm)
   * @returns {{ type: string, start: number, duration: number }[]}
   */
  function generateSchedule({ meetingMinutes, numMeetings, numChat, numEmails,
                               focusHoursDaily, fragmentedHoursDaily, focusThr, workStart, workEnd }) {
    // Seed the RNG with a hash of all input values so any change in metrics
    // produces a noticeably different (but still deterministic) schedule.
    const rng = makeRNG(
      Math.round(meetingMinutes) * 10_007 +
      numMeetings               *    997 +
      numChat                   *    101 +
      numEmails                 *     37
    );

    // Leave a 30-minute buffer at each end of the day (commute / wind-down time).
    const buf    = 30;
    const aStart = workStart + buf;  // earliest event start
    const aEnd   = workEnd   - buf;  // latest event end
    const aLen   = aEnd - aStart;    // total placeable span (minutes)

    // ── Focus block ────────────────────────────────────────────────────────────
    // When the employee has ≥ 2 h of measured daily focus time, reserve a
    // contiguous block for it. Meetings are then placed in the remaining windows
    // so they don't accidentally fragment the focus period.
    // Chat and email are NOT restricted to these windows — they are the
    // interruptions that happen throughout the day (see step 3 above).
    const focusMin = focusHoursDaily ? Math.round(focusHoursDaily * 60) : 0;
    const hasFocus = focusMin >= 120;  // 2-hour minimum for a "focus" block
    const focusBuf = 15;               // minutes of breathing room around the focus block

    let focusStart = null, focusEnd = null;
    if (hasFocus) {
      // Anchor the focus block somewhere between 15 % and 65 % through the day,
      // so it doesn't always land at the very start or end.
      const span = Math.max(0, aLen - focusMin);
      focusStart = Math.round(aStart + (0.15 + rng() * 0.50) * span);
      focusEnd   = focusStart + focusMin;
    }

    // ── Meeting placement windows ──────────────────────────────────────────────
    // Meetings are placed in the portions of the day outside the focus block.
    // If there is no focus block, the whole available span is one window.
    const windows = hasFocus
      ? [
          { start: aStart,              end: focusStart - focusBuf },
          { start: focusEnd + focusBuf, end: aEnd                  },
        ].filter(w => w.end - w.start >= 20)   // drop windows too short to be useful
      : [{ start: aStart, end: aEnd }];

    const totalWinLen = windows.reduce((s, w) => s + Math.max(0, w.end - w.start), 0);

    // ── Meetings ──────────────────────────────────────────────────────────────
    const avgDur    = Math.max(15, Math.min(90, meetingMinutes / Math.max(1, numMeetings)));
    // Generate one random position [0,1] per meeting, pre-sorted so meetings
    // are distributed left-to-right across the windows before de-overlapping.
    const sortedPos = Array.from({ length: numMeetings }, rng).sort((a, b) => a - b);

    const meetings = sortedPos.map(pos => {
      // Map a position in [0, totalWinLen] back to a real time in one of the windows.
      let t = pos * totalWinLen, cumLen = 0;
      for (const w of windows) {
        const wLen = Math.max(0, w.end - w.start);
        if (t <= cumLen + wLen) {
          const localT   = wLen > 0 ? (t - cumLen) / wLen : 0;
          const rawStart = Math.round(w.start + localT * Math.max(0, wLen - avgDur));
          const start    = Math.max(w.start, Math.min(w.end - 15, rawStart));
          // Cap duration so the meeting cannot bleed past the window boundary
          // and accidentally overwrite the reserved focus zone.
          const maxDur   = Math.max(15, w.end - start);
          return {
            type:     'meeting',
            start,
            duration: Math.max(15, Math.min(maxDur, Math.round(avgDur * (0.75 + rng() * 0.5)))),
          };
        }
        cumLen += wLen;
      }
      // Fallback: if position arithmetic fails, place at the start of the first window.
      return { type: 'meeting', start: windows[0]?.start ?? aStart, duration: Math.round(avgDur) };
    });

    // Resolve any meeting overlaps by pushing later meetings forward.
    // Require at least a 15-minute gap between consecutive meetings.
    meetings.sort((a, b) => a.start - b.start);
    for (let i = 1; i < meetings.length; i++) {
      const prev = meetings[i - 1];
      meetings[i].start = Math.max(meetings[i].start, prev.start + prev.duration + 15);
    }

    // Drop any meetings that ended up outside the workday or overlapping the
    // focus zone (can happen after the overlap-resolution push above).
    const validMeetings = meetings.filter(m => {
      if (m.start + m.duration > aEnd) return false;
      if (hasFocus) {
        const overlapsFocus = m.start < focusEnd + focusBuf &&
                              m.start + m.duration > focusStart - focusBuf;
        if (overlapsFocus) return false;
      }
      return true;
    });

    // ── Email & chat interruptions ─────────────────────────────────────────────
    // Track occupied time ranges so email/chat clusters don't overlap each other
    // or land on top of meetings. The focus block itself is kept clean — all
    // event types are restricted from entering it so the plateau is visually
    // accurate (the Worklytics focus metric measures genuinely uninterrupted time).
    const occupied = [
      ...validMeetings.map(m => ({ s: m.start - 15, e: m.start + m.duration + 15 })),
    ];

    /**
     * Attempt to place a single event of the given type at a random position.
     * Returns the event object on success, or null after 60 failed attempts.
     *
     * @param {'email'|'chat'|'meeting'} type
     * @param {number} duration  – event length in minutes
     * @param {number} [buffer]  – minimum gap around the event (default 10 min)
     */
    const tryPlace = (type, duration, buffer) => {
      buffer = buffer ?? 10;
      for (let attempt = 0; attempt < 60; attempt++) {
        const t = Math.round(aStart + rng() * (aLen - duration));
        // All event types must stay outside the reserved focus block so the
        // focus plateau is visually clean (no interruptions shown inside it).
        // If an email or chat cluster can't find a slot outside, tryPlace
        // returns null and it is silently dropped — fewer events is preferable
        // to showing interruptions inside a block labelled "focus time".
        if (hasFocus &&
            t + duration > focusStart - focusBuf && t < focusEnd + focusBuf) continue;
        // Reject positions that overlap any already-occupied range.
        if (!occupied.some(o => t < o.e && t + duration > o.s)) {
          occupied.push({ s: t - buffer, e: t + duration + buffer });
          return { type, start: t, duration };
        }
      }
      return null;  // could not find a free slot
    };

    // Group individual messages into short activity clusters:
    //   • Emails are sent in bursts (check inbox, reply to several at once) → fewer, longer gaps
    //   • Chat is conversational (back-and-forth) → more clusters, each just ~5 min
    const emailClusters = Math.max(2, Math.round(numEmails / 3));
    const chatClusters  = Math.max(2, Math.round(numChat   / 4));

    const emailEvents = Array.from({ length: emailClusters }, () => tryPlace('email', 5, 5)).filter(Boolean);
    const chatEvents  = Array.from({ length: chatClusters  }, () => tryPlace('chat',  5, 5)).filter(Boolean);

    const allEvents = [...validMeetings, ...emailEvents, ...chatEvents];

    // ── Filler: add chat events to calibrate fragmented time ──────────────────
    // The schedule often has more open time outside the focus zone than the
    // measured fragmentedHoursDaily. Rather than invisible phantom events, add
    // real chat events so the bar and shapes always stay consistent with each
    // other. Each iteration places one extra chat cluster until the fragmented
    // total converges to the target (within a 15-minute tolerance).
    if (fragmentedHoursDaily != null) {
      const targetFragMin = Math.round(fragmentedHoursDaily * 60);
      for (let i = 0; i < 40; i++) {
        const sorted = allEvents.slice().sort((a, b) => a.start - b.start);
        const fragTotal = getFragmentedBlocks(sorted, workStart, workEnd, focusThr, 15)
          .reduce((s, b) => s + b.end - b.start, 0);
        if (fragTotal <= targetFragMin + 15) break;
        const ev = tryPlace('chat', 5, 5);
        if (!ev) break;  // no more room outside the focus zone
        allEvents.push(ev);
      }
    }

    allEvents.sort((a, b) => a.start - b.start);

    // ── Transition chat events at focus-zone boundaries ───────────────────────
    // Place one visible chat event near the start of each focusBuf zone so the
    // fragmented arches that bracket the focus plateau always have an actual
    // interruption visible inside them (prevents arch-over-clean-blue).
    if (hasFocus) {
      const noOverlap = (s, d) =>
        !allEvents.some(e => e.start < s + d && e.start + e.duration > s);
      const tPre  = focusStart - 6;   // ends at phantom (focusStart-1), flush with plateau ramp
      const tPost = focusEnd   + 2;  // just after post-focus boundary
      if (tPre  >= workStart && tPre  + 5 <= workEnd && noOverlap(tPre,  5))
        allEvents.push({ type: 'chat', start: tPre,  duration: 5 });
      if (tPost >= workStart && tPost + 5 <= workEnd && noOverlap(tPost, 5))
        allEvents.push({ type: 'chat', start: tPost, duration: 5 });
      allEvents.sort((a, b) => a.start - b.start);
    }

    // ── Boundary phantoms for clean shape detection ───────────────────────────
    // Insert 1-minute 'fragmented' events at the edges of the focus zone.
    // They render as blue on the bar (COLOR.fragmented = COLOR.focus = #3B82F6)
    // so they're visually invisible, but they create precise gap boundaries:
    //   • getFocusBlocks  finds exactly [focusStart, focusEnd]
    //   • getFragmentedBlocks finds the pre/post sections naturally
    // This eliminates the extraFrag overlap problem in _draw entirely.
    if (hasFocus) {
      allEvents.push({ type: 'fragmented', start: focusStart - 1, duration: 1 });
      allEvents.push({ type: 'fragmented', start: focusEnd,       duration: 1 });
      allEvents.sort((a, b) => a.start - b.start);
    }

    return { events: allEvents, hasFocus, focusStart, focusEnd };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Timeline helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Converts a sorted event list into an ordered array of coloured bar segments.
   *
   * Gaps between events are classified as either:
   *   'focus'      – gap duration ≥ focusThr (default 2 h): long enough for deep work
   *   'fragmented' – gap duration < focusThr: uninterrupted but too short for deep work
   *
   * Event segments retain their original type ('meeting', 'email', 'chat').
   *
   * @param {{ type: string, start: number, duration: number }[]} events
   * @param {number} workStart
   * @param {number} workEnd
   * @param {number} focusThr – minimum gap length (minutes) to count as focus time
   * @returns {{ start: number, end: number, type: string }[]}
   */
  function buildTimeline(events, workStart, workEnd, focusThr) {
    const classify = dur => dur >= focusThr ? 'focus' : 'fragmented';
    const segs = [];
    let t = workStart;
    for (const ev of events) {
      if (ev.start > t) {
        // isGap:true — a genuine uninterrupted stretch that gets a shape above it
        segs.push({ start: t, end: ev.start, type: classify(ev.start - t), isGap: true });
      }
      segs.push({ start: ev.start, end: ev.start + ev.duration, type: ev.type, isGap: false });
      t = ev.start + ev.duration;
    }
    if (t < workEnd) {
      segs.push({ start: t, end: workEnd, type: classify(workEnd - t), isGap: true });
    }
    return segs;
  }

  /**
   * Returns all contiguous gaps of at least focusThr minutes.
   * These are the blocks rendered as blue plateaus above the timeline bar.
   *
   * @param {{ start: number, duration: number }[]} events
   * @param {number} workStart
   * @param {number} workEnd
   * @param {number} focusThr
   * @returns {{ start: number, end: number }[]}
   */
  function getFocusBlocks(events, workStart, workEnd, focusThr) {
    const blocks = [];
    let t = workStart;
    for (const ev of events) {
      if (ev.start - t >= focusThr) blocks.push({ start: t, end: ev.start });
      t = ev.start + ev.duration;
    }
    if (workEnd - t >= focusThr) blocks.push({ start: t, end: workEnd });
    return blocks;
  }

  /**
   * Returns contiguous gaps that are at least minGap minutes but shorter than focusThr.
   * These are rendered as pink arches above the bar — uninterrupted time that is
   * nonetheless too short to count as meaningful focus time.
   *
   * @param {{ start: number, duration: number }[]} events
   * @param {number} workStart
   * @param {number} workEnd
   * @param {number} focusThr – upper bound (exclusive)
   * @param {number} minGap   – lower bound (inclusive), e.g. 15 min
   * @returns {{ start: number, end: number }[]}
   */
  function getFragmentedBlocks(events, workStart, workEnd, focusThr, minGap) {
    const blocks = [];
    let t = workStart;
    for (const ev of events) {
      const gap = ev.start - t;
      if (gap >= minGap && gap < focusThr) blocks.push({ start: t, end: ev.start });
      t = ev.start + ev.duration;
    }
    const gap = workEnd - t;
    if (gap >= minGap && gap < focusThr) blocks.push({ start: t, end: workEnd });
    return blocks;
  }

  /**
   * Calibrates the simulated schedule so its total focus time matches the
   * measured Worklytics value.
   *
   * WHY THIS IS NEEDED
   * ──────────────────
   * Random meeting placement can accidentally leave large gaps that register as
   * focus blocks even when the employee's actual measured focus time is lower
   * (e.g. because of unmeasured interruptions). This function inserts invisible
   * "phantom" gap events to break up excess focus blocks until the simulated
   * total matches the real-world target.
   *
   * ALGORITHM
   * ─────────
   * On each iteration: find the largest focus block, compute how much needs to
   * be trimmed, then insert a phantom event at the right position to split it.
   * Repeats up to 40 times or until simulated focus ≤ target + 15 min tolerance.
   *
   * This function is only called when targetFocusMin < focusThr (i.e. the
   * employee has less than 2 h of daily focus, so there should be no focus
   * blocks at all and any that exist need to be eliminated).
   *
   * @param {{ type: string, start: number, duration: number }[]} events
   * @param {number} workStart
   * @param {number} workEnd
   * @param {number} focusThr
   * @param {number} targetFocusMin – desired total focus time in minutes
   * @returns {{ type: string, start: number, duration: number }[]}
   */
  function calibrateToFocusTarget(events, workStart, workEnd, focusThr, targetFocusMin) {
    const sumFocus = evts =>
      getFocusBlocks(evts, workStart, workEnd, focusThr)
        .reduce((s, b) => s + b.end - b.start, 0);

    let result = [...events];
    for (let i = 0; i < 40; i++) {
      const simFocus = sumFocus(result);
      if (simFocus <= targetFocusMin + 15) break;  // within tolerance — done

      const blocks = getFocusBlocks(result, workStart, workEnd, focusThr);
      if (!blocks.length) break;

      // Target the largest focus block first.
      blocks.sort((a, b) => (b.end - b.start) - (a.end - a.start));
      const blk    = blocks[0];
      const excess = simFocus - targetFocusMin;

      // Trim from the start of the block by exactly `excess` minutes if possible,
      // leaving the correct amount of focus time in the tail.
      // If the block is only just above the threshold, split at the midpoint
      // instead — both halves will then fall below focusThr.
      const trimDur = Math.min(excess, blk.end - blk.start - focusThr);
      if (trimDur >= 5) {
        result = [...result, { type: 'gap', start: blk.start, duration: Math.round(trimDur) }]
                   .sort((a, b) => a.start - b.start);
      } else {
        const mid = Math.round((blk.start + blk.end) / 2);
        result = [...result, { type: 'gap', start: mid - 5, duration: 10 }]
                   .sort((a, b) => a.start - b.start);
      }
    }
    return result;
  }

  /**
   * Calibrates the simulated schedule so its total fragmented time matches the
   * measured Worklytics value. Works the same way as calibrateToFocusTarget but
   * targets fragmented (< focusThr) gaps instead of focus (≥ focusThr) gaps.
   *
   * On each iteration: find the largest fragmented block, then insert a phantom
   * event at its start with enough duration to either shrink it or eliminate it
   * entirely (if the remaining piece would fall below minGap).
   *
   * @param {{ type: string, start: number, duration: number }[]} events
   * @param {number} workStart
   * @param {number} workEnd
   * @param {number} focusThr
   * @param {number} minGap       – minimum gap length to count as fragmented (px)
   * @param {number} targetFragMin – desired total fragmented time in minutes
   * @returns {{ type: string, start: number, duration: number }[]}
   */
  function calibrateToFragmentedTarget(events, workStart, workEnd, focusThr, minGap, targetFragMin) {
    const sumFrag = evts =>
      getFragmentedBlocks(evts, workStart, workEnd, focusThr, minGap)
        .reduce((s, b) => s + b.end - b.start, 0);

    let result = [...events];
    for (let i = 0; i < 40; i++) {
      const simFrag = sumFrag(result);
      if (simFrag <= targetFragMin + 15) break;  // within tolerance — done

      const blocks = getFragmentedBlocks(result, workStart, workEnd, focusThr, minGap);
      if (!blocks.length) break;

      // Target the largest fragmented block first.
      blocks.sort((a, b) => (b.end - b.start) - (a.end - a.start));
      const blk    = blocks[0];

      // Trim from the start of the block. Adding minGap to the trim ensures the
      // remaining piece drops below minGap and is eliminated, rather than leaving
      // a tiny fragment that still counts toward the total.
      const trimDur = Math.min(simFrag - targetFragMin + minGap, blk.end - blk.start);
      if (trimDur >= 5) {
        result = [...result, { type: 'gap', start: blk.start, duration: Math.round(trimDur) }]
                   .sort((a, b) => a.start - b.start);
      } else {
        const mid = Math.round((blk.start + blk.end) / 2);
        result = [...result, { type: 'gap', start: mid - 5, duration: 10 }]
                   .sort((a, b) => a.start - b.start);
      }
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. SVG shape builders
  // ─────────────────────────────────────────────────────────────────────────────
  //
  // All shapes grow upward from a baseline y (top of the timeline bar).
  // SVG y-axis is inverted (increases downward), so y1 < y0 for taller shapes.
  //
  // Bezier handles use the standard approximation cx ≈ length × 0.55 to
  // produce smooth S-curves that closely resemble circular arcs.

  /**
   * Smooth trapezoidal plateau path — used for focus blocks (≥ 2 h).
   *
   * The shape has a flat top (plateau) with S-curve ramps at each end.
   * If the block is too narrow to fit both ramps, it falls back to a pure arch.
   *
   *   y0 ──╮                      ╭── y0
   *        │  S-ramp    plateau   │
   *   y1 ──┴──────────────────────┴── y1
   *
   * @param {number} x0     – left edge x
   * @param {number} x3     – right edge x
   * @param {number} y0     – baseline y (top of bar)
   * @param {number} y1     – plateau y (< y0, i.e. higher on screen)
   * @param {number} rampPx – horizontal width of each S-curve ramp
   */
  function plateauPath(x0, x3, y0, y1, rampPx) {
    const x1 = x0 + rampPx;  // end of left ramp / start of plateau
    const x2 = x3 - rampPx;  // end of plateau / start of right ramp
    const cx = rampPx * 0.55; // bezier handle offset for smooth S-curve
    if (x2 <= x1) {
      // Block is too narrow for a plateau — draw a simple arch instead.
      const mx = (x0 + x3) / 2;
      return (
        `M${f(x0)},${f(y0)} ` +
        `C${f(x0 + cx)},${f(y0)} ${f(mx)},${f(y1)} ${f(mx)},${f(y1)} ` +
        `C${f(mx)},${f(y1)} ${f(x3 - cx)},${f(y0)} ${f(x3)},${f(y0)} Z`
      );
    }
    return (
      `M${f(x0)},${f(y0)} ` +
      `C${f(x0 + cx)},${f(y0)} ${f(x1 - cx)},${f(y1)} ${f(x1)},${f(y1)} ` +
      `L${f(x2)},${f(y1)} ` +
      `C${f(x2 + cx)},${f(y1)} ${f(x3 - cx)},${f(y0)} ${f(x3)},${f(y0)} Z`
    );
  }

  /**
   * Smooth arch path — always rounded at the top, no flat plateau.
   * Used for fragmented blocks (< 2 h) to visually distinguish them from
   * the flat-topped focus plateaus.
   *
   * The bezier handles are all set to the peak height (y1), which causes the
   * sides to rise steeply from the baseline before rounding off at the top.
   *
   * @param {number} x0 – left edge x
   * @param {number} x3 – right edge x
   * @param {number} y0 – baseline y (top of bar)
   * @param {number} y1 – peak y (< y0)
   */
  function archPath(x0, x3, y0, y1) {
    const w  = x3 - x0;
    const mx = (x0 + x3) / 2;
    const hx = w * 0.22;  // horizontal spread of bezier handles
    // All four control points are at y1 (peak height) — this gives the shape
    // a steep climb at the edges and a smooth rounded top.
    return (
      `M${f(x0)},${f(y0)} ` +
      `C${f(x0 + hx)},${f(y1)} ${f(mx - hx)},${f(y1)} ${f(mx)},${f(y1)} ` +
      `C${f(mx + hx)},${f(y1)} ${f(x3 - hx)},${f(y1)} ${f(x3)},${f(y0)} Z`
    );
  }

  /**
   * Smooth mountain / hump path — defined for future use (not currently rendered).
   *
   * Intended for showing interruption events as humps rising above the bar,
   * including a ramp-down before and a ramp-up after the event body.
   *
   * @param {number} x0 – start of pre-event ramp (event.start − rampPx)
   * @param {number} x1 – event start
   * @param {number} x2 – event end
   * @param {number} x3 – end of post-event ramp (event.end + rampPx)
   * @param {number} y0 – baseline y
   * @param {number} y1 – peak y
   */
  function humpPath(x0, x1, x2, x3, y0, y1) {
    const cx1 = (x1 - x0) * 0.55;
    const cx2 = (x3 - x2) * 0.55;
    if (x2 - x1 < 2) {
      // Very short event — collapse to a single arch.
      const mx = (x0 + x3) / 2;
      return (
        `M${f(x0)},${f(y0)} ` +
        `C${f(x0 + cx1)},${f(y0)} ${f(mx)},${f(y1)} ${f(mx)},${f(y1)} ` +
        `C${f(mx)},${f(y1)} ${f(x3 - cx2)},${f(y0)} ${f(x3)},${f(y0)} Z`
      );
    }
    return (
      `M${f(x0)},${f(y0)} ` +
      `C${f(x0 + cx1)},${f(y0)} ${f(x1 - cx1)},${f(y1)} ${f(x1)},${f(y1)} ` +
      `L${f(x2)},${f(y1)} ` +
      `C${f(x2 + cx2)},${f(y1)} ${f(x3 - cx2)},${f(y0)} ${f(x3)},${f(y0)} Z`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Looker visualization
  // ─────────────────────────────────────────────────────────────────────────────

  looker.plugins.visualizations.add({
    id:    'focus_time_timeline_v1',
    label: 'Focus Time Timeline',

    // ── Visualization settings (exposed in the Looker "Edit" panel) ───────────
    options: {
      // ── Schedule section ─────────────────────────────────────────────────
      // Controls the shape of the simulated workday.
      work_start_hour: {
        type: 'number', label: 'Work Start (24-h hour)', default: 8,
        section: 'Schedule', order: 1,
      },
      work_end_hour: {
        type: 'number', label: 'Work End (24-h hour)', default: 18,
        section: 'Schedule', order: 2,
      },
      focus_threshold_hours: {
        type: 'number', label: 'Min Focus Block (hours)', default: 2,
        section: 'Schedule', order: 3,
        // Gaps shorter than this are shown as fragmented arches (pink);
        // gaps at least this long are shown as focus plateaus (blue).
      },
      ramp_minutes: {
        type: 'number', label: 'Focus Ramp Time (minutes)', default: 12,
        section: 'Schedule', order: 4,
        // Width of the S-curve slope at each edge of a focus plateau.
        // Represents the mental ramp-up / wind-down time around deep work.
      },

      // ── Metrics section ───────────────────────────────────────────────────
      // Worklytics data can come from different tool connectors (Slack vs Teams,
      // Gmail vs Outlook, etc.) and their metric keys differ. These dropdowns
      // let you pin each category to its exact source when auto-detection picks
      // the wrong one (most common when multiple tools are both connected).
      chat_source: {
        type: 'string', label: 'Chat / Messaging Tool',
        display: 'select',
        values: [
          { 'Auto-detect':       'auto'        },
          { 'Slack':             'slack'        },
          { 'Microsoft Teams':   'msft:teams'   },
          { 'Google Chat':       'google:chat'  },
        ],
        section: 'Metrics', order: 1, default: 'auto',
      },
      email_source: {
        type: 'string', label: 'Email Tool',
        display: 'select',
        values: [
          { 'Auto-detect':             'auto'  },
          { 'Gmail':                   'gmail' },
          { 'Outlook / Microsoft 365': 'msft'  },
        ],
        section: 'Metrics', order: 2, default: 'auto',
      },
      meeting_source: {
        type: 'string', label: 'Calendar / Meetings Tool',
        display: 'select',
        values: [
          { 'Auto-detect':            'auto'             },
          { 'Google Calendar':        'google:calendar'  },
          { 'Outlook Calendar':       'msft:calendar'    },
          { 'Microsoft Teams Calls':  'msft:teams:calls' },
          { 'Zoom':                   'zoom'             },
        ],
        section: 'Metrics', order: 3, default: 'auto',
      },
    },

    // ── create ────────────────────────────────────────────────────────────────
    // Called once when the visualization is first mounted. Injects the static
    // HTML skeleton and CSS. The SVG and stats text are populated in _draw().
    //
    // HTML structure:
    //   .ftl                  – outer flex column, vertically centred
    //     .ftl-chart          – shrink-to-fit wrapper around the SVG
    //       #ftl-svg          – the timeline SVG (width/height set dynamically)
    //     #ftl-stats          – "N interruptions · Xh focus · Yh fragmented" line
    //     .ftl-legend         – row of legend chips
    //       .ftl-li           – non-clickable chip (Focus Time)
    //       .ftl-toggle       – clickable chip (Email / Chat / Meetings)
    create(element, config) {
      element.style.background = '#ffffff';
      element.style.overflow   = 'hidden';
      element.innerHTML = `
<style>
  /* ── Outer layout ─────────────────────────────────────────────────────── */
  .ftl{display:flex;flex-direction:column;width:100%;height:100%;
       padding:10px 8px 8px;box-sizing:border-box;overflow:hidden;
       font-family:"Google Sans",Roboto,Arial,sans-serif;justify-content:center}

  /* flex-shrink:0 (not flex:1) lets the SVG drive its own height rather than
     expanding to fill all available space, which would create dead whitespace. */
  .ftl-chart{flex-shrink:0;position:relative;overflow:hidden}

  /* ── Stats & legend ───────────────────────────────────────────────────── */
  .ftl-stats{text-align:center;flex-shrink:0;margin-top:0;
             font-size:13px;color:#5f6368;line-height:1.4}
  .ftl-stats b{font-weight:600;color:#3c4043}
  .ftl-legend{display:flex;gap:24px;justify-content:center;flex-shrink:0;
              margin-top:10px;font-size:13px;color:#5f6368}
  .ftl-li{display:flex;align-items:center;gap:6px}
  .ftl-sw{width:14px;height:14px;border-radius:2px;flex-shrink:0}

  /* ── Clickable legend chips ───────────────────────────────────────────── */
  /* Styled as filter chips (pill shape with border) so they read as
     interactive elements even without a hover state. */
  .ftl-toggle{cursor:pointer;user-select:none;
             padding:3px 10px 3px 6px;border-radius:14px;
             border:1.5px solid rgba(0,0,0,0.14);
             transition:background 0.15s,opacity 0.2s,border-color 0.15s}
  .ftl-toggle:hover{background:rgba(0,0,0,0.05);border-color:rgba(0,0,0,0.28)}

  /* Disabled state: dashed border + strikethrough label */
  .ftl-toggle.ftl-off{opacity:0.45;border-style:dashed}
  .ftl-toggle.ftl-off span{text-decoration:line-through}

  /* ✓ checkmark overlaid on the colour swatch when the chip is active */
  .ftl-toggle .ftl-sw{position:relative;border-radius:3px}
  .ftl-toggle .ftl-sw::after{content:'✓';position:absolute;inset:0;
    display:flex;align-items:center;justify-content:center;
    color:rgba(255,255,255,0.95);font-size:9px;font-weight:700;line-height:1}
  .ftl-toggle.ftl-off .ftl-sw::after{content:''}  /* hide ✓ when disabled */

  /* ── Shape bubble-in animation ────────────────────────────────────────── */
  /* Applied to all above-bar shapes (plateaus + arches) on each re-render.
     Uses transform-box:fill-box so transform-origin is relative to each
     shape's own bounding box, making them scale from their base (bar edge).
     Spring easing cubic-bezier(0.34, 1.56, 0.64, 1) gives a slight overshoot
     for an organic "pop". Shapes are staggered with per-shape animation-delay
     to create a left-to-right cascade effect. */
  @keyframes ftl-bubble{from{transform:scaleY(0);opacity:0}to{transform:scaleY(1);opacity:1}}
  .ftl-shape{transform-box:fill-box;transform-origin:bottom center;
             animation:ftl-bubble 0.55s cubic-bezier(0.34,1.56,0.64,1) both}
</style>
<div class="ftl">
  <div class="ftl-chart">
    <svg id="ftl-svg" style="display:block;overflow:hidden"></svg>
  </div>
  <div class="ftl-stats" id="ftl-stats"></div>
  <div class="ftl-legend">
    <div class="ftl-li"><div class="ftl-sw" style="background:rgba(59,130,246,0.35)"></div><span>Focus Time</span></div>
    <div class="ftl-li"><div class="ftl-sw" style="background:rgba(239,68,68,0.35)"></div><span>Fragmented Time</span></div>
    <div class="ftl-li ftl-toggle" data-type="email"><div class="ftl-sw" style="background:#10B981"></div><span>Email</span></div>
    <div class="ftl-li ftl-toggle" data-type="chat"><div class="ftl-sw" style="background:#F59E0B"></div><span>Chat</span></div>
    <div class="ftl-li ftl-toggle" data-type="meeting"><div class="ftl-sw" style="background:#EF4444"></div><span>Meetings</span></div>
  </div>
</div>`;
    },

    // ── updateAsync ───────────────────────────────────────────────────────────
    // Called by Looker whenever data or config changes. Responsible for:
    //   1. Extracting metric values from whichever data layout Looker provides
    //   2. Converting weekly totals to daily averages
    //   3. Generating and calibrating the representative schedule
    //   4. Rendering the SVG via _draw()
    //   5. Wiring up the legend toggle click handlers
    updateAsync(data, element, config, queryResponse, details, done) {

      // ── Step 1: Detect data layout and extract metric values ──────────────
      // Worklytics data can arrive in three different Looker query shapes.
      // We detect which one is present and normalise to the same six variables.
      const dims     = queryResponse.fields.dimension_like || [];
      const measures = queryResponse.fields.measure_like   || [];
      const pivots   = queryResponse.fields.pivots         || [];
      const row      = data[0] || {};

      console.log('[FTL] schema — dims:', dims.map(d => d.name),
                  'measures:', measures.map(m => m.name),
                  'pivots:', pivots.map(p => p.name), 'rows:', data.length);

      let meetingsAttended = 0, meetingHours = 0, emailsSent = 0,
          chatSent = 0, focusHours = 0, fragmentedHours = 0;

      /**
       * Search a flat key→value lookup object for the first key that contains
       * any of the given pattern substrings (case-insensitive via .toLowerCase()).
       * Optional `exclude` patterns allow skipping keys that also match an
       * unwanted term (e.g. skip "fragmented" when looking for "focus").
       *
       * @param {Record<string,number>} lookup
       * @param {string[]} patterns
       * @param {string[]} [exclude]
       * @returns {number}
       */
      const findInLookup = (lookup, patterns, exclude) => {
        for (const [k, v] of Object.entries(lookup)) {
          if (exclude && exclude.some(e => k.includes(e))) continue;
          if (patterns.some(p => k.includes(p))) return v;
        }
        return 0;
      };

      // ── Per-tool metric key patterns ────────────────────────────────────
      // Maps each tool selector value (from the Metrics config dropdowns) to
      // the substring patterns used to identify that tool's metric keys in the
      // Looker data. Patterns are tried left-to-right; the first match wins.
      //
      // 'auto' uses broad patterns that match any tool — fine when only one
      // tool is connected. Specific tool values are more precise and avoid
      // false matches when, for example, both Slack and Teams are connected.
      const PATTERNS = {
        chat: {
          auto:          ['slack:message:sent', 'msft:teams:v1:message:sent',
                          'google-chat:message:sent', 'gmail:chats:sent',
                          'message:sent', 'message_sent'],
          slack:         ['slack:message:sent', 'slack:v1:message:sent:count',
                          'slack:message', 'slack'],
          'msft:teams':  ['msft:teams:v1:message:sent:count',
                          'msft:teams:v1:dm:chats:sent:count',
                          'msft:teams:v1:group:chats:sent:count',
                          'msft:teams:v1:message:sent', 'msft:teams'],
          'google:chat': ['google-chat:message:sent', 'google-chat:message', 'google-chat'],
        },
        email: {
          auto:  ['outlook-mail:emails:sent', 'gmail:emails:sent',
                  'email:outgoing:total', 'emails:sent', 'emails_sent'],
          gmail: ['gmail:emails:sent', 'gmail:email', 'gmail'],
          msft:  ['outlook-mail:emails:sent', 'outlook-mail:email', 'outlook-mail'],
        },
        meetingsAttended: {
          auto:               ['calendar:events:attended', 'gcal:events:attended',
                               'outlook-cal:events:attended', 'zoom:v3:events:attended',
                               'events:attended', 'events_attended'],
          'google:calendar':  ['gcal:events:attended', 'calendar:events:attended'],
          'msft:calendar':    ['outlook-cal:events:attended'],
          'msft:teams:calls': ['msft:teams:v1:calls:attended:scheduled:count',
                               'msft:teams:v1:calls:attended:unscheduled:count',
                               'msft:teams:v1:calls:attended'],
          zoom:               ['zoom:v3:events:attended', 'zoom:events:attended'],
        },
        meetingHours: {
          auto:               ['calendar:events:hours:meetings',
                               'gcal:events:hours:spent:meetings',
                               'outlook-cal:events:hours:spent:meetings',
                               'zoom:v3:events:hours:spent:meetings',
                               'hours:meetings', 'meeting_hours'],
          'google:calendar':  ['gcal:events:hours:spent:meetings',
                               'calendar:events:hours:meetings'],
          'msft:calendar':    ['outlook-cal:events:hours:spent:meetings'],
          'msft:teams:calls': ['msft:teams:v1:calls:sum:hours:spent:meetings',
                               'msft:teams:v1:calls:scheduled:sum:hours:spent:meetings'],
          zoom:               ['zoom:v3:events:hours:spent:meetings',
                               'zoom:events:hours:spent:meetings'],
        },
      };

      // Read tool selections from config (default to 'auto' if not set).
      const chatSrc = config.chat_source    || 'auto';
      const emlSrc  = config.email_source   || 'auto';
      const metSrc  = config.meeting_source || 'auto';

      /**
       * Extract all six metric values from a key→value lookup object.
       * Used by both Layout B (key-value rows) and Layout C (pivoted).
       */
      const extractMetrics = (lookup) => {
        meetingsAttended = findInLookup(lookup,
          PATTERNS.meetingsAttended[metSrc] || PATTERNS.meetingsAttended.auto);
        meetingHours = findInLookup(lookup,
          PATTERNS.meetingHours[metSrc]     || PATTERNS.meetingHours.auto);
        emailsSent = findInLookup(lookup,
          PATTERNS.email[emlSrc]            || PATTERNS.email.auto);
        chatSent = findInLookup(lookup,
          PATTERNS.chat[chatSrc]            || PATTERNS.chat.auto);
        // Focus and fragmented keys both contain "focus" so we search for the
        // most specific patterns first and exclude "fragmented" from the focus search.
        focusHours      = findInLookup(lookup,
          ['worklytics:hours:in:focus', 'hours:in:focus', 'focus:blocks', 'focus'],
          ['fragment']);
        fragmentedHours = findInLookup(lookup,
          ['worklytics:hours:fragmented', 'hours:fragmented', 'fragmented']);
      };

      if (measures.length >= 4) {
        // ── Layout A: multiple measure columns, positional order ──────────
        // Each measure column is a distinct metric. Column order is fixed:
        // [0] meetings attended, [1] meeting hours, [2] emails sent,
        // [3] chat messages sent, [4+] focus/fragmented hours (detected by name).
        const gv = i => parseFloat(row[measures[i]?.name]?.value) || 0;
        meetingsAttended = gv(0);
        meetingHours     = gv(1);
        emailsSent       = gv(2);
        chatSent         = gv(3);
        const fi = measures.findIndex(f => /focus/i.test(f.name) && !/fragment/i.test(f.name));
        focusHours = fi >= 0 ? gv(fi) : gv(4);
        const fri = measures.findIndex(f => /fragment/i.test(f.name));
        fragmentedHours = fri >= 0 ? gv(fri) : 0;

      } else if (pivots.length > 0 || (measures.length === 1 && dims.length === 0)) {
        // ── Layout C: pivoted — metric keys are pivot column headers ──────
        // e.g. People Metrics Typical Metric Key (pivot) | P50 (measure)
        // Build a key→value lookup from the pivot column cells.
        const valName   = measures[0]?.name;
        const pivotData = valName ? row[valName] : {};
        const lookup    = {};
        if (pivotData && typeof pivotData === 'object') {
          for (const [key, cell] of Object.entries(pivotData)) {
            const raw = typeof cell === 'object' ? cell?.value : cell;
            const val = parseFloat(raw);
            if (!isNaN(val)) lookup[key.toLowerCase()] = val;
          }
        }
        console.log('[FTL] pivot lookup:', JSON.stringify(lookup));
        extractMetrics(lookup);

      } else if (dims.length > 0) {
        // ── Layout B: key-value rows ───────────────────────────────────────
        // e.g. Metric Key (dimension) | Value (measure) — one row per metric.
        const dimName = dims[0]?.name;
        const valName = measures[0]?.name;
        if (dimName && valName) {
          const lookup = {};
          for (const r of data) {
            const key = String(r[dimName]?.value || '').toLowerCase();
            const val = parseFloat(r[valName]?.value);
            if (key && !isNaN(val)) lookup[key] = val;
          }
          console.log('[FTL] kv lookup:', JSON.stringify(lookup));
          extractMetrics(lookup);
        }
      }

      console.log('[FTL] raw values:', { meetingsAttended, meetingHours, emailsSent, chatSent,
                                          focusHours, fragmentedHours });

      // ── Step 2: Convert to daily inputs for schedule generation ───────────
      // Meeting, email and chat metrics from Worklytics are weekly totals
      // (covering a typical 5-day work week), so we divide by 5 to get a
      // representative single-day value.
      //
      // Focus and fragmented hours are already daily averages as reported by
      // Worklytics (the :flow metric represents a person's typical day), so
      // they are used directly without dividing.
      //
      // Default values are used when a metric is missing from the query,
      // producing a plausible "average" schedule rather than an empty chart.
      const renderOpts = {
        rampMin:  config.ramp_minutes              || 12,
        focusThr: Math.round((config.focus_threshold_hours || 2) * 60),
      };
      const inputs = {
        numMeetings:          Math.max(1, Math.round((meetingsAttended / 5) || 4)),
        meetingMinutes:       ((meetingHours / 5) || 2) * 60,  // weekly hours → daily minutes
        numEmails:            (emailsSent / 5) || 10,           // weekly → daily
        numChat:              (chatSent    / 5) || 20,           // weekly → daily
        focusHoursDaily:      focusHours      > 0 ? focusHours      : null,  // already daily
        fragmentedHoursDaily: fragmentedHours > 0 ? fragmentedHours : null,  // already daily
        focusThr:             renderOpts.focusThr,               // passed into generateSchedule
        workStart:            Math.round((config.work_start_hour || 8)  * 60),
        workEnd:              Math.round((config.work_end_hour   || 18) * 60),
      };
      console.log('[FTL] schedule inputs:', JSON.stringify(inputs));

      // ── Step 3: Generate schedule ──────────────────────────────────────────
      // generateSchedule handles calibration internally by placing real chat
      // events — keeping bar and shapes always in sync with each other.
      const { events, hasFocus, focusStart, focusEnd } = generateSchedule(inputs);

      // ── Step 4: Render ─────────────────────────────────────────────────────
      // Persist the disabled-type set across Looker data refreshes so that
      // legend toggle state is preserved when the underlying data updates.
      if (!this._disabledTypes) this._disabledTypes = new Set();

      // Store the full calibrated event list and render options so that legend
      // toggles can re-draw without re-running the full schedule generation.
      this._allEvents = events;
      this._drawOpts  = { ...inputs, ...renderOpts, hasFocus, focusStart, focusEnd };

      const filteredEvents = events.filter(e => !this._disabledTypes.has(e.type));
      this._draw(element, filteredEvents, this._drawOpts);

      // ── Step 5: Wire up legend toggle click handlers ───────────────────────
      // We clone each toggle node before attaching a new listener to prevent
      // duplicate handlers from accumulating across repeated updateAsync calls.
      const self = this;
      element.querySelectorAll('.ftl-toggle').forEach(li => {
        const fresh = li.cloneNode(true);
        li.parentNode.replaceChild(fresh, li);
        const type = fresh.dataset.type;

        // Restore the chip's visual state if this type was already toggled off.
        if (self._disabledTypes.has(type)) fresh.classList.add('ftl-off');

        fresh.addEventListener('click', () => {
          // Toggle the type in/out of the disabled set and update the chip UI.
          if (self._disabledTypes.has(type)) {
            self._disabledTypes.delete(type);
            fresh.classList.remove('ftl-off');
          } else {
            self._disabledTypes.add(type);
            fresh.classList.add('ftl-off');
          }
          // Re-draw with the updated filter. The bubble-in animation fires
          // automatically because _draw() replaces svg.innerHTML, triggering
          // a fresh animation cycle on the newly-created path elements.
          const filtered = self._allEvents.filter(e => !self._disabledTypes.has(e.type));
          self._draw(element, filtered, self._drawOpts);
        });
      });

      done();
    },

    // ── _draw (SVG renderer) ──────────────────────────────────────────────────
    // Builds the SVG string from scratch and assigns it to svg.innerHTML.
    // Called on initial render and on every legend toggle click.
    //
    // RENDERING PIPELINE
    // ──────────────────
    //  1. Clip path + gray background bar
    //  2. Coloured timeline segments (clipped to bar bounds)
    //  3. Thin border overlay on bar
    //  4. Above-bar shapes: focus plateaus (blue) and fragmented arches (pink)
    //     — sorted left-to-right, staggered animation delay for cascade effect
    //  5. Hour-marker tick lines and labels
    //  6. Stats text (interruptions / focus time / fragmented time)
    _draw(element, events, { workStart, workEnd, rampMin, focusThr, hasFocus, focusStart, focusEnd,
                              focusHoursDaily, fragmentedHoursDaily }) {
      const svg = element.querySelector('#ftl-svg');
      if (!svg) return;

      // Read container dimensions. We use element.clientWidth directly rather
      // than the SVG's own size because flex child dimensions are unreliable
      // inside Looker's sandboxed iframe until after layout has settled.
      const W = Math.max(300, element.clientWidth  || 700);
      // H drives the bar's vertical position; SVG height is set to content height
      // (barY + barH + padding) so there is no dead space below the axis labels.
      const H = Math.max(100, (element.clientHeight || 280) - 108);

      svg.setAttribute('width', W);

      // ── Chart margins ─────────────────────────────────────────────────────
      const ML   = 36;           // left margin (pixels)
      const MR   = 36;           // right margin (pixels)
      const cW   = W - ML - MR;  // drawable chart width
      const wDur = workEnd - workStart;  // workday duration (minutes)

      // A small gray extension at each end of the bar represents non-work time
      // (i.e. the buffer before the first event and after the last). Capped so
      // it never exceeds the margin, which would clip the bar end.
      const grayBuf = Math.min(Math.round(cW * 0.03), ML - 4, MR - 4);

      // ── Vertical layout ───────────────────────────────────────────────────
      // The bar sits at 62% of the available height. The space above it
      // (barY pixels) holds the focus plateaus and fragmented arches.
      const barY  = Math.round(H * 0.62);
      const barH  = Math.max(20, Math.round(H * 0.15));
      const maxFH = Math.round(barY * 0.80);  // maximum shape height above bar

      // Set SVG height precisely so it is exactly as tall as its content
      // (bar + axis labels + 32 px gap before the stats line).
      const svgH = barY + barH + 56;  // 56 = 24px axis label height + 32px gap
      svg.setAttribute('height', svgH);

      // ── Coordinate helpers ─────────────────────────────────────────────────
      const tx     = t => ML + ((t - workStart) / wDur) * cW;  // minutes → x pixels
      const rampPx = (rampMin / wDur) * cW;                     // focus ramp minutes → pixels

      // ── Colour palette ────────────────────────────────────────────────────
      // All uninterrupted time (whether long enough for focus or not) is the
      // same blue in the bar — the shape height above the bar differentiates
      // focus (plateau) from fragmented (arch).
      const COLOR = {
        focus:      '#3B82F6',  // slate blue   — long uninterrupted blocks
        fragmented: '#3B82F6',  // same blue    — short uninterrupted blocks
        meeting:    '#EF4444',  // rose red
        email:      '#10B981',  // emerald green
        chat:       '#F59E0B',  // amber
        bg:         '#E8EAED',  // light grey   — background bar
      };

      // ── Tooltip text for SVG <title> elements ─────────────────────────────
      // Browsers show these natively on hover with no JavaScript required.
      const TIP = {
        focus:      'Focus time, which allows for deep work',
        fragmented: 'Time lost due to fragmented time',
        meeting:    'Meeting',
        email:      'Email sent',
        chat:       'Chat message sent',
      };

      // ── Build SVG element list ────────────────────────────────────────────
      const p      = [];
      const clipId = 'ftl-bar-clip';

      // Full bar dimensions including the gray buffer zones at each edge.
      const fullBarX = ML - grayBuf;
      const fullBarW = cW + grayBuf * 2;

      // 1. Clip path: ensures coloured segments don't bleed outside the bar bounds.
      p.push(
        `<defs>` +
        `<clipPath id="${clipId}">` +
        `<rect x="${fullBarX}" y="${barY}" width="${fullBarW}" height="${barH}"/>` +
        `</clipPath>` +
        `</defs>`
      );

      // 2a. Gray background bar (the "empty" workday before events are applied).
      p.push(`<rect x="${fullBarX}" y="${barY}" width="${fullBarW}" height="${barH}" fill="${COLOR.bg}"/>`);

      // 2b. Coloured timeline segments (clipped to bar).
      // All events are real visible events — no phantom gap types exist.
      p.push(`<g clip-path="url(#${clipId})">`);
      const timelineSegs = buildTimeline(events, workStart, workEnd, focusThr);
      timelineSegs.forEach(seg => {
        const x = tx(seg.start);
        const w = Math.max(1.5, tx(seg.end) - x);  // min 1.5px so tiny events remain visible
        const tip = TIP[seg.type] || '';
        p.push(
          `<rect x="${f(x)}" y="${barY}" width="${f(w)}" height="${barH}" fill="${COLOR[seg.type] || COLOR.bg}">` +
          (tip ? `<title>${tip}</title>` : '') +
          `</rect>`
        );
      });
      p.push('</g>');

      // 3. Subtle border overlay (drawn after segments so it sits on top).
      p.push(`<rect x="${fullBarX}" y="${barY}" width="${fullBarW}" height="${barH}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="1"/>`);

      // 4. Above-bar shapes: focus plateaus (blue) + fragmented arches (pink).
      //
      // Both sets are merged and sorted by start time so the bubble-in animation
      // stagger follows left-to-right visual order — the leftmost shape pops in
      // first, then each subsequent shape 40 ms later.
      //
      // Focus plateau height scales linearly with block duration (capped at maxFH).
      // Fragmented arch height uses a power curve (pct^0.6) so medium-length
      // blocks (e.g. 1 h) appear noticeably taller than very short ones.
      //
      // Two shape-detection modes depending on toggle state:
      //
      // DEFAULT (nothing toggled):
      //   Use the Worklytics-measured zone directly — always exactly one plateau
      //   covering [focusStart, focusEnd]. This matches the measured value and
      //   avoids any boundary-phantom artifacts.
      //
      // TOGGLE MODE (one or more types disabled):
      //   Recompute dynamically from the remaining events so users can explore
      //   "what if I had no meetings?" hypotheticals. Boundary phantoms (type:
      //   'fragmented') are excluded from shape detection here — they only exist
      //   for bar rendering and would otherwise create a phantom 1-min gap at
      //   focusEnd that splits the plateau in two. Without them, uninterrupted
      //   time extends naturally: toggle everything off → whole day is focus.
      const anyDisabled = this._disabledTypes && this._disabledTypes.size > 0;
      let focusBlocks, fragBlocks;
      if (!anyDisabled) {
        focusBlocks = hasFocus ? [{ start: focusStart, end: focusEnd }] : [];
        fragBlocks  = getFragmentedBlocks(events, workStart, workEnd, focusThr, 2);
      } else {
        // In toggle mode, exclude both boundary phantoms AND disabled event types.
        // This lets getFocusBlocks/getFragmentedBlocks see the hypothetical schedule
        // with those interruption types removed — e.g. toggle all off → whole day focus.
        const shapeEvents = events.filter(
          e => e.type !== 'fragmented' && !this._disabledTypes.has(e.type)
        );
        focusBlocks = getFocusBlocks(shapeEvents, workStart, workEnd, focusThr);
        fragBlocks  = getFragmentedBlocks(shapeEvents, workStart, workEnd, focusThr, 2);
      }

      const allShapes = [
        ...focusBlocks.map(b => ({ ...b, kind: 'focus' })),
        ...fragBlocks.map(b  => ({ ...b, kind: 'fragmented' })),
      ].sort((a, b) => a.start - b.start);

      allShapes.forEach((block, idx) => {
        // Stagger animation: 50 ms base delay + 40 ms per shape.
        const delay = (0.05 + idx * 0.04).toFixed(2);

        if (block.kind === 'focus') {
          // All focus plateaus are the same height — every block qualifies equally
          // (≥ focusThr uninterrupted), so height should not vary by duration.
          const fH  = maxFH;
          const x0  = tx(block.start);
          const x3  = tx(block.end);
          const rp  = Math.min(rampPx, (x3 - x0) * 0.25);  // ramp can't exceed 25% of block width
          const d   = plateauPath(x0, x3, barY, barY - fH, rp);
          p.push(
            `<path d="${d}" fill="rgba(59,130,246,0.26)" stroke="none" ` +
            `class="ftl-shape" style="animation-delay:${delay}s">` +
            `<title>${TIP.focus}</title></path>`
          );
        } else {
          const dur = block.end - block.start;
          // Power curve: 15 min → ~26% height, 1 h → ~73%, approaching 100% at 2 h.
          const pct = Math.min(1, dur / focusThr);
          const fH  = maxFH * (0.20 + 0.80 * Math.pow(pct, 0.6));
          const x0  = tx(block.start);
          const x3  = tx(block.end);
          const d   = archPath(x0, x3, barY, barY - fH);
          p.push(
            `<path d="${d}" fill="rgba(239,68,68,0.22)" stroke="none" ` +
            `class="ftl-shape" style="animation-delay:${delay}s">` +
            `<title>${TIP.fragmented}</title></path>`
          );
        }
      });

      // 5. Hour-marker axis: dashed tick line + label for each whole hour.
      const h0 = Math.ceil(workStart  / 60);
      const hN = Math.floor(workEnd   / 60);
      for (let h = h0; h <= hN; h++) {
        const x   = tx(h * 60);
        const lbl = h === 12 ? '12 pm' : h < 12 ? `${h} am` : `${h - 12} pm`;
        p.push(
          `<line x1="${f(x)}" y1="${barY}" x2="${f(x)}" y2="${barY + barH + 6}" ` +
          `stroke="#9AA0A6" stroke-width="1" stroke-dasharray="3,3"/>`
        );
        p.push(
          `<text x="${f(x)}" y="${barY + barH + 20}" ` +
          `text-anchor="middle" font-size="12" fill="#5F6368" ` +
          `font-family="Arial,sans-serif">${lbl}</text>`
        );
      }

      // Assign the assembled SVG markup in one shot to minimise reflow.
      svg.innerHTML = p.join('\n');

      // ── 6. Summary stats line ─────────────────────────────────────────────
      const statsEl = element.querySelector('#ftl-stats');
      if (statsEl) {
        // Format minutes as "Xh Ym" (or just "Ym" if under an hour).
        const fmtTime = min => {
          const h = Math.floor(min / 60), m = Math.round(min % 60);
          return h > 0 ? `${h}h ${m}m` : `${m}m`;
        };

        // Interruptions = real event types only (exclude invisible 'gap' phantoms
        // added by calibrateToFocusTarget).
        const interruptions = events.filter(
          e => e.type === 'meeting' || e.type === 'email' || e.type === 'chat'
        ).length;

        // When event types are toggled off, compute focus/frag time from the
        // detected blocks so the stats reflect the visible bar and users can
        // see the hypothetical gain from removing meetings/email/chat.
        // When nothing is toggled, prefer the raw Worklytics metric values
        // (more accurate than the simulated gap widths).
        const focusMin = (!anyDisabled && focusHoursDaily != null)
          ? Math.round(focusHoursDaily * 60)
          : focusBlocks.reduce((s, b) => s + (b.end - b.start), 0);
        const fragMin  = (!anyDisabled && fragmentedHoursDaily != null)
          ? Math.round(fragmentedHoursDaily * 60)
          : fragBlocks.reduce( (s, b) => s + (b.end - b.start), 0);

        statsEl.innerHTML =
          `<b>${interruptions}</b> interruption${interruptions !== 1 ? 's' : ''} · ` +
          `<b>${fmtTime(focusMin)}</b> focus time · ` +
          `<b>${fmtTime(fragMin)}</b> lost to fragmentation`;
      }
    },
  });
})();
