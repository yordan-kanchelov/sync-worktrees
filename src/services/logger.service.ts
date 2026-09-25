import { inspect, stripVTControlCharacters } from "util";

import { summarizeExpectedError } from "../utils/error-summary";
import { redactSecretsInText } from "../utils/git-url";
import { colorsEnabled } from "../utils/terminal";

export type LogLevel = "info" | "warn" | "error" | "debug";
export type LogOutputFn = (message: string, level: LogLevel) => void;

export interface LoggerOptions {
  repoName?: string;
  debug?: boolean;
  /** Strip ANSI sequences (e.g. from hook output). Defaults to on when stdout
   * is not a terminal or `NO_COLOR` is set; see {@link colorsEnabled}. */
  disableColors?: boolean;
  outputFn?: LogOutputFn;
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
  private disableColors: boolean;
  private outputFn?: LogOutputFn;

  constructor(options: LoggerOptions = {}) {
    this.repoName = options.repoName;
    this.debugEnabled = options.debug ?? false;
    this.disableColors = options.disableColors ?? !colorsEnabled();
    this.outputFn = options.outputFn;
  }

  private scrub(text: string): string {
    const redacted = redactSecretsInText(text);
    return this.disableColors ? stripVTControlCharacters(redacted) : redacted;
  }

  private prefix(): string {
    return this.repoName ? `[${this.repoName}] ` : "";
  }

  debug(message: string, ...args: unknown[]): void {
    if (!this.debugEnabled) return;
    const formattedMessage = this.scrub(this.prefix() + this.formatMessage(message, args));
    if (this.outputFn) {
      this.outputFn(formattedMessage, "debug");
    } else {
      console.log(formattedMessage);
    }
  }

  info(message: string, ...args: unknown[]): void {
    const formattedMessage = this.scrub(this.prefix() + this.formatMessage(message, args));
    if (this.outputFn) {
      this.outputFn(formattedMessage, "info");
    } else {
      console.log(formattedMessage);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    const formattedMessage = this.scrub(this.prefix() + this.formatMessage(message, args));
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
    formattedMessage = this.scrub(formattedMessage);
    if (this.outputFn) {
      this.outputFn(formattedMessage, "error");
    } else if (error) {
      // console.error(message, error) would hand the raw value to util.inspect,
      // whose output (message, stack, simple-git's `task.commands`, ...) can
      // carry a credential-bearing URL. Inspect it here so it can be scrubbed.
      // A git or typed failure is one line unless debug asks for everything.
      const summary = this.debugEnabled ? null : summarizeExpectedError(error);
      const detail = summary ?? (typeof error === "string" ? error : inspect(error));
      console.error(this.scrub(`${this.prefix()}${message} ${detail}`));
    } else {
      console.error(this.scrub(this.prefix() + message));
    }
  }

  table(content: string): void {
    const formattedMessage = this.scrub("\n" + content + "\n");
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

  static createDefault(repoName?: string, debug?: boolean): Logger {
    return new Logger({ repoName, debug });
  }

  withPassthrough(passthrough: LogOutputFn): Logger {
    const upstream = this.outputFn;
    return new Logger({
      repoName: this.repoName,
      debug: this.debugEnabled,
      disableColors: this.disableColors,
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
