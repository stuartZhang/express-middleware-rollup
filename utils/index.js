const cluster = require('cluster');
const debug = require('debug');
const _ = require('underscore');
const pckg = require('../package.json');

_.defaults(String.prototype, {
  at(position){
    return String.fromCodePoint(this.codePointAt(position));
  }
});

_.extendOwn(exports, {
  debug(category){
    if (cluster.isWorker) {
      return debug(`${pckg.name}[${cluster.worker.process.pid}/${cluster.worker.id}]:${category}`);
    }
    return debug(`${pckg.name}:${category}`);
  }
});
