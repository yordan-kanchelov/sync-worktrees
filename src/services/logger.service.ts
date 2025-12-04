export type LogLevel = "info" | "warn" | "error" | "debug";
export type LogOutputFn = (message: string, level: LogLevel) => void;

export interface LoggerOptions {
  repoName?: string;
  debug?: boolean;
  disableColors?: boolean;
  outputFn?: LogOutputFn;
}

export class Logger {
  private repoName?: string;
  private debugEnabled: boolean;
  private outputFn?: LogOutputFn;

  constructor(options: LoggerOptions = {}) {
    this.repoName = options.repoName;
    this.debugEnabled = options.debug ?? false;
    this.outputFn = options.outputFn;
  }

  private prefix(): string {
    return this.repoName ? `[${this.repoName}] ` : "";
  }

  debug(message: string, ...args: unknown[]): void {
    if (!this.debugEnabled) return;
    const formattedMessage = this.prefix() + this.formatMessage(message, args);
    if (this.outputFn) {
      this.outputFn(formattedMessage, "debug");
    } else {
      console.log(formattedMessage);
    }
  }

  info(message: string, ...args: unknown[]): void {
    const formattedMessage = this.prefix() + this.formatMessage(message, args);
    if (this.outputFn) {
      this.outputFn(formattedMessage, "info");
    } else {
      console.log(formattedMessage);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    const formattedMessage = this.prefix() + this.formatMessage(message, args);
    if (this.outputFn) {
      this.outputFn(formattedMessage, "warn");
    } else {
      console.warn(formattedMessage);
    }
  }

  error(message: string, error?: Error | unknown): void {
    let formattedMessage = this.prefix() + message;
    if (error instanceof Error) {
      formattedMessage += ` ${error.message}`;
    } else if (error) {
      formattedMessage += ` ${String(error)}`;
    }
    if (this.outputFn) {
      this.outputFn(formattedMessage, "error");
    } else {
      if (error instanceof Error) {
        console.error(this.prefix() + message, error);
      } else if (error) {
        console.error(this.prefix() + message, error);
      } else {
        console.error(this.prefix() + message);
      }
    }
  }

  table(content: string): void {
    const formattedMessage = "\n" + content + "\n";
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
}
