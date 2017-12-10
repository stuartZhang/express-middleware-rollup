// System dependencies
const _ = require('underscore');
// App dependencies
const {debug} = require('./index');
// Variable
const macroRegExp = /^(\s*)MACRO_(TIME(?:_END)?|LOG_(DEBUG|INFO|WARN|ERROR))(?:\s+\[(\w+)\])?\s+(.+)\s*$/mg;
const template1 = 'var __logDVal@INDEX@__ = __simpleLogFormat__.@LOGLEV@.@LOGCAT@(@LOGPARAMS@);' +
                  "if (__logDVal@INDEX@__ != '')" +
                    'console.@LOGLEVEL@.apply(console, __logDVal@INDEX@__);';
const template2 = 'var __logDVal@INDEX@__ = __simpleLogFormat__.@LOGLEV@(@LOGPARAMS@);' +
                  "if (__logDVal@INDEX@__ != '')" +
                    'console.@LOGLEVEL@.apply(console, __logDVal@INDEX@__);';
const template3 = 'var __logDVal@INDEX@__ = __simpleLogFormat__.@LOGLEV@.@LOGCAT@(@LOGPARAMS@);' +
                  "if (__logDVal@INDEX@__ != '')" +
                    'console.@LOGLEVEL@(__logDVal@INDEX@__[0].replace(/^%c\\[DEBUG\\]/, "[AUDIT]"));';
module.exports = function sweetjsRuntime(){
  function replacer(match, ws, command, logLevel, logCat, logParams){ // , offset, source
    logParams = logParams.replace(/;$/, '');
    let result;
    if (command.match(/^LOG_/)) {
      logLevel = logLevel.toLowerCase();
      const logLev = logLevel.at(0);
      if (logCat == null) { // template 2
        result = ws + template2;
      } else { // template 1
        result = ws + template1.replace(/@LOGCAT@/g, logCat);
      }
      result = result.replace(/@LOGLEVEL@/g, logLevel)
        .replace(/@LOGLEV@/g, logLev);
    } else if (command.match(/^TIME(?:_END)?$/)) {
      command = command.toLowerCase().replace(/_(\w)/mg, (match, capital) => capital.toUpperCase());
      result = ws + template3;
      result = result.replace(/@LOGCAT@/g, logCat)
        .replace(/@LOGLEVEL@/g, command)
        .replace(/@LOGLEV@/g, 'd');
    }
    if (result == null) {
      throw new Error(`No-match command: ${command}`);
    }
    result = result.replace(/@INDEX@/g, String(macroIndex))
      .replace(/@LOGPARAMS@/g, logParams);
    if (macroIndex < Number.MAX_VALUE) {
      macroIndex++;
    } else {
      macroIndex = 1;
    }
    logger.debug(' >>> Replacer: from %s\n to %s\n', match, result);
    // console.log(result);
    return result;
  }
  let macroIndex = 1;
  return function sweetCompile(code, dest, filename){
    const log = debug('sweetjs');
    log(`Sweetjs compiling ${filename}: ${Math.round(code.length / 1000)}KB`);
    const compiled = code.replace(macroRegExp, replacer);
    return {
      'code': compiled,
      'sourceMap': null,
      'mapfile': null
    };
  };
};
