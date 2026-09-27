// Bridge between the React UI and the CLI sidecar. Under Tauri this is the
// pty; in a plain browser (vite dev) a scripted mock stands in so the UI can
// be previewed without the native shell.

export type Line = string;
export type Listener = (line: Line) => void;

export interface Transport {
  send(cmd: object): Promise<void>;
  subscribe(cb: Listener): Promise<() => void>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriTransport(): Promise<Transport> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return {
    send: (cmd) => invoke("pty_write", { data: JSON.stringify(cmd) + "\n" }),
    subscribe: async (cb) => {
      let buf = "";
      const dec = new TextDecoder();
      const un = await listen<number[]>("pty-out", (e) => {
        buf += dec.decode(new Uint8Array(e.payload), { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) cb(line);
        }
      });
      return un;
    },
    ready: () => invoke("ui_ready"),
    close: () => getCurrentWindow().close(),
  };
}

export const transport: Promise<Transport> =
  isTauri || !import.meta.env.DEV
    ? tauriTransport()
    : import("./mock").then((m) => m.mockTransport());
