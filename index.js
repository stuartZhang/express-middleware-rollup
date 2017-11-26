'use strict';

const rollup  = require('rollup');
const fsp     = require('fs-promise');

let fecha     = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved, node/no-missing-require
  fecha = require('fecha');
} catch (e) { /* empty */ }
const url     = require('url');
const path    = require('path');
const dirname = require('path').dirname;
const join    = require('path').join;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`\x07\x1B[31m${message}\x1B[91m`);
  }
}

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
  log(key, val) {
    if (this.opts.debug) {
      let time = '';
      let diff = '';
      if (fecha !== null) {
        const now = new Date();
        time = `${fecha.format(now, 'hh:mm:ss')} `;
        diff = `+${fecha.format(now.getTime() - this.lastTimeStamp, 'ss.SSS')} `;
        this.lastTimeStamp = now;
      }
      if (!val) {
        console.error('\x1B[33m%s\x1B[34m%s\x1B[36m%s\x1B[0m', diff, time, key);
      } else {
        console.error('\x1B[33m%s\x1B[34m%s\x1B[90m%s: \x1B[36m%s\x1B[0m', diff, time, key, val);
      }
    }
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
    const extRegex = /\.js$/;

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

    this.log('source', bundlePath);
    this.log('dest', jsPath);

    rollupOpts.entry = bundlePath;
    bundleOpts.dest = jsPath;
    this.checkNeedsRebuild(jsPath, rollupOpts).then((rebuild) => {
      if (rebuild.needed) {
        this.log('Needs rebuild', 'true');
        this.log('Rolling up', 'started');
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
              this.log('Serving', 'ourselves');
            }
          });
        return true;
      }
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
    this.log('Rolling up', 'finished');
    const writePromise = this.writeBundle(bundled, bundleOpts);
    this.log('Writing out', 'started');
    if (opts.serve === true || opts.serve === 'on-compile') {
      /** serves js code by ourselves */
      this.log('Serving', 'ourselves');
      res.status(200)
        .type(opts.type)
        .set('Cache-Control', `max-age=${opts.maxAge}`)
        .send(bundled.code);
    } else {
      writePromise.then(() => {
        this.log('Serving', 'by next()');
        next();
      } /* Error case for this is handled below */);
    }
    writePromise.then(() => {
      this.log('Writing out', 'finished');
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
        this.log(`${sourceMap} sourceMap for ${dest}`);
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
      assert(fileStat, 'File tested for allFilesOlder does not exist?');
      this.log('Stats loaded', `${stats.length - 1} dependencies`);
      for (let i = 1; i < stats.length; i += 1) {
        // return false if a file does not exist (any more)
        if (stats[i] === false) {
          return false;
        }
        if (fileStat.mtime.valueOf() <= stats[i].mtime.valueOf()) {
          this.log('File is newer', files[i - 1]);
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
      this.log(this.opts.rebuild === 'always' ? 'Always rebuild' : 'Cache miss');
      if (jsExists) {
        const bundle = await rollup.rollup(rollupOpts);
        this.log('Bundle loaded');
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
  assert(opts.src, 'rollup middleware requires src directory.');
  // Destination directory (source by default)
  opts.dest = opts.dest || opts.src;

  const expressRollup = new ExpressRollup(opts);
  // eslint-disable-next-line prefer-rest-params, prefer-spread
  function middleware() { expressRollup.handle.apply(expressRollup, arguments); }
  return middleware;
};
