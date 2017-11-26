'use strict';

const debug = require('debug');
const rollup  = require('rollup');
const fsp     = require('fs-promise');

const logger = {
  prepare: debug('express-rollup-mw:prepare'),
  check: debug('express-rollup-mw:check'),
  build: debug('express-rollup-mw:build'),
  res: debug('express-rollup-mw:res')
};

let fecha     = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved, node/no-missing-require
  fecha = require('fecha');
} catch (e) { /* empty */ }
const url     = require('url');
const path    = require('path');
const dirname = require('path').dirname;
const join    = require('path').join;
const extRegex = /\.js$/;
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
  constructor(opts) {
    this.opts = opts;
    // Cache for bundles' dependencies list
    this.cache = {};
    this.lastTimeStamp = Date.now();
  }
  handle(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }
    const opts = this.opts;
    const src = opts.src;
    const dest = opts.dest;
    const root = opts.root;
    const rollupOpts = Object.assign({}, opts.rollupOpts);
    const bundleOpts = Object.assign({}, opts.bundleOpts);

    let pathname = url.parse(req.url).pathname;
    if (opts.prefix && pathname.indexOf(opts.prefix) === 0) {
      pathname = pathname.substring(opts.prefix.length);
    }
    if (!extRegex.test(pathname)) {
      return next();
    }
    const jsPath = join(root, dest, pathname.replace(new RegExp(`^${dest}`), ''));
    const bundlePath = join(root, src, pathname
          .replace(new RegExp(`^${dest}`), '')
          .replace(extRegex, opts.bundleExtension));

    logger.prepare('source: %s', bundlePath);
    logger.prepare('dest: %s', jsPath);

    rollupOpts.entry = bundlePath;
    bundleOpts.dest = jsPath;
    this.checkNeedsRebuild(jsPath, rollupOpts).then((rebuild) => {
      logger.check('Needs rebuild: %s', rebuild.needed);
      if (rebuild.needed) {
        logger.build('Rolling up started');
        // checkNeedsRebuild may need to inspect the bundle, so re-use the
        // one already available instead of creating a new one
        if (rebuild.bundle) {
          this.processBundle(rebuild.bundle, bundleOpts, res, next, opts);
        } else {
          rollup.rollup(rollupOpts).then((bundle) => {
            this.processBundle(bundle, bundleOpts, res, next, opts);
          }, (err) => {
            console.error(err);
          });
        }
        return true;
      } else if (opts.serve === true) {
        /** serves js code from cache by ourselves */
        res.status(200)
          .type(opts.type)
          .set('Cache-Control', `max-age=${opts.maxAge}`)
          .sendFile(jsPath, (err) => {
            if (err) {
              console.error(err);
              res.status(err.status).end();
            } else {
              logger.res('Serving ourselves');
            }
          });
        return true;
      }
      logger.res('Serving', 'by next()');
      return next();
    }, (err) => {
      console.error(err);
    });
    return true;
  }

  processBundle(bundle, bundleOpts, res, next, opts) {
    // after loading the bundle, we first want to make sure the dependency
    // cache is up-to-date
    this.cache[bundleOpts.dest] = ExpressRollup.getBundleDependencies(bundle);
    const bundled = bundle.generate(bundleOpts);
    logger.build('Rolling up finished');
    const writePromise = this.writeBundle(bundled, bundleOpts);
    logger.build('Writing out started');
    if (opts.serve === true || opts.serve === 'on-compile') {
      /** serves js code by ourselves */
      logger.res('Serving ourselves');
      res.status(200)
        .type(opts.type)
        .set('Cache-Control', `max-age=${opts.maxAge}`)
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
    const dirExists = fsp.stat(dirname(dest))
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

  async checkNeedsRebuild(jsPath, rollupOpts) {
    const jsExists = await fsp.access(jsPath, fsp.F_OK).then(() => true, err => {
      Reflect.deleteProperty(this.cache, jsPath);
      return false;
    });
    if (this.opts.rebuild !== 'never' && (!this.cache.hasOwnProperty(jsPath) || this.opts.rebuild === 'always')) {
      logger.check(this.opts.rebuild === 'always' ? 'Always rebuild' : 'Cache miss');
      if (jsExists) {
        const bundle = await rollup.rollup(rollupOpts);
        logger.check('Bundle loaded');
        const dependencies = ExpressRollup.getBundleDependencies(bundle);
        this.cache[jsPath] = dependencies;
        const needed = await this.allFilesOlder(jsPath, dependencies);
        return {
          needed: !needed,
          bundle
        };
      } // it does not exist, so we MUST rebuild (allFilesOlder = false)
      return {needed: true};
    }
    const allOlder = await this.allFilesOlder(jsPath, this.cache[jsPath]);
    return {needed: !allOlder};
  }

  static getBundleDependencies(bundle) {
    return bundle.modules.map(module => module.id).filter(path.isAbsolute);
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

  const expressRollup = new ExpressRollup(opts);
  // eslint-disable-next-line prefer-rest-params, prefer-spread
  function middleware() { expressRollup.handle.apply(expressRollup, arguments); }
  return middleware;
};
