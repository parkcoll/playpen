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
   * Gaps >= focusThr are 'focus'; shorter gaps are 'fragmented'.
   */
  function buildTimeline(events, workStart, workEnd, focusThr) {
    const classify = dur => dur >= focusThr ? 'focus' : 'fragmented';
    const segs = [];
    let t = workStart;
    for (const ev of events) {
      if (ev.start > t) {
        segs.push({ start: t, end: ev.start, type: classify(ev.start - t) });
      }
      segs.push({ start: ev.start, end: ev.start + ev.duration, type: ev.type });
      t = ev.start + ev.duration;
    }
    if (t < workEnd) {
      segs.push({ start: t, end: workEnd, type: classify(workEnd - t) });
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
   * Returns contiguous gaps that are shorter than focusThr but at least minGap minutes.
   * These are "fragmented focus" blocks – uninterrupted but too short to count as focus.
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
    <div class="ftl-li"><div class="ftl-sw" style="background:#F28B82"></div>Fragmented</div>
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

      // ── Extract metric values ─────────────────────────────────────────────
      // Supports three Looker data layouts:
      //   A) Multiple measure columns, one row (each column = a metric)
      //   B) Key-value rows: dimension = metric key, measure = value
      //   C) Pivoted: metric keys are pivot columns on a single measure (p50)
      const dims     = queryResponse.fields.dimension_like || [];
      const measures = queryResponse.fields.measure_like   || [];
      const pivots   = queryResponse.fields.pivots         || [];
      const row      = data[0] || {};

      console.log('[FTL v12] schema — dims:', dims.map(d => d.name),
                  'measures:', measures.map(m => m.name),
                  'pivots:', pivots.map(p => p.name), 'rows:', data.length);

      let meetingsAttended = 0, meetingHours = 0, emailsSent = 0,
          chatSent = 0, focusHours = 0, fragmentedHours = 0;

      // Helper: search an object's keys by substring patterns.
      // Optional `exclude` array skips keys containing those substrings.
      const findInLookup = (lookup, patterns, exclude) => {
        for (const [k, v] of Object.entries(lookup)) {
          if (exclude && exclude.some(e => k.includes(e))) continue;
          if (patterns.some(p => k.includes(p))) return v;
        }
        return 0;
      };

      // Shared helper to extract all metrics from a lookup object.
      const extractMetrics = (lookup) => {
        meetingsAttended = findInLookup(lookup,
          ['attended', 'events_attended', 'events:attended']);
        meetingHours = findInLookup(lookup,
          ['hours_meeting', 'hours:meeting', 'hours:meetings', 'meeting_hours', 'calendar_hours']);
        emailsSent = findInLookup(lookup,
          ['emails_sent', 'emails:sent', 'email_sent', 'email']);
        chatSent = findInLookup(lookup,
          ['message_sent', 'messages_sent', 'message:sent', 'slack']);
        // 'focus' appears in both focus and fragmented keys — exclude 'fragment' for focus.
        focusHours      = findInLookup(lookup, ['focus'], ['fragment']);
        fragmentedHours = findInLookup(lookup, ['fragment']);
      };

      if (measures.length >= 4) {
        // ── Layout A: each measure is a distinct metric ──────────────────
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
        // ── Layout C: pivoted data (metric keys as pivot columns) ────────
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
        console.log('[FTL v12] pivot lookup:', JSON.stringify(lookup));
        extractMetrics(lookup);

      } else if (dims.length > 0) {
        // ── Layout B: key-value rows ─────────────────────────────────────
        const dimName = dims[0]?.name;
        const valName = measures[0]?.name;
        if (dimName && valName) {
          const lookup = {};
          for (const r of data) {
            const key = String(r[dimName]?.value || '').toLowerCase();
            const val = parseFloat(r[valName]?.value);
            if (key && !isNaN(val)) lookup[key] = val;
          }
          console.log('[FTL v12] kv lookup:', JSON.stringify(lookup));
          extractMetrics(lookup);
        }
      }

      console.log('[FTL v12] raw:', { meetingsAttended, meetingHours, emailsSent, chatSent,
                                       focusHours, fragmentedHours });

      const inputs = {
        numMeetings:          Math.max(1, Math.round((meetingsAttended / 5) || 4)),
        meetingMinutes:       ((meetingHours / 5) || 2) * 60,   // weekly hours → daily → minutes
        numEmails:            (emailsSent / 5) || 10,
        numChat:              (chatSent / 5) || 20,
        focusHoursDaily:      focusHours > 0 ? focusHours : null,
        fragmentedHoursDaily: fragmentedHours > 0 ? fragmentedHours : null, // daily, < 2 h blocks
        workStart:            Math.round((config.work_start_hour || 8)  * 60),
        workEnd:              Math.round((config.work_end_hour   || 18) * 60),
      };
      console.log('[FTL v12] inputs:', JSON.stringify(inputs));
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
      // above it is used for the focus plateaus and fragmented arches.
      const barY   = Math.round(H * 0.62);
      const barH   = Math.max(20, Math.round(H * 0.15));
      const maxFH  = Math.round(barY * 0.80); // max height of focus plateau

      // ── Coordinate helpers ─────────────────────────────────────────────────
      const tx     = t   => ML + ((t - workStart) / wDur) * cW; // time → x pixel
      const rampPx = (rampMin / wDur) * cW;                      // ramp time → px width

      // ── Colors ────────────────────────────────────────────────────────────
      const COLOR = {
        focus:      '#4285F4',
        fragmented: '#F28B82', // light red – uninterrupted but < 2 h (lost focus)
        meeting:    '#EA4335',
        email:      '#34A853',
        chat:       '#FBBC04',
        bg:         '#E8EAED',
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
      const focusBlocks = getFocusBlocks(events, workStart, workEnd, focusThr);
      focusBlocks.forEach(block => {
        const dur = block.end - block.start;
        const fH  = Math.min(maxFH, maxFH * (0.40 + 0.60 * Math.min(1, dur / 240)));
        const x0  = tx(block.start);
        const x3  = tx(block.end);
        const rp  = Math.min(rampPx, (x3 - x0) * 0.25);
        const d   = plateauPath(x0, x3, barY, barY - fH, rp);
        p.push(`<path d="${d}" fill="rgba(66,133,244,0.26)" stroke="none"/>`);
      });

      // ── Fragmented block arches (light red, shorter, above bar) ───────────
      // Gaps ≥ 15 min and < focusThr – uninterrupted but too short for deep focus.
      const fragBlocks = getFragmentedBlocks(events, workStart, workEnd, focusThr, 15);
      fragBlocks.forEach(block => {
        const dur = block.end - block.start;
        // Shorter arch: ~30-50% of maxFH, scaling with duration.
        const fH  = Math.min(maxFH * 0.50, maxFH * (0.15 + 0.35 * Math.min(1, dur / 120)));
        const x0  = tx(block.start);
        const x3  = tx(block.end);
        const rp  = Math.min(rampPx, (x3 - x0) * 0.30);
        const d   = plateauPath(x0, x3, barY, barY - fH, rp);
        p.push(`<path d="${d}" fill="rgba(234,67,53,0.18)" stroke="none"/>`);
      });

      // Interruptions (meetings, email, chat) appear only in the bar – no shapes above.

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
