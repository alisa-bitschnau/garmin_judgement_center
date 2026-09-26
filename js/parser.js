// ============================================================================
// parser.js
// ============================================================================
// This file's entire job: take whatever raw file Garmin gives you (a JSON
// export or a CSV export) and turn it into OUR OWN simple, consistent
// shape:
//
//   { id, name, sport, date, distanceKm, elevGainM, durationMin, avgHr, maxHr }
//
// Every other file in this app (charts.js, app.js, plan.js) only ever
// touches activities in THIS shape. They never need to know Garmin's field
// names, Garmin's units, or the difference between the JSON export and the
// CSV export. That translation happens exactly once, here -- which is the
// whole reason a bug like the comma/decimal one only needed fixing in one
// place instead of everywhere distance was used.
// ============================================================================

const JCParser = (() => {

  // --------------------------------------------------------------------
  // PART 0: our OWN backup format
  // --------------------------------------------------------------------
  // Since every URL this app runs at has its own separate, walled-off
  // storage (a browser security rule, not something this app controls),
  // "export a backup file, import it somewhere else" is the bridge
  // between them. This format is deliberately simple: our own already-
  // normalized activity shape, wrapped in a small envelope object with a
  // version marker (jcBackupVersion) so parseFileText can immediately
  // recognize "this is one of MY OWN exports" and skip straight past all
  // the Garmin-specific unwrapping logic below, using the activities
  // list exactly as-is.
  function isBackupFormat(json) {
    return json && typeof json === 'object' && !Array.isArray(json) && json.jcBackupVersion === 1 && Array.isArray(json.activities);
  }

  // --------------------------------------------------------------------
  // PART 1: the full JSON export
  // (DI_CONNECT/DI-Connect-Fitness/*_summarizedActivities.json)
  // --------------------------------------------------------------------
  // This part was built and verified against a REAL export file, not
  // guessed. Confirmed facts about this specific format:
  //
  //   - file shape: [ { "summarizedActivitiesExport": [ ...activities ] } ]
  //     i.e. an array containing one object, which itself contains the
  //     real list of activities.
  //   - "activityType" is a plain string, e.g. "trail_running" -- not
  //     nested inside another object.
  //   - distance and elevationGain are in CENTIMETERS.
  //     (divide by 100000 for km, or by 100 for meters)
  //   - duration and every timestamp field are in MILLISECONDS.
  //     (divide by 60000 for minutes)
  //   - "startTimeLocal" is an epoch-milliseconds number that has ALREADY
  //     been shifted to represent local wall-clock time. This matters for
  //     one subtle reason explained right where we use it, below.

  // Turns ONE raw Garmin activity object (from the JSON export) into our
  // own clean shape. Returns null for anything that doesn't look like a
  // real activity (missing a start time, or has neither distance nor
  // duration) -- callers filter those out.
  function normalizeActivity(raw) {
    if (!raw || !raw.startTimeLocal) return null;

    const distanceKm = raw.distance ? raw.distance / 100000 : 0;
    const elevGainM = raw.elevationGain ? raw.elevationGain / 100 : 0;
    const durationMin = raw.duration ? raw.duration / 60000 : 0;

    // Skip anything with literally nothing recorded -- these show up
    // occasionally as junk/incomplete entries in real exports.
    if (distanceKm <= 0 && durationMin <= 0) return null;

    return {
      id: String(raw.activityId), // Garmin's own unique ID -- this is what makes de-duplication reliable for JSON imports
      name: raw.name || '',
      sport: (raw.activityType || 'other').toLowerCase(), // e.g. "trail_running"

      // WHY .toISOString() here and not raw.getDate()/getMonth()/etc:
      // `startTimeLocal` is a millisecond timestamp that Garmin has already
      // shifted to represent the activity's LOCAL date and time -- but
      // JavaScript's Date object always treats a raw number of
      // milliseconds as UTC internally. So when we do
      // `new Date(raw.startTimeLocal)`, JS creates a Date object that
      // (measured in UTC) already lands on the correct local calendar day.
      // Calling `.toISOString()` reads that Date back out AS UTC, which
      // gives us back exactly the local date Garmin intended.
      // If we instead used `.getDate()`/`.getMonth()` (which read a Date
      // using the BROWSER'S OWN timezone setting), the browser would try
      // to shift the timestamp AGAIN on top of Garmin's shift -- and for
      // anyone not in Garmin's assumed timezone, or right around midnight,
      // that would land on the wrong day entirely. Using .toISOString()
      // avoids that double-shift.
      date: new Date(raw.startTimeLocal).toISOString().slice(0, 10), // -> "YYYY-MM-DD"

      // Math.round(x * 100) / 100 is a common trick to round to 2 decimal
      // places: multiply up so the digits you want to keep are to the left
      // of the decimal point, round to a whole number, then divide back
      // down. Plain Math.round(x) would only give whole kilometers.
      distanceKm: Math.round(distanceKm * 100) / 100,
      elevGainM: Math.round(elevGainM),
      durationMin: Math.round(durationMin),

      // `raw.avgHr ? Math.round(raw.avgHr) : null` -- if there's no heart
      // rate data for this activity (e.g. it wasn't recorded), we store
      // `null` rather than `0`. This matters later: a null heart rate can
      // be displayed as "–" and skipped in averages, whereas a stored 0
      // would look like a real (and very alarming) heart rate reading.
      avgHr: raw.avgHr ? Math.round(raw.avgHr) : null,
      maxHr: raw.maxHr ? Math.round(raw.maxHr) : null,
    };
  }

  // Parses ONE JSON file's raw text (you might have several -- Garmin
  // splits large histories into multiple files). Returns
  // { activities: [...], error: "message" or null } -- callers check
  // `error` to know whether to show something to the user, and always get
  // an `activities` array back (empty if something went wrong) so they
  // never need a separate null-check.
  function parseFileText(rawText) {
    let json;
    try {
      json = JSON.parse(rawText); // turns the raw file text into real JS objects/arrays
    } catch (e) {
      return { activities: [], error: 'Could not parse this file as JSON — it may be corrupted or not a Garmin export.' };
    }

    // Check for our OWN backup format FIRST, before assuming this is a
    // Garmin export -- see isBackupFormat()'s comment above for why this
    // shape is unambiguous (an object with jcBackupVersion, never an
    // array), so there's no risk of confusing it with a real Garmin file.
    if (isBackupFormat(json)) {
      return { activities: json.activities, error: null };
    }

    if (!Array.isArray(json)) {
      return { activities: [], error: 'Unexpected file shape (expected a JSON array at the top level).' };
    }

    const activities = [];
    // Garmin's export is an array of "blocks" -- in practice usually just
    // one block per file, but we loop over all of them just in case a
    // future export format bundles more than one per file.
    json.forEach(block => {
      const raw = (block && block.summarizedActivitiesExport) || [];
      raw.forEach(r => {
        const a = normalizeActivity(r);
        if (a) activities.push(a); // normalizeActivity returns null for junk entries -- skip those
      });
    });

    return { activities, error: null };
  }

  // --------------------------------------------------------------------
  // PART 2: the CSV export
  // (Garmin Connect website -> Activities -> All Activities -> Export CSV)
  // --------------------------------------------------------------------
  // Unlike the JSON export above, this format was NOT verified against a
  // real sample file at first -- it's built against Garmin's commonly
  // reported column names, and got fixed twice already based on real
  // files you sent (the wrong-export-type mixup, and the comma/decimal
  // number bug). That's completely normal for integrating with a format
  // you don't control the shape of: build a best guess, test it against
  // something real, fix what's actually wrong. It's also exactly why this
  // translation logic all lives in ONE file -- fixing the number-parsing
  // bug meant changing one function, not hunting through the whole app
  // for every place a distance was displayed.

  // Garmin's CSV column headers, and the various names we've seen or
  // expect for each piece of data. `findCsvField` below checks each of
  // these possibilities in order and uses the first one that's actually
  // present with a value.
  const CSV_HEADER_SYNONYMS = {
    date: ['date'],
    name: ['title', 'activity name', 'name'],
    sport: ['activity type', 'type'],
    distance: ['distance'],
    elevGain: ['total ascent', 'elev gain', 'elevation gain'],
    duration: ['time', 'moving time', 'duration'],
    avgHr: ['avg hr', 'average hr'],
    maxHr: ['max hr', 'maximum hr'],
  };

  // `row` here is one parsed CSV row, as an object like
  // { "Date": "2026-09-20", "Distance": "5,00", ... } -- PapaParse (the
  // library doing the actual CSV splitting) gives us the column headers
  // as the object's keys exactly as they appeared in the file.
  function findCsvField(row, synonyms) {
    const keys = Object.keys(row);
    for (const syn of synonyms) {
      // .trim() removes accidental leading/trailing spaces in a header
      // name; .toLowerCase() makes the comparison case-insensitive, so
      // "Distance", "distance", and "DISTANCE" all match the same way
      const match = keys.find(k => k.trim().toLowerCase() === syn);
      if (match && row[match] !== undefined && row[match] !== '') return row[match];
    }
    return undefined; // none of the expected header names were found in this file
  }

  // Converts a duration TEXT value into a plain number of minutes.
  // Garmin's CSV writes durations as "HH:MM:SS" (e.g. "01:15:30") or
  // sometimes just "MM:SS" for short activities -- never as a plain
  // number of seconds like the JSON export uses, so this needs entirely
  // different logic from the JSON side's simple division.
  function parseDurationText(val) {
    if (val === undefined) return 0;
    const str = String(val).trim();

    // if it's ALREADY just a plain number (no colons at all), assume it's
    // already in minutes and use it directly
    if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);

    // .split(':') on "01:15:30" gives ["01","15","30"]; .map(Number)
    // converts each piece from a string to an actual number: [1, 15, 30]
    const parts = str.split(':').map(Number);
    if (parts.some(isNaN)) return 0; // something in there wasn't a valid number -- bail out safely

    if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60; // HH:MM:SS -> minutes
    if (parts.length === 2) return parts[0] + parts[1] / 60;                  // MM:SS -> minutes
    return 0;
  }

  // Converts a number TEXT value into a real JavaScript number, correctly
  // handling BOTH number formats Garmin's CSV export can use depending on
  // your account's region/locale settings:
  //   "5.00"  -- period as the decimal separator (US-style)
  //   "5,00"  -- comma as the decimal separator (Swiss/European-style)
  //
  // THE BUG THIS REPLACES: an earlier version of this function stripped
  // out every character that wasn't a digit, a period, or a minus sign.
  // That's fine for "5.00" (nothing gets stripped), but for "5,00" it
  // deletes the comma entirely, leaving the digits mashed together into
  // "500" -- silently inflating every European-formatted number by
  // exactly 100x. The output still LOOKED like a plausible number, which
  // is what made it easy to miss until real distances came back wrong.
  function toNumber(val) {
    if (val === undefined) return 0;
    let str = String(val).trim();

    const hasComma = str.includes(',');
    const hasDot = str.includes('.');

    if (hasComma && hasDot) {
      // Both a comma AND a period appear -- this means one of them is a
      // THOUSANDS separator and the other is the real decimal point.
      // Whichever one appears LAST in the string is the decimal point
      // (a decimal separator always comes after any thousands grouping).
      // Examples: "1.234,56" (European: period=thousands, comma=decimal)
      //           "1,234.56" (US: comma=thousands, period=decimal)
      if (str.lastIndexOf(',') > str.lastIndexOf('.')) {
        // comma comes later -> European style: remove every period (the
        // thousands separators), then turn the comma into a real decimal point
        str = str.replace(/\./g, '').replace(',', '.');
      } else {
        // period comes later -> US style: just remove the thousands commas
        str = str.replace(/,/g, '');
      }
    } else if (hasComma) {
      // Only a comma appears, no period at all -- in Garmin's export this
      // means the comma IS the decimal separator (European locale, no
      // thousands grouping needed because activity distances are small).
      str = str.replace(',', '.');
    }
    // else: only a period, or no separator at all -- the string is
    // already in a shape JavaScript's parseFloat understands natively.

    // Final cleanup pass: strip anything that still isn't a digit, a
    // period, or a minus sign (stray units like "km", spaces, etc.),
    // then hand it to parseFloat.
    const n = parseFloat(str.replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }

  // Turns ONE raw CSV row into our own clean activity shape (same target
  // shape as normalizeActivity() above, for the JSON path). Returns null
  // for rows that don't look like real activities.
  function normalizeCsvRow(row) {
    const dateRaw = findCsvField(row, CSV_HEADER_SYNONYMS.date);
    if (!dateRaw) return null; // no recognizable date column -- can't use this row at all

    const date = new Date(dateRaw);
    if (isNaN(date)) return null; // the date column was present but didn't parse into a real date

    const distanceKm = toNumber(findCsvField(row, CSV_HEADER_SYNONYMS.distance));
    const durationMin = Math.round(parseDurationText(findCsvField(row, CSV_HEADER_SYNONYMS.duration)));
    if (distanceKm <= 0 && durationMin <= 0) return null; // nothing meaningful recorded

    const sportRaw = findCsvField(row, CSV_HEADER_SYNONYMS.sport) || 'other';
    const sport = String(sportRaw).toLowerCase().replace(/\s+/g, '_'); // "Trail Running" -> "trail_running", to match the JSON export's naming style

    return {
      // WHY THIS ID SHAPE: Garmin's CSV export has no equivalent of the
      // JSON export's stable activityId -- there's simply no unique
      // identifier column at all. So instead we build a "fingerprint" out
      // of the activity's own content: same date + sport + distance +
      // duration is treated as the same activity, no matter which row
      // number it happens to land on. This specifically matters because
      // re-exporting an overlapping date range from Garmin (e.g.
      // "overshoot rather than undershoot" when you can't filter exactly)
      // will put the same real activity at a DIFFERENT row number each
      // time -- so an ID based on row position would fail to recognize it
      // as a duplicate, while this content-based ID correctly does.
      // The one edge case this can't handle: two genuinely different
      // activities with identical date, sport, distance, AND duration
      // would look identical and one would be silently dropped. Rare, but
      // a real limitation of not having a proper ID from Garmin.
      id: `csv-${date.toISOString().slice(0, 10)}-${sport}-${distanceKm}-${durationMin}`,
      name: findCsvField(row, CSV_HEADER_SYNONYMS.name) || '',
      sport,
      date: date.toISOString().slice(0, 10),
      distanceKm: Math.round(distanceKm * 100) / 100,
      elevGainM: Math.round(toNumber(findCsvField(row, CSV_HEADER_SYNONYMS.elevGain))),
      durationMin,
      avgHr: findCsvField(row, CSV_HEADER_SYNONYMS.avgHr) ? Math.round(toNumber(findCsvField(row, CSV_HEADER_SYNONYMS.avgHr))) : null,
      maxHr: findCsvField(row, CSV_HEADER_SYNONYMS.maxHr) ? Math.round(toNumber(findCsvField(row, CSV_HEADER_SYNONYMS.maxHr))) : null,
    };
  }

  // Parses ONE CSV file's raw text. Returns a PROMISE (not a plain value
  // like parseFileText does) because PapaParse -- the library actually
  // splitting the CSV into rows -- does its work through a callback
  // (`complete`) rather than simply returning a result directly. Wrapping
  // that callback in a `new Promise(...)` lets the rest of our code use
  // the same `await JCParser.parseCsvText(...)` style everywhere, instead
  // of needing different handling for the CSV path versus the JSON path.
  function parseCsvText(rawText) {
    return new Promise((resolve) => {
      Papa.parse(rawText, {
        header: true,        // treat the first row as column names rather than data
        skipEmptyLines: true, // ignore blank trailing lines some exports include
        complete: (results) => {
          if (!results.data.length) {
            resolve({ activities: [], error: 'CSV parsed but contained no rows.' });
            return;
          }
          const activities = results.data
            .map(row => normalizeCsvRow(row))
            .filter(Boolean); // .filter(Boolean) drops every `null` from the array -- a common shorthand for "keep only the truthy values"

          if (!activities.length) {
            // Every row failed to match expected columns -- almost always
            // means this is the WRONG kind of export (e.g. a single
            // activity's lap/splits file instead of the activities list).
            // Reporting the actual column names we saw is what let us
            // diagnose that exact mixup with your real files.
            resolve({
              activities: [],
              error: `Found ${results.data.length} row(s) but couldn't match expected columns. Columns seen: ${Object.keys(results.data[0]).join(', ')}. Paste one real row and we'll fix the mapping.`,
            });
            return;
          }
          resolve({ activities, error: null });
        },
        error: (err) => resolve({ activities: [], error: 'Could not parse CSV: ' + err.message }),
      });
    });
  }

  // --------------------------------------------------------------------
  // PART 3: merging new activities into the existing stored list
  // --------------------------------------------------------------------

  // Combines a NEW batch of activities into an EXISTING list, treating any
  // activity with a matching `id` as "the same activity" rather than a
  // duplicate to add. This is what makes re-importing the same export (or
  // an overlapping one) completely safe.
  function dedupeMerge(existing, incoming) {
    // A `Map` here works like a dictionary/lookup table: `.set(key, value)`
    // stores something under a key, and looking the same key up again
    // OVERWRITES whatever was there before rather than creating a second
    // entry. Building one from the EXISTING activities first, keyed by
    // `id`, means that when we then also `.set()` each incoming activity
    // by its `id`, any that share an id with something already in the
    // list simply replace it in place -- no duplicates possible.
    const map = new Map(existing.map(a => [a.id, a]));

    let added = 0, updated = 0;
    incoming.forEach(a => {
      if (map.has(a.id)) updated++; else added++;
      map.set(a.id, a);
    });

    // Array.from(map.values()) turns the Map's values back into a plain
    // array; .sort(...) then puts them back in date order (Maps don't
    // guarantee any particular order once you've mixed inserts and
    // overwrites the way we just did).
    const merged = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
    return { merged, added, updated };
  }

  // Only these five functions are visible outside this file -- everything
  // else above (findCsvField, toNumber, parseDurationText, the synonym
  // tables) is an internal implementation detail that the rest of the app
  // never needs to touch directly.
  return { normalizeActivity, parseFileText, parseCsvText, dedupeMerge };
})();
