// System dependencies
const _ = require('underscore');
const path = require('path');
// Application modules

// Variable
module.exports = function(options){
  const pluginName = 'Web Worker';
  let optExternal, optPaths;
  const importScripts = [];
  const history = [];
  let dirTopFilepath, relTopFilepath, topFilepath;
  return {
    'name': pluginName,
    'options'(options){
      optExternal = options.external || [];
      optPaths = options.paths || {};
      Reflect.deleteProperty(options, 'external');
      Reflect.deleteProperty(options, 'paths');
    },
    'resolveId'(importee, importer){
      if (!importer) {
        topFilepath = importee;
        relTopFilepath = path.relative(options.cwd, topFilepath);
        dirTopFilepath = path.dirname(relTopFilepath);
      }
      if (optExternal.indexOf(importee) < 0) {
        return null; // defer to the next.
      }
      if (history.indexOf(importee) > -1) {
        return false; // external
      }
      let pathImportees = optPaths[importee];
      if (pathImportees) {
        if (!_.isArray(pathImportees)) {
          pathImportees = [pathImportees];
        }
        pathImportees.forEach(pathImportee => {
          const refImportee = path.relative(dirTopFilepath, pathImportee);
          if (importScripts.indexOf(refImportee) > -1) {
            return;
          }
          importScripts.push(refImportee);
          options.logger && options.logger.writeln("Roll up plugin [%s] importScripts('%s');", pluginName, refImportee);
        });
      }
      history.push(importee);
      return false; // external
    },
    'banner'(){
      const polyfills = options.polyfills.slice(0);
      const _importScripts = importScripts.slice(0);
      polyfills.reverse().forEach(polyfill => {
        const refImportee = path.relative(dirTopFilepath, polyfill);
        _importScripts.unshift(refImportee);
        options.logger && options.logger.writeln("Roll up plugin [%s] importScripts('%s');", pluginName, refImportee);
      });
      const result = `${[
        `importScripts('${_importScripts.join("', '").replace(/\\/g, '/')}')`
      ].join(';\n')};`;
      return result;
    }
  };
};
