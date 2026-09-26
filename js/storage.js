// ============================================================================
// storage.js
// ============================================================================
// Every single read or write to localStorage in the whole app happens
// through this file, and nowhere else. Why bother with that discipline for
// something as small as "save a value, read a value"?
//
//   1. localStorage can THROW an error (e.g. the browser's storage quota is
//      full, or the user is in a locked-down privacy mode). If every part
//      of the app called localStorage directly, every part of the app would
//      need its own try/catch around it. Instead, we wrap it once, here,
//      and everywhere else in the app just calls JCStore.getActivities()
//      and trusts it to never throw.
//
//   2. localStorage ONLY stores strings. Our actual data (an array of
//      activity objects, a settings object) is not a string -- so every
//      write needs JSON.stringify() and every read needs JSON.parse().
//      Centralizing that means the rest of the app deals in real
//      JavaScript objects and arrays, never raw strings.
//
//   3. If we ever needed to change WHERE this data lives (say, syncing to
//      a real server one day instead of just this browser), this is the
//      only file that would need to change. Nothing else in the app knows
//      or cares that localStorage is the thing being used underneath.
//
// "JCStore" -- the "JC" prefix (short for "Judgement Center") on this and
// the other module names (JCParser, JCPlan, JCCharts) is just a convention
// to avoid these names accidentally colliding with some other script's
// globals. Since every file here is loaded as a plain <script> tag rather
// than through a module system, everything defined at the top level shares
// one global namespace -- prefixing is how you keep that tidy by hand.
// ============================================================================

const JCStore = (() => {
  // This whole file is wrapped in an IIFE -- an "Immediately Invoked
  // Function Expression": `(() => { ... })()`. The `()` at the very end is
  // what makes it run immediately, right where it's defined, rather than
  // needing to be called later. Its purpose here: everything declared
  // INSIDE it (like the KEYS object and the get/set helper functions
  // below) is private -- invisible from outside this file. The only thing
  // that becomes visible to the rest of the app is whatever this function
  // explicitly `return`s at the bottom: the small set of named methods
  // like getActivities/setActivities. This is how you get the equivalent
  // of "public" and "private" in a language that doesn't have those
  // keywords built in.

  // Every distinct thing we store gets its own key (its own "slot") in
  // localStorage. Keeping them all listed in one place here means if you
  // ever rename one, there's exactly one place to change it.
  const KEYS = {
    activities: 'jc_activities',           // the array of every imported/manual activity
    settings: 'jc_settings',               // race date + distance choice
    planOverrides: 'jc_plan_overrides',    // any hand-edited week targets in the training plan
    lastTab: 'jc_last_tab',                // which tab was open, so a refresh restores it
  };

  // Reads one key back out of localStorage and parses it from JSON.
  // `fallback` is what gets returned if the key has never been set before
  // (e.g. the very first time the app is ever opened) OR if something goes
  // wrong reading/parsing it -- callers never have to handle "null" or
  // "throws an error" themselves, they always get back something usable.
  function get(key, fallback) {
    try {
      const raw = localStorage.getItem(key); // returns a string, or null if the key doesn't exist
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      // Two realistic ways this can fail: localStorage.getItem() itself
      // can throw in some locked-down privacy modes, or JSON.parse() can
      // throw if the stored string is somehow corrupted. Either way, we
      // don't want the WHOLE APP to crash because of it -- log it for
      // debugging and hand back the safe fallback instead.
      console.error('JCStore read failed:', key, e);
      return fallback;
    }
  }

  // Writes one value into localStorage, converting it to a JSON string
  // first (since localStorage can only hold strings). Returns true/false
  // so a caller COULD check whether the write actually succeeded, though
  // in this app we mostly don't bother -- a failed save here just means
  // the browser's storage is unusually full, which is rare and not
  // something the user can do much about anyway.
  function set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('JCStore write failed:', key, e);
      return false;
    }
  }

  // This is the object the rest of the app actually sees. Each property is
  // a small function using JavaScript's "arrow function" shorthand:
  // `() => get(KEYS.activities, [])` is exactly equivalent to writing
  // `function() { return get(KEYS.activities, []); }`, just shorter.
  return {
    getActivities: () => get(KEYS.activities, []),      // [] = if nothing saved yet, act like an empty list
    setActivities: (list) => set(KEYS.activities, list),

    // if settings have never been saved, default to the Karwendelmarsch
    // full distance with its usual race date -- a sensible starting point
    // rather than forcing the user to configure everything before the app
    // shows anything useful
    getSettings: () => get(KEYS.settings, { raceDate: '2027-08-28', raceDistance: '52' }),
    setSettings: (s) => set(KEYS.settings, s),

    // {} = if no weeks have ever been hand-edited, act like an empty set of overrides
    getPlanOverrides: () => get(KEYS.planOverrides, {}),
    setPlanOverrides: (o) => set(KEYS.planOverrides, o),

    // lastTab is a single plain string, not an object, so it doesn't need
    // JSON.stringify/parse -- localStorage can hold a plain string as-is.
    // That's why these two go straight to localStorage instead of using
    // the get()/set() helpers above (which assume JSON).
    getLastTab: () => localStorage.getItem(KEYS.lastTab),
    setLastTab: (tab) => localStorage.setItem(KEYS.lastTab, tab),

    // Used by the "Clear all imported data" button. Deliberately only
    // clears activities, not settings/planOverrides/lastTab -- clearing
    // your imported history shouldn't also reset your race date or which
    // tab you were on.
    clearActivities: () => {
      try {
        localStorage.removeItem(KEYS.activities);
        return true;
      } catch (e) {
        console.error('JCStore clear failed:', e);
        return false;
      }
    },
  };
})();
