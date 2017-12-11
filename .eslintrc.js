'use strict';

module.exports = {
  'parserOptions': {
    'ecmaVersion': 5,
    'sourceType': 'module',
    'ecmaFeatures': {
      'globalReturn': true,
      'impliedStrict': false,
      'jsx': false,
      'experimentalObjectRestSpread': false
    }
  },
  'env': {
    'es6': true,
    'node': true
  },
  'extends': [
    'eslint:recommended',
    'amo/eslint-config-bestpractice.js',
    'amo/eslint-config-errors.js',
    'amo/eslint-config-es6.js',
    'amo/eslint-config-node.js',
    'amo/eslint-config-possibleerrors.js',
    'amo/eslint-config-stylistic.js',
    'amo/eslint-config-var.js'
  ],
  'plugins': ['amo'],
  'rules': {
    'amo/no-string-charcode': 'off'
  },
  'parser': 'babel-eslint',
  'root': true
};
