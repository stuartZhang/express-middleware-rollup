// System dependencies
const Babel = require('rollup-plugin-babel');
const _ = require('underscore');
const path = require('path');
const fsp = require('fs-promise');
// Application modules
const {debug} = require('./utils');
const sweetjsRuntime = require('./utils/sweetjs');
// Variable
module.exports = function(options){
  const optKeys = ['extName', 'indexFile'];
  const opts = _.defaults(_.pick(options, optKeys), {
    'extName': '.mjs',
    'indexFile': 'index'
  });
  options = _.omit(options, optKeys);
  const babel = Babel(options);
  const oldApis = _.pick(babel, ['resolveId', 'transform']);
  const extNameRegexp = /\.\w+$/;
  const keywordRegexp = /^[a-z0-9_-]+$/i;
  const sweetCompile = sweetjsRuntime();
  return _.extend(babel, {
    'name': 'Babel Transpiler',
    async resolveId(importee, importer){
      const result = Reflect.apply(oldApis.resolveId, babel, [importee]);
      if (result || keywordRegexp.test(importee) ||
          extNameRegexp.test(importee) || !opts.extName) {
        return result;
      }
      const dirname = path.resolve(path.dirname(importer), importee);
      let filename;
      try {
        await fsp.access(dirname, fsp.R_OK);
        const fStats = await fsp.stat(dirname);
        if (fStats.isDirectory()) {
          filename = path.join(dirname, `${opts.indexFile}${opts.extName}`);
        } else {
          filename = dirname;
        }
      } catch (err) {
        filename = `${dirname}${opts.extName}`;
      }
      const log = debug('babel-plugin:resolveId');
      log('resolveId from', importee, 'to', filename);
      return filename;
    },
    transform(code, id){
      const log = debug('babel-plugin:transform');
      const sweetjsRes = sweetCompile(code, null, id);
      log(`Babel compiling ${id}`);
      const result = Reflect.apply(oldApis.transform, babel, [sweetjsRes.code, id]);
      return result;
    }
  });
};
