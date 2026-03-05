/**
 * Focus Time Timeline – Looker Custom Visualization
 *
 * Simulates a representative workday based on aggregate meeting/communication
 * metrics and renders it as an annotated timeline showing focus time vs. interruptions.
 *
 * Field order (drag measures onto the visualization in this order):
 *   1. Meeting minutes per day   — e.g. SUM(meeting_minutes)
 *   2. Number of meetings        — e.g. COUNT(meeting_id)
 *   3. Chat / Slack messages     — e.g. SUM(chat_messages_sent)
 *   4. Emails sent               — e.g. SUM(emails_sent)
 *
 * The chart uses a seeded pseudo-random generator so the same input values
 * always produce the same representative schedule.
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  /** Xorshift32 seeded RNG – returns floats in [0, 1). */
  function makeRNG(seed) {
    let s = (Math.abs(Math.round(seed)) >>> 0) || 1_234_567;
    return () => {
      s ^= s << 13;
      s ^= s >> 17;
      s ^= s << 5;
      return (s >>> 0) / 0x1_0000_0000;
    };
  }

  /** Format a number to one decimal place (for SVG coordinates). */
  const f = v => Number(v).toFixed(1);

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Schedule generation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Generates a list of events (meetings, email sessions, chat sessions)
   * spread across the workday using a deterministic seeded RNG.
   *
   * @param {object} opts
   * @param {number} opts.meetingMinutes  – total meeting time in minutes
   * @param {number} opts.numMeetings     – number of distinct meetings
   * @param {number} opts.numChat         – number of chat/Slack messages
   * @param {number} opts.numEmails       – number of emails sent
   * @param {number} opts.workStart       – work day start in minutes from midnight (e.g. 480 = 8 am)
   * @param {number} opts.workEnd         – work day end   in minutes from midnight (e.g. 1080 = 6 pm)
   * @returns {{ type: string, start: number, duration: number }[]}
   */
  function generateSchedule({ meetingMinutes, numMeetings, numChat, numEmails, focusHoursDaily, workStart, workEnd }) {
    const rng = makeRNG(
      Math.round(meetingMinutes) * 10_007 +
      numMeetings               *    997 +
      numChat                   *    101 +
      numEmails                 *     37
    );

    const buf    = 30;
    const aStart = workStart + buf;
    const aEnd   = workEnd   - buf;
    const aLen   = aEnd - aStart;

    // ── Focus block ───────────────────────────────────────────────────────────
    // If actual focus time >= 2 h, reserve a block for it first so that
    // meetings and chat are packed around it rather than fragmenting the day.
    const focusMin = focusHoursDaily ? Math.round(focusHoursDaily * 60) : 0;
    const hasFocus = focusMin >= 120;
    const focusBuf = 15; // min gap between focus block and surrounding meetings

    let focusStart = null, focusEnd = null;
    if (hasFocus) {
      // Position the focus block somewhere in the middle of the day
      // (between 15% and 65% through the available span).
      const span = Math.max(0, aLen - focusMin);
      focusStart = Math.round(aStart + (0.15 + rng() * 0.50) * span);
      focusEnd   = focusStart + focusMin;
    }

    // ── Build placement windows (regions outside the focus block) ─────────────
    const windows = hasFocus
      ? [
          { start: aStart,              end: focusStart - focusBuf },
          { start: focusEnd + focusBuf, end: aEnd                  },
        ].filter(w => w.end - w.start >= 20)
      : [{ start: aStart, end: aEnd }];

    const totalWinLen = windows.reduce((s, w) => s + Math.max(0, w.end - w.start), 0);

    // ── Meetings ──────────────────────────────────────────────────────────────
    const avgDur     = Math.max(15, Math.min(90, meetingMinutes / Math.max(1, numMeetings)));
    const sortedPos  = Array.from({ length: numMeetings }, rng).sort((a, b) => a - b);

    const meetings = sortedPos.map(pos => {
      // Map pos [0,1] to a point inside one of the placement windows.
      let t = pos * totalWinLen, cumLen = 0;
      for (const w of windows) {
        const wLen = Math.max(0, w.end - w.start);
        if (t <= cumLen + wLen) {
          const localT    = wLen > 0 ? (t - cumLen) / wLen : 0;
          const rawStart  = Math.round(w.start + localT * Math.max(0, wLen - avgDur));
          const start     = Math.max(w.start, Math.min(w.end - 15, rawStart));
          // Cap duration so the meeting cannot bleed past the window end
          // (which would overwrite the reserved focus zone).
          const maxDur    = Math.max(15, w.end - start);
          return {
            type:     'meeting',
            start,
            duration: Math.max(15, Math.min(maxDur, Math.round(avgDur * (0.75 + rng() * 0.5)))),
          };
        }
        cumLen += wLen;
      }
      // Fallback: first window start
      return { type: 'meeting', start: windows[0]?.start ?? aStart, duration: Math.round(avgDur) };
    });

    // Resolve meeting overlaps with a 15-min gap.
    meetings.sort((a, b) => a.start - b.start);
    for (let i = 1; i < meetings.length; i++) {
      const p = meetings[i - 1];
      meetings[i].start = Math.max(meetings[i].start, p.start + p.duration + 15);
    }
    // Drop meetings that overflow the day or that bleed into the focus zone
    // (can happen after overlap-push during resolution).
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
    const occupied = [
      ...validMeetings.map(m => ({ s: m.start - 15, e: m.start + m.duration + 15 })),
      // Block the focus window so chat/email don't land inside it.
      ...(hasFocus ? [{ s: focusStart - focusBuf, e: focusEnd + focusBuf }] : []),
    ];

    const tryPlace = (type, duration) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const t = Math.round(aStart + rng() * (aLen - duration));
        if (hasFocus && t + duration > focusStart - focusBuf && t < focusEnd + focusBuf) continue;
        if (!occupied.some(o => t < o.e && t + duration > o.s)) {
          occupied.push({ s: t - 10, e: t + duration + 10 });
          return { type, start: t, duration };
        }
      }
      return null;
    };

    const emailClusters = Math.max(1, Math.round(numEmails / 5));
    const chatClusters  = Math.max(1, Math.round(numChat   / 8));

    const emailEvents = Array.from({ length: emailClusters }, () => tryPlace('email', 5)).filter(Boolean);
    const chatEvents  = Array.from({ length: chatClusters  }, () => tryPlace('chat',  3)).filter(Boolean);

    return [...validMeetings, ...emailEvents, ...chatEvents].sort((a, b) => a.start - b.start);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Timeline helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Converts an event list into an ordered array of coloured bar segments.
   * Gaps >= focusThr minutes are classified as 'focus'; shorter gaps as 'gap'.
   */
  function buildTimeline(events, workStart, workEnd, focusThr) {
    const segs = [];
    let t = workStart;
    for (const ev of events) {
      if (ev.start > t) {
        segs.push({ start: t, end: ev.start, type: (ev.start - t) >= focusThr ? 'focus' : 'gap' });
      }
      segs.push({ start: ev.start, end: ev.start + ev.duration, type: ev.type });
      t = ev.start + ev.duration;
    }
    if (t < workEnd) {
      segs.push({ start: t, end: workEnd, type: (workEnd - t) >= focusThr ? 'focus' : 'gap' });
    }
    return segs;
  }

  /**
   * Returns the list of contiguous gaps that qualify as focus time (>= focusThr min).
   * These are the gaps where the "plateau" shape will be drawn above the bar.
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
   * Adds phantom interruptions to the schedule until the total simulated focus
   * time is <= targetFocusMin. This calibrates the visual to match the actual
   * measured focus time from Worklytics.
   *
   * Each iteration finds the largest focus block and splits it with a 10-min
   * interruption at its midpoint. A single split typically eliminates an entire
   * block since each half falls below the 2-hour threshold.
   */
  function calibrateToFocusTarget(events, workStart, workEnd, focusThr, targetFocusMin) {
    const sumFocus = evts =>
      getFocusBlocks(evts, workStart, workEnd, focusThr)
        .reduce((s, b) => s + b.end - b.start, 0);

    let result = [...events];
    for (let i = 0; i < 40; i++) {
      const simFocus = sumFocus(result);
      if (simFocus <= targetFocusMin + 15) break;

      const blocks = getFocusBlocks(result, workStart, workEnd, focusThr);
      if (!blocks.length) break;

      blocks.sort((a, b) => (b.end - b.start) - (a.end - a.start));
      const blk     = blocks[0];
      const excess  = simFocus - targetFocusMin;
      // Trim from the start of the block by exactly `excess` minutes so the
      // remaining tail is the right size.  If the block is barely above the
      // threshold, split at the midpoint (both halves will fall below it).
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

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. SVG shape builders
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Smooth trapezoidal plateau path for focus blocks.
   * The shape rises from y0 to y1 over rampPx pixels at each end.
   *
   * @param {number} x0     – left edge of the block
   * @param {number} x3     – right edge of the block
   * @param {number} y0     – baseline y (top of bar)
   * @param {number} y1     – plateau height y (< y0 since SVG y increases downward)
   * @param {number} rampPx – width of the ramp slopes in pixels
   */
  function plateauPath(x0, x3, y0, y1, rampPx) {
    const x1 = x0 + rampPx;
    const x2 = x3 - rampPx;
    const cx = rampPx * 0.55; // bezier handle offset for smooth S-curve
    if (x2 <= x1) {
      // Block is too narrow for a plateau – draw an arch instead.
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
   * Smooth mountain / hump path for interruption events.
   *
   * The hump spans from x0 (start of ramp-down) through the event body
   * (x1 → x2) to x3 (end of ramp-up), peaking at y1.
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
      // Very short event – single arch.
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

    options: {
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
      },
      ramp_minutes: {
        type: 'number', label: 'Focus Ramp Time (minutes)', default: 12,
        section: 'Schedule', order: 4,
      },
      chart_title: {
        type: 'string', label: 'Chart Title',
        default: 'But in reality, interruptions occur',
        section: 'Display', order: 1,
      },
    },

    // ── create ───────────────────────────────────────────────────────────────
    create(element, config) {
      element.style.background = '#ffffff';
      element.style.overflow   = 'hidden';
      element.innerHTML = `
<style>
  .ftl{display:flex;flex-direction:column;width:100%;height:100%;
       padding:16px 28px 8px;box-sizing:border-box;overflow:hidden;
       font-family:"Google Sans",Roboto,Arial,sans-serif}
  .ftl-title{font-size:20px;font-weight:400;color:#3c4043;margin-bottom:8px;flex-shrink:0}
  .ftl-chart{flex:1;min-height:0;position:relative;overflow:hidden}
  .ftl-legend{display:flex;gap:24px;justify-content:center;flex-shrink:0;
              margin-top:8px;font-size:13px;color:#5f6368}
  .ftl-li{display:flex;align-items:center;gap:6px}
  .ftl-sw{width:14px;height:14px;border-radius:2px;flex-shrink:0}
</style>
<div class="ftl">
  <div class="ftl-title">But in reality, interruptions occur</div>
  <div class="ftl-chart">
    <svg id="ftl-svg" style="display:block;overflow:hidden"></svg>
  </div>
  <div class="ftl-legend">
    <div class="ftl-li"><div class="ftl-sw" style="background:#4285F4"></div>Focus Time</div>
    <div class="ftl-li"><div class="ftl-sw" style="background:#34A853"></div>Email</div>
    <div class="ftl-li"><div class="ftl-sw" style="background:#FBBC04"></div>Chat</div>
    <div class="ftl-li"><div class="ftl-sw" style="background:#EA4335"></div>Meetings</div>
  </div>
</div>`;
    },

    // ── updateAsync ──────────────────────────────────────────────────────────
    updateAsync(data, element, config, queryResponse, details, done) {
      // Update title
      const titleEl = element.querySelector('.ftl-title');
      if (titleEl) titleEl.textContent = config.chart_title || 'But in reality, interruptions occur';

      // Use only measure_like to avoid dimension field index offset.
      // Worklytics field order (drag measures in this order):
      //   [0] calendar:events:attended                  → meetings/week  ÷5 → daily
      //   [1] calendar:events:hours:meetings            → meeting hours/week ÷5 → daily → ×60 → minutes
      //   [2] gmail:emails:sent                         → emails/week    ÷5 → daily
      //   [3] slack:message:sent                        → messages/week  ÷5 → daily
      //   [4] worklytics:hours:in:focus:blocks:v3_5:flow→ focus hours/day (already daily)
      const fields = queryResponse.fields.measure_like || [];
      const row = (data && data[0]) || {};
      const gv  = i => fields[i] ? (parseFloat(row[fields[i].name]?.value) || 0) : 0;

      const inputs = {
        numMeetings:     Math.max(1, Math.round((gv(0) / 5) || 4)),
        meetingMinutes:  ((gv(1) / 5) || 2) * 60,   // weekly hours → daily → minutes
        numEmails:       (gv(2) / 5) || 10,
        numChat:         (gv(3) / 5) || 20,
        focusHoursDaily: gv(4) > 0 ? gv(4) : null,  // daily value; null = skip calibration
        workStart:       Math.round((config.work_start_hour      || 8)  * 60),
        workEnd:         Math.round((config.work_end_hour        || 18) * 60),
      };
      console.log('[FTL v8] inputs:', JSON.stringify(inputs));
      const renderOpts = {
        rampMin:  config.ramp_minutes              || 12,
        focusThr: Math.round((config.focus_threshold_hours || 2) * 60),
      };

      let events = generateSchedule(inputs);
      // If actual focus data is provided and it's below the 2-hour threshold,
      // calibrate down by adding phantom interruptions to eliminate any
      // accidental focus blocks the random placement may have created.
      if (inputs.focusHoursDaily !== null) {
        const targetMin = inputs.focusHoursDaily * 60;
        if (targetMin < renderOpts.focusThr) {
          events = calibrateToFocusTarget(
            events, inputs.workStart, inputs.workEnd, renderOpts.focusThr, targetMin
          );
        }
      }
      this._draw(element, events, { ...inputs, ...renderOpts });
      done();
    },

    // ── _draw (SVG renderer) ─────────────────────────────────────────────────
    _draw(element, events, { workStart, workEnd, rampMin, focusThr }) {
      const svg      = element.querySelector('#ftl-svg');
      if (!svg) return;

      // Use the root element's dimensions directly — flex child clientHeight
      // is unreliable in Looker's sandboxed iframe context.
      // Subtract ~130px for: title (36px) + legend (28px) + padding (16+8px) + margins (16px) + axis labels (26px).
      const W = Math.max(300, element.clientWidth  || 700);
      const H = Math.max(100, (element.clientHeight || 280) - 130);

      svg.setAttribute('width',  W);
      svg.setAttribute('height', H);

      // Chart margins
      const ML   = 12;  // left  (no y-axis labels needed)
      const MR   = 12;  // right
      const cW   = W - ML - MR;
      const wDur = workEnd - workStart;

      // ── Layout constants ───────────────────────────────────────────────────
      // The bar sits at ~62% of the chart height from the top; the area
      // above it is used for the focus plateaus and interruption humps.
      const barY   = Math.round(H * 0.62);
      const barH   = Math.max(20, Math.round(H * 0.15));
      const maxFH  = Math.round(barY * 0.80); // max height of focus plateau
      const maxIH  = Math.round(barY * 0.62); // max height of interruption hump

      // ── Coordinate helpers ─────────────────────────────────────────────────
      const tx     = t   => ML + ((t - workStart) / wDur) * cW; // time → x pixel
      const rampPx = (rampMin / wDur) * cW;                      // ramp time → px width

      // ── Colors ────────────────────────────────────────────────────────────
      const COLOR = {
        focus:   '#4285F4',
        gap:     '#EA4335', // insufficient focus (< 2 h) – same red as meetings
        meeting: '#EA4335',
        email:   '#34A853',
        chat:    '#FBBC04',
        bg:      '#E8EAED',
      };

      // ── Build SVG ─────────────────────────────────────────────────────────
      const p      = [];
      const clipId = 'ftl-bar-clip';
      const rx     = Math.round(barH * 0.45); // border-radius for bar ends

      // Clip path so coloured segments inherit the bar's rounded corners.
      p.push(
        `<defs>` +
        `<clipPath id="${clipId}">` +
        `<rect x="${ML}" y="${barY}" width="${cW}" height="${barH}" rx="${rx}"/>` +
        `</clipPath>` +
        `</defs>`
      );

      // Gray background bar
      p.push(`<rect x="${ML}" y="${barY}" width="${cW}" height="${barH}" fill="${COLOR.bg}" rx="${rx}"/>`);

      // Coloured timeline segments (clipped to rounded bar)
      p.push(`<g clip-path="url(#${clipId})">`);
      buildTimeline(events, workStart, workEnd, focusThr).forEach(seg => {
        const x = tx(seg.start);
        const w = Math.max(1.5, tx(seg.end) - x);
        p.push(`<rect x="${f(x)}" y="${barY}" width="${f(w)}" height="${barH}" fill="${COLOR[seg.type] || COLOR.bg}"/>`);
      });
      p.push('</g>');

      // Subtle bar border
      p.push(`<rect x="${ML}" y="${barY}" width="${cW}" height="${barH}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="1" rx="${rx}"/>`);

      // ── Focus plateau shapes (blue, above bar) ────────────────────────────
      getFocusBlocks(events, workStart, workEnd, focusThr).forEach(block => {
        const dur = block.end - block.start;
        // Plateau height scales with block duration, capped at maxFH.
        const fH  = Math.min(maxFH, maxFH * (0.40 + 0.60 * Math.min(1, dur / 240)));
        const x0  = tx(block.start);
        const x3  = tx(block.end);
        // Ramp width: smaller of rampPx and 25% of block width.
        const rp  = Math.min(rampPx, (x3 - x0) * 0.25);
        const d   = plateauPath(x0, x3, barY, barY - fH, rp);
        p.push(`<path d="${d}" fill="rgba(66,133,244,0.26)" stroke="none"/>`);
      });

      // ── Interruption humps (salmon/pink, above bar) ───────────────────────
      events.forEach(ev => {
        const nd  = ev.duration / 60; // duration in hours
        let iH;
        if (ev.type === 'meeting') {
          iH = maxIH * Math.min(1, 0.28 + 0.72 * Math.sqrt(nd));
        } else if (ev.type === 'email') {
          iH = maxIH * 0.32;
        } else {
          iH = maxIH * 0.24; // chat
        }
        iH = Math.max(maxIH * 0.12, iH);

        const x1 = tx(ev.start);
        const x2 = tx(ev.start + ev.duration);
        const d  = humpPath(x1 - rampPx, x1, x2, x2 + rampPx, barY, barY - iH);
        p.push(`<path d="${d}" fill="rgba(234,67,53,0.20)" stroke="none"/>`);
      });

      // ── Hour-marker axis ──────────────────────────────────────────────────
      const h0 = Math.ceil(workStart  / 60);
      const hN = Math.floor(workEnd   / 60);
      for (let h = h0; h <= hN; h++) {
        const x   = tx(h * 60);
        const lbl = h === 12 ? '12 pm' : h < 12 ? `${h} am` : `${h - 12} pm`;
        // Dashed vertical tick into the bar
        p.push(
          `<line x1="${f(x)}" y1="${barY}" x2="${f(x)}" y2="${barY + barH + 6}" ` +
          `stroke="#9AA0A6" stroke-width="1" stroke-dasharray="3,3"/>`
        );
        // Hour label below bar
        p.push(
          `<text x="${f(x)}" y="${barY + barH + 20}" ` +
          `text-anchor="middle" font-size="12" fill="#5F6368" ` +
          `font-family="Arial,sans-serif">${lbl}</text>`
        );
      }

      svg.innerHTML = p.join('\n');
    },
  });
})();
