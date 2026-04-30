export type CleanupFn = (fast: boolean) => void | Promise<void>;

export interface SignalHandlerOptions {
  forceExitMs?: number;
  log?: (message: string) => void;
  exit?: (code: number) => void;
  process?: NodeJS.EventEmitter;
}

export interface SignalHandlerHandle {
  register: (fn: CleanupFn) => void;
  dispose: () => void;
}

export const DEFAULT_FORCE_EXIT_MS = 3000;

export function setupSignalHandlers(options: SignalHandlerOptions = {}): SignalHandlerHandle {
  const forceExitMs = options.forceExitMs ?? DEFAULT_FORCE_EXIT_MS;
  const log = options.log ?? ((msg: string): void => console.log(msg));
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const target = options.process ?? process;

  const cleanupFns: CleanupFn[] = [];
  let signalCount = 0;

  const handler = (signal: string): void => {
    signalCount += 1;
    if (signalCount >= 2) {
      log(`\nReceived second ${signal}, forcing exit.`);
      exit(130);
      return;
    }
    log(`\nReceived ${signal}, shutting down (Ctrl+C again to force exit)...`);

    const watchdog = setTimeout(() => {
      log(`\nShutdown took longer than ${forceExitMs}ms, forcing exit.`);
      exit(130);
    }, forceExitMs);
    if (typeof watchdog.unref === "function") {
      watchdog.unref();
    }

    void Promise.allSettled(cleanupFns.map((fn) => Promise.resolve().then(() => fn(true)))).then(() => {
      clearTimeout(watchdog);
      exit(0);
    });
  };

  const sigintListener = (): void => handler("SIGINT");
  const sigtermListener = (): void => handler("SIGTERM");

  target.on("SIGINT", sigintListener);
  target.on("SIGTERM", sigtermListener);

  return {
    register: (fn: CleanupFn): void => {
      cleanupFns.push(fn);
    },
    dispose: (): void => {
      target.removeListener("SIGINT", sigintListener);
      target.removeListener("SIGTERM", sigtermListener);
    },
  };
}
