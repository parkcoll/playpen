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

    const tryPlace = (type, duration, buffer) => {
      buffer = buffer ?? 10;
      for (let attempt = 0; attempt < 60; attempt++) {
        const t = Math.round(aStart + rng() * (aLen - duration));
        if (hasFocus && t + duration > focusStart - focusBuf && t < focusEnd + focusBuf) continue;
        if (!occupied.some(o => t < o.e && t + duration > o.s)) {
          occupied.push({ s: t - buffer, e: t + duration + buffer });
          return { type, start: t, duration };
        }
      }
      return null;
    };

    // Email sessions: each cluster = a short burst of sending/replying.
    const emailClusters = Math.max(2, Math.round(numEmails / 3));
    // Chat happens in conversational bursts – more clusters, each ~5 min.
    const chatClusters  = Math.max(2, Math.round(numChat   / 4));

    const emailEvents = Array.from({ length: emailClusters }, () => tryPlace('email', 5, 5)).filter(Boolean);
    // Smaller buffer (5 min) for chat so clusters can be placed closer together.
    const chatEvents  = Array.from({ length: chatClusters  }, () => tryPlace('chat',  5, 5)).filter(Boolean);

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
   * Smooth arch path – always rounded, no flat top.
   * Used for fragmented blocks that shouldn't reach a plateau.
   *
   * @param {number} x0 – left edge
   * @param {number} x3 – right edge
   * @param {number} y0 – baseline y (top of bar)
   * @param {number} y1 – peak y (< y0)
   */
  function archPath(x0, x3, y0, y1) {
    const w   = x3 - x0;
    const mx  = (x0 + x3) / 2;
    const hx  = w * 0.22; // horizontal handle spread
    // Outer control points at peak height (y1) → steep rise from edges;
    // inner handles also at y1 → smooth rounded top.
    return (
      `M${f(x0)},${f(y0)} ` +
      `C${f(x0 + hx)},${f(y1)} ${f(mx - hx)},${f(y1)} ${f(mx)},${f(y1)} ` +
      `C${f(mx + hx)},${f(y1)} ${f(x3 - hx)},${f(y1)} ${f(x3)},${f(y0)} Z`
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

      // ── Metrics source selectors ──────────────────────────────────────────
      // When multiple tools are connected (e.g. both Slack and Teams), pick
      // which one's keys to use.  'auto' tries all known patterns in order.
      chat_source: {
        type: 'string', label: 'Chat / Messaging Tool',
        display: 'select',
        values: [
          { 'Auto-detect': 'auto' },
          { 'Slack':             'slack'       },
          { 'Microsoft Teams':   'msft:teams'  },
          { 'Google Chat':       'google:chat' },
        ],
        section: 'Metrics', order: 1, default: 'auto',
      },
      email_source: {
        type: 'string', label: 'Email Tool',
        display: 'select',
        values: [
          { 'Auto-detect': 'auto' },
          { 'Gmail':                 'gmail' },
          { 'Outlook / Microsoft 365': 'msft' },
        ],
        section: 'Metrics', order: 2, default: 'auto',
      },
      meeting_source: {
        type: 'string', label: 'Calendar / Meetings Tool',
        display: 'select',
        values: [
          { 'Auto-detect': 'auto' },
          { 'Google Calendar':        'google:calendar'  },
          { 'Outlook Calendar':       'msft:calendar'    },
          { 'Microsoft Teams Calls':  'msft:teams:calls' },
        ],
        section: 'Metrics', order: 3, default: 'auto',
      },
    },

    // ── create ───────────────────────────────────────────────────────────────
    create(element, config) {
      element.style.background = '#ffffff';
      element.style.overflow   = 'hidden';
      element.innerHTML = `
<style>
  .ftl{display:flex;flex-direction:column;width:100%;height:100%;
       padding:10px 8px 8px;box-sizing:border-box;overflow:hidden;
       font-family:"Google Sans",Roboto,Arial,sans-serif;justify-content:center}
  .ftl-chart{flex-shrink:0;position:relative;overflow:hidden}
  .ftl-stats{text-align:center;flex-shrink:0;margin-top:0;
             font-size:13px;color:#5f6368;line-height:1.4}
  .ftl-stats b{font-weight:600;color:#3c4043}
  .ftl-legend{display:flex;gap:24px;justify-content:center;flex-shrink:0;
              margin-top:1px;font-size:13px;color:#5f6368}
  .ftl-li{display:flex;align-items:center;gap:6px}
  .ftl-sw{width:14px;height:14px;border-radius:2px;flex-shrink:0}
  .ftl-toggle{cursor:pointer;user-select:none;
             padding:3px 10px 3px 6px;border-radius:14px;
             border:1.5px solid rgba(0,0,0,0.14);
             transition:background 0.15s,opacity 0.2s,border-color 0.15s}
  .ftl-toggle:hover{background:rgba(0,0,0,0.05);border-color:rgba(0,0,0,0.28)}
  .ftl-toggle.ftl-off{opacity:0.45;border-style:dashed}
  .ftl-toggle.ftl-off span{text-decoration:line-through}
  .ftl-toggle .ftl-sw{position:relative;border-radius:3px}
  .ftl-toggle .ftl-sw::after{content:'✓';position:absolute;inset:0;
    display:flex;align-items:center;justify-content:center;
    color:rgba(255,255,255,0.95);font-size:9px;font-weight:700;line-height:1}
  .ftl-toggle.ftl-off .ftl-sw::after{content:''}
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
    <div class="ftl-li"><div class="ftl-sw" style="background:#3B82F6"></div><span>Focus Time</span></div>
    <div class="ftl-li ftl-toggle" data-type="email"><div class="ftl-sw" style="background:#10B981"></div><span>Email</span></div>
    <div class="ftl-li ftl-toggle" data-type="chat"><div class="ftl-sw" style="background:#F59E0B"></div><span>Chat</span></div>
    <div class="ftl-li ftl-toggle" data-type="meeting"><div class="ftl-sw" style="background:#EF4444"></div><span>Meetings</span></div>
  </div>
</div>`;
    },

    // ── updateAsync ──────────────────────────────────────────────────────────
    updateAsync(data, element, config, queryResponse, details, done) {
      // ── Extract metric values ─────────────────────────────────────────────
      // Supports three Looker data layouts:
      //   A) Multiple measure columns, one row (each column = a metric)
      //   B) Key-value rows: dimension = metric key, measure = value
      //   C) Pivoted: metric keys are pivot columns on a single measure (p50)
      const dims     = queryResponse.fields.dimension_like || [];
      const measures = queryResponse.fields.measure_like   || [];
      const pivots   = queryResponse.fields.pivots         || [];
      const row      = data[0] || {};

      console.log('[FTL v16] schema — dims:', dims.map(d => d.name),
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

      // ── Per-tool metric key patterns ───────────────────────────────────────
      // Each entry is an array of substrings tried in order against the lookup keys.
      // 'auto' covers broad patterns that work across tools; specific entries are
      // more precise and avoid false matches when multiple tools are connected.
      const PATTERNS = {
        chat: {
          auto:          ['message_sent', 'messages_sent', 'message:sent', 'slack'],
          slack:         ['slack:message:sent', 'slack:message', 'slack'],
          'msft:teams':  ['msft:teams:v1:message:sent', 'msft:teams:message:sent',
                          'msft:teams:v1:dm:chats:sent', 'msft:teams:v1:group:chats:sent',
                          'msft:teams:message'],
          'google:chat': ['google:chat:message:sent', 'google:chat:message', 'google:chat'],
        },
        email: {
          auto:   ['emails_sent', 'emails:sent', 'email_sent', 'email'],
          gmail:  ['gmail:emails:sent', 'gmail:email', 'gmail'],
          msft:   ['msft:outlook:emails:sent', 'msft:email', 'outlook:email', 'msft:emails'],
        },
        meetingsAttended: {
          auto:               ['attended', 'events_attended', 'events:attended'],
          'google:calendar':  ['google:calendar:events:attended', 'gcal:events:attended'],
          'msft:calendar':    ['msft:calendar:events:attended', 'msft:calendar:events'],
          'msft:teams:calls': ['msft:teams:v1:calls:attended', 'msft:teams:calls:attended'],
        },
        meetingHours: {
          auto:               ['hours_meeting', 'hours:meeting', 'hours:meetings',
                               'meeting_hours', 'calendar_hours'],
          'google:calendar':  ['google:calendar:hours:meeting', 'google:calendar:hours'],
          'msft:calendar':    ['msft:calendar:hours:meeting', 'msft:calendar:hours'],
          'msft:teams:calls': ['msft:teams:v1:calls:sum:hours', 'msft:teams:v1:calls:hours',
                               'msft:teams:minutes:week'],
        },
      };

      const chatSrc = config.chat_source    || 'auto';
      const emlSrc  = config.email_source   || 'auto';
      const metSrc  = config.meeting_source || 'auto';

      // Shared helper to extract all metrics from a lookup object.
      const extractMetrics = (lookup) => {
        meetingsAttended = findInLookup(lookup,
          PATTERNS.meetingsAttended[metSrc] || PATTERNS.meetingsAttended.auto);
        meetingHours = findInLookup(lookup,
          PATTERNS.meetingHours[metSrc]     || PATTERNS.meetingHours.auto);
        emailsSent = findInLookup(lookup,
          PATTERNS.email[emlSrc]            || PATTERNS.email.auto);
        chatSent = findInLookup(lookup,
          PATTERNS.chat[chatSrc]            || PATTERNS.chat.auto);
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
        console.log('[FTL v16] pivot lookup:', JSON.stringify(lookup));
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
          console.log('[FTL v16] kv lookup:', JSON.stringify(lookup));
          extractMetrics(lookup);
        }
      }

      console.log('[FTL v16] raw:', { meetingsAttended, meetingHours, emailsSent, chatSent,
                                       focusHours, fragmentedHours });

      const inputs = {
        numMeetings:          Math.max(1, Math.round((meetingsAttended / 5) || 4)),
        meetingMinutes:       ((meetingHours / 5) || 2) * 60,   // weekly hours → daily → minutes
        numEmails:            (emailsSent / 5) || 10,
        numChat:              (chatSent / 5) || 20,
        focusHoursDaily:      focusHours > 0 ? focusHours / 5 : null,      // weekly → daily
        fragmentedHoursDaily: fragmentedHours > 0 ? fragmentedHours / 5 : null, // weekly → daily
        workStart:            Math.round((config.work_start_hour || 8)  * 60),
        workEnd:              Math.round((config.work_end_hour   || 18) * 60),
      };
      console.log('[FTL v16] inputs:', JSON.stringify(inputs));
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
      // Persist toggle state across Looker data refreshes.
      if (!this._disabledTypes) this._disabledTypes = new Set();

      // Store the full (calibrated) event list and draw options for re-use by toggles.
      this._allEvents = events;
      this._drawOpts  = { ...inputs, ...renderOpts };

      const filteredEvents = events.filter(e => !this._disabledTypes.has(e.type));
      this._draw(element, filteredEvents, this._drawOpts);

      // ── Legend toggle handlers ───────────────────────────────────────────
      const self = this;
      element.querySelectorAll('.ftl-toggle').forEach(li => {
        // Replace node to remove any stale listeners from a previous refresh.
        const fresh = li.cloneNode(true);
        li.parentNode.replaceChild(fresh, li);
        const type = fresh.dataset.type;
        // Restore visual state if this type was already disabled.
        if (self._disabledTypes.has(type)) fresh.classList.add('ftl-off');
        fresh.addEventListener('click', () => {
          if (self._disabledTypes.has(type)) {
            self._disabledTypes.delete(type);
            fresh.classList.remove('ftl-off');
          } else {
            self._disabledTypes.add(type);
            fresh.classList.add('ftl-off');
          }
          const filtered = self._allEvents.filter(e => !self._disabledTypes.has(e.type));
          self._draw(element, filtered, self._drawOpts);
        });
      });

      done();
    },

    // ── _draw (SVG renderer) ─────────────────────────────────────────────────
    _draw(element, events, { workStart, workEnd, rampMin, focusThr }) {
      const svg      = element.querySelector('#ftl-svg');
      if (!svg) return;

      // Use the root element's dimensions directly — flex child clientHeight
      // is unreliable in Looker's sandboxed iframe context.
      const W = Math.max(300, element.clientWidth  || 700);
      // H is the available space; SVG height is set to content height after layout is computed.
      const H = Math.max(100, (element.clientHeight || 280) - 108);

      svg.setAttribute('width', W);
      // Height set below, after barY/barH are computed, so SVG is exactly as tall as its content.

      // Chart margins – generous to avoid clipping at edges
      const ML   = 36;
      const MR   = 36;
      const cW   = W - ML - MR;
      const wDur = workEnd - workStart;

      // Gray buffer width (non-work time at day edges)
      // Capped so it never exceeds margins (which would clip the rounded corners).
      const grayBuf = Math.min(Math.round(cW * 0.03), ML - 4, MR - 4);

      // ── Layout constants ───────────────────────────────────────────────────
      // The bar sits at ~62% of the chart height from the top; the area
      // above it is used for the focus plateaus and fragmented arches.
      const barY   = Math.round(H * 0.62);
      const barH   = Math.max(20, Math.round(H * 0.15));
      const maxFH  = Math.round(barY * 0.80); // max height of focus plateau

      // Set SVG height to content height + gap before stats.
      const svgH = barY + barH + 56; // 24px label + 32px gap
      svg.setAttribute('height', svgH);

      // ── Coordinate helpers ─────────────────────────────────────────────────
      const tx     = t   => ML + ((t - workStart) / wDur) * cW; // time → x pixel
      const rampPx = (rampMin / wDur) * cW;                      // ramp time → px width

      // ── Colors ────────────────────────────────────────────────────────────
      const COLOR = {
        focus:      '#3B82F6',
        fragmented: '#3B82F6', // same blue in the bar – all uninterrupted time is "focus"
        meeting:    '#EF4444',
        email:      '#10B981',
        chat:       '#F59E0B',
        bg:         '#E8EAED',
      };

      // ── Build SVG ─────────────────────────────────────────────────────────
      const p      = [];
      const clipId = 'ftl-bar-clip';

      // Full bar width including gray buffers
      const fullBarX = ML - grayBuf;
      const fullBarW = cW + grayBuf * 2;

      // Clip path — square ends
      p.push(
        `<defs>` +
        `<clipPath id="${clipId}">` +
        `<rect x="${fullBarX}" y="${barY}" width="${fullBarW}" height="${barH}"/>` +
        `</clipPath>` +
        `</defs>`
      );

      // Gray background bar (full width including buffer zones) — square ends
      p.push(`<rect x="${fullBarX}" y="${barY}" width="${fullBarW}" height="${barH}" fill="${COLOR.bg}"/>`);

      // ── Tooltip text per segment type ──────────────────────────────────
      const TIP = {
        focus:      'Focus time, which allows for deep work',
        fragmented: 'Time lost due to fragmented time',
        meeting:    'Meeting',
        email:      'Email sent',
        chat:       'Chat message sent',
      };

      // Coloured timeline segments (clipped to bar)
      p.push(`<g clip-path="url(#${clipId})">`);
      buildTimeline(events, workStart, workEnd, focusThr).forEach(seg => {
        const x = tx(seg.start);
        const w = Math.max(1.5, tx(seg.end) - x);
        const tip = TIP[seg.type] || '';
        p.push(
          `<rect x="${f(x)}" y="${barY}" width="${f(w)}" height="${barH}" fill="${COLOR[seg.type] || COLOR.bg}">` +
          (tip ? `<title>${tip}</title>` : '') +
          `</rect>`
        );
      });
      p.push('</g>');

      // Subtle bar border — square ends
      p.push(`<rect x="${fullBarX}" y="${barY}" width="${fullBarW}" height="${barH}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="1"/>`);

      // ── Above-bar shapes (focus plateaus + fragmented arches) ───────────────
      // Collect both shape types and sort by start time so the staggered
      // animation delay follows left-to-right visual order.
      const focusBlocks = getFocusBlocks(events, workStart, workEnd, focusThr);
      const fragBlocks  = getFragmentedBlocks(events, workStart, workEnd, focusThr, 15);

      const allShapes = [
        ...focusBlocks.map(b => ({ ...b, kind: 'focus' })),
        ...fragBlocks.map(b  => ({ ...b, kind: 'fragmented' })),
      ].sort((a, b) => a.start - b.start);

      allShapes.forEach((block, idx) => {
        const delay = (0.05 + idx * 0.04).toFixed(2);
        if (block.kind === 'focus') {
          const dur = block.end - block.start;
          const fH  = Math.min(maxFH, maxFH * (0.40 + 0.60 * Math.min(1, dur / 240)));
          const x0  = tx(block.start);
          const x3  = tx(block.end);
          const rp  = Math.min(rampPx, (x3 - x0) * 0.25);
          const d   = plateauPath(x0, x3, barY, barY - fH, rp);
          p.push(
            `<path d="${d}" fill="rgba(59,130,246,0.26)" stroke="none" ` +
            `class="ftl-shape" style="animation-delay:${delay}s">` +
            `<title>${TIP.focus}</title></path>`
          );
        } else {
          const dur = block.end - block.start;
          const pct = Math.min(1, dur / focusThr); // 0 → 1 as duration approaches threshold
          // Power curve (pct^0.6) pushes medium blocks higher — e.g. 1h ≈ 73% instead of 55%.
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

      // ── Summary stats ───────────────────────────────────────────────────
      const statsEl = element.querySelector('#ftl-stats');
      if (statsEl) {
        const fmtTime = min => {
          const h = Math.floor(min / 60), m = Math.round(min % 60);
          return h > 0 ? `${h}h ${m}m` : `${m}m`;
        };

        // Count interruptions (meetings, email, chat events – exclude 'gap' phantoms)
        const interruptions = events.filter(e => e.type === 'meeting' || e.type === 'email' || e.type === 'chat').length;

        // Sum focus time (blocks ≥ focusThr)
        const focusMin = focusBlocks.reduce((s, b) => s + (b.end - b.start), 0);

        // Sum fragmented time (blocks ≥15 min but < focusThr)
        const fragMin = fragBlocks.reduce((s, b) => s + (b.end - b.start), 0);

        statsEl.innerHTML =
          `<b>${interruptions}</b> interruption${interruptions !== 1 ? 's' : ''} · ` +
          `<b>${fmtTime(focusMin)}</b> focus time · ` +
          `<b>${fmtTime(fragMin)}</b> lost to fragmentation`;
      }
    },
  });
})();
