export const PROMPT_CANCELLED = "PROMPT_CANCELLED" as const;

/** Raised when a person deliberately leaves an onboarding prompt. */
export class PromptCancelledError extends Error {
  readonly code = PROMPT_CANCELLED;

  constructor(message = "Setup cancelled.") {
    super(message);
    this.name = "PromptCancelledError";
  }
}

export function isPromptCancelled(error: unknown): error is PromptCancelledError {
  return error instanceof PromptCancelledError
    || (typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === PROMPT_CANCELLED);
}

export interface PromptOption<T> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean | string;
}

export interface SelectPromptOptions<T> {
  message: string;
  options: readonly PromptOption<T>[];
  /** Choice highlighted when the prompt first opens. */
  initialValue?: T;
  /** Choice used for an empty answer in the numbered fallback. */
  defaultValue?: T;
}

export interface ConfirmPromptOptions {
  message: string;
  initialValue?: boolean;
}

export type TextValidationResult = string | undefined | null | false;

export interface TextPromptOptions {
  message: string;
  initialValue?: string;
  placeholder?: string;
  sensitive?: boolean;
  validate?: (value: string) => TextValidationResult | Promise<TextValidationResult>;
}

export interface PromptProgress {
  readonly isActive: boolean;
  update(message: string): void;
  succeed(message?: string): void;
  fail(message?: string): void;
  stop(message?: string): void;
}

export interface PromptInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export interface PromptOutput extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
}

export interface TerminalPrompterOptions {
  input?: PromptInput;
  output?: PromptOutput;
  /** Force ANSI styling on or off. By default it follows the output TTY. */
  color?: boolean;
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  inverse: "\u001b[7m",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
  eraseLine: "\u001b[2K",
  eraseDown: "\u001b[0J",
} as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const CANCEL_WORDS = new Set(["0", "q", "quit", "cancel", "exit"]);

function chunksToText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return String(chunk);
}

function optionIsEnabled<T>(option: PromptOption<T>): boolean {
  return option.disabled !== true && typeof option.disabled !== "string";
}

function valuesMatch<T>(left: T, right: T | undefined): boolean {
  return right !== undefined && Object.is(left, right);
}

/**
 * Small dependency-free prompt adapter for the onboarding state machine.
 *
 * Real terminals get arrow-key navigation. Redirected/piped input gets a
 * deterministic numbered interface suitable for installers and tests.
 */
export class TerminalPrompter {
  readonly input: PromptInput;
  readonly output: PromptOutput;

  private readonly useColor: boolean;
  private fallbackReader: FallbackLineReader | undefined;
  private closed = false;

  constructor(options: TerminalPrompterOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.useColor = options.color
      ?? Boolean(this.output.isTTY && process.env.NO_COLOR === undefined);
  }

  intro(title: string, subtitle?: string): void {
    this.assertOpen();
    const edge = this.paint("cyan", "◆");
    this.write(`\n${edge} ${this.paint("bold", title)}\n`);
    if (subtitle) this.write(`  ${this.paint("dim", subtitle)}\n`);
    this.write("\n");
  }

  note(message: string, title?: string): void {
    this.assertOpen();
    if (title) this.write(`${this.paint("cyan", "◇")} ${this.paint("bold", title)}\n`);
    for (const line of message.split("\n")) this.write(`  ${line}\n`);
    this.write("\n");
  }

  outro(message: string): void {
    this.assertOpen();
    this.write(`\n${this.paint("green", "◆")} ${this.paint("bold", message)}\n\n`);
  }

  async select<T>(prompt: SelectPromptOptions<T>): Promise<T> {
    this.assertOpen();
    this.validateSelect(prompt);
    return this.supportsInteractiveSelection()
      ? this.selectInteractive(prompt)
      : this.selectNumbered(prompt);
  }

  async confirm(prompt: ConfirmPromptOptions): Promise<boolean> {
    return this.select<boolean>({
      message: prompt.message,
      options: [
        { value: true, label: "Yes" },
        { value: false, label: "No" },
      ],
      initialValue: prompt.initialValue ?? true,
      defaultValue: prompt.initialValue ?? true,
    });
  }

  async text(prompt: TextPromptOptions): Promise<string> {
    this.assertOpen();
    let initialValue = prompt.initialValue ?? "";

    while (true) {
      const value = this.supportsRawInput()
        ? await this.textInteractive({ ...prompt, initialValue })
        : await this.textNumbered({ ...prompt, initialValue });
      const validationError = await prompt.validate?.(value);
      if (!validationError) return value;

      this.write(`${this.paint("yellow", "!")} ${validationError}\n`);
      initialValue = value;
    }
  }

  progress(message: string): PromptProgress {
    this.assertOpen();
    return new TerminalProgress(this, message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fallbackReader?.close();
    this.fallbackReader = undefined;
  }

  dispose(): void {
    this.close();
  }

  /** @internal Used by the dependency-free progress renderer. */
  progressWrite(value: string): void {
    this.write(value);
  }

  /** @internal Used by the dependency-free progress renderer. */
  progressPaint(style: keyof typeof ANSI, value: string): string {
    return this.paint(style, value);
  }

  /** @internal Used by the dependency-free progress renderer. */
  progressIsInteractive(): boolean {
    return Boolean(this.output.isTTY);
  }

  private async selectInteractive<T>(prompt: SelectPromptOptions<T>): Promise<T> {
    const enabledIndices = prompt.options
      .map((option, index) => optionIsEnabled(option) ? index : -1)
      .filter((index) => index >= 0);
    let selectedIndex = this.findChoiceIndex(prompt.options, prompt.initialValue)
      ?? this.findChoiceIndex(prompt.options, prompt.defaultValue)
      ?? enabledIndices[0]!;
    let renderedLineCount = 0;

    const render = () => {
      if (renderedLineCount > 0) this.clearBlock(renderedLineCount);
      const lines = [
        `${this.paint("cyan", "?")} ${this.paint("bold", prompt.message)}`,
        ...prompt.options.map((option, index) => this.renderOption(option, index === selectedIndex)),
        this.paint("dim", "  Use ↑/↓ and Enter · Esc to cancel"),
      ];
      renderedLineCount = lines.length;
      this.write(lines.join("\n"));
    };

    render();

    try {
      const selected = await this.withRawInput<T>(() => new Promise<T>((resolve, reject) => {
        const cleanup = () => {
          this.input.removeListener("data", onData);
          this.input.removeListener("error", onError);
          this.input.removeListener("end", onEnd);
        };
        const finish = (value: T) => {
          cleanup();
          resolve(value);
        };
        const cancel = () => {
          cleanup();
          reject(new PromptCancelledError());
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onEnd = () => cancel();
        const move = (amount: number) => {
          const currentPosition = enabledIndices.indexOf(selectedIndex);
          const nextPosition = (currentPosition + amount + enabledIndices.length) % enabledIndices.length;
          selectedIndex = enabledIndices[nextPosition]!;
          render();
        };
        const onData = (chunk: unknown) => {
          const key = chunksToText(chunk);
          if (key.includes("\u0003") || key.includes("\u0004")) {
            cancel();
            return;
          }
          if (key === "\u001b") {
            cancel();
            return;
          }
          if (key.includes("\u001b[A")) {
            move(-1);
            return;
          }
          if (key.includes("\u001b[B")) {
            move(1);
            return;
          }
          if (key === "k") {
            move(-1);
            return;
          }
          if (key === "j") {
            move(1);
            return;
          }
          if (key.includes("\r") || key.includes("\n")) {
            finish(prompt.options[selectedIndex]!.value);
            return;
          }
          if (/^[1-9]$/.test(key)) {
            const numericIndex = Number(key) - 1;
            const option = prompt.options[numericIndex];
            if (option && optionIsEnabled(option)) {
              selectedIndex = numericIndex;
              render();
            }
          }
        };

        this.input.on("data", onData);
        this.input.once("error", onError);
        this.input.once("end", onEnd);
      }));

      this.clearBlock(renderedLineCount);
      const selectedOption = prompt.options.find((option) => Object.is(option.value, selected));
      this.write(`${this.paint("green", "✓")} ${prompt.message} ${this.paint("dim", selectedOption?.label ?? "Selected")}\n`);
      return selected;
    } catch (error) {
      this.clearBlock(renderedLineCount);
      this.write(`${this.paint("dim", "—")} ${prompt.message}\n`);
      throw error;
    }
  }

  private async selectNumbered<T>(prompt: SelectPromptOptions<T>): Promise<T> {
    this.fallbackReader ??= new FallbackLineReader(this.input, this.output);
    const enabled = prompt.options
      .map((option, originalIndex) => ({ option, originalIndex }))
      .filter(({ option }) => optionIsEnabled(option));
    const fallback = this.findChoice(prompt.options, prompt.defaultValue)
      ?? this.findChoice(prompt.options, prompt.initialValue)
      ?? enabled[0]!.option;
    const defaultNumber = enabled.findIndex(({ option }) => Object.is(option.value, fallback.value)) + 1;

    this.write(`${this.paint("cyan", "?")} ${prompt.message}\n`);
    for (const [index, { option }] of enabled.entries()) {
      const hint = option.hint ? ` ${this.paint("dim", `— ${option.hint}`)}` : "";
      const defaultMarker = Object.is(option.value, fallback.value) ? this.paint("dim", " (default)") : "";
      this.write(`  ${index + 1}) ${option.label}${hint}${defaultMarker}\n`);
    }
    for (const option of prompt.options.filter((candidate) => !optionIsEnabled(candidate))) {
      const reason = typeof option.disabled === "string" ? ` — ${option.disabled}` : "";
      this.write(`  -  ${this.paint("dim", `${option.label}${reason}`)}\n`);
    }
    this.write(`  0) ${this.paint("dim", "Cancel")}\n`);

    while (true) {
      const answer = (await this.readFallbackLine(`Choose [${defaultNumber}]: `)).trim().toLowerCase();
      if (CANCEL_WORDS.has(answer)) throw new PromptCancelledError();
      if (answer === "") return fallback.value;

      const number = Number.parseInt(answer, 10);
      if (Number.isInteger(number) && number >= 1 && number <= enabled.length) {
        return enabled[number - 1]!.option.value;
      }
      this.write(`${this.paint("yellow", "!")} Enter a number from 1 to ${enabled.length}, or 0 to cancel.\n`);
    }
  }

  private async textInteractive(prompt: TextPromptOptions): Promise<string> {
    let value = prompt.initialValue ?? "";
    let rendered = false;

    const displayValue = () => {
      if (value.length > 0) {
        return prompt.sensitive ? "•".repeat(Array.from(value).length) : value;
      }
      return prompt.placeholder ? this.paint("dim", prompt.placeholder) : "";
    };
    const render = () => {
      if (rendered) this.write(`\r${this.output.isTTY ? ANSI.eraseLine : ""}`);
      this.write(`${this.paint("cyan", "?")} ${prompt.message} ${displayValue()}`);
      rendered = true;
    };

    render();

    try {
      const answer = await this.withRawInput<string>(() => new Promise<string>((resolve, reject) => {
        const cleanup = () => {
          this.input.removeListener("data", onData);
          this.input.removeListener("error", onError);
          this.input.removeListener("end", onEnd);
        };
        const finish = () => {
          cleanup();
          resolve(value);
        };
        const cancel = () => {
          cleanup();
          reject(new PromptCancelledError());
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onEnd = () => cancel();
        const onData = (chunk: unknown) => {
          const text = chunksToText(chunk);
          if (text.includes("\u0003") || text.includes("\u0004") || text === "\u001b") {
            cancel();
            return;
          }
          if (text === "\u007f" || text === "\b") {
            value = Array.from(value).slice(0, -1).join("");
            render();
            return;
          }
          if (text.includes("\u0015")) {
            value = "";
            render();
            return;
          }
          if (text.includes("\r") || text.includes("\n")) {
            const beforeNewline = text.split(/[\r\n]/u, 1)[0];
            if (beforeNewline) value += this.printableText(beforeNewline);
            finish();
            return;
          }
          if (text.startsWith("\u001b[")) return;
          value += this.printableText(text);
          render();
        };

        this.input.on("data", onData);
        this.input.once("error", onError);
        this.input.once("end", onEnd);
      }));

      this.write("\n");
      return answer;
    } catch (error) {
      this.write("\n");
      throw error;
    }
  }

  private async textNumbered(prompt: TextPromptOptions): Promise<string> {
    this.fallbackReader ??= new FallbackLineReader(this.input, this.output);
    const suffix = prompt.initialValue && !prompt.sensitive
      ? ` [${prompt.initialValue}]`
      : prompt.placeholder
        ? ` ${this.paint("dim", `(${prompt.placeholder})`)}`
        : "";
    const answer = await this.readFallbackLine(`${this.paint("cyan", "?")} ${prompt.message}${suffix}: `);
    const normalized = answer.trim();
    if (CANCEL_WORDS.has(normalized.toLowerCase())) throw new PromptCancelledError();
    return answer === "" ? (prompt.initialValue ?? "") : answer;
  }

  private async readFallbackLine(query: string): Promise<string> {
    if (!this.fallbackReader) {
      this.fallbackReader = new FallbackLineReader(this.input, this.output);
    }

    try {
      return await this.fallbackReader.readLine(query);
    } catch (error) {
      if (isPromptCancelled(error)) throw error;
      throw new PromptCancelledError("Input closed before setup was finished.");
    }
  }

  private async withRawInput<T>(operation: () => Promise<T>): Promise<T> {
    const previousRawMode = this.input.isRaw ?? false;
    const wasPaused = this.input.isPaused();
    let changedRawMode = false;

    try {
      this.input.setRawMode?.(true);
      changedRawMode = true;
      this.input.resume();
      if (this.output.isTTY) this.write(ANSI.hideCursor);
      return await operation();
    } finally {
      try {
        if (changedRawMode) this.input.setRawMode?.(previousRawMode);
      } finally {
        try {
          if (this.output.isTTY) this.write(ANSI.showCursor);
        } finally {
          if (wasPaused) this.input.pause();
        }
      }
    }
  }

  private supportsRawInput(): boolean {
    return Boolean(this.input.isTTY && typeof this.input.setRawMode === "function");
  }

  private supportsInteractiveSelection(): boolean {
    return Boolean(this.output.isTTY && this.supportsRawInput());
  }

  private renderOption<T>(option: PromptOption<T>, selected: boolean): string {
    const disabled = !optionIsEnabled(option);
    const pointer = selected ? this.paint("cyan", "❯") : " ";
    const label = disabled
      ? this.paint("dim", option.label)
      : selected
        ? this.paint("inverse", ` ${option.label} `)
        : option.label;
    const hintText = option.hint
      ?? (typeof option.disabled === "string" ? option.disabled : undefined);
    const hint = hintText ? ` ${this.paint("dim", `— ${hintText}`)}` : "";
    return `  ${pointer} ${label}${hint}`;
  }

  private clearBlock(lineCount: number): void {
    if (!this.output.isTTY) return;
    const up = lineCount > 1 ? `\u001b[${lineCount - 1}A` : "";
    this.write(`\r${up}${ANSI.eraseDown}`);
  }

  private validateSelect<T>(prompt: SelectPromptOptions<T>): void {
    if (prompt.options.length === 0) throw new Error("A select prompt needs at least one option.");
    if (!prompt.options.some(optionIsEnabled)) throw new Error("A select prompt needs at least one enabled option.");
    const initial = this.findChoice(prompt.options, prompt.initialValue);
    if (prompt.initialValue !== undefined && (!initial || !optionIsEnabled(initial))) {
      throw new Error("The initial select value must match an enabled option.");
    }
    const fallback = this.findChoice(prompt.options, prompt.defaultValue);
    if (prompt.defaultValue !== undefined && (!fallback || !optionIsEnabled(fallback))) {
      throw new Error("The default select value must match an enabled option.");
    }
  }

  private findChoice<T>(options: readonly PromptOption<T>[], value: T | undefined): PromptOption<T> | undefined {
    return options.find((option) => valuesMatch(option.value, value));
  }

  private findChoiceIndex<T>(options: readonly PromptOption<T>[], value: T | undefined): number | undefined {
    const index = options.findIndex((option) => valuesMatch(option.value, value) && optionIsEnabled(option));
    return index >= 0 ? index : undefined;
  }

  private printableText(value: string): string {
    return Array.from(value)
      .filter((character) => character >= " " && character !== "\u007f")
      .join("");
  }

  private paint(style: keyof typeof ANSI, value: string): string {
    if (!this.useColor) return value;
    return `${ANSI[style]}${value}${ANSI.reset}`;
  }

  private write(value: string): void {
    this.output.write(value);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("This terminal prompter has already been closed.");
  }
}

interface PendingLine {
  resolve(value: string): void;
  reject(error: Error): void;
}

/** Keeps piped lines queued across a multi-step wizard. */
class FallbackLineReader {
  private readonly input: PromptInput;
  private readonly output: PromptOutput;
  private readonly lines: string[] = [];
  private readonly pending: PendingLine[] = [];
  private buffer = "";
  private ended = false;
  private closed = false;
  private failure: Error | undefined;

  constructor(input: PromptInput, output: PromptOutput) {
    this.input = input;
    this.output = output;
    input.on("data", this.onData);
    input.once("end", this.onEnd);
    input.once("error", this.onError);
    input.resume();
  }

  readLine(query: string): Promise<string> {
    this.output.write(query);
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended || this.closed) {
      return Promise.reject(new PromptCancelledError("Input closed before setup was finished."));
    }
    return new Promise<string>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    const cancellation = new PromptCancelledError("Input closed before setup was finished.");
    for (const waiter of this.pending.splice(0)) waiter.reject(cancellation);
    if (!this.ended) this.input.pause();
  }

  private readonly onData = (chunk: unknown) => {
    this.buffer += chunksToText(chunk);
    while (true) {
      const newline = /\r\n|\n|\r/u.exec(this.buffer);
      if (!newline || newline.index === undefined) break;
      this.lines.push(this.buffer.slice(0, newline.index));
      this.buffer = this.buffer.slice(newline.index + newline[0].length);
    }
    this.drain();
  };

  private readonly onEnd = () => {
    this.ended = true;
    if (this.buffer.length > 0) {
      this.lines.push(this.buffer);
      this.buffer = "";
    }
    this.detach();
    this.drain();
  };

  private readonly onError = (error: Error) => {
    this.failure = error;
    this.detach();
    this.drain();
  };

  private drain(): void {
    while (this.lines.length > 0 && this.pending.length > 0) {
      this.pending.shift()!.resolve(this.lines.shift()!);
    }
    if (this.failure) {
      for (const waiter of this.pending.splice(0)) waiter.reject(this.failure);
    } else if (this.ended && this.lines.length === 0) {
      const cancellation = new PromptCancelledError("Input closed before setup was finished.");
      for (const waiter of this.pending.splice(0)) waiter.reject(cancellation);
    }
  }

  private detach(): void {
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
    this.input.removeListener("error", this.onError);
  }
}

class TerminalProgress implements PromptProgress {
  private readonly prompter: TerminalPrompter;
  private active = true;
  private message: string;
  private frameIndex = 0;
  private readonly timer: NodeJS.Timeout | undefined;

  constructor(
    prompter: TerminalPrompter,
    message: string,
  ) {
    this.prompter = prompter;
    this.message = message;
    if (prompter.progressIsInteractive()) {
      this.render();
      this.timer = setInterval(() => {
        this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
        this.render();
      }, 80);
      this.timer.unref();
    } else {
      this.timer = undefined;
      prompter.progressWrite(`… ${message}\n`);
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  update(message: string): void {
    if (!this.active) return;
    this.message = message;
    if (this.prompter.progressIsInteractive()) this.render();
  }

  succeed(message = this.message): void {
    this.finish("green", "✓", message);
  }

  fail(message = this.message): void {
    this.finish("red", "✗", message);
  }

  stop(message = this.message): void {
    this.finish("dim", "—", message);
  }

  private render(): void {
    if (!this.active) return;
    const frame = this.prompter.progressPaint("cyan", SPINNER_FRAMES[this.frameIndex]!);
    this.prompter.progressWrite(`\r${ANSI.eraseLine}${frame} ${this.message}`);
  }

  private finish(style: keyof typeof ANSI, symbol: string, message: string): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    const prefix = this.prompter.progressIsInteractive() ? `\r${ANSI.eraseLine}` : "";
    this.prompter.progressWrite(`${prefix}${this.prompter.progressPaint(style, symbol)} ${message}\n`);
  }
}

export function createTerminalPrompter(options: TerminalPrompterOptions = {}): TerminalPrompter {
  return new TerminalPrompter(options);
}
