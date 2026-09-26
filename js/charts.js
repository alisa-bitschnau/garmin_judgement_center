// ============================================================================
// charts.js
// ============================================================================
// Everything on the Insights tab that draws a picture rather than showing
// plain numbers lives here: three Chart.js charts, plus one small grid
// built with plain CSS/DOM (the "consistency grid") that doesn't need a
// charting library at all.
//
// Chart.js itself is loaded via a <script> tag in index.html (from a CDN),
// which is why this file can just use the global `Chart` constructor
// directly without any import statement -- when you load a library as a
// plain <script> tag rather than through a module bundler, whatever it
// defines becomes available as a global, the same way our own JCStore,
// JCParser, etc. do.
// ============================================================================

const JCCharts = (() => {
  // These three variables hold a reference to each currently-drawn chart.
  // WHY WE NEED TO KEEP THESE: Chart.js doesn't automatically replace an
  // old chart when you draw a new one on the same <canvas> -- if you don't
  // explicitly destroy the previous chart first, redrawing (e.g. every
  // time new data is imported) leaves the old chart's event listeners and
  // memory hanging around, and can cause visual glitches. Each render
  // function below checks "do I already have a chart here? If so, destroy
  // it first" before creating a new one.
  let volumeChart, sportSplitChart, vertPerKmChart;

  // Reads a CSS custom property's actual current value (e.g. "#38BDF8" for
  // --accent) so our JavaScript-drawn charts use EXACTLY the same colors
  // as the rest of the page's CSS, rather than duplicating color values in
  // two places that could drift out of sync.
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Looks up the color defined for a given sport, e.g. sportColor('hiking')
  // reads the --sport-hiking variable from style.css. Falls back to
  // --sport-other for any sport that doesn't have its own dedicated color
  // yet (rather than crashing or drawing nothing).
  function sportColor(sport) {
    return cssVar(`--sport-${sport}`) || cssVar('--sport-other');
  }

  // Turns a raw sport key like "trail_running" into a display-friendly
  // "Trail Running" for chart legends and the activity table.
  function sportLabel(sport) {
    // \b\w matches the first letter of every "word" (a run of word
    // characters) in the string -- .replace(...) uppercases each one.
    return sport.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // Given one activity's date string, returns the Monday that starts its
  // week -- reusing JCPlan's startOfWeek so this always agrees exactly
  // with how plan.js defines "which week is this."
  function weekKey(dateStr) {
    return JCPlan.startOfWeek(new Date(dateStr + 'T00:00:00')).toISOString().slice(0, 10);
  }

  // Groups a flat list of activities into one entry PER WEEK, summing up
  // distance and elevation gain within each week. This is the shape every
  // chart below that shows a "trend over time" actually needs -- a single
  // activity is too granular to chart meaningfully across months, but a
  // week is a natural unit both for training and for reading a chart.
  function bucketByWeek(activities) {
    // A Map is used here (rather than a plain object) mainly out of habit
    // from the rest of this codebase -- either would work fine for this
    // particular case, since week-start strings make perfectly good plain
    // object keys too.
    const map = new Map();
    activities.forEach(a => {
      const wk = weekKey(a.date);
      if (!map.has(wk)) map.set(wk, { week: wk, distanceKm: 0, elevGainM: 0 });
      const b = map.get(wk);
      b.distanceKm += a.distanceKm;
      b.elevGainM += a.elevGainM;
    });
    // Sorted so charts read left-to-right in chronological order --
    // Map iteration order isn't something you want to rely on for this.
    return Array.from(map.values()).sort((a, b) => a.week.localeCompare(b.week));
  }

  // Builds the common Chart.js "options" object (axis colors, grid line
  // colors, legend text color) shared by the line/bar charts below, so
  // each chart doesn't need to repeat this styling boilerplate. `extra.y1`
  // adds a SECOND y-axis on the right side, used only by the volume chart
  // (which shows both distance and elevation on different scales at once).
  function baseOptions(extra) {
    const text = cssVar('--text-soft');
    const grid = cssVar('--border');
    const opts = {
      responsive: true,        // the chart resizes itself when its container's size changes (e.g. window resize, or the stat-grid collapsing to one column on mobile)
      maintainAspectRatio: false, // lets the chart's HEIGHT be controlled by CSS/the canvas's own height attribute, rather than Chart.js forcing a fixed width:height ratio
      plugins: { legend: { labels: { color: cssVar('--text'), font: { family: 'Inter', size: 11 } } } },
      scales: {
        x: { ticks: { color: text, font: { size: 10 } }, grid: { color: grid } },
        y: { ticks: { color: text, font: { size: 10 } }, grid: { color: grid }, beginAtZero: true },
      },
    };
    if (extra && extra.y1) {
      // position: 'right' puts this axis's labels on the opposite side
      // from the default 'y' axis; grid: { display: false } avoids
      // drawing a SECOND set of horizontal gridlines on top of the first
      // axis's gridlines, which would just look like visual noise.
      opts.scales.y1 = { position: 'right', ticks: { color: text, font: { size: 10 } }, grid: { display: false }, beginAtZero: true };
    }
    return opts;
  }

  // Chart 1: weekly volume (bars) with elevation gain overlaid (a line),
  // using two different y-axes since kilometers and meters-of-climbing are
  // very different scales -- plotting both on one axis would make one of
  // them look flat.
  function renderVolumeChart(activities) {
    const buckets = bucketByWeek(activities).slice(-16); // .slice(-16) keeps only the LAST 16 entries -- i.e. the most recent 16 weeks, how ever many total weeks of history exist

    if (volumeChart) volumeChart.destroy(); // see the comment on the `let volumeChart` declaration above for why this matters
    volumeChart = new Chart(document.getElementById('chartVolume'), {
      data: {
        labels: buckets.map(b => b.week.slice(5)), // "2026-09-14" -> "09-14", trims the year off since 16 weeks never spans enough time for the year to matter on the x-axis
        datasets: [
          {
            type: 'bar', label: 'Distance (km)',
            data: buckets.map(b => Math.round(b.distanceKm * 10) / 10), // round to 1 decimal place
            backgroundColor: cssVar('--accent'),
            yAxisID: 'y', // ties this dataset to the LEFT axis
          },
          {
            type: 'line', label: 'Elevation gain (m)',
            data: buckets.map(b => Math.round(b.elevGainM)),
            borderColor: cssVar('--sport-hiking'), backgroundColor: cssVar('--sport-hiking'),
            yAxisID: 'y1', // ties this dataset to the RIGHT axis instead
            tension: 0.25, // slightly curves the line between points rather than sharp straight segments -- purely a visual preference
          },
        ],
      },
      options: baseOptions({ y1: true }), // { y1: true } is what makes baseOptions() add that second axis
    });
  }

  // Chart 2: a doughnut chart showing how your training TIME (not
  // distance -- a strength session has 0 distance but real duration) is
  // split across different sports, all-time.
  function renderSportSplitChart(activities) {
    // Building a running total of minutes per sport, the same
    // Map-as-lookup-table pattern used in bucketByWeek() above.
    const totals = new Map();
    activities.forEach(a => totals.set(a.sport, (totals.get(a.sport) || 0) + a.durationMin));

    // Turn the Map into an array of [sport, totalMinutes] pairs and sort
    // it so the biggest slice is listed (and colored) first -- purely a
    // readability choice for the legend.
    const sorted = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);

    if (sportSplitChart) sportSplitChart.destroy();
    sportSplitChart = new Chart(document.getElementById('chartSportSplit'), {
      type: 'doughnut',
      data: {
        labels: sorted.map(([sport]) => sportLabel(sport)), // [sport] destructures just the first element out of each [sport, minutes] pair
        datasets: [{
          data: sorted.map(([, mins]) => Math.round(mins / 60 * 10) / 10), // [, mins] skips the first element and grabs the second -- converting total minutes to hours, rounded to 1 decimal
          backgroundColor: sorted.map(([sport]) => sportColor(sport)), // one slice color per sport, straight from our CSS variables
          borderColor: cssVar('--surface'), // the thin line between slices matches the card background, making slices look visually separated rather than touching
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // 'right' legend placement (rather than Chart.js's default of
        // below the chart) fits better in this card's roughly-square
        // shape; boxWidth shrinks the little color swatches next to each
        // legend label so more sports can fit without wrapping awkwardly.
        plugins: { legend: { position: 'right', labels: { color: cssVar('--text'), font: { family: 'Inter', size: 11 }, boxWidth: 12 } } },
      },
    });
  }

  // Chart 3: "climbing intensity" -- meters of elevation gained per
  // kilometer, per week. This is a metric Garmin's own app doesn't
  // surface as a trend at all; a flat run and a steep trail can have
  // identical distance but wildly different difficulty, and this chart is
  // what makes that difference visible over time.
  function renderVertPerKmChart(activities) {
    const buckets = bucketByWeek(activities).slice(-16);
    if (vertPerKmChart) vertPerKmChart.destroy();
    vertPerKmChart = new Chart(document.getElementById('chartVertPerKm'), {
      type: 'line',
      data: {
        labels: buckets.map(b => b.week.slice(5)),
        datasets: [{
          label: 'm climbed per km',
          // guard against dividing by zero: a week with 0km logged (e.g.
          // only a strength session) would otherwise produce Infinity or
          // NaN here, which Chart.js would either crash on or draw as a
          // broken line
          data: buckets.map(b => b.distanceKm > 0 ? Math.round(b.elevGainM / b.distanceKm) : 0),
          borderColor: cssVar('--accent'),
          backgroundColor: cssVar('--accent'),
          tension: 0.25,
        }],
      },
      options: baseOptions({}), // no y1 needed -- this chart only has one thing to plot
    });
  }

  // The consistency grid: NOT a Chart.js chart at all, just a plain CSS
  // grid of small colored squares (16 weeks x 7 days), similar in spirit
  // to GitHub's contribution graph. Deliberately built this way instead of
  // as a chart because the "shape" being communicated -- which exact days
  // had activity -- is really a grid layout problem, not a data-plotting
  // one; CSS Grid is simpler and lighter-weight for this than asking a
  // charting library to draw 112 individual colored cells.
  function renderConsistencyGrid(activities) {
    const el = document.getElementById('consistencyGrid');
    el.innerHTML = ''; // clear out whatever was drawn last time before rebuilding

    const today = JCPlan.startOfWeek(new Date());
    const weeks = [];
    // builds a list of the last 16 Mondays, OLDEST first (i starts at 15
    // and counts down to 0) -- so the grid reads left-to-right as past-to-present,
    // matching how the other charts on this tab are also oriented
    for (let i = 15; i >= 0; i--) weeks.push(JCPlan.addDays(today, -7 * i));

    // counts how many activities happened on each individual DAY (not
    // week) -- a Map keyed by "YYYY-MM-DD" date strings
    const countByDay = new Map();
    activities.forEach(a => countByDay.set(a.date, (countByDay.get(a.date) || 0) + 1));

    weeks.forEach(weekStart => {
      for (let d = 0; d < 7; d++) {
        const day = JCPlan.addDays(weekStart, d);
        const key = day.toISOString().slice(0, 10);
        const n = countByDay.get(key) || 0;

        const cell = document.createElement('div'); // builds one grid square as a real DOM element
        cell.className = 'consistency-cell';
        cell.title = `${key}: ${n} activit${n === 1 ? 'y' : 'ies'}`; // the `title` attribute becomes a native browser tooltip on hover -- no JavaScript needed to make hovering show a message
        // data-level drives the actual COLOR via CSS (see the
        // .consistency-cell[data-level="1"/"2"] rules in style.css) --
        // 0 activities = default dim color, 1 = a highlighted color, 2+ = the fullest color
        cell.dataset.level = n === 0 ? '0' : n === 1 ? '1' : '2';
        el.appendChild(cell);
      }
    });
  }

  // Everything returned here is what app.js calls after every import,
  // manual add, or data clear -- each render function is safe to call
  // repeatedly and safe to call with an EMPTY activities array (charts
  // just draw as empty/flat rather than crashing), which is what lets
  // app.js call all four of these unconditionally rather than needing a
  // special "if there's no data yet" branch.
  return { renderVolumeChart, renderSportSplitChart, renderVertPerKmChart, renderConsistencyGrid, bucketByWeek, weekKey, sportColor, sportLabel };
})();
