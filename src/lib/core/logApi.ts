/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

/* --------------------------------------------------------------------------------------------------------------------
 * WARNING: This file has been deprecated and should now be considered locked against further changes.  Its contents
 * have been partially or wholely superceded by functionality included in the @salesforce/core npm package, and exists
 * now to service prior uses in this repository only until they can be ported to use the new @salesforce/core library.
 *
 * If you need or want help deciding where to add new functionality or how to migrate to the new library, please
 * contact the CLI team at alm-cli@salesforce.com.
 * ----------------------------------------------------------------------------------------------------------------- */

// node libs
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 3rd party
import * as BBPromise from 'bluebird';

const fs_readFile = BBPromise.promisify(fs.readFile);
import * as mkdirp from 'mkdirp';
import * as bunyan from 'bunyan-sfdx-no-dtrace';
import * as h from 'heroku-cli-util';
import * as _ from 'lodash';
import { isPlainObject } from '@salesforce/ts-types';
const { env } = require('@salesforce/kit');

const almError = require('./almError');
const _constants = require('./constants');
import Messages = require('../messages');
const messages = Messages();

import stripAnsi = require('strip-ansi');
import chalkStyles = require('ansi-styles');
import chalk = require('chalk');

const heroku: any = h;
const ROOT_LOGGER_NAME = 'sfdx';
const DEFAULT_LOG_FILE = 'sfdx.log';

const LOG_LEVEL_DEFAULT = bunyan.WARN;

// Ok to log clientid
const FILTERED_KEYS = [
  'sid',
  // Any json attribute that contains the words "access" and "token" will have the attribute/value hidden
  { name: 'access_token', regex: 'access[^\'"]*token' },
  // Any json attribute that contains the words "refresh" and "token" will have the attribute/value hidden
  { name: 'refresh_token', regex: 'refresh[^\'"]*token' },
  'clientsecret',
  // Any json attribute that contains the words "sfdx", "auth", and "url" will have the attribute/value hidden
  { name: 'sfdxauthurl', regex: 'sfdx[^\'"]*auth[^\'"]*url' }
];

const loggerRegistry = {}; // store so we reuse and properly close

const serializers = bunyan.stdSerializers;

serializers.config = obj => {
  const configCopy = {};

  Object.keys(obj).forEach(key => {
    const val = obj[key];
    if (_.isString(val) || _.isNumber(val) || _.isBoolean(val)) {
      configCopy[key] = val;
    }
  });

  return configCopy;
};

// close streams
// FIXME: sadly, this does not work when process.exit is called; for now, disabled process.exit
const closeStreams = fn => {
  Object.keys(loggerRegistry).forEach(key => {
    loggerRegistry[key].close(fn);
  });
};

const uncaughtExceptionHandler = err => {
  // log the exception
  const logger = _getLogger(ROOT_LOGGER_NAME, false); // eslint-disable-line no-use-before-define
  if (logger) {
    // FIXME: good chance this won't be logged because
    // process.exit was called before this is logged
    // https://github.com/trentm/node-bunyan/issues/95
    logger.fatal(err);
  }
};

// Never show tokens or connect app information in the logs
const _filter = (...args) =>
  args.map(arg => {
    if (_.isArray(arg)) {
      return _filter(...arg);
    }

    if (arg) {
      let _arg = arg;

      // Normalize all objects into a string. This include errors.
      if (_.isObject(arg)) {
        _arg = JSON.stringify(arg);
      }

      const HIDDEN = 'HIDDEN';

      FILTERED_KEYS.forEach(key => {
        let expElement = key;
        let expName = key;

        // Filtered keys can be strings or objects containing regular expression components.
        if (isPlainObject(key)) {
          expElement = key.regex;
          expName = key.name;
        }

        const hiddenAttrMessage = `<${expName} - ${HIDDEN}>`;

        // Match all json attribute values case insensitive: ex. {" Access*^&(*()^* Token " : " 45143075913458901348905 \n\t" ...}
        const regexTokens = new RegExp(`['"][^'"]*${expElement}[^'"]*['"]\\s*:\\s*['"][^'"]*['"]`, 'gi');

        // Replaced value will be no longer be a valid JSON object which is ok for logs: {<access_token - HIDDEN> ...}
        _arg = _arg.replace(regexTokens, hiddenAttrMessage);

        // Match all key value attribute case insensitive: ex. {" key\t"    : ' access_token  ' , " value " : "  dsafgasr431 " ....}
        const keyRegex = new RegExp(
          `['"]\\s*key\\s*['"]\\s*:\\s*['"]\\s*${expElement}\\s*['"]\\s*.\\s*['"]\\s*value\\s*['"]\\s*:\\s*['"]\\s*[^'"]*['"]`,
          'gi'
        );

        // Replaced value will be no longer be a valid JSON object which is ok for logs: {<access_token - HIDDEN> ...}
        _arg = _arg.replace(keyRegex, hiddenAttrMessage);
      });

      // This is a jsforce message we are masking. This can be removed after the following pull request is committed
      // and pushed to a jsforce release.
      //
      // Looking  For: "Refreshed access token = ..."
      // Related Jsforce pull requests:
      //  https://github.com/jsforce/jsforce/pull/598
      //  https://github.com/jsforce/jsforce/pull/608
      //  https://github.com/jsforce/jsforce/pull/609
      const jsForceTokenRefreshRegEx = new RegExp('Refreshed(.*)access(.*)token(.*)=\\s*[^\'"\\s*]*');
      _arg = _arg.replace(jsForceTokenRefreshRegEx, `<refresh_token - ${HIDDEN}>`);

      _arg = _arg.replace(/sid=(.*)/, `sid=<${HIDDEN}>`);

      return _arg;
    } else {
      return arg;
    }
  });

const _registerLogger = function(logger, name) {
  if (_.isNil(name)) {
    throw new Error('Logger name required');
  }

  if (!loggerRegistry[name]) {
    loggerRegistry[name] = logger;
  }
};

class Mode {
  static get types() {
    return ['production', 'development', 'demo'];
  }

  public mode: string;

  constructor(mode) {
    mode = mode && mode.toLowerCase();
    this.mode = Mode.types.includes(mode) ? mode : 'production';

    Mode.types.forEach(modeType => {
      this[`is${_.capitalize(modeType)}`] = () => modeType === this.mode;
    });
  }
}

/**
 * SFDX Logger logs all lines at or above a given level to a file. It also
 * handles logging to stdout, which delegates to heroku-cli-util.
 *
 * Implementation extends Bunyan.
 *
 * https://github.com/trentm/node-bunyan
 *
 * Things to note:
 *   # Logging API params:
 *     Note that this implies you cannot blindly pass any object as the first argument
 *     to log it because that object might include fields that collide with Bunyan's
 *     core record fields. In other words, log.info(mywidget) may not yield what you
 *     expect. Instead of a string representation of mywidget that other logging
 *     libraries may give you, Bunyan will try to JSON-ify your object. It is a Bunyan
 *     best practice to always give a field name to included objects, e.g.:
 *
 *     log.info({widget: mywidget}, ...)
 *
 *   # Issues:
 *     - Ensuring writable stream is flushed on exception
 *       https://github.com/trentm/node-bunyan/issues/37
 *
 */
class Logger extends bunyan {
  static commandName: string;

  // TODO: proper property typing
  [property: string]: any;

  constructor(options, _childOptions?, _childSimple?) {
    super(options, _childOptions, _childSimple);
    this.name = options.name;
    this.colorEnabled = false;
    this.humanConsumable = true;
    this.filters = [];
    this.levels = bunyan.levelFromName;
    this._useRingBuffer = false;
  }

  init(level?, logFile = path.join(path.join(os.homedir(), '.sfdx', DEFAULT_LOG_FILE))) {
    if (_.isNil(level)) {
      // Default the log level
      level = LOG_LEVEL_DEFAULT;
    }

    if (this.useRingBuffer) {
      try {
        this.ringbuffer = new bunyan.RingBuffer({ limit: 5000 });
        this.addStream({ type: 'raw', stream: this.ringbuffer, level });
      } catch (error) {
        const levels = Object.keys(this.levels).join(', ');
        error['message'] = `${error.message} - ${messages.getMessage('IncorrectLogLevel', levels)}`;
        throw error;
      }
    }

    // disable log file writing, if applicable
    else if (process.env.SFDX_DISABLE_LOG_FILE !== 'true') {
      // create log file, if not exists
      if (!fs.existsSync(logFile)) {
        mkdirp.sync(path.dirname(logFile), {
          mode: _constants.DEFAULT_USER_DIR_MODE
        });
        fs.writeFileSync(logFile, '', {
          mode: _constants.DEFAULT_USER_FILE_MODE
        });
      }

      // avoid multiple streams to same log file
      if (!this.streams.find(stream => stream.type === 'file' && stream.path === logFile)) {
        // TODO: rotating-file
        // https://github.com/trentm/node-bunyan#stream-type-rotating-file
        try {
          this.path = logFile;
          this.addStream({ type: 'file', path: logFile, level });
        } catch (error) {
          const levels = Object.keys(this.levels).join(', ');
          error['message'] = `${error.message} - ${messages.getMessage('IncorrectLogLevel', levels)}`;
          throw error;
        }
      }

      // This is to prevent the following warning
      // node:12145) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.

      // This should be an adequate solution for a force-com-toolbelt logger in the context of running a command.
      // This however shouldn't be used in say sfdx-core where the logger could be used in a persistent service.
      process.setMaxListeners(100);

      // to debug 'Possible EventEmitter memory leak detected', add the following to top of index.js or, for
      // log tests, top of logApi.js
      // https://git.soma.salesforce.com/ALMSourceDrivenDev/force-com-toolbelt/compare/cwall/logs-for-EventEmitter-memory-leak

      // ensure that uncaughtException is logged
      process.on('uncaughtException', uncaughtExceptionHandler);

      // FIXME: ensure that streams are flushed on ext
      // https://github.com/trentm/node-bunyan/issues/37
      process.on('exit', closeStreams);
    }
  }

  // Compares the requested log level with the current log level.  Returns true if
  // the requested log level is greater than or equal to the current log level.
  shouldLog(logLevel) {
    let shouldLog = false;
    if (_.isNumber(logLevel)) {
      shouldLog = logLevel >= this.level();
    } else if (_.isString(logLevel)) {
      shouldLog = this.level[logLevel] >= this.level();
    }
    return shouldLog;
  }

  /**
   * @returns {boolean} returns true or false depending on if in memory logging is enabled.
   */
  get useRingBuffer() {
    return this._useRingBuffer;
  }

  /**
   * Turns on in memory logging
   * @param {boolean} val
   */
  set useRingBuffer(val) {
    this._useRingBuffer = _.isBoolean(val) ? val : false;
  }

  /**
   * Returns an array of log line objects. Each element is an object the corresponds to a log line.
   * @returns {Array}
   */
  getBufferedRecords() {
    return this.ringbuffer.records;
  }

  /**
   * Returns a text blob of all the log lines contained in memory.
   * @returns {*}
   */
  getLogContentsAsText() {
    if (this.useRingBuffer) {
      return BBPromise.resolve(
        this.getBufferedRecords().reduce((accum, value) => {
          accum += JSON.stringify(value) + this.getEOL();
          return accum;
        }, '')
      );
    } else if (!_.isNil(this.path)) {
      return fs_readFile(this.path, 'utf8');
    } else {
      return BBPromise.reject(new Error('Log type is neither a file stream or ring buffer'));
    }
  }

  /**
   * Adds a filter to the array
   * @param filter - function defined in the command constructor
   * that manipulates log messages
   */
  addFilter(filter) {
    this.filters.push(filter);
  }

  /**
   * When logging messages to the DEFAULT_LOG_FILE, this method
   * calls the filters defined in the executed commands.
   * @param args - this can be an array of strings, objects, etc.
   */
  applyFilters(logLevel, ...args) {
    if (this.shouldLog(logLevel)) {
      this.filters.forEach(filter => {
        args = filter(...args);
      });
    }

    return args && args.length === 1 ? args[0] : args;
  }

  /**
   * Set the state of the logger to be human consumable or not. Human
   * consumable enables colors and typical output to stdout. When disabled,
   * it prevents color and stdout and only allows outputting JSON.
   */
  setHumanConsumable(isConsumable) {
    this.humanConsumable = isConsumable;
    this.colorEnabled = isConsumable;
  }

  /**
   *
   */
  close(fn?) {
    if (this.streams) {
      try {
        this.streams.forEach(stream => {
          if (fn && _.isFunction(fn)) {
            fn(stream);
          }

          // close stream, flush buffer to disk
          if (stream.type === 'file') {
            stream.stream.end();
          }
        });
      } finally {
        // remove listeners to avoid 'Possible EventEmitter memory leak detected'
        process.removeListener('uncaughtException', uncaughtExceptionHandler);
        process.removeListener('exit', closeStreams);
      }
    }
  }

  /**
   * Create a child logger, typically to add a few log record fields.
   *
   * @see bunyan.child(options, simple).
   *
   * @param {string} name - required, name of child logger that is emitted w/ logline as log:<name>
   * @param {object} fields - additional fields include in logline
   * @param {boolean} humanConsumable - true if this logger supports human readable output.
   * @returns {logger}
   */
  child(name, fields: any = {}, humanConsumable) {
    if (!name) {
      throw almError('LoggerNameRequired');
    }

    fields.log = name;

    // only support including addt'l fields on logline (no config)
    const childLogger = super.child(fields, true);

    childLogger.colorEnabled = this.colorEnabled;
    childLogger.humanConsumable = _.isNil(humanConsumable) ? this.humanConsumable : humanConsumable;
    childLogger.filters = this.filters;
    childLogger.path = this.path;

    if (this.useRingBuffer) {
      childLogger._useRingBuffer = this.useRingBuffer;
      childLogger.ringbuffer = this.ringbuffer;
    }

    // store to close on exit
    _registerLogger(childLogger, name);

    this.trace(`Setup '${name}' logger instance`);

    return childLogger;
  }

  setConfig(name, value) {
    if (!this.fields.config) {
      this.fields.config = {};
    }
    this.fields.config[name] = value;
  }

  isDebugEnabled() {
    return super.debug();
  }

  getEnvironmentMode() {
    return new Mode(this.envMode || process.env.SFDX_ENV);
  }

  isError() {
    return this.level() === bunyan.ERROR;
  }

  /**
   *  Go directly to stdout. Useful when wanting to write to the same line.
   */
  logRaw(...args) {
    this.info(...args);

    if (this.humanConsumable) {
      heroku.console.writeLog(...args);
      // If we stop using heroku
      // process.stdout.write(...args);
    }

    return this;
  }

  /**
   * Log JSON to stdout and to the log file with log level info.
   */
  logJson(obj) {
    heroku.log(JSON.stringify(obj));

    // log to sfdx.log after the console as filtering will change values
    this.trace(obj);
  }

  /**
   * Log JSON to stderr and to the log file with log level error.
   */
  logJsonError(obj) {
    const err = JSON.stringify(obj);
    console.error(err); // eslint-disable-line no-console
    return super.error(this.applyFilters(bunyan.ERROR, err));
  }

  /**
   * Logs INFO level log AND logs to console.log in human-readable form.
   *
   * See "Logging API params" in top-level doc.
   *
   * @see bunyan.debug()
   */
  log(...args) {
    if (this.humanConsumable) {
      heroku.log(...args);
    }

    // log to sfdx.log after the console as filtering will change values
    this.info(...args);

    return this;
  }

  trace(...args) {
    return super.trace(this.applyFilters(bunyan.TRACE, ...args));
  }

  debug(...args) {
    return super.debug(this.applyFilters(bunyan.DEBUG, ...args));
  }

  info(...args) {
    return super.info(this.applyFilters(bunyan.INFO, ...args));
  }

  warn(...args) {
    return super.warn(this.applyFilters(bunyan.WARN, ...args));
  }

  warnUser(context, message) {
    const warning = `${this.color.yellow('WARNING:')}`;
    this.warn(warning, message);
    if (this.shouldLog(bunyan.WARN)) {
      if (context && context.flags.json) {
        if (!context.warnings) {
          context.warnings = [];
        }
        context.warnings.push(message);
        // Also log the message if valid stderr with json going to stdout.
        if (env.getBoolean('SFDX_JSON_TO_STDOUT', true)) {
          console.error(warning, message); // eslint-disable-line no-console
        }
      } else {
        console.error(warning, message); // eslint-disable-line no-console
      }
    }
  }

  formatDeprecationWarning(name, def, type) {
    let msg =
      def.messageOverride ||
      `The ${type} "${name}" has been deprecated and will be removed in v${`${def.version + 1}.0`} or later.`;
    if (def.to) {
      msg += ` Use "${def.to}" instead.`;
    }
    if (def.message) {
      msg += ` ${def.message}`;
    }
    return msg;
  }

  /**
   * Set the command name for this node process by seeing it statically accross
   * all logger instances.
   * @param {string} cmdName The command name
   */
  setCommandName(cmdName) {
    // Only one command is ran at a time. Set this statically so all child
    // loggers have access to it too.
    Logger.commandName = cmdName;
  }

  /**
   * Format errors for human consumption. Adds 'ERROR running <command name>',
   * as well as turns all errors the color red/
   */
  formatError(...args) {
    const colorizedArgs = [];
    const runningWith = _.isString(Logger.commandName) ? ` running ${Logger.commandName}` : '';
    colorizedArgs.push(this.color.bold(`ERROR${runningWith}: `));
    args.forEach(arg => {
      colorizedArgs.push(`${this.color.red(arg)}`);
    });
    return colorizedArgs;
  }

  // boolean first arg determines if we log to console: false to
  // only log to logfile, default is true
  error(...args) {
    const consoleLog = args.length && args.length > 1 && _.isBoolean(args[0]) ? args[0] : true;

    if (consoleLog && (this.humanConsumable || env.getBoolean('SFDX_JSON_TO_STDOUT', true))) {
      console.error(...this.formatError(args)); // eslint-disable-line no-console
    }

    return super.error(this.applyFilters(bunyan.ERROR, ...args));
  }

  action(action) {
    if (this.humanConsumable) {
      const args = this.formatError(action.message);
      const colorizedAction = this.color.blue(this.color.bold('Try this:'));
      args.push(`\n\n${colorizedAction}\n${action.action}`);
      console.error(...args); // eslint-disable-line no-console
    }

    return super.error(this.applyFilters(action.message, action.action));
  }

  fatal(...args) {
    // Always show fatal to stdout
    console.error(...args); // eslint-disable-line no-console
    return super.fatal(this.applyFilters(bunyan.FATAL, ...args));
  }

  table(...args) {
    if (this.humanConsumable) {
      const columns = _.get(args, '[1].columns');
      if (columns) {
        args[1].columns = _.map(columns, col => {
          if (_.isString(col)) {
            return { key: col, label: _.toUpper(col) };
          }
          return {
            key: col.key,
            label: _.toUpper(col.label),
            format: col.format
          };
        });
      }
      heroku.table(...args);
    }

    // before table as filtering will change values
    this.info(...args);

    return this;
  }

  styledHash(...args) {
    this.info(...args);
    if (this.humanConsumable) {
      heroku.styledHash(...args);
    }
    return this;
  }

  styledHeader(...args) {
    this.info(...args);
    if (this.humanConsumable) {
      heroku.styledHeader(...args);
    }
    return this;
  }

  get color() {
    const colorFns: any = {};
    Object.keys(chalkStyles).forEach(style => {
      colorFns[style] = msg => {
        if (this.colorEnabled) {
          const colorfn = chalk[style] as (msg: string) => string;
          return colorfn(msg);
        }
        return msg;
      };
    });
    colorFns['stripColor'] = stripAnsi;
    return colorFns;
  }

  /**
   * Get/set the level of all streams on this logger.
   *
   * @see bunyan.nameFromLevel(value).
   */
  nameFromLevel(value) {
    return bunyan.nameFromLevel[value === undefined ? this.level() : value];
  }

  setLevel(level) {
    if (_.isNil(level)) {
      // Set log level to the default
      level = this.levels[LOG_LEVEL_DEFAULT];
    }
    // level of all streams on this logger
    this.level(level);
  }

  // reset stream(s) and log file(s) to support testing with test workspaces
  reset() {
    this.close();
    this.streams.forEach(stream => {
      if (stream.path) {
        try {
          if (process.platform === 'win32') {
            // todo: remove this writeFileSync when we fix file deletion on windows
            fs.writeFileSync(stream.path, '');
          }
          fs.unlinkSync(stream.path);
        } catch (err) {
          // ignore
        }
      }
    });
    this.streams = [];
    this.init();
    return this;
  }

  getEOL() {
    return os.EOL;
  }
}

const _getLogger = function(name, initGlobalLoggerIfNotFound = true) {
  if (_.isNil(name)) {
    throw new Error('Logger name required');
  }

  if (Object.keys(loggerRegistry).length === 0 && initGlobalLoggerIfNotFound) {
    // if no loggers, create and init global logger
    const globalLogger = new Logger({
      name: ROOT_LOGGER_NAME,
      level: 'error',
      serializers,
      // No streams for now, not until it is enabled
      streams: []
    });

    globalLogger.addFilter((...args) => _filter(...args));

    _registerLogger(globalLogger, ROOT_LOGGER_NAME);

    globalLogger.trace(`Setup '${name}' logger instance`);
  }

  if (!loggerRegistry[name]) {
    throw new Error(`Logger ${name} not found`);
  }

  return loggerRegistry[name];
};

export = _getLogger(ROOT_LOGGER_NAME);
