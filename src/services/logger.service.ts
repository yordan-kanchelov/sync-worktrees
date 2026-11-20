import { inspect, stripVTControlCharacters } from "util";

import { summarizeExpectedError } from "../utils/error-summary";
import { redactSecretsInText } from "../utils/git-url";
import { colorsEnabled } from "../utils/terminal";

export type LogLevel = "info" | "warn" | "error" | "debug";
export type LogOutputFn = (message: string, level: LogLevel) => void;

export interface LoggerOptions {
  repoName?: string;
  debug?: boolean;
  disableColors?: boolean;
  outputFn?: LogOutputFn;
  quiet?: boolean;
}

export class Logger {
  private repoName?: string;
  private debugEnabled: boolean;
  private disableColors: boolean;
  private outputFn?: LogOutputFn;
  private quiet: boolean;

  constructor(options: LoggerOptions = {}) {
    this.repoName = options.repoName;
    this.debugEnabled = options.debug ?? false;
    this.disableColors = options.disableColors ?? !colorsEnabled();
    this.outputFn = options.outputFn;
    this.quiet = options.quiet ?? false;
  }

  private scrub(text: string): string {
    const redacted = redactSecretsInText(text);
    return this.disableColors ? stripVTControlCharacters(redacted) : redacted;
  }

  private prefix(): string {
    return this.repoName ? `[${this.repoName}] ` : "";
  }

  debug(message: string): void {
    if (!this.debugEnabled || this.quiet) return;
    const formattedMessage = this.scrub(this.prefix() + message);
    if (this.outputFn) {
      this.outputFn(formattedMessage, "debug");
    } else {
      console.log(formattedMessage);
    }
  }

  info(message: string): void {
    if (this.quiet) return;
    const formattedMessage = this.scrub(this.prefix() + message);
    if (this.outputFn) {
      this.outputFn(formattedMessage, "info");
    } else {
      console.log(formattedMessage);
    }
  }

  warn(message: string): void {
    const formattedMessage = this.scrub(this.prefix() + message);
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
      const summary = this.debugEnabled ? null : summarizeExpectedError(error);
      const detail = summary ?? (typeof error === "string" ? error : inspect(error));
      console.error(this.scrub(`${this.prefix()}${message} ${detail}`));
    } else {
      console.error(this.scrub(this.prefix() + message));
    }
  }

  table(content: string): void {
    if (this.quiet) return;
    const formattedMessage = this.scrub("\n" + content + "\n");
    if (this.outputFn) {
      this.outputFn(formattedMessage, "info");
    } else {
      console.log(formattedMessage);
    }
  }

  static createDefault(repoName?: string, debug?: boolean, options: { quiet?: boolean } = {}): Logger {
    return new Logger({ repoName, debug, quiet: options.quiet });
  }
}
