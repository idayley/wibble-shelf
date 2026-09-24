// claude-usage/main.js
//
// Claude's usage limits as two pills over the canvas: the same numbers
// Claude Code's own status line shows. How much of the five-hour window
// and of the week is used, and when each one resets.
//
// THE LAST READING IS KEPT. Claude Code reports usage about once a turn,
// so right after a launch nothing has arrived yet. Rather than an empty
// panel until the first turn ends, it shows what it knew last time, and
// a window whose reset time has passed shows as reset, not as stale.

export async function activate(wibble) {
  const KEY = "last";
  const ALERT_AT = 0.8;

  let last = await wibble.storage.get(KEY);

  wibble.stream.on("usage", async (event) => {
    // Other engines have their own limits, and this panel is Claude's.
    if (event.engine !== "claude") return;
    last = {
      fiveHour: event.fiveHour ?? (last && last.fiveHour),
      sevenDay: event.sevenDay ?? (last && last.sevenDay),
    };
    await wibble.storage.set(KEY, last);
    await draw();
  });

  function bar(key, label, window, when) {
    if (!window) return null;
    const reset = window.resetsAt > 0 && window.resetsAt <= Date.now();
    const used = reset ? 0 : window.used;
    const pct = Math.round(used * 100) + "%";
    const detail = reset ? "reset" : window.resetsAt > 0 ? pct + " · resets " + when(window.resetsAt) : pct;
    return { kind: "bar", key, label, value: used, detail, tone: used >= ALERT_AT ? "alert" : "normal" };
  }

  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (ms) => new Date(ms).toLocaleDateString([], { weekday: "short" });

  function draw() {
    const bars = last
      ? [bar("five", "5h", last.fiveHour, time), bar("week", "7d", last.sevenDay, day)].filter(Boolean)
      : [];
    return wibble.panel.set("Claude usage", {
      kind: "stack",
      gap: 8,
      children: bars.length ? bars : [{ kind: "text", key: "empty", content: "Claude usage", tone: "faint" }],
    });
  }

  await draw();
}
