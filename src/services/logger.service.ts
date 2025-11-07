export interface LoggerOptions {
  repoName?: string;
  debug?: boolean;
  disableColors?: boolean;
}

export class Logger {
  private repoName?: string;
  private debugEnabled: boolean;

  constructor(options: LoggerOptions = {}) {
    this.repoName = options.repoName;
    this.debugEnabled = options.debug ?? false;
  }

  private prefix(): string {
    return this.repoName ? `[${this.repoName}] ` : "";
  }

  debug(message: string, ...args: unknown[]): void {
    if (!this.debugEnabled) return;
    console.log(this.prefix() + this.formatMessage(message, args));
  }

  info(message: string, ...args: unknown[]): void {
    console.log(this.prefix() + this.formatMessage(message, args));
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(this.prefix() + this.formatMessage(message, args));
  }

  error(message: string, error?: Error | unknown): void {
    if (error instanceof Error) {
      console.error(this.prefix() + message, error);
    } else if (error) {
      console.error(this.prefix() + message, error);
    } else {
      console.error(this.prefix() + message);
    }
  }

  table(content: string): void {
    console.log("\n" + content + "\n");
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
