/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {MarkupFormatOptions} from '@romejs/string-markup';
import {
  ProgressShape,
  RemoteReporterClientMessage,
  RemoteReporterReceiveMessage as RemoteReporterServerMessage,
  ReporterStream,
  ReporterDerivedStreams,
} from './types';
import {markupToAnsi, stripMarkupTags} from '@romejs/string-markup';
import {humanizeNumber, removeSuffix} from '@romejs/string-utils';
import {stripAnsi, splitAnsiLines} from '@romejs/string-ansi';
import Progress, {ProgressOptions} from './Progress';
import {interpolate} from './util';
import {formatAnsi, rightPad, escapes, hasAnsiColor} from '@romejs/string-ansi';
import format from '@romejs/pretty-format';
import stream = require('stream');
import {CWD_PATH} from '@romejs/path';
import {Event} from '@romejs/events';

type ListOptions = {
  reverse?: boolean;
  truncate?: number;
  ordered?: boolean;
};

type WrapperFactory = <T extends (...args: Array<any>) => any>(
  callback: T,
) => T;

export type ReporterOptions = {
  streams?: Array<ReporterStream>;
  programName?: string;
  hasClearScreen?: boolean;
  programVersion?: string;
  markupOptions?: MarkupFormatOptions;
  disabled?: boolean;
  verbose?: boolean;
  silent?: boolean;
  useRemoteProgressBars?: boolean;
  startTime?: number;
  wrapperFactory?: WrapperFactory;
};

export type LogOptions = {
  nonTTY?: string;
  noPrefix?: boolean;
  stderr?: boolean;
};

export type LogCategoryOptions = LogOptions & {
  prefix: string;
  format: (str: string) => string;
  suffix?: string;
};

let remoteProgressIdCounter = 0;

const INDENT = '  ';

type Stdout = stream.Writable & {
  isTTY?: boolean;
  columns?: number;
};

export default class Reporter {
  constructor(opts: ReporterOptions = {}) {
    this.programName =
      opts.programName === undefined ? 'rome' : opts.programName;
    this.programVersion = opts.programVersion;

    this.noProgress = process.env.CI === '1';
    this.isVerbose = Boolean(opts.verbose);

    this.silent = opts.silent === true;
    this.startTime = opts.startTime === undefined ? Date.now() : opts.startTime;
    this.hasClearScreen =
      opts.hasClearScreen === undefined ? true : opts.hasClearScreen;
    this.activeElements = new Set();
    this.indentLevel = 0;
    this.indentString = '';
    this.enabled = opts.disabled === true ? 0 : 1;
    this.markupOptions =
      opts.markupOptions === undefined ? {} : opts.markupOptions;
    this.hasSpacer = false;
    this.shouldRedirectOutToErr = false;

    this.wrapperFactory = opts.wrapperFactory;

    this.remoteClientProgressBars = new Map();
    this.remoteServerProgressBars = new Map();

    this.sendRemoteServerMessage = new Event({
      name: 'sendRemoteServerMessage',
    });
    this.sendRemoteClientMessage = new Event({
      name: 'sendRemoteClientMessage',
    });

    this.isRemote = opts.useRemoteProgressBars === true;

    this.outStreams = new Set();
    this.errStreams = new Set();
    this.streams = new Set();

    if (opts.streams !== undefined) {
      for (const stream of opts.streams) {
        this.addStream(stream);
      }
    }
  }

  static DEFAULT_COLUMNS = 100;

  attachStdoutStreams(
    stdout?: Stdout,
    stderr?: Stdout,
    format?: ReporterStream['format'],
  ): ReporterDerivedStreams {
    const columns =
      stdout === undefined || stdout.columns === undefined
        ? Reporter.DEFAULT_COLUMNS
        : stdout.columns;

    if (format === undefined) {
      format = stdout !== undefined && stdout.isTTY === true ? 'ansi' : 'none';
    }

    const columnsUpdated: Event<number, void> = new Event({
      name: 'columnsUpdated',
    });

    const outStream: ReporterStream = {
      type: 'out',
      format,
      columns,
      write(chunk) {
        if (stdout !== undefined) {
          stdout.write(chunk);
        }
      },
      teardown() {},
    };

    const errStream: ReporterStream = {
      ...outStream,
      type: 'error',
      write(chunk) {
        if (stderr !== undefined) {
          stderr.write(chunk);
        }
      },
    };

    // Watch for resizing
    if (outStream.format === 'ansi' && stdout !== undefined) {
      const onStdoutResize = () => {
        if (stdout !== undefined && stdout.columns !== undefined) {
          const {columns} = stdout;
          columnsUpdated.send(columns);
          this.setStreamColumns([outStream, errStream], columns);
        }
      };

      outStream.teardown = () => {
        stdout.off('resize', onStdoutResize);
      };

      stdout.on('resize', onStdoutResize);
    }

    this.addStream(outStream);
    this.addStream(errStream);

    return {
      columnsUpdated,
      stdout: outStream,
      stderr: errStream,
    };
  }

  static fromProcess(opts: ReporterOptions = {}): Reporter {
    const reporter = new Reporter({
      ...opts,
      markupOptions: {
        cwd: CWD_PATH,
        ...opts.markupOptions,
      },
    });

    reporter.attachStdoutStreams(process.stdout, process.stderr);

    return reporter;
  }

  programName: string;
  programVersion: string | undefined;
  markupOptions: MarkupFormatOptions;

  isRemote: boolean;
  silent: boolean;
  noProgress: boolean;
  isVerbose: boolean;
  hasSpacer: boolean;
  indentLevel: number;
  indentString: string;
  enabled: number;
  startTime: number;
  shouldRedirectOutToErr: boolean;
  wrapperFactory: undefined | WrapperFactory;
  outStreams: Set<ReporterStream>;
  errStreams: Set<ReporterStream>;
  streams: Set<ReporterStream>;
  sendRemoteServerMessage: Event<RemoteReporterServerMessage, void>;
  sendRemoteClientMessage: Event<RemoteReporterClientMessage, void>;

  remoteClientProgressBars: Map<string, Progress>;
  remoteServerProgressBars: Map<
    string,
    {
      end: () => void;
    }
  >;

  // track whether we've output anything, we need this to avoid outputting multiple spacers etc
  hasClearScreen: boolean;

  //Store active progress indicators so we can easily bail out and destroy them
  activeElements: Set<{
    render: () => void;
    end: () => void;
  }>;

  processRemoteClientMessage(msg: RemoteReporterClientMessage) {
    if (msg.type === 'PROGRESS_CREATE') {
      this.remoteClientProgressBars.set(
        msg.id,
        this.progressLocal({}, () => {
          this.sendRemoteServerMessage.call({
            type: 'ENDED',
            id: msg.id,
          });
        }),
      );
      return;
    }

    let bar = this.remoteClientProgressBars.get(msg.id);
    if (bar === undefined) {
      throw new Error(
        `Remote reporter message for progress bar ${msg.id} that does not exist`,
      );
    }

    bar.processRemoteClientMessage(msg);

    if (msg.type === 'PROGRESS_END') {
      this.remoteClientProgressBars.delete(msg.id);
    }
  }

  receivedRemoteServerMessage(msg: RemoteReporterServerMessage) {
    // Currently the only message a remote Reporter can send is that it has ended
    switch (msg.type) {
      case 'ENDED':
        const progress = this.remoteServerProgressBars.get(msg.id);
        if (progress !== undefined) {
          progress.end();
        }
    }
  }

  getMessagePrefix(stream: ReporterStream): string {
    stream;
    return '';
  }

  normalizeMessage(
    stream: ReporterStream,
    tty: string,
    opts: LogOptions,
  ): string {
    let msg =
      stream.format !== 'none' || opts.nonTTY === undefined ? tty : opts.nonTTY;

    if (opts.noPrefix !== true) {
      msg = this.getMessagePrefix(stream) + msg;
    }

    // Don't indent if there is no indent, or the message is empty
    const {indentString} = this;
    if (indentString !== '' && msg !== '') {
      // Indent each line, leaving out the indentation for empty lines
      msg = indentString + msg.replace(/\n([^\n])/g, `\n${indentString}$1`);
    }

    // Track if there's going to be a completely empty line
    this.hasSpacer = msg === '' || msg[msg.length - 1] === '\n';

    return msg;
  }

  redirectOutToErr(should: boolean) {
    this.shouldRedirectOutToErr = should;
  }

  setStreamColumns(streams: Array<ReporterStream>, columns: number) {
    for (const stream of streams) {
      if (!this.streams.has(stream)) {
        throw new Error(
          "Trying to setStreamColumns on a stream that isn't attached to this Reporter",
        );
      }

      stream.columns = columns;
    }

    for (const elem of this.activeElements) {
      elem.render();
    }
  }

  addStream(stream: ReporterStream) {
    if (this.silent) {
      return;
    }

    this.streams.add(stream);

    if (stream.type === 'error' || stream.type === 'all') {
      this.errStreams.add(stream);
    }

    if (stream.type === 'out' || stream.type === 'all') {
      this.outStreams.add(stream);
    }
  }

  removeStream(stream: ReporterStream) {
    if (stream.teardown !== undefined) {
      stream.teardown();
    }
    this.streams.delete(stream);
    this.outStreams.delete(stream);
    this.errStreams.delete(stream);
  }

  //# Control

  isEnabled(stderr: undefined | boolean): boolean {
    return this.getStreams(stderr).size > 0;
  }

  getStreams(stderr: undefined | boolean): Set<ReporterStream> {
    if (this.enabled === 0) {
      return new Set();
    }

    if (this.shouldRedirectOutToErr) {
      return this.errStreams;
    }

    if (stderr) {
      return this.errStreams;
    }

    return this.outStreams;
  }

  enable(): () => void {
    let alreadyDisabled = false;

    this.enabled++;

    return () => {
      if (alreadyDisabled) {
        throw new Error('Already disabled Reporter');
      }

      this.enabled--;
      alreadyDisabled = true;
    };
  }

  //# LIFECYCLE

  teardown() {
    for (const stream of this.streams) {
      this.removeStream(stream);
    }

    for (const elem of this.activeElements) {
      elem.end();
    }
    this.activeElements.clear();
  }

  fork(opts: Partial<ReporterOptions> = {}) {
    return new Reporter({
      streams: [...this.streams],
      verbose: this.isVerbose,
      markupOptions: this.markupOptions,
      wrapperFactory: this.wrapperFactory,
      ...opts,
    });
  }

  //# INDENTATION METHODS

  indent(callback?: () => void) {
    this.indentLevel++;
    this.updateIndent();

    if (callback !== undefined) {
      callback();
      this.dedent();
    }
  }

  noIndent(callback: () => void) {
    const prevIndentLevel = this.indentLevel;
    this.indentLevel = 0;
    this.updateIndent();
    callback();
    this.indentLevel = prevIndentLevel;
    this.updateIndent();
  }

  dedent() {
    this.indentLevel--;
    this.updateIndent();
  }

  updateIndent() {
    this.indentString = INDENT.repeat(this.indentLevel);
  }

  //# INTERNAL

  prependEmoji(
    stream: ReporterStream,
    msg: string,
    emoji: string,
    fallback?: string,
  ): string {
    if (stream.format === 'none') {
      return `${emoji} ${msg}`;
    } else {
      if (fallback === undefined) {
        return msg;
      } else {
        return `${fallback} ${msg}`;
      }
    }
  }

  //# VISUALISATION

  table(head: Array<string>, rawBody: Array<Array<string | number>>) {
    // Format the head, just treat it like another row
    head = head.map((field: string): string =>
      formatAnsi.bold(formatAnsi.underline(field)),
    );

    // Humanize all number fields
    const rows: Array<Array<string>> = [head];
    for (const row of rawBody) {
      rows.push(
        row.map(field => {
          if (typeof field === 'number') {
            return humanizeNumber(field);
          } else {
            return field;
          }
        }),
      );
    }

    // Get column widths
    const cols: Array<number> = [];
    for (let i = 0; i < head.length; i++) {
      const widths = rows.map((row): number => stripAnsi(row[i]).length);
      cols[i] = Math.max(...widths);
    }

    // Format all rows
    const builtRows = rows.map((row): string => {
      for (let i = 0; i < row.length; i++) {
        const field = row[i];
        const padding = cols[i] - stripAnsi(field).length;

        row[i] = field + ' '.repeat(padding);
      }
      return row.join(' ');
    });

    this.logAll(builtRows.join('\n'));
  }

  verboseInspect(val: unknown) {
    if (this.isVerbose) {
      this.inspect(val);
    }
  }

  inspect(value: unknown) {
    for (const stream of this.getStreams(false)) {
      let formatted = value;

      if (typeof formatted !== 'number' && typeof formatted !== 'string') {
        formatted = format(formatted, {color: stream.format === 'ansi'});
      }

      this.logOneNoMarkup(stream, String(formatted));
    }
  }

  //# ESCAPE HATCHES

  clearLineAll() {
    for (const stream of this.getStreams(false)) {
      this.clearLineSpecific(stream);
    }
  }

  clearLineSpecific(stream: ReporterStream) {
    stream.write(escapes.eraseLine);
    stream.write(escapes.cursorTo(0));
  }

  writeAll(msg: string, opts: LogOptions = {}) {
    for (const stream of this.getStreams(opts.stderr)) {
      this.writeSpecific(stream, msg, opts);
    }
  }

  writeSpecific(stream: ReporterStream, msg: string, opts: LogOptions = {}) {
    if (!this.isEnabled(opts.stderr)) {
      return;
    }

    this.hasClearScreen = false;

    if (stream.format === 'ansi' && this.activeElements.size > 0) {
      // A progress bar is active and has probably drawn to the screen
      this.clearLineSpecific(stream);
    }

    stream.write(msg);
  }

  //# UTILITIES

  getTotalTime(): number {
    return Date.now() - this.startTime;
  }

  clear() {
    for (const stream of this.getStreams(false)) {
      if (stream.format === 'ansi') {
        stream.write(escapes.clearScreen);
      }
    }
    this.hasClearScreen = true;
  }

  //# SECTIONS

  heading(text: string) {
    this.optionalSpacer();
    const tty = formatAnsi.inverse(formatAnsi.bold(` ${text} `));
    this.logAll(tty, {
      nonTTY: `## ${text}`,
    });
    this.spacer();
  }

  banner(command: string) {
    let msg = `${this.programName} ${command}`;
    if (this.programVersion !== undefined) {
      msg += ` v${this.programVersion}`;
    }
    this.logAll(formatAnsi.bold(msg), {
      nonTTY: `# ${msg}`,
    });
  }

  footer() {
    const totalTime = (this.getTotalTime() / 1000).toFixed(2);
    const msg = `Done in ${totalTime}s.`;
    for (const stream of this.getStreams(false)) {
      this.logOneNoMarkup(stream, this.prependEmoji(stream, msg, '✨'));
    }
  }

  section(title: string, callback: () => void) {
    this.hr(`<emphasis>${title}</emphasis>`);
    this.indent(() => {
      callback();
      this.spacer();
    });
  }

  hr(text?: string) {
    const {hasClearScreen} = this;

    this.optionalSpacer();

    if (hasClearScreen && text === undefined) {
      return;
    }

    for (const stream of this.getStreams(false)) {
      const prefix = this.markupify(
        stream,
        text === undefined ? '' : ` ${text} `,
      );
      const prefixLength = stripAnsi(prefix).length;
      const barLength = Math.max(0, stream.columns - prefixLength);
      this.logOneNoMarkup(stream, prefix + '━'.repeat(barLength));
    }

    this.optionalSpacer();
  }

  step(current: number, total: number, msg: string) {
    if (msg.endsWith('?')) {
      msg = `${removeSuffix(msg, '?')}...?`;
    } else {
      msg += '...';
    }

    this.logAll(`${formatAnsi.dim(`[${current}/${total}]`)} ${msg}`, {
      nonTTY: `[${current}/${total}] ${msg}`,
    });
  }

  optionalSpacer() {
    if (!this.hasSpacer) {
      this.spacer();
    }
  }

  spacer() {
    this.logAll('');
  }

  wrapCallback: WrapperFactory = callback => {
    const {wrapperFactory} = this;
    if (wrapperFactory === undefined) {
      return callback;
    } else {
      return wrapperFactory(callback);
    }
  };

  //# LOG

  stripMarkup(str: string) {
    return stripMarkupTags(str, this.markupOptions);
  }

  markupify(stream: ReporterStream, str: string): string {
    if (stream.format === 'ansi') {
      return markupToAnsi(str, this.markupOptions);
    } else if (stream.format === 'html') {
      // TODO
      return stripMarkupTags(str);
    } else {
      return stripMarkupTags(str);
    }
  }

  logAll(tty: string, opts: LogOptions = {}) {
    for (const stream of this.getStreams(opts.stderr)) {
      this.logOne(stream, tty, opts);
    }
  }

  logAllNoMarkup(msg: string, opts: LogOptions = {}) {
    for (const stream of this.getStreams(opts.stderr)) {
      this.logOneNoMarkup(stream, msg, opts);
    }
  }

  logOne(stream: ReporterStream, tty: string, opts: LogOptions = {}) {
    const msg =
      stream.format !== 'none' || opts.nonTTY === undefined ? tty : opts.nonTTY;
    const formatted = this.markupify(stream, msg);
    this.logOneNoMarkup(stream, formatted, opts);
  }

  logOneNoMarkup(stream: ReporterStream, tty: string, opts: LogOptions = {}) {
    if (!this.isEnabled(opts.stderr)) {
      return;
    }

    const msg = this.normalizeMessage(stream, tty, opts);
    this.writeSpecific(stream, msg + '\n', opts);
  }

  logAllWithCategory(
    msg: string,
    args: Array<unknown>,
    opts: LogCategoryOptions,
  ) {
    for (const stream of this.getStreams(opts.stderr)) {
      const prefix = this.getMessagePrefix(stream) + opts.prefix;

      // Format with string-markup, we only do the first message rather than the interpolated string so you can pass in any data and not have to worry about escaping it
      const msgMarkup = this.markupify(stream, msg);

      // Interpolated and line wrapped string
      let inner = interpolate(msgMarkup, args);

      // Word wrap - we don't use getColumns() here as we don't want to line wrap for a non-tty
      if (stream.format === 'ansi') {
        const width = stream.columns;
        const allowedWidth =
          width - prefix.length - INDENT.length * this.indentLevel;
        if (stripAnsi(inner).length > allowedWidth) {
          const lines = splitAnsiLines(inner, allowedWidth);
          inner = String(lines.shift());

          for (const line of lines) {
            inner += '\n' + ' '.repeat(prefix.length) + line;
          }
        }
      }

      // If the message contains any color then we shouldn't format it, so consider it outside the prefix (which will always be colored)
      let outer = '';
      if (hasAnsiColor(inner)) {
        outer = inner;
        inner = prefix;
      }

      // Build the TTY and non-TTY variants
      let tty =
        formatAnsi.bold(opts.format(prefix)) + opts.format(inner) + outer;
      let nonTTY = prefix + inner + outer;
      if (opts.suffix !== undefined) {
        tty += opts.format(formatAnsi.bold(opts.suffix));
        nonTTY += opts.suffix;
      }

      this.logOneNoMarkup(stream, tty, {
        nonTTY: nonTTY,
        // No prefix as we added it ourselves at the beginning, this is so the indentation is correct when line wrapped
        noPrefix: true,
        ...opts,
      });
    }
  }

  success(msg: string, ...args: Array<unknown>) {
    this.logAllWithCategory(msg, args, {
      prefix: '✔ ',
      format: formatAnsi.green,
    });
  }

  error(msg: string, ...args: Array<unknown>) {
    this.logAllWithCategory(msg, args, {
      format: formatAnsi.red,
      prefix: '✖ ',
      stderr: true,
    });
  }

  errorObj(err: Error) {
    this.error(err.stack || err.message || err.name || 'Unknown Error');
  }

  question(msg: string, ...args: Array<unknown>) {
    this.logAllWithCategory(msg, args, {
      prefix: '❓ ',
      format: formatAnsi.magenta,
    });
  }

  info(msg: string, ...args: Array<unknown>) {
    this.logAllWithCategory(msg, args, {
      prefix: 'ℹ ',
      format: formatAnsi.blue,
    });
  }

  warn(msg: string, ...args: Array<unknown>) {
    this.logAllWithCategory(msg, args, {
      prefix: '⚠ ',
      suffix: ' ⚠',
      format: formatAnsi.yellow,
      stderr: true,
    });
  }

  verbose(msg: string, ...args: Array<unknown>) {
    if (this.isVerbose) {
      this.verboseForce(msg, args);
    }
  }

  verboseForce(msg: string, ...args: Array<unknown>) {
    this.logAllWithCategory(msg, args, {
      prefix: '⚡ ',
      format: formatAnsi.brightBlack,
    });
  }

  command(command: string) {
    for (const stream of this.getStreams(false)) {
      this.logOneNoMarkup(stream, formatAnsi.dim(`$ ${command}`), {
        nonTTY: `$ ${command}`,
      });
    }
  }

  //# LISTS

  _getListIndentation(): string {
    // If we're at the top level then add some implicit indentation
    return this.indentLevel === 0 ? '  ' : '';
  }

  processedList<T>(
    items: Array<T>,
    callback: (item: T, display: (str: string) => void) => void,
    opts: ListOptions = {},
  ) {
    if (items.length === 0) {
      // We make some assumptions that there's at least one item
      return;
    }

    const indent = this._getListIndentation();

    let tuples: Array<[number, T]>;
    if (opts.reverse === true) {
      tuples = items.reverse().map((item, i) => [items.length - i, item]);
    } else {
      tuples = items.map((item, i) => [i, item]);
    }

    // Truncate if necessary
    let truncatedCount = 0;
    if (opts.truncate !== undefined) {
      tuples = tuples.slice(0, opts.truncate);
      truncatedCount = items.length - tuples.length;
    }

    let indentLength = indent.length;

    if (opts.ordered) {
      // Get the highest visible number. It could be at the start or the end depending on if it was reversed
      const highestVisible = Math.max(
        tuples[0][0],
        tuples[tuples.length - 1][0],
      );

      // Length of the largest visible number plus the dot for padding
      const numLen = humanizeNumber(highestVisible + 1).length + 1;

      // "0. "
      indentLength += numLen + 1;

      for (const [index, item] of tuples) {
        callback(item, str => {
          const num: string = rightPad(humanizeNumber(index + 1) + '.', numLen);
          this.logAll(`${indent}${formatAnsi.dim(num)} ${str}`, {
            nonTTY: `${indent}${num} ${str}`,
          });
        });
      }
    } else {
      // "- "
      indentLength += 2;

      for (const [, item] of tuples) {
        callback(item, str => {
          this.logAll(`${indent}${formatAnsi.dim('-')} ${str}`, {
            nonTTY: `${indent}- ${str}`,
          });
        });
      }
    }

    if (truncatedCount > 0) {
      const indent = ' '.repeat(indentLength);
      this.logAll(`${indent}and <number>${truncatedCount}</number> others...`);
    }
  }

  list(items: Array<string>, opts: ListOptions = {}) {
    this.processedList(items, (str, display) => display(str), opts);
  }

  progress(opts?: Partial<ProgressOptions>): ProgressShape {
    if (this.isRemote) {
      return this.progressRemote(opts);
    } else {
      return this.progressLocal(opts);
    }
  }

  progressLocal(opts?: Partial<ProgressOptions>, onEnd?: () => void): Progress {
    const bar = new Progress(this, opts, () => {
      this.activeElements.delete(bar);
      if (onEnd !== undefined) {
        onEnd();
      }
    });
    this.activeElements.add(bar);
    return bar;
  }

  progressRemote(opts?: Partial<ProgressOptions>): ProgressShape {
    const id: string = `${process.pid}:${remoteProgressIdCounter++}`;

    this.sendRemoteClientMessage.send({
      type: 'PROGRESS_CREATE',
      opts,
      id,
    });

    let closed = false;

    const dispatch = (message: RemoteReporterClientMessage) => {
      if (!closed) {
        this.sendRemoteClientMessage.send(message);
      }
    };

    const end = () => {
      this.activeElements.delete(progress);
      this.remoteServerProgressBars.delete(id);
      closed = true;
    };

    const progress: ProgressShape = {
      render() {
        // Don't do anything
        // This is called when columns have updated and we want to force a rerender
      },

      setCurrent: (current: number) => {
        dispatch({
          type: 'PROGRESS_SET_CURRENT',
          current,
          id,
        });
      },

      setTotal: (total: number, approximate: boolean = false) => {
        dispatch({
          type: 'PROGRESS_SET_TOTAL',
          total,
          approximate,
          id,
        });
      },

      setTitle: (title: string) => {
        dispatch({
          type: 'PROGRESS_SET_TITLE',
          title,
          id,
        });
      },

      setText: (text: string) => {
        dispatch({
          type: 'PROGRESS_SET_TEXT',
          text,
          id,
        });
      },

      setApproximateETA: (duration: number) => {
        dispatch({
          type: 'PROGRESS_SET_APPROXIMATE_ETA',
          duration,
          id,
        });
      },

      pushText: (text: string) => {
        dispatch({
          type: 'PROGRESS_PUSH_TEXT',
          text,
          id,
        });
      },

      popText: (text: string) => {
        dispatch({
          type: 'PROGRESS_POP_TEXT',
          text,
          id,
        });
      },

      tick: () => {
        dispatch({
          type: 'PROGRESS_TICK',
          id,
        });
      },

      end: () => {
        dispatch({
          type: 'PROGRESS_END',
          id,
        });
      },

      pause: () => {
        dispatch({
          type: 'PROGRESS_PAUSE',
          id,
        });
      },

      resume: () => {
        dispatch({
          type: 'PROGRESS_RESUME',
          id,
        });
      },
    };

    this.remoteServerProgressBars.set(id, {
      end,
    });

    this.activeElements.add(progress);

    return progress;
  }
}
