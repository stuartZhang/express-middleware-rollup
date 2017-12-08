'use strict';
/* eslint-disable no-sync */
/* global describe before it after */
const fs = require('fs');
const path = require('path');
const plugin = require('./rollup-plugin');
const express = require('express');
const rollup = require('../../../');
const request = require('supertest');

const app = express();
app.use(rollup({
  'src': './',
  'dest': './',
  'root': __dirname,
  'serve': 'on-compile',
  // Because we can't know reliably what express' mime.lookup returns for the default 'javascript'
  'type': 'application/javascript',
  'rollupOpts': {'plugins': [plugin]}
}));

describe('virtual bundle dependencies', () => {
  const cachePath = path.join(__dirname, 'module.js');
  before(() => {
    try {
      fs.statSync(cachePath).isFile(); // throws if not existing
      fs.unlinkSync(cachePath);
    } catch (e) {
      // do nothing
    }
  });
  after(() => {
    fs.unlinkSync(cachePath);
  });
  it('respond with javascript', done => {
    request(app).get('/module.js')
    .expect('Content-Type', /javascript/)
    .expect(200)
    .end(err => {
      if (err) {
        return done(err);
      }
      return request(app).get('/module.js')
      .expect(404, done); // we don't have a static middleware installed and `serve` is 'on-compile' only
    });
  });
});
