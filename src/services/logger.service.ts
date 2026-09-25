import { inspect } from "util";

import { redactSecretsInText } from "../utils/git-url";

export type LogLevel = "info" | "warn" | "error" | "debug";
export type LogOutputFn = (message: string, level: LogLevel) => void;

export interface LoggerOptions {
  repoName?: string;
  debug?: boolean;
  disableColors?: boolean;
  outputFn?: LogOutputFn;
  /**
   * `--quiet`: drop info, debug and table output so only warnings and errors
   * get through. For one-shot runs under cron, where every stdout line is mail.
   */
  quiet?: boolean;
}

/**
 * Every line leaves through {@link redactSecretsInText}: repository URLs with
 * embedded credentials (`https://user:token@host/...`) are common in CI and
 * show up in clone/fetch messages, git's own error text and the run banner,
 * so the logger scrubs them centrally instead of trusting each call site.
 */
export class Logger {
  private repoName?: string;
  private debugEnabled: boolean;
  private outputFn?: LogOutputFn;
  private quiet: boolean;

  constructor(options: LoggerOptions = {}) {
    this.repoName = options.repoName;
    this.debugEnabled = options.debug ?? false;
    this.outputFn = options.outputFn;
    this.quiet = options.quiet ?? false;
  }

  private prefix(): string {
    return this.repoName ? `[${this.repoName}] ` : "";
  }

  debug(message: string, ...args: unknown[]): void {
    if (!this.debugEnabled || this.quiet) return;
    const formattedMessage = redactSecretsInText(this.prefix() + this.formatMessage(message, args));
    if (this.outputFn) {
      this.outputFn(formattedMessage, "debug");
    } else {
      console.log(formattedMessage);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.quiet) return;
    const formattedMessage = redactSecretsInText(this.prefix() + this.formatMessage(message, args));
    if (this.outputFn) {
      this.outputFn(formattedMessage, "info");
    } else {
      console.log(formattedMessage);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    const formattedMessage = redactSecretsInText(this.prefix() + this.formatMessage(message, args));
    if (this.outputFn) {
      this.outputFn(formattedMessage, "warn");
    } else {
      console.warn(formattedMessage);
    }
  }

  error(message: string, error?: unknown): void {
    let formattedMessage = this.prefix() + message;
    if (error instanceof Error) {
      formattedMessage += ` ${error.message}`;
    } else if (error) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- non-Error values are logged in their default string form
      formattedMessage += ` ${String(error)}`;
    }
    formattedMessage = redactSecretsInText(formattedMessage);
    if (this.outputFn) {
      this.outputFn(formattedMessage, "error");
    } else if (error) {
      // console.error(message, error) would hand the raw value to util.inspect,
      // whose output (message, stack, simple-git's `task.commands`, ...) can
      // carry a credential-bearing URL. Inspect it here so it can be scrubbed.
      const detail = typeof error === "string" ? error : inspect(error);
      console.error(redactSecretsInText(`${this.prefix()}${message} ${detail}`));
    } else {
      console.error(redactSecretsInText(this.prefix() + message));
    }
  }

  table(content: string): void {
    if (this.quiet) return;
    const formattedMessage = redactSecretsInText("\n" + content + "\n");
    if (this.outputFn) {
      this.outputFn(formattedMessage, "info");
    } else {
      console.log(formattedMessage);
    }
  }

  private formatMessage(message: string, args: unknown[]): string {
    if (args.length === 0) {
      return message;
    }

    return args.reduce((msg, arg) => (msg as string).replace("%s", String(arg)), message) as string;
  }

  static createDefault(repoName?: string, debug?: boolean, options: { quiet?: boolean } = {}): Logger {
    return new Logger({ repoName, debug, quiet: options.quiet });
  }

  withPassthrough(passthrough: LogOutputFn): Logger {
    const upstream = this.outputFn;
    return new Logger({
      repoName: this.repoName,
      debug: this.debugEnabled,
      quiet: this.quiet,
      outputFn: (msg: string, level: LogLevel): void => {
        if (upstream) {
          upstream(msg, level);
        } else {
          defaultConsoleOutput(msg, level);
        }
        try {
          passthrough(msg, level);
        } catch {
          // swallow - passthrough must never break primary logging
        }
      },
    });
  }
}

function defaultConsoleOutput(msg: string, level: LogLevel): void {
  if (level === "warn") console.warn(msg);
  else if (level === "error") console.error(msg);
  else console.log(msg);
}
