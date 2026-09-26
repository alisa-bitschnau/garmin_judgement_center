// ============================================================================
// app.js
// ============================================================================
// This is the "glue" file: it doesn't contain any of the actual logic for
// parsing Garmin data, generating a training plan, or drawing charts --
// that all lives in storage.js / parser.js / plan.js / charts.js, loaded
// before this file in index.html. What app.js DOES do is:
//
//   - respond to things the user actually clicks/types/drops
//   - call the right function in the right module in response
//   - take the result and update the actual HTML on screen
//
// This split (logic in separate files, UI wiring in this one) is a
// pattern worth internalizing: it's what let us fix the CSV number-parsing
// bug by changing ONE function in parser.js, without touching this file at
// all, even though the bug's SYMPTOM (wrong distances) was visible here on
// the dashboard.
//
// The whole file is wrapped in `(function () { ... })();` -- another IIFE,
// same idea as the one in storage.js: everything declared inside (like
// `currentPlan` below) stays private to this file rather than leaking into
// the global namespace where it could accidentally clash with something in
// another script.
// ============================================================================

(function () {

  // Maps the <select> dropdown's two option values ("52"/"35") to the
  // actual race distance in km and a display label. Kept as a lookup
  // table rather than an if/else so adding a third race distance later
  // would mean adding one line here, not hunting through every place a
  // distance decision is made.
  const RACE_DEFAULTS = {
    '52': { km: 52, label: 'Karwendelmarsch 52' },
    '35': { km: 35, label: 'Karwendelmarsch 35 (to the Eng)' },
  };

  // Which sports count toward the TRAIL-RUNNING PLAN's weekly targets
  // specifically. A ski touring day or a strength session still shows up
  // everywhere in Insights and the Dashboard totals -- this list only
  // narrows down what counts when checking "did I hit this week's
  // trail-running plan target", since a big mountain bike week shouldn't
  // count as satisfying a running-specific long-run target, but IS still
  // relevant leg/aerobic training worth including in the plan's actual-vs-
  // target comparison.
  const PLAN_RELEVANT_SPORTS = ['running', 'trail_running', 'hiking', 'walking', 'mountain_biking'];

  // Holds whatever training plan is currently generated, so multiple
  // functions below (renderDashboard, renderPlanWeeks, the "generate plan"
  // button handler) can all read/use the same plan without regenerating it
  // or passing it around as a parameter everywhere. Declared with `let`
  // rather than `const` specifically because regeneratePlan() reassigns it
  // whenever the race date/distance changes.
  let currentPlan = null;

  // ==========================================================================
  // TABS
  // ==========================================================================

  // Shows the panel matching `tabName` and hides the other three, and
  // highlights the matching nav button. Also SAVES the choice to
  // localStorage (via JCStore) so a page refresh reopens on the same tab
  // instead of resetting to Dashboard every time.
  function switchTab(tabName) {
    // .toggle('is-active', condition) is a shorthand for "add this class if
    // condition is true, remove it if false" -- avoids writing a separate
    // if/else with .add()/.remove() calls.
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('is-active', b.dataset.tab === tabName));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('is-active', p.id === `panel-${tabName}`));
    JCStore.setLastTab(tabName);
  }

  document.querySelectorAll('nav button').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ==========================================================================
  // COUNTDOWN
  // ==========================================================================

  function renderCountdown(settings) {
    const race = new Date(settings.raceDate + 'T00:00:00'); // see plan.js's generatePlan() comment for why 'T00:00:00' is appended here too
    const today = new Date();
    today.setHours(0, 0, 0, 0); // zero out today's time-of-day so we're comparing whole calendar days, not "exactly this many hours and minutes from now"

    // (race - today) subtracts two Dates -> a difference in milliseconds;
    // dividing by 86400000 (the number of milliseconds in a day) converts
    // that into a number of days. Math.round rather than Math.floor/ceil
    // because both Dates are already at midnight, so the division should
    // land almost exactly on a whole number -- rounding just cleans up any
    // tiny floating-point imprecision.
    const days = Math.round((race - today) / 86400000);
    document.getElementById('countdownDays').textContent = days >= 0 ? days : 0; // never show a negative countdown if the race date is somehow in the past
  }

  // ==========================================================================
  // DASHBOARD
  // ==========================================================================

  // Counts how many days IN A ROW, ending today, have at least one logged
  // activity. Walks backward from today one day at a time; stops the
  // moment it hits a day with nothing logged.
  function computeStreak(activities) {
    // A `Set` here is just a list where membership-checking (`.has(x)`) is
    // fast and where duplicates don't matter -- we only care WHICH dates
    // have at least one activity, not how many.
    const days = new Set(activities.map(a => a.date));

    let streak = 0;
    let cursor = new Date();
    cursor.setHours(0, 0, 0, 0);

    while (days.has(cursor.toISOString().slice(0, 10))) {
      streak++;
      cursor = JCPlan.addDays(cursor, -1); // step one day INTO THE PAST
    }
    return streak;
  }

  // Sums up distance/climbing/activity-count for whatever activities fall
  // between startDate and endDate (inclusive), optionally restricted to a
  // specific list of sports. `sportsFilter` is `null` when we want every
  // sport (used for the plain "this week" dashboard stat), or an array
  // like PLAN_RELEVANT_SPORTS when checking progress against the training
  // plan specifically.
  function weekActualFor(activities, startDate, endDate, sportsFilter) {
    // Comparing date strings like "2026-09-20" directly with >= and <= works
    // correctly here because they're all in "YYYY-MM-DD" format -- that
    // specific format happens to sort correctly as plain TEXT in exactly
    // the same order as it sorts chronologically, so no need to convert
    // back into Date objects just to compare them.
    const inRange = activities.filter(a =>
      a.date >= startDate && a.date <= endDate &&
      (!sportsFilter || sportsFilter.includes(a.sport))
    );
    return {
      distanceKm: inRange.reduce((s, a) => s + a.distanceKm, 0), // .reduce() walks the array accumulating a running total -- `s` starts at 0 (the second argument) and becomes s + a.distanceKm each step
      vertM: inRange.reduce((s, a) => s + a.elevGainM, 0),
      count: inRange.length,
    };
  }

  // Turns "actual X vs target Y" into a plain-language verdict + a CSS
  // class name for coloring it. The three thresholds (85%, 60%) are a
  // judgment call, not a scientific formula -- feel free to change them in
  // this one place if they don't feel right for how you train.
  function verdictFor(actual, target) {
    if (target <= 0) return { label: 'PENDING', cls: 'pending' }; // avoids a divide-by-zero, and correctly represents "there's no meaningful target to compare against yet"
    const ratio = actual / target;
    if (ratio >= 0.85) return { label: 'ON TRACK', cls: 'ok' };
    if (ratio >= 0.6) return { label: 'WATCH', cls: 'watch' };
    return { label: 'BEHIND', cls: 'behind' };
  }

  // Recomputes and redraws EVERYTHING on the Dashboard and Insights tabs.
  // Called after every import, every manual add, every plan-week edit, and
  // on first page load -- rather than trying to update just the one number
  // that changed, this just redraws everything from scratch each time,
  // which is simpler to reason about and plenty fast for a dataset this
  // size (hundreds of activities, not millions).
  function renderDashboard() {
    const activities = JCStore.getActivities();

    const totalDistance = activities.reduce((s, a) => s + a.distanceKm, 0);
    const totalVert = activities.reduce((s, a) => s + a.elevGainM, 0);

    // .innerHTML (rather than .textContent) is used here specifically
    // because we want the "<small>km</small>" part to actually render as a
    // smaller nested element, not display literally as the text
    // "<small>km</small>" on the page.
    document.getElementById('statTotalDistance').innerHTML = `${Math.round(totalDistance).toLocaleString()}<small>km</small>`;
    document.getElementById('statTotalVert').innerHTML = `${Math.round(totalVert).toLocaleString()}<small>m</small>`;
    document.getElementById('statCount').textContent = activities.length;
    document.getElementById('statStreak').innerHTML = `${computeStreak(activities)}<small>days</small>`;

    const thisWeekStart = JCPlan.startOfWeek(new Date()).toISOString().slice(0, 10);
    const thisWeekEnd = JCPlan.addDays(new Date(thisWeekStart), 6).toISOString().slice(0, 10);
    const thisWeekActual = weekActualFor(activities, thisWeekStart, thisWeekEnd, null); // null = every sport counts for this particular stat
    document.getElementById('statThisWeek').innerHTML = `${thisWeekActual.distanceKm.toFixed(1)}<small>km</small>`;

    // The "Vs. training plan" verdict looks at the TRAILING 3 COMPLETED
    // weeks (not including the current, still-in-progress week) rather
    // than just the current week alone -- a single week can be misleading
    // (e.g. a planned rest day makes that week look "behind" even though
    // you're perfectly on schedule), while 3 weeks smooths that out.
    const verdictEl = document.getElementById('statVerdict');
    if (currentPlan) {
      const todayStr = new Date().toISOString().slice(0, 10);
      // keep only weeks that have FULLY ended by today, then take the last 3 of those
      const doneWeeks = currentPlan.weeks.filter(w => w.endDate <= todayStr).slice(-3);

      let actualSum = 0, targetSum = 0;
      doneWeeks.forEach(w => {
        actualSum += weekActualFor(activities, w.startDate, w.endDate, PLAN_RELEVANT_SPORTS).distanceKm;
        targetSum += w.targetVolumeKm;
      });

      const v = verdictFor(actualSum, targetSum);
      verdictEl.textContent = v.label;
      // sets the text color inline using the matching CSS variable (--ok /
      // --watch / --behind / --text-soft) -- reusing the SAME color tokens
      // everything else in the app uses, rather than picking a new color
      // here that could drift out of sync with the rest of the palette
      verdictEl.style.color = v.cls === 'pending' ? 'var(--text-soft)' : `var(--${v.cls})`;
    } else {
      verdictEl.textContent = '–';
    }

    // Recent activity table: shows the 15 most recently logged activities,
    // newest first.
    const tbody = document.querySelector('#recentTable tbody');
    tbody.innerHTML = ''; // clear whatever was there before rebuilding
    // [...activities] makes a COPY of the array before sorting -- .sort()
    // normally rearranges an array IN PLACE, and we don't want to
    // accidentally reorder the actual stored activities list just because
    // we wanted a sorted view of it for this one table.
    [...activities].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15).forEach(a => {
      const tr = document.createElement('tr');
      const dot = `<span class="sport-dot" style="background:${JCCharts.sportColor(a.sport)}"></span>`;
      tr.innerHTML = `<td>${a.date}</td><td>${dot}${JCCharts.sportLabel(a.sport)}</td><td>${a.distanceKm.toFixed(1)} km</td><td>${a.elevGainM} m</td><td>${a.durationMin} min</td>`;
      tbody.appendChild(tr);
    });

    // Redraw every Insights chart and the consistency grid. All of these
    // are written to handle an EMPTY activities array gracefully (see the
    // comments in charts.js), which is what lets us call them
    // unconditionally here rather than needing an "if activities.length > 0" check.
    JCCharts.renderVolumeChart(activities);
    JCCharts.renderSportSplitChart(activities);
    JCCharts.renderVertPerKmChart(activities);
    JCCharts.renderConsistencyGrid(activities);

    updateOnFileHint(activities.length);
  }

  // ==========================================================================
  // TRAINING PLAN
  // ==========================================================================

  // Renders the four Base/Build/Peak/Taper summary cards at the top of the
  // Trail Run Training tab.
  function renderPhaseOverview(plan) {
    const el = document.getElementById('planPhaseOverview');
    el.innerHTML = '';

    let idx = 0; // tracks our position through plan.weeks as we walk phase by phase
    plan.phaseSummary.forEach(ph => {
      // plan.weeks is one FLAT list covering every phase back-to-back;
      // .slice(idx, idx + ph.weeks) pulls out just the chunk belonging to
      // this particular phase, using the running `idx` counter to know
      // where each phase starts.
      const weeksInPhase = plan.weeks.slice(idx, idx + ph.weeks);
      idx += ph.weeks;
      if (!weeksInPhase.length) return; // a phase could theoretically end up with 0 weeks in an extreme edge case -- skip drawing a card for it if so

      const div = document.createElement('div');
      div.className = 'phase-card';
      div.innerHTML = `
        <span class="phase-card__name">${ph.label}</span>
        <span class="phase-card__range">${weeksInPhase[0].dateLabel.split(' – ')[0]} – ${weeksInPhase[weeksInPhase.length - 1].dateLabel.split(' – ')[1]}</span>
        <span class="phase-card__weeks">${ph.weeks} week${ph.weeks === 1 ? '' : 's'}</span>`;
      el.appendChild(div);
    });
  }

  // Renders every individual week row in the training plan -- the big
  // expandable/editable list under the phase overview cards.
  function renderPlanWeeks(plan) {
    const el = document.getElementById('planWeeks');
    el.innerHTML = '';

    const activities = JCStore.getActivities();
    const overrides = JCStore.getPlanOverrides(); // any weeks the user has hand-edited targets for
    const todayStr = new Date().toISOString().slice(0, 10);
    let lastMonth = null; // tracks the most recent month-heading we've drawn, so we only draw a new "September 2026" heading when the month actually changes

    plan.weeks.forEach(w => {
      const ov = overrides[w.index] || {};
      // `??` is the "nullish coalescing" operator: `ov.longRunKm ?? w.targetLongRunKm`
      // means "use ov.longRunKm UNLESS it's null or undefined, in which
      // case fall back to the plan's own computed target." This is subtly
      // different from `||`, which would ALSO fall back if ov.longRunKm
      // were 0 -- and a user might genuinely want to override a week's
      // target down to 0 (e.g. an injury week), so `??` is the correct
      // choice here specifically.
      const longRunKm = ov.longRunKm ?? w.targetLongRunKm;
      const vertM = ov.vertM ?? w.targetVertM;
      const volumeKm = ov.volumeKm ?? w.targetVolumeKm;

      if (w.monthLabel !== lastMonth) {
        const h = document.createElement('div');
        h.className = 'plan-month-heading';
        h.textContent = w.monthLabel;
        el.appendChild(h);
        lastMonth = w.monthLabel;
      }

      const actual = weekActualFor(activities, w.startDate, w.endDate, PLAN_RELEVANT_SPORTS);
      const isFuture = w.startDate > todayStr;
      const isPast = w.endDate < todayStr;

      let verdict;
      if (isFuture) verdict = { label: 'UPCOMING', cls: 'pending' };
      else if (actual.count === 0 && isPast) verdict = { label: 'NO DATA', cls: 'pending' }; // distinguishes "you didn't train this week" from "you trained but fell short" -- both would otherwise show as BEHIND, which reads very differently
      else verdict = verdictFor(actual.distanceKm, volumeKm);

      const row = document.createElement('div');
      row.className = 'week-row';
      row.dataset.phase = w.phase; // used purely by CSS, to color-code each row's left border by phase (see .week-row[data-phase="..."] in style.css)
      row.innerHTML = `
        <div class="week-row__head">
          <span class="week-row__num">Wk ${w.index + 1}</span>
          <span class="week-row__dates">${w.dateLabel}</span>
          <span class="week-row__phase-tag">${w.phaseLabel}${w.isRecoveryWeek ? ' · recovery' : ''}</span>
          <span class="week-row__targets">Target: ${volumeKm} km / ${vertM} m D+ / long run ${longRunKm} km</span>
          <span class="week-row__verdict verdict--${verdict.cls}">${verdict.label}</span>
        </div>
        <div class="week-row__body">
          <div class="week-row__grid">
            <div class="week-row__field"><label>Long run target (km)<input type="number" min="0" data-field="longRunKm" value="${longRunKm}"></label></div>
            <div class="week-row__field"><label>Climbing target (m)<input type="number" min="0" step="50" data-field="vertM" value="${vertM}"></label></div>
            <div class="week-row__field"><label>Volume target (km)<input type="number" min="0" data-field="volumeKm" value="${volumeKm}"></label></div>
          </div>
          <div class="week-row__sessions"><strong>Key sessions:</strong><ul>${w.sessions.map(s => `<li>${s}</li>`).join('')}</ul></div>
          <div class="week-row__actual">Actual (running/hiking/mtb): ${actual.distanceKm.toFixed(1)} km · ${Math.round(actual.vertM)} m D+ · ${actual.count} activit${actual.count === 1 ? 'y' : 'ies'}</div>
        </div>`;

      // Clicking anywhere on the "head" row (not the expanded body) toggles
      // whether this week is expanded -- .toggle() with no second argument
      // flips the class on/off each time, rather than always setting it to
      // one specific state.
      row.querySelector('.week-row__head').addEventListener('click', () => row.classList.toggle('is-open'));

      // Wires up the three editable number inputs inside the expanded body.
      row.querySelectorAll('input[data-field]').forEach(input => {
        // Without this line, clicking INTO an input field (to type a new
        // number) would also trigger the .week-row__head click handler
        // above (since the input sits inside that same clickable area),
        // immediately collapsing the row you just tried to edit.
        // .stopPropagation() prevents the click from "bubbling up" to that
        // parent handler.
        input.addEventListener('click', e => e.stopPropagation());

        input.addEventListener('change', () => {
          // Re-reads the CURRENT overrides fresh from storage (rather than
          // reusing the `overrides` variable from the top of this
          // function) -- guards against a subtle bug where editing two
          // different weeks in a row, without this file having reloaded
          // in between, could otherwise overwrite one week's just-saved
          // change with a stale copy of the whole overrides object.
          const ov2 = JCStore.getPlanOverrides();
          ov2[w.index] = ov2[w.index] || {};
          ov2[w.index][input.dataset.field] = parseFloat(input.value) || 0;
          JCStore.setPlanOverrides(ov2);
          renderDashboard(); // the dashboard's "vs plan" verdict depends on plan targets, so it needs refreshing too whenever a target changes
        });
      });

      el.appendChild(row);
    });
  }

  // Runs when the "Generate / regenerate plan" button is clicked: reads
  // the race date + distance from the form inputs, saves them, builds a
  // brand new plan from scratch, and redraws everything that depends on
  // it. Deliberately WIPES any hand-made week overrides -- since the
  // number of weeks and their dates will have shifted, old overrides tied
  // to specific week INDEXES could otherwise end up attached to entirely
  // different weeks than the ones they were meant for.
  function regeneratePlan() {
    const raceDate = document.getElementById('raceDateInput').value;
    const raceDistanceKey = document.getElementById('raceDistanceInput').value;
    const raceKm = RACE_DEFAULTS[raceDistanceKey].km;

    JCStore.setSettings({ raceDate, raceDistance: raceDistanceKey });
    JCStore.setPlanOverrides({});
    currentPlan = JCPlan.generatePlan(raceDate, raceKm);

    renderCountdown({ raceDate });
    renderPhaseOverview(currentPlan);
    renderPlanWeeks(currentPlan);
    renderDashboard();
  }

  document.getElementById('generatePlanBtn').addEventListener('click', regeneratePlan);

  // ==========================================================================
  // IMPORT (file picker, drag-and-drop, whole-folder select)
  // ==========================================================================

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');     // the hidden <input type="file"> used for picking individual files
  const folderInput = document.getElementById('folderInput'); // the hidden <input type="file" webkitdirectory> used for picking a WHOLE FOLDER at once
  const importStatus = document.getElementById('importStatus');

  // Both "browse" buttons just programmatically click their corresponding
  // hidden <input>, since a plain <button> can't open a file picker on its
  // own -- only an <input type="file"> can, and clicking it via JavaScript
  // opens the exact same native OS file dialog as if the user had clicked
  // a visible file input themselves.
  document.getElementById('browseBtn').addEventListener('click', () => fileInput.click());
  document.getElementById('browseFolderBtn').addEventListener('click', () => folderInput.click());
  dropzone.addEventListener('click', () => fileInput.click()); // clicking anywhere on the dropzone itself (not just the "browse" link) also opens the file picker, which is what most people instinctively try first

  // Drag-and-drop visual feedback: 'dragenter'/'dragover' fire repeatedly
  // while something is being dragged over the dropzone; 'dragleave'/'drop'
  // fire when it leaves or lands. e.preventDefault() is required on all of
  // these -- without it, the BROWSER'S OWN default behavior (usually
  // navigating away to open the dropped file directly) takes over instead
  // of letting our own 'drop' handler run.
  ['dragenter', 'dragover'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('is-dragover'); }));
  ['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('is-dragover'); }));

  dropzone.addEventListener('drop', e => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
  fileInput.addEventListener('change', e => { if (e.target.files.length) handleFiles(e.target.files); });
  folderInput.addEventListener('change', e => { if (e.target.files.length) handleFiles(e.target.files); }); // webkitdirectory hands back every file found inside the chosen folder (recursively) as one flat FileList, exactly like a normal multi-file selection

  function showStatus(text, kind) {
    importStatus.textContent = text;
    importStatus.className = 'import-status ' + (kind ? `status--${kind}` : '');
  }

  function updateOnFileHint(n) {
    document.getElementById('onFileHint').textContent = n ? `— ${n} activities stored` : '';
  }

  // The main import handler -- called from the file input, the folder
  // input, AND drag-and-drop, all of which end up handing this function a
  // FileList of one or more files.
  async function handleFiles(fileList) {
    // Array.from() converts the FileList (which looks array-like but isn't
    // a REAL array -- it doesn't have .filter()/.map()/etc.) into an
    // actual array we can use normal array methods on. The .filter() here
    // also quietly ignores anything that isn't .json or .csv -- relevant
    // specifically for the "select whole folder" button, since a real
    // folder might contain other file types we have no use for.
    const files = Array.from(fileList).filter(f => /\.(json|csv)$/i.test(f.name));
    if (!files.length) { showStatus('Please choose .json or .csv files from Garmin.', 'error'); return; }

    showStatus(`Reading ${files.length} file(s)...`, null);

    try {
      let allNew = [];
      let anyError = null;

      // A plain `for...of` loop (rather than .forEach or Promise.all) is
      // used here specifically because each file needs an `await` inside
      // the loop body (`await file.text()`, and for CSVs `await
      // JCParser.parseCsvText(...)`) -- `await` only works cleanly inside
      // a real loop like this, not inside a .forEach() callback.
      for (const file of files) {
        const text = await file.text(); // file.text() reads the file's contents -- asynchronous, since reading a file takes real time, hence needing `await`
        const isCsv = /\.csv$/i.test(file.name);

        // parseFileText (the JSON path) returns a plain object directly;
        // parseCsvText (the CSV path) returns a PROMISE (because PapaParse
        // works through a callback internally -- see the comment on
        // parseCsvText in parser.js). Using `await` in front of BOTH calls
        // here works fine either way: `await` on something that's already
        // a plain, non-Promise value just uses that value immediately,
        // with no actual waiting involved. This is what lets both file
        // types share one line of calling code instead of needing an
        // if/else with separate handling for each.
        const result = isCsv ? await JCParser.parseCsvText(text) : JCParser.parseFileText(text);

        if (result.error) anyError = `${file.name}: ${result.error}`; // if MULTIPLE files have errors, only the last one is kept here -- a deliberate simplification, since showing every possible error at once would clutter the status message more than it helps
        allNew = allNew.concat(result.activities);
      }

      if (!allNew.length) {
        showStatus(anyError || 'No recognizable activities found in those files.', 'error');
        return;
      }

      const existing = JCStore.getActivities();
      const { merged, added, updated } = JCParser.dedupeMerge(existing, allNew);
      JCStore.setActivities(merged);

      let msg = `Imported ${allNew.length} activities from ${files.length} file(s).\n${added} new, ${updated} already on file.\nTotal now on file: ${merged.length}.`;
      if (anyError) msg += `\n\nNote: ${anyError}`;
      showStatus(msg, 'ok');

      renderDashboard();
      if (currentPlan) renderPlanWeeks(currentPlan); // the plan's per-week "actual" numbers depend on imported activities too, so it needs refreshing whenever new data comes in
    } catch (err) {
      // A genuinely UNEXPECTED failure (not one of the handled error cases
      // above, which return cleanly) -- logged to the console for
      // debugging, and shown to the user in plain language rather than
      // letting the error silently vanish or crash the page.
      console.error(err);
      showStatus('Something went wrong reading those files: ' + err.message, 'error');
    }
  }

  document.getElementById('clearDataBtn').addEventListener('click', () => {
    // confirm() shows a native browser yes/no dialog and PAUSES script
    // execution until the user responds -- if they click "Cancel", it
    // returns false and the `return` below stops this function here,
    // before anything is actually deleted.
    if (!confirm('Clear all imported activity data? Your training plan settings are kept.')) return;
    JCStore.clearActivities();
    renderDashboard();
    if (currentPlan) renderPlanWeeks(currentPlan);
    showStatus('All imported activity data cleared.', 'ok');
  });

  // ==========================================================================
  // EXPORT BACKUP -- the bridge between this app's separate storage boxes
  // ==========================================================================
  // Every distinct URL this app is opened at (Live Server on some port,
  // your computer's local IP, the GitHub Pages URL, the installed phone
  // app) has entirely separate browser storage -- that's a security rule
  // browsers enforce, not something this app can override. This button
  // downloads everything currently stored as one plain .json file, which
  // can then be re-imported through the exact same Import Data flow on
  // whichever OTHER url/device you want the data to also exist on.

  document.getElementById('exportBackupBtn').addEventListener('click', () => {
    const backup = {
      jcBackupVersion: 1, // lets parser.js instantly recognize this exact shape as "one of my own backups" on the way back in, rather than trying (and failing) to interpret it as a raw Garmin export
      exportedAt: new Date().toISOString(),
      activities: JCStore.getActivities(),
    };

    // Building a downloadable file entirely in the browser, with no server
    // involved, always follows this same three-step recipe:
    //   1. Wrap the data in a Blob (a browser object representing raw
    //      file-like data, here: our JSON text, tagged as type "application/json").
    //   2. URL.createObjectURL(blob) gives us a special temporary URL
    //      (looks like "blob:https://...") that points at that Blob's data.
    //   3. Create an invisible <a> (link) element pointing at that URL,
    //      with a "download" attribute (which tells the browser "save
    //      this instead of navigating to it" and sets the filename), then
    //      simulate a click on it -- exactly as if the user had clicked a
    //      real download link themselves.
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `judgement-center-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); // some browsers require the link to actually be in the page to click() it reliably
    a.click();
    document.body.removeChild(a); // clean up -- we don't need this invisible link hanging around afterward
    URL.revokeObjectURL(url); // frees the browser's memory holding that temporary blob: URL, now that the download's been triggered

    showStatus(`Exported ${backup.activities.length} activities to a backup file. Import that file on any other device/URL to bring this data over.`, 'ok');
  });

  // ==========================================================================
  // QUICK ADD (manual, single activity -- no file needed)
  // ==========================================================================

  const quickAddForm = document.getElementById('quickAddForm');
  // Defaults the date field to TODAY the moment the page loads, since
  // logging today's own session is by far the most common use of this
  // form -- saves the user from having to open the date picker every time
  // for the common case.
  document.getElementById('qaDate').value = new Date().toISOString().slice(0, 10);

  quickAddForm.addEventListener('submit', (e) => {
    // Without this line, submitting a <form> makes the BROWSER'S default
    // behavior kick in: reload the whole page (or navigate somewhere),
    // wiping out everything including whatever we're about to do here.
    // e.preventDefault() stops that default behavior so our own code
    // below can run instead.
    e.preventDefault();

    const manualActivity = {
      // The "manual-" prefix guarantees this id can never accidentally
      // collide with a real Garmin activityId (which are always plain
      // numbers) or a CSV-import fingerprint id (which start with "csv-").
      // Date.now() (current time in milliseconds) plus a random number
      // means two quick-adds submitted on the same day, even seconds
      // apart, still get different ids from each other.
      id: `manual-${Date.now()}-${Math.round(Math.random() * 1000)}`,
      name: 'Manual entry',
      sport: document.getElementById('qaSport').value,
      date: document.getElementById('qaDate').value,
      distanceKm: parseFloat(document.getElementById('qaDistance').value) || 0,
      elevGainM: parseFloat(document.getElementById('qaVert').value) || 0,
      durationMin: parseFloat(document.getElementById('qaDuration').value) || 0,
      avgHr: null,
      maxHr: null,
    };

    const existing = JCStore.getActivities();
    JCStore.setActivities([...existing, manualActivity].sort((a, b) => a.date.localeCompare(b.date)));

    showStatus(`Added 1 manual activity on ${manualActivity.date}.`, 'ok');
    quickAddForm.reset(); // clears every field in the form back to its default value
    document.getElementById('qaDate').value = new Date().toISOString().slice(0, 10); // .reset() above also clears the date field -- immediately re-defaulting it to today keeps the form ready for the NEXT quick-add without extra clicks

    renderDashboard();
    if (currentPlan) renderPlanWeeks(currentPlan);
  });

  // ==========================================================================
  // PWA INSTALL (the service worker that makes "Add to Home Screen" work)
  // ==========================================================================

  if ('serviceWorker' in navigator) { // some older/unusual browsers don't support service workers at all -- this check avoids an error trying to use an API that doesn't exist there
    // Registering inside a 'load' event listener (rather than immediately)
    // means this happens AFTER the page has fully finished loading --
    // registering a service worker takes a small amount of background
    // work, and we'd rather that not compete with the page's own initial
    // load time for the user's very first visit.
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker registration failed:', err));
    });
  }

  // ==========================================================================
  // INITIALIZATION -- runs once, immediately, when this script first loads
  // ==========================================================================

  function init() {
    const settings = JCStore.getSettings();
    document.getElementById('raceDateInput').value = settings.raceDate;
    document.getElementById('raceDistanceInput').value = settings.raceDistance;
    renderCountdown(settings);

    currentPlan = JCPlan.generatePlan(settings.raceDate, RACE_DEFAULTS[settings.raceDistance].km);
    renderPhaseOverview(currentPlan);
    renderPlanWeeks(currentPlan);
    renderDashboard();

    // If a tab was remembered from a previous visit, switch to it now --
    // otherwise the page just stays on Dashboard, which is already marked
    // as the active tab/panel directly in the HTML.
    const lastTab = JCStore.getLastTab();
    if (lastTab) switchTab(lastTab);
  }

  init(); // actually run everything above -- nothing before this line executes anything, it only DEFINES functions and sets up event listeners
})();
