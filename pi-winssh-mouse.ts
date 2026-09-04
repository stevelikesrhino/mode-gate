import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/*
 * Re-arm mouse reporting after ProcessTerminal.start() has:
 *   1. enabled raw mode
 *   2. enabled Windows virtual-terminal input
 *
 * 1000: button + wheel reporting
 * 1002: button-motion reporting
 * 1004: focus reporting
 * 1006: SGR mouse encoding
 *
 * 1003 is deliberately omitted. Pi normally enables it outside multiplexers,
 * but it is unnecessary for wheel scrolling and generates a report for every
 * pointer movement.
 */
const MOUSE_ON =
  "\x1b[?1000h" +
  "\x1b[?1002h" +
  "\x1b[?1004h" +
  "\x1b[?1006h";

function rearmMouse(): void {
  if (process.platform !== "win32") return;
  if (!process.env.SSH_CONNECTION && !process.env.SSH_TTY) return;

  process.stdout.write(MOUSE_ON);
}

export default function windowsSshMouseFix(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // session_start already runs after ui.start(); deferring once also avoids
    // interleaving the sequence with the current extension event dispatch.
    setImmediate(rearmMouse);
  });

  // Useful after an external editor, suspend/resume, or anything else that
  // restarts Pi's terminal lifecycle without starting a new session.
  pi.registerCommand("fix-mouse", {
    description: "Re-arm fullscreen mouse reporting over Windows SSH",
    handler: async (_args, ctx) => {
      rearmMouse();
      ctx.ui.notify("Fullscreen mouse reporting re-armed", "info");
    },
  });
}
