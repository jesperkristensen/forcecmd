"use strict";
let fs = require("graceful-fs");
let url = require("url");
let salesforce = require("./salesforce");

module.exports.async = function(generator) {
  return function() {
    let iterator = generator.apply(this, arguments);
    return new Promise((resolve, reject) => {
      function await(step) {
        if (step.done) {
          resolve(step.value);
          return;
        }
        Promise.resolve(step.value).then(iterator.next.bind(iterator), iterator.throw.bind(iterator)).then(await, reject);
      }
      await(iterator.next());
    });
  };
}

module.exports.timeout = function(ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms);
  });
}

module.exports.login = module.exports.async(function*(options) {
  let pwfileName = (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) + "/forcepw.json";
  if (options.verbose) {
    console.log("- Looking for password in file: " + pwfileName );
  }
  let filePromise = module.exports.nfcall(fs.readFile, "forcecmd.json", "utf-8");
  let pwfilePromise = module.exports.nfcall(fs.readFile, pwfileName, "utf-8");
  let file = yield filePromise;
  let pwfile = yield pwfilePromise;
  let config = JSON.parse(file);
  module.exports.apiVersion = config.apiVersion;
  module.exports.excludeDirs = config.excludeDirs || [];
  module.exports.objects = config.objects || {};
  if (config.includeObjects) throw "includeObjects is obsolete";
  if (config.excludeObjects) throw "excludeObjects is obsolete";
  let pwKey = config.loginUrl + "$" + config.username;
  if (options.verbose) {
    console.log("- Looking for password with key: " + pwKey);
  }
  let password = JSON.parse(pwfile).passwords[pwKey];
  if (!config.loginUrl) throw "Missing loginUrl";
  if (!config.username) throw "Missing username";
  if (!password) throw "Missing password";
  if (!config.apiVersion) throw "Missing apiVersion";
  let loginUrl = url.parse(config.loginUrl);
  if (loginUrl.protocol != "https:") throw "loginUrl must start with https://";
  if (loginUrl.port) throw "loginUrl must use the default port";
  console.log("Login " + loginUrl.hostname + " " + config.username + " " + config.apiVersion);
  let sfConn = new salesforce();
  let oldRequest = sfConn._request;
  sfConn._request = function() {
    let doRequest = retries => {
      return oldRequest.apply(this, arguments).catch(err => {
        if (err && err.networkError && err.networkError.errno == "ETIMEDOUT" && err.networkError.syscall == "connect" && retries > 0) {
          console.log("(Got connect ETIMEDOUT, retrying)");
          return doRequest(retries - 1);
        }
        throw err;
      });
    }
    return doRequest(10);
  }
  yield sfConn.partnerLogin({hostname: loginUrl.hostname, apiVersion: config.apiVersion, username: config.username, password});
  return sfConn;
});

module.exports.asArray = salesforce.asArray;

module.exports.complete = module.exports.async(function*(doCheck) {
  let interval = 1000;
  yield module.exports.timeout(interval);
  while (true) {
    let result = yield doCheck()
    if (result.done !== "false") {
      return result;
    }
    interval *= 1.3;
    yield module.exports.timeout(interval);
  }
});

module.exports.nfcall = function nfapply(fn) {
  let args = Array.prototype.slice.call(arguments, 1);
  return new Promise(function(resolve, reject) {
    try {
      function nodeResolver(error, value) {
        if (error) {
          reject(error);
        } else if (arguments.length > 2) {
          resolve(Array.prototype.slice.call(arguments, 1));
        } else {
          resolve(value);
        }
      }
      args.push(nodeResolver);
      fn.apply(undefined, args);
    } catch (e) {
      reject(e);
    }
  });
}