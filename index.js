try {
  require('fecha');
} catch (e) {}
const _ = require('underscore');
const debug = require('debug');
const rollup = require('rollup');
const fsp = require('fs-promise');
const url = require('url');
const path = require('path');
const express = require('express');
const UglifyJS = require("uglify-js");
_.defaults(RegExp, {quote: require("regexp-quote")});

const logger = {
  check: debug('express-rollup-mw:check'),
  build: debug('express-rollup-mw:build'),
  res: debug('express-rollup-mw:res'),
  rollup: debug('express-rollup-mw:rollup')
};
const AVAIL_METHODS = ['GET', 'HEAD'];
const defaults = {
  mode: 'compile',
  destExtension: /\.js$/,
  bundleExtension: '.bundle',
  src: null,
  dest: null,
  root: process.cwd(),
  prefix: null,
  rebuild: 'deps-change', // or 'never' or 'always'
  serve: false, // or 'on-compile' or true. 'on-compile' has the benefit
                // that the bundle which is already in memory will be
                // written directly into the response
  type: 'javascript',
  rollupOpts: {
    onwarn(err){
      if (err.code !== 'THIS_IS_UNDEFINED') {
        logger.rollup(err);
      }
    }
  },
  bundleOpts: {
    format: 'iife'
  },
  isUglify: true,
  uglifyOpts: {
    warnings: true,
    ie8: true
  },
  maxAge: 0
};
class ExpressRollup {
  static getBundleDependencies(bundle) {
    return bundle.modules.map(module => module.id).filter(path.isAbsolute);
  }
  static async errHandleWrapper(func, req, res, next){
    try {
      await func(req, res, next);
    } catch (err) {
      next(err);
    }
  }
  static guardHandle(req, res, next){
    const err = new Error('Not Found');
    err.status = 404;
    next(err);
  }
  static get [Symbol.species]() {
    return this;
  }
  constructor(opts) {
    this.opts = opts;
    this.cache = new Map(); // Cache for bundles' dependencies list
    this[Symbol.toStringTag] = 'ExpressRollup';
  }
  refreshCache(jsPath, needed = true){
    if (needed) { // expired
      if (this.cache.has(jsPath) &&
          this.cache.get(jsPath).status === 'pending') {
        this.cache.get(jsPath).reject('expired');
      }
      this.cache.set(jsPath, defer());
    }
  }
  async checkNeedsRebuild(bundleOpts, rollupOpts) {
    if (process.env.NODE_ENV === 'production') {
      if (this.cache.has(bundleOpts.dest)) {
        await this.cache.get(bundleOpts.dest).promise;
        return {needed: false};
      }
      this.refreshCache(bundleOpts.dest);
      return {needed: true};
    }
    const [entryExists, jsExists] = await Promise.all([
      fsp.access(rollupOpts.entry, fsp.F_OK).then(() => true, err => false),
      fsp.access(bundleOpts.dest, fsp.F_OK).then(() => true, err => false)
    ]);
    if (!entryExists) {
      return null;
    }
    const relDest = path.relative(this.opts.root, bundleOpts.dest);
    logger.check('source: %s', path.relative(this.opts.root, rollupOpts.entry));
    logger.check('dest: %s', relDest);
    if (jsExists && this.cache.has(bundleOpts.dest)) { // both
      logger.check(`[f+, c+] Check the cache item for ${relDest}`);
      const dependencies = await this.cache.get(bundleOpts.dest).promise;
      const needed = !(await this.allFilesOlder(bundleOpts.dest, dependencies));
      this.refreshCache(bundleOpts.dest, needed);
      return {needed};
    }
    if (!jsExists && !this.cache.has(bundleOpts.dest)) { // neither
      logger.check(`[f-, c-] Create a cache item for ${relDest}`);
      this.refreshCache(bundleOpts.dest);
      return {needed: true};
    }
    if (jsExists && !this.cache.has(bundleOpts.dest)) {
      logger.check(`[f+, c-] Create a cache item for the existing ${relDest}`);
      this.refreshCache(bundleOpts.dest);
      const bundle = await rollup.rollup(rollupOpts);
      const dependencies = ExpressRollup.getBundleDependencies(bundle);
      const needed = !(await this.allFilesOlder(bundleOpts.dest, dependencies));
      if (needed) { // expired
        return {needed, bundle};
      }
      this.cache.get(bundleOpts.dest).resolve(dependencies);
      return {needed: false};
    }
    if (!jsExists && this.cache.has(bundleOpts.dest)) {
      // js is absent but cache item is here.
      if (this.cache.get(bundleOpts.dest).status === 'pending') {
        logger.check(`[f-, c+] Await the ${relDest} is built by other threads.`);
        await this.cache.get(bundleOpts.dest).promise;
        return {needed: false};
      } else {
        logger.check(`[f-, c+] Invalid cache item, due to losing ${relDest}`);
        this.refreshCache(bundleOpts.dest);
        return {needed: true};
      }
    }
    throw new Error('Unknown situation!');
  }
  handles(){
    return [
      async (req, res, next) => {
        if (!AVAIL_METHODS.includes(req.method)) {
          return next('route');
        }
        let {pathname} = url.parse(req.originalUrl);
        if (!this.opts.destExtension.test(pathname)) {
          return next('route');
        }
        if (this.opts.prefix && pathname.startsWith(this.opts.prefix)) {
          pathname = pathname.substring(this.opts.prefix.length);
        }
        const rollupOpts = _.defaults({
          entry: path.join(this.opts.root, this.opts.src, pathname
            .replace(new RegExp(`^${this.opts.dest}`), '')
            .replace(this.opts.destExtension, this.opts.bundleExtension))
        }, this.opts.rollupOpts);
        const bundleOpts = _.defaults({
          dest: path.join(this.opts.root, this.opts.dest,
            pathname.replace(new RegExp(`^${RegExp.quote(this.opts.dest)}`), ''))
        }, this.opts.bundleOpts);
        const rebuild = await this.checkNeedsRebuild(bundleOpts, rollupOpts);
        if (rebuild == null) {
          return next('route');
        }
        switch (this.opts.rebuild) {
        case 'always':
          rebuild.needed = true;
          break;
        case 'never':
          rebuild.needed = false;
          break;
        }
        _.extendOwn(res.locals, {rollupOpts, bundleOpts, rebuild})
        return next();
      },
      async (req, res, next) => {
        const {bundleOpts, rollupOpts, rebuild} = res.locals;
        logger.check('Needs rebuild: %s', rebuild.needed);
        if (rebuild.needed) {
          logger.build('Rolling up started');
          // checkNeedsRebuild may need to inspect the bundle, so re-use the
          // one already available instead of creating a new one
          if (rebuild.bundle) {
            await this.processBundle(rebuild.bundle, bundleOpts, res, next);
          } else {
            const bundle = await rollup.rollup(rollupOpts);
            await this.processBundle(bundle, bundleOpts, res, next);
          }
        } else if (this.opts.serve === true) {
          /** serves js code from cache by ourselves */
          res.status(200)
            .type(this.opts.type)
            .set('Cache-Control', `max-age=${this.opts.maxAge}`)
            .sendFile(bundleOpts.dest, err => {
              if (err) {
                console.error(err);
                res.status(err.status).end();
              } else {
                logger.res('Serving ourselves');
              }
            });
        } else {
          logger.res('Serving', 'by next()');
          next('route');
        }
      }
    ].map(func => _.wrap(func, ExpressRollup.errHandleWrapper));
  }
  async processBundle(bundle, bundleOpts, res, next) {
    // after loading the bundle, we first want to make sure the dependency
    // cache is up-to-date
    let bundled = bundle.generate(bundleOpts);
    logger.build('Rolling up finished');
    if (this.opts.isUglify) {
      logger.build('Uglify started');
      const uglifyOpts = _.defaults(bundleOpts.sourceMap ? {
        sourceMap: {
          content: bundled.map,
          'filename': path.basename(bundleOpts.dest)
        }
      } : {}, this.opts.uglifyOpts);
      bundled = UglifyJS.minify(bundled.code, uglifyOpts);
      if (bundled.error) {
        throw bundled.error;
      }
      if (bundled.warnings) {
        for (const warning of bundled.warnings) {
          logger.build('uglify:', warning);
        }
      }
      if (_.isString(bundled.map) && !_.isEmpty(bundled.map)) {
        const {map} = bundled;
        bundled.map = {
          toString(){
            return map;
          },
          toUrl(){
            return `data:application/json;charset=utf-8;base64,${Buffer.from(map, 'utf-8').toString('base64')}`;
          }
        }
      }
      logger.build('Uglify finished');
    }
    let isSent = false;
    if (this.opts.serve === true || this.opts.serve === 'on-compile') {
      isSent = true; // serves js code by ourselves
      logger.res('Serving ourselves');
      res.status(200)
        .type(this.opts.type)
        .set('Cache-Control', `max-age=${this.opts.maxAge}`)
        .send(bundled.code);
    }
    logger.build('Writing out started');
    await this.writeBundle(bundled, bundleOpts);
    logger.build('Writing out', 'finished');
    if (!isSent) {
      logger.res('Serving', 'by next()');
      next('route');
    }
    this.cache.get(bundleOpts.dest).resolve(ExpressRollup.getBundleDependencies(bundle));
  }
  async writeBundle({code, map}, {dest, sourceMap}) {
    const stats = await fsp.stat(path.dirname(dest)).catch(err => null);
    if (stats == null) {
      await fsp.mkdir(path.dirname(dest));
    } else if (!stats.isDirectory()) {
      throw new Error('Directory to write to does not exist (not a directory)');
    }
    if (map && sourceMap) {
      logger.build(`${sourceMap} sourceMap for ${path.relative(this.opts.root, dest)}`);
      if (sourceMap === 'inline') {
        code += '\n//# sourceMappingURL=' + map.toUrl();
      } else {
        code += '\n//# sourceMappingURL=' + path.basename(`${dest}.map`);
      }
    }
    const promises = [fsp.writeFile(dest, code)];
    if (map && sourceMap === true) {
      promises.push(fsp.writeFile(`${dest}.map`, map))
    }
    await Promise.all(promises);
  }
  allFilesOlder(file, files) {
    const statsPromises = [file].concat(files)
      .map(f => fsp.stat(f).then(stat => stat, () => false));
    return Promise.all(statsPromises).then((stats) => {
      const fileStat = stats[0];
      console.assert(fileStat, 'File tested for allFilesOlder does not exist?');
      logger.check('Stats loaded', `${stats.length - 1} dependencies`);
      for (let i = 1; i < stats.length; i += 1) {
        // return false if a file does not exist (any more)
        if (stats[i] === false) {
          return false;
        }
        if (fileStat.mtime.valueOf() <= stats[i].mtime.valueOf()) {
          logger.check('File is newer', path.relative(this.opts.root, files[i - 1]));
          return false;
        }
      }
      return true;
    }, (err) => {
      throw err;
    });
  }
}
module.exports = function createExpressRollup(options) {
  const opts = buildOpts(options);
  const router = express.Router();
  const expressRollup = new ExpressRollup(opts);
  router.get(`*${opts.bundleExtension}`, ExpressRollup.guardHandle)
        .get(opts.destExtension, ...expressRollup.handles());
  return router;
};
function buildOpts(options){
  const opts = _.extendOwn({}, defaults);
  if (options.mode === 'polyfill' || (!options.mode && defaults.mode === 'polyfill')) {
    if (options.dest || options.serve || options.bundleExtension) {
      console.warn('Explicitly setting options of compile mode in polyfill mode');
    }
    // some default values will be different if mode === 'polyfill'
    _.extendOwn(opts, {
      serve: true,
      bundleExtension: '.js',
      dest: options.cache || options.dest || 'cache'
    });
  }
  _.extendOwn(opts, options);
  // We're not fancy enough to use recursive option merging (yet), so...
  opts.rollupOpts = _.extendOwn({}, defaults.rollupOpts);
  _.extendOwn(opts.rollupOpts, options.rollupOpts);
  opts.bundleOpts = _.extendOwn({}, defaults.bundleOpts);
  _.extendOwn(opts.bundleOpts, options.bundleOpts);
  // Source directory (required)
  console.assert(opts.src, 'rollup middleware requires src directory.');
  // Destination directory (source by default)
  opts.dest = opts.dest || opts.src;
  return opts;
}
function defer(){
  const _defer = {};
  _defer.state = 'pending';
  _defer.promise = new Promise((_resolve, _reject) => {
    Object.assign(_defer, {
      resolve(result){
        _resolve(result);
        _defer.state = 'resolved';
        return _defer;
      },
      reject(err){
        _reject(err);
        _defer.state = 'rejected';
        return _defer;
      }
    });
  });
  return _defer;
}