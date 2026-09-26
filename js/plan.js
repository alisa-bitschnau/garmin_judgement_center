// ============================================================================
// plan.js
// ============================================================================
// Generates a week-by-week training plan between TODAY and your race date.
// This is the one piece of the whole app that has nothing to do with
// Garmin at all -- it's pure scheduling/math, built from four ideas any
// endurance training plan uses:
//
//   1. Split the available time into PHASES (Base, Build, Peak, Taper),
//      each with a different training focus.
//   2. Within each phase, targets (long run distance, weekly climbing,
//      weekly volume) increase gradually from a lower starting point to a
//      higher one as the phase progresses.
//   3. Every 4th week is a lighter "recovery" week -- a standard technique
//      so the body actually absorbs the training instead of just piling
//      on fatigue indefinitely.
//   4. The last 2 weeks are always a Taper -- volume drops sharply so
//      you arrive at race day recovered, not exhausted.
//
// None of these numbers are physiologically "correct" in some absolute
// sense -- they're a reasonable, generic starting shape. The whole point
// of the app.js "week-row" UI is that you can override any week's targets
// by hand once you know your own training better than a formula does.
// ============================================================================

const JCPlan = (() => {

  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // Returns the Monday that starts the week containing date `d`. Having a
  // single, consistent definition of "which week does this date belong
  // to" matters a lot -- it's what lets us group activities into weekly
  // buckets (for charts) and match them against the plan's weekly targets
  // using the exact same boundaries every time.
  function startOfWeek(d) {
    const date = new Date(d);
    const day = date.getDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday (JavaScript's built-in convention)

    // We want Monday to be the start of the week regardless of what day
    // `d` falls on. This little formula figures out how many days to shift
    // backward to land on the most recent Monday:
    //   if today IS Sunday (day === 0), we need to go back 6 days to reach
    //     the Monday that started this week (Sunday is the LAST day of a
    //     Mon-Sun week, not the first)
    //   otherwise, Monday is day 1, so we go back (day - 1) days
    const diff = (day === 0 ? -6 : 1) - day;
    date.setDate(date.getDate() + diff);
    date.setHours(0, 0, 0, 0); // zero out the time-of-day, so this Date represents exactly midnight on that Monday
    return date;
  }

  // Returns a NEW Date, `n` days after (or before, if `n` is negative) `d`.
  // Deliberately does NOT modify `d` itself -- always returns a fresh Date
  // object. This matters because JavaScript Dates are "mutable" (calling
  // .setDate() on one changes that exact object in place); if this
  // function modified and returned the same object you handed it, calling
  // it repeatedly in a loop (as generatePlan does below, walking forward
  // week by week) could produce very confusing bugs where every previous
  // result silently changes too.
  function addDays(d, n) {
    const nd = new Date(d);
    nd.setDate(nd.getDate() + n);
    return nd;
  }

  // Formats a Date as e.g. "05 Jun" for display in the plan's week labels.
  function fmt(d) {
    return `${String(d.getDate()).padStart(2, '0')} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
  }

  // Linear interpolation: given a starting value `a`, an ending value `b`,
  // and a progress fraction `t` between 0 and 1, returns the value that's
  // `t` of the way from `a` to `b`. Example: lerp(10, 20, 0.5) = 15 (the
  // midpoint). This is the single mathematical idea behind every target
  // that "gradually increases through a phase" below -- rather than
  // writing separate formulas for long-run distance, weekly vert, and
  // weekly volume, we always compute a start value and an end value for
  // whatever's being ramped up, then call lerp() to find where a given
  // week sits between them.
  function lerp(a, b, t) {
    // Math.max(0, Math.min(1, t)) "clamps" t into the 0-1 range first, in
    // case of any rounding weirdness upstream -- guarantees we never
    // extrapolate outside the intended a..b range.
    return a + (b - a) * Math.max(0, Math.min(1, t));
  }

  // The actual workout suggestions shown under each week, grouped by
  // phase. These are static, generic descriptions -- not personalized to
  // your specific pace or fitness, just the KIND of session that phase of
  // training typically calls for.
  const SESSIONS = {
    base: [
      'Easy aerobic run, conversational pace',
      'Hill walk or hike with weighted pack',
      'Strength: legs + core, 2x this week',
      'One longer weekend hike/run on varied terrain',
    ],
    build: [
      'Hill repeats: 6–10 x 3–5 min uphill effort, easy jog down',
      'Back-to-back long days on the weekend (Sat moderate, Sun long)',
      'Steady-state run on rolling terrain',
      'Strength: legs + core, 2x this week',
    ],
    peak: [
      'Long run on terrain resembling race profile',
      'Back-to-back weekend: Sat 60–70% of long-run distance, Sun long run',
      'Race-pace/effort tempo on rolling or climbing terrain',
      'Practice race-day nutrition and gear on the long run',
    ],
    taper: [
      'Short easy runs, legs feeling fresh not flat',
      'One short session with a few race-pace strides',
      'Prioritize sleep, mobility, staying off your feet otherwise',
      'Final short shakeout 2–3 days out, nothing more',
    ],
  };

  // Decides how many weeks go into each of the four phases, given the
  // TOTAL number of weeks available between now and race day.
  function phaseSplit(totalWeeks) {
    const taper = 2; // always exactly 2 weeks, regardless of how long the whole plan is

    // Peak phase: roughly 8% of the total plan, but clamped between 2 and
    // 4 weeks so it's never absurdly short (a 1-week "peak" barely counts)
    // or absurdly long (peak-intensity training for months isn't
    // sustainable) even if the total plan is very long or very short.
    const peak = Math.min(4, Math.max(2, Math.round(totalWeeks * 0.08)));

    // Build phase: roughly 32% of the total, clamped between 6 and 18
    // weeks for the same reason.
    let build = Math.round(totalWeeks * 0.32);
    build = Math.max(6, Math.min(18, build));

    // Base phase: whatever's left over after taper+peak+build are
    // subtracted -- this is naturally the LONGEST phase for anyone
    // training many months out, and could theoretically be very short (or
    // even need Math.max(1, ...) to guarantee it's never negative) for
    // someone setting this up shortly before their race.
    const base = Math.max(1, totalWeeks - taper - peak - build);

    return { base, build, peak, taper };
  }

  // Computes ONE week's targets (long run distance, weekly climbing,
  // weekly total volume), given:
  //   raceKm             - the race's total distance (e.g. 52 for the full Karwendelmarsch)
  //   phase              - 'base' | 'build' | 'peak' | 'taper'
  //   progressInPhase    - 0 (first week of this phase) to 1 (last week of this phase)
  //   weekIndexInCycle   - this week's position within its phase, used only to detect recovery weeks
  function targetsForPhaseProgress(raceKm, phase, progressInPhase, weekIndexInCycle) {
    // Each of these three objects defines the LOW and HIGH end of a range,
    // scaled off the race's own distance. E.g. a 52km race gets a peak
    // long run of up to 52 * 0.75 = 39km; a 35km race scales everything
    // down proportionally. This is what makes generatePlan() work sensibly
    // for either Karwendelmarsch distance without separate hardcoded plans.
    const longRun = { peakMax: raceKm * 0.75, buildMax: raceKm * 0.5, baseMax: raceKm * 0.28, baseMin: 10 };
    const vert    = { peakMax: 2600, buildMax: 1800, baseMax: 900, baseMin: 300 }; // climbing targets aren't scaled by race distance, since Karwendelmarsch's climbing-per-km is roughly fixed regardless of which of its two distances you're doing
    const vol     = { peakMax: raceKm * 1.7, buildMax: raceKm * 1.3, baseMax: raceKm * 0.9, baseMin: 25 };

    // For whichever phase this week is in, lerp() between that phase's
    // start-of-phase and end-of-phase values, using this week's progress
    // through the phase. Notice each phase's STARTING value is the
    // PREVIOUS phase's peak value (e.g. build starts at longRun.baseMax,
    // exactly where base left off) -- this is what makes the whole plan
    // ramp up smoothly across phase boundaries instead of jumping.
    let lr, v, vl;
    if (phase === 'base') {
      lr = lerp(longRun.baseMin, longRun.baseMax, progressInPhase);
      v = lerp(vert.baseMin, vert.baseMax, progressInPhase);
      vl = lerp(vol.baseMin, vol.baseMax, progressInPhase);
    } else if (phase === 'build') {
      lr = lerp(longRun.baseMax, longRun.buildMax, progressInPhase);
      v = lerp(vert.baseMax, vert.buildMax, progressInPhase);
      vl = lerp(vol.baseMax, vol.buildMax, progressInPhase);
    } else if (phase === 'peak') {
      lr = lerp(longRun.buildMax, longRun.peakMax, progressInPhase);
      v = lerp(vert.buildMax, vert.peakMax, progressInPhase);
      vl = lerp(vol.buildMax, vol.peakMax, progressInPhase);
    } else {
      // taper: deliberately doesn't use the longRun/vert/vol objects'
      // "Max" values directly -- tapering means dropping FROM peak-ish
      // levels down toward near-rest, so these are written as their own
      // shrinking range ending very low (8km long run, 150m of climbing)
      // right before race day.
      lr = lerp(longRun.peakMax * 0.5, 8, progressInPhase);
      v = lerp(vert.peakMax * 0.4, 150, progressInPhase);
      vl = lerp(vol.peakMax * 0.55, raceKm * 0.15, progressInPhase);
    }

    // Recovery week detection: every 4th week within a phase (index 3, 7,
    // 11, ... since we count from 0) gets its targets pulled down, EXCEPT
    // during taper (which is already low-volume by design -- pulling it
    // down further isn't meaningful with only 2 weeks total).
    const isRecoveryWeek = phase !== 'taper' && (weekIndexInCycle % 4 === 3);
    if (isRecoveryWeek) {
      vl *= 0.7;  // 30% less weekly volume
      v *= 0.65;  // 35% less climbing
      lr *= 0.8;  // 20% shorter long run
    }

    return {
      longRunKm: Math.round(lr),
      vertM: Math.round(v / 50) * 50, // rounds to the nearest 50m -- a target of "1,847m" reads as needlessly precise for something this approximate; "1,850m" reads as an intentional round number
      volumeKm: Math.round(vl),
      isRecoveryWeek,
    };
  }

  // The main function the rest of the app calls. Builds the ENTIRE
  // week-by-week plan from today through race day in one go.
  function generatePlan(raceDateStr, raceDistanceKm) {
    const raceDate = new Date(raceDateStr + 'T00:00:00'); // the 'T00:00:00' avoids a subtle gotcha: a bare "2027-08-28" string is parsed by JS as UTC midnight, which can display as the PREVIOUS day in timezones behind UTC. Appending a specific local time avoids that ambiguity.
    const today = startOfWeek(new Date());
    const raceWeekStart = startOfWeek(raceDate);

    // How many weeks fit between the start of this week and the start of
    // race week, inclusive of both ends. Math.max(4, ...) guarantees the
    // plan never tries to squeeze phases into an unreasonably tiny number
    // of weeks (e.g. if someone sets a race date that's only 1 week away).
    const totalWeeks = Math.max(4, Math.round((raceWeekStart - today) / (7 * 86400000)) + 1);
    // (raceWeekStart - today) subtracts two Dates, which JavaScript
    // automatically converts to a difference in MILLISECONDS. Dividing by
    // (7 * 86400000) -- 7 days' worth of milliseconds -- converts that
    // into a number of weeks.

    const { base, build, peak, taper } = phaseSplit(totalWeeks);
    const phases = [
      { key: 'base', label: 'Base', weeks: base },
      { key: 'build', label: 'Build', weeks: build },
      { key: 'peak', label: 'Peak', weeks: peak },
      { key: 'taper', label: 'Taper', weeks: taper },
    ];

    const weeks = [];
    let cursor = new Date(today); // walks forward one week at a time as we build the list below
    let globalIndex = 0;          // this week's position in the WHOLE plan (0, 1, 2, ...), used later by app.js to look up hand-made overrides for a specific week

    phases.forEach(ph => {
      for (let i = 0; i < ph.weeks; i++) {
        // progress: 0 for the first week of this phase, 1 for the last.
        // The `ph.weeks <= 1 ? 1 : ...` guard avoids a divide-by-zero: if
        // a phase is only 1 week long, there's no meaningful "progress
        // through" it, so we just treat it as the phase's peak value.
        const progress = ph.weeks <= 1 ? 1 : i / (ph.weeks - 1);
        const t = targetsForPhaseProgress(raceDistanceKm, ph.key, progress, i);

        const weekStart = new Date(cursor);
        const weekEnd = addDays(weekStart, 6); // Monday + 6 days = Sunday, the last day of that week

        weeks.push({
          index: globalIndex,
          phase: ph.key,
          phaseLabel: ph.label,
          startDate: weekStart.toISOString().slice(0, 10), // "YYYY-MM-DD", used for string comparisons elsewhere (e.g. "is this activity's date within this week's range")
          endDate: weekEnd.toISOString().slice(0, 10),
          dateLabel: `${fmt(weekStart)} – ${fmt(weekEnd)}`, // for display, e.g. "05 Jun – 11 Jun"
          monthLabel: `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getFullYear()}`, // groups weeks under month headings in the UI
          targetLongRunKm: t.longRunKm,
          targetVertM: t.vertM,
          targetVolumeKm: t.volumeKm,
          isRecoveryWeek: t.isRecoveryWeek,
          sessions: SESSIONS[ph.key],
        });

        cursor = addDays(cursor, 7); // move the cursor forward exactly one week for the next loop iteration
        globalIndex++;
      }
    });

    return { raceDate: raceDateStr, raceDistanceKm, totalWeeks, phaseSummary: phases, weeks };
  }

  // startOfWeek and addDays are also exported (not just generatePlan)
  // because app.js and charts.js both need the exact same "which week does
  // this date belong to" logic -- for grouping activities into weekly
  // buckets, and for figuring out which plan week corresponds to "this
  // week" right now. Reusing these instead of re-implementing the same
  // date math elsewhere is what guarantees they always agree.
  return { generatePlan, addDays, startOfWeek };
})();
