'use strict';

// Main-process polling is not throttled when the popover is hidden. This only
// reads local profiles; server fetching remains on its separate schedule.
function startLocalRefresh(refresh, timers = globalThis) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await refresh(); }
    catch { /* A transient read failure must not stop subsequent polling. */ }
    finally { busy = false; }
  };
  const timer = timers.setInterval(tick, 30 * 1000);
  tick();
  return () => timers.clearInterval(timer);
}

module.exports = { startLocalRefresh };
