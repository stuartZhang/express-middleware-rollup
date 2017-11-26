
try {
  require('fecha');
} catch (e) {}
const _ = require('underscore');
const debug = require('debug');
const rollup = require('rollup');
const fsp = require('fs-promise');
const url = require('url');
const path = require('path');
_.defaults(RegExp, {quote: require("regexp-quote")});

const logger = {
  check: debug('express-rollup-mw:check'),
  build: debug('express-rollup-mw:build'),
  res: debug('express-rollup-mw:res')
};
const AVAIL_METHODS = ['GET', 'HEAD'];
const EXT_REGEX = /\.js$/;
const defaults = {
  mode: 'compile',
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
  rollupOpts: {},
  bundleOpts: { format: 'iife' },
  debug: false,
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
  static get [Symbol.species]() {
    return this;
  }
  constructor(opts) {
    this.opts = opts;
    // Cache for bundles' dependencies list
    this.cache = {};
    this.lastTimeStamp = Date.now();
    this[Symbol.toStringTag] = 'ExpressRollup';
  }
  async checkNeedsRebuild(bundleOpts, rollupOpts) {
    const [entryExists, jsExists] = await Promise.all([
      fsp.access(rollupOpts.entry, fsp.F_OK).then(() => true, err => false),
      fsp.access(bundleOpts.dest, fsp.F_OK).then(() => true, err => false)
    ]);
    if (!entryExists) {
      return null;
    }
    logger.check('source: %s', rollupOpts.entry);
    logger.check('dest: %s', bundleOpts.dest);
    if (!this.cache.hasOwnProperty(bundleOpts.dest) || !jsExists) {
      logger.check('Cache miss');
      if (jsExists) { // 刷新内存缓存清单
        const bundle = await rollup.rollup(rollupOpts);
        logger.check('Bundle loaded');
        const dependencies = ExpressRollup.getBundleDependencies(bundle);
        this.cache[bundleOpts.dest] = dependencies;
        const needed = await this.allFilesOlder(bundleOpts.dest, dependencies);
        return {
          needed: !needed,
          bundle
        };
      } // it does not exist, so we MUST rebuild (allFilesOlder = false)
      return {needed: true};
    }
    const allOlder = await this.allFilesOlder(bundleOpts.dest, this.cache[bundleOpts.dest]);
    return {needed: !allOlder};
  }
  handles(){
    return [
      async (req, res, next) => {
        if (!AVAIL_METHODS.includes(req.method)) {
          return next('route');
        }
        let {pathname} = url.parse(req.url);
        if (!EXT_REGEX.test(pathname)) {
          return next('route');
        }
        if (this.opts.prefix && pathname.startsWith(this.opts.prefix)) {
          pathname = pathname.substring(this.opts.prefix.length);
        }
        const rollupOpts = _.defaults({
          entry: path.join(this.opts.root, this.opts.src, pathname
            .replace(new RegExp(`^${this.opts.dest}`), '')
            .replace(EXT_REGEX, this.opts.bundleExtension))
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
            this.processBundle(rebuild.bundle, bundleOpts, res, next);
          } else {
            const bundle = await rollup.rollup(rollupOpts);
            this.processBundle(bundle, bundleOpts, res, next);
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
          return next();
        }
      }
    ].map(func => _.wrap(func, ExpressRollup.errHandleWrapper));
  }
  processBundle(bundle, bundleOpts, res, next) {
    // after loading the bundle, we first want to make sure the dependency
    // cache is up-to-date
    this.cache[bundleOpts.dest] = ExpressRollup.getBundleDependencies(bundle);
    const bundled = bundle.generate(bundleOpts);
    logger.build('Rolling up finished');
    const writePromise = this.writeBundle(bundled, bundleOpts);
    logger.build('Writing out started');
    if (this.opts.serve === true || this.opts.serve === 'on-compile') {
      /** serves js code by ourselves */
      logger.res('Serving ourselves');
      res.status(200)
        .type(this.opts.type)
        .set('Cache-Control', `max-age=${this.opts.maxAge}`)
        .send(bundled.code);
    } else {
      writePromise.then(() => {
        logger.res('Serving', 'by next()');
        next();
      } /* Error case for this is handled below */);
    }
    writePromise.then(() => {
      logger.build('Writing out', 'finished');
    }, (err) => {
      console.error(err);
      // Hope, that maybe another middleware can handle things
      next();
    });
  }
  writeBundle(bundle, {dest, sourceMap}) {
    const dirExists = fsp.stat(path.dirname(dest))
      .catch(() => Promise.reject('Directory to write to does not exist'))
      .then(stats => (!stats.isDirectory()
        ? Promise.reject('Directory to write to does not exist (not a directory)')
        : Promise.resolve()));

    return dirExists.then(() => {
      let {code, map} = bundle;
      if (map && sourceMap) {
        logger.build(`${sourceMap} sourceMap for ${dest}`);
        if (sourceMap === 'inline') {
          code += '\n//# sourceMappingURL=' + map.toUrl();
        } else {
          code += '\n//# sourceMappingURL=' + path.basename(path.basename(`${dest}.map`));
        }
      }
      let promise = fsp.writeFile(dest, code);
      if (map && sourceMap === true) {
        const mapPromise = fsp.writeFile(`${dest}.map`, map);
        promise = Promise.all([promise, mapPromise]);
      }
      return promise;
    }, (err) => { throw err; });
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
          logger.check('File is newer', files[i - 1]);
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
  const opts = Object.assign({}, defaults);
  if (options.mode === 'polyfill' || (!options.mode && defaults.mode === 'polyfill')) {
    if (options.dest || options.serve || options.bundleExtension) {
      console.warn('Explicitly setting options of compile mode in polyfill mode');
    }
    // some default values will be different if mode === 'polyfill'
    Object.assign(opts, {
      serve: true,
      bundleExtension: '.js',
      dest: options.cache || options.dest || 'cache'
    });
  }
  Object.assign(opts, options);
  // We're not fancy enough to use recursive option merging (yet), so...
  opts.rollupOpts = Object.assign({}, defaults.rollupOpts);
  Object.assign(opts.rollupOpts, options.rollupOpts);
  opts.bundleOpts = Object.assign({}, defaults.bundleOpts);
  Object.assign(opts.bundleOpts, options.bundleOpts);
  // Source directory (required)
  console.assert(opts.src, 'rollup middleware requires src directory.');
  // Destination directory (source by default)
  opts.dest = opts.dest || opts.src;
  //
  const expressRollup = new ExpressRollup(opts);
  return expressRollup.handles();
};
