import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

const term = new Terminal({
  fontFamily: "'IBM Plex Mono', 'JetBrains Mono', Menlo, monospace",
  fontSize: 14,
  cursorBlink: true,
  theme: { background: "#0c0d13" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal")!);
fit.fit();

term.onData((d) => invoke("pty_write", { data: d }));
term.onResize(({ cols, rows }) => invoke("pty_resize", { cols, rows }));
window.addEventListener("resize", () => fit.fit());

listen<number[]>("pty-out", (e) => term.write(new Uint8Array(e.payload)));

// Sync the pty size once the frontend is up.
invoke("pty_resize", { cols: term.cols, rows: term.rows });
