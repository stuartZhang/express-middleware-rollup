# express-middleware-rollup
Express middleware for [rollup](http://rollupjs.org/) + [Babel](https://babeljs.io/)

[![Npm version](https://d25lcipzij17d.cloudfront.net/badge.svg?id=js&type=6&v=5.5&x2=0)](https://badge.fury.io/js/express-middleware-rollup)
![Node version](https://img.shields.io/badge/node-%3E%3D%208.9-yellow.svg)
[![Build Status](https://travis-ci.org/suluke/express-middleware-rollup.svg?branch=master)](https://travis-ci.org/suluke/express-middleware-rollup)

## Motivation
作为一位资深的全栈WEB开发者，你是否已经厌倦了各种File Watch的配置，也非常地嫌弃手动预编译\*.mjs文件的麻烦（虽然那仅只意为着Ctrl+Shift+B）。如果是那样的话，请你向这看，我最初受到了JSP工作原理的启发，然后又被[express-babelify-middleware](https://github.com/luisfarzati/express-babelify-middleware)与[express-sass-middleware](https://github.com/shamsup/express-sass-middleware)开源项目震撼。嗯！原来前端\*.mjs的预编译还能这么玩！

就[express-sass-middleware](https://github.com/shamsup/express-sass-middleware)的开箱即用，我直接拿来享用。鉴于[express-babelify-middleware](https://github.com/luisfarzati/express-babelify-middleware)的完善与强大，我曾经一度考虑放弃[rollup](http://rollupjs.org/)而转向[Browserify](https://github.com/browserify/browserify)的怀抱。但是，我不幸地被历史包袱拖累（例如，[自制Rollup-WebWorker打包插件](https://cnodejs.org/topic/5826f9acd3abab717d8b4be6)）。打包工具的“转型”决策真心地艰难。

所以，我fork了[suluke](https://github.com/suluke)的[express-middleware-rollup](https://github.com/suluke/express-middleware-rollup)，努力构建一款更完善的“即时预编译器”。

## Function and Mechanism
简单地说，就是 预编译ES6/7的*.mjs文件为ES5的\*.js文件。但是，它即不是配置File Watch来实时地扫描硬盘检查文件修改，也不是从VSCode中利用Ctrl+Shift+B快捷键来手动触发预编译命令，而是模拟JSP编译为Servlet的工作原理：
1. \*.mjs文件就被保存在[Express](https://expressjs.com/)的public目录下（类似于JSP被保存在J2EE的WebContent目录内），而不需要你做任何项目的事情。
1. 当入口\*.js文件被从浏览器**第一次**访问时，express-middleware-rollup中间件就会自动地
    1. 关联js背后的所有mjs文件
    1. 利用[Babel](https://babeljs.io/)编译mjs为js文件。
    1. 以iife格式（可配置改变的），打包js文件
    1. 甚至，混淆被打包后的js文件。（可配置关闭）
    1. 最终，将编译+打包+混淆结果保存到硬盘上。
1. 以后，当相同的入口js文件再次被浏览器下载执行时，Express Rollup中间件就直接返回硬盘上的保存结果。 

express-middleware-rollup算是[express-babelify-middleware](https://github.com/luisfarzati/express-babelify-middleware)基于[rollup](http://rollupjs.org/)打包器的复刻版。它的工作原理也与后端模板引擎雷同。

## Install
npm-install is still unavailable. But it's upcoming.

## Basic Usage
Assuming a directory setup (from [experess-generator](https://expressjs.com/en/starter/generator.html)) like the following of your project:
```
.
├── public
│   └── javascripts
│       ├── repl.mjs
│       └── repl-es5.js
├── app.js
└── views
    └── index.hbs
```
In your `app.js` write the following:
```
const express = require('express');
const rollup  = require('express-middleware-rollup');
const path    = require('path');
const app = express();
app.use('/javascripts', rollupMiddleware({
  src: 'public',
  destExtension: /-es5\.js$/,
  bundleExtension: '.mjs', // The access to *.mjs will be forbidden.
  root: __dirname,
  bundleOpts: {
    sourceMap: 'inline'
  }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.listen(3000);
```
Now, if you request `localhost:3000/repl-es5.js`, the middleware will automatically bundle `public/javascripts/repl.bjs` using rollup into a file that is ready to be served by `express.static` middleware.

## Options
Options which are available in both modes are:
* `src`: (String, required). Directory where to look for bundle entries
* `root`: (String, default: `process.cwd()`). Directory which other paths (like `src`) are relative to
* `rebuild`: (String, default: `'deps-change'`). Strategy used to determine whether to re-run `rollup` if a compiled/cached bundle exists. Can be  `'deps-change'`, `'never'` or `'always'`
* `rollupOpts`: (Object, default: `{}`). Options that will be passed to [`rollup.rollup`](https://github.com/rollup/rollup/wiki/JavaScript-API#rolluprollup-options-). `entry` is set by the plugin, though.
* `bundleOpts`: (Object, default: `{ format: 'iife' }`). Options passed to [`bundle.generate`](https://github.com/rollup/rollup/wiki/JavaScript-API#bundlegenerate-options-)
* `uglifyOpts` (Object, default: `{ warnings: true, ie8: true }`). Options passed to [UglifyJS2](https://github.com/mishoo/UglifyJS2).
* `isUglify` (Boolean, default: `true`)
* `prefix`: (String, default: `null`)
* `dest`: (String, default: value of `src`)
* `destExtension`: (RegExp, default: /\.js$/)
* `bundleExtension`: (String, default: `'.bundle'`)

## Troubleshooting
### Different module file extensions than `.js`
Let's say you have files with `.jsx` or `.es6` as file extension in your project but you still want to `import` them without any extension specified in your code.
Then you were probably hoping for an option similar to browserify's [`--extension` option](https://github.com/substack/node-browserify#usage).
Unfortunately, the rollup team [does not seem to favor a solution like that](https://github.com/rollup/rollup/issues/448).
Therefore, I am afraid yo're stuck specifying the extension of the files you import in your code.

## Why?
Essentially, the reasons for why you would want to use this middleware are the same as for middlewares like [browserify-middleware](https://github.com/ForbesLindesay/browserify-middleware) or [node-sass-middleware](https://github.com/sass/node-sass-middleware):
You like it simple and don't want to set up a build pipeline with `gulp`/`grunt`/`broccoli`/`webpack`/`file watchers` etc.
Also, you don't really need hot-reloading on save, since you are able to press f5 on your own.
And maybe you also have the problem that you don't want to choose between having compiled files in your repo and forcing the server guys to build the client code each time they pull.
With this package, you can simply have your server handle the build process, just when it's needed and only if it's needed.

## Credits
This middleware is heavily influenced by [node-sass-middleware](https://github.com/sass/node-sass-middleware)

## Copyright
Copyright (c) 2016+ Lukas Böhm. See [LICENSE](LICENSE) for details.
