const cluster = require('cluster');
const debug = require('debug');
const _ = require('underscore');
const pckg = require('../package.json');

_.extendOwn(exports, {
  debug(category){
    if (cluster.isWorker) {
      return debug(`${pckg.name}[${cluster.worker.process.pid}/${cluster.worker.id}]:${category}`);
    }
    return debug(`${pckg.name}:${category}`);
  }
});
