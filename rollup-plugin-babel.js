// System dependencies
const Babel = require('rollup-plugin-babel');
const _ = require('underscore');
const path = require('path');
const fs = require('fs');
// Application modules
const sweetjsRuntime = require('./utils/sweetjs');
// Variable
module.exports = function(options){
  const optKeys = ['extName', 'logger', 'indexFile'];
  const opts = _.defaults(_.pick(options, optKeys), {
    'extName': '.js',
    'indexFile': 'index',
    'logger': {
      'writeln': _.noop,
      'debug': _.noop
    }
  });
  options = _.omit(options, optKeys);
  const babel = Babel(options);
  const oldApis = _.pick(babel, ['resolveId', 'transform']);
  const extNameRegexp = /\.\w+$/;
  const keywordRegexp = /^[a-z0-9_-]+$/i;
  const sweetCompile = sweetjsRuntime(); // opts.logger
  return _.extend(babel, {
    'name': 'Babel Transpiler',
    resolveId(importee, importer){
      const result = Reflect.apply(oldApis.resolveId, babel, [importee]);
      if (result || keywordRegexp.test(importee) ||
          extNameRegexp.test(importee) || !opts.extName) {
        return result;
      }
      const dirname = path.resolve(path.dirname(importer), importee);
      let filename;
      try {
        fs.accessSync(dirname, fs.R_OK); // eslint-disable-line no-sync
        if (fs.statSync(dirname).isDirectory()) { // eslint-disable-line no-sync
          filename = path.join(dirname, opts.indexFile + opts.extName);
        } else {
          filename = dirname;
        }
      } catch (err) {
        filename = dirname + opts.extName;
      }
      opts.logger.writeln('resolveId from', importee, 'to', filename);
      return filename;
    },
    transform(code, id){
      const sweetjsRes = sweetCompile(code, null, id);
      opts.logger.writeln(`Babel compiling ${id}`);
      const result = Reflect.apply(oldApis.transform, babel, [sweetjsRes.code, id]);
      return result;
    }
  });
};
