"use strict";
let fs = require("graceful-fs");
let url = require("url");
let Salesforce = require("./salesforce");

module.exports.async = function(generator) {
  return function(...args) {
    let iterator = generator.apply(this, args);
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
};

module.exports.timeout = function(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
};

module.exports.login = module.exports.async(function*(options) {
  let pwfileName = (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) + "/forcepw.json";
  if (options.verbose) {
    console.log("- Looking for password in file: " + pwfileName);
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
  let sfConn = new Salesforce();
  /* eslint-disable no-underscore-dangle */
  if (options.netlog) {
    let oldRequestNetlog = sfConn._request;
    sfConn._request = function(...args) {
      let [httpsOptions, requestBody] = args;
      return oldRequestNetlog.apply(this, args).then(res => {
        console.log("request success");
        console.log("request options:", httpsOptions);
        console.log("request body:", requestBody);
        console.log("response body:", res.responseBody);
        return res;
      }, err => {
        console.log("request error");
        console.log("request options:", httpsOptions);
        console.log("request body:", requestBody);
        console.log("response:", err);
        throw err;
      });
    };
  }
  let oldRequest = sfConn._request;
  sfConn._request = function(...args) {
    let doRequest = retries =>
      oldRequest.apply(this, args).catch(err => {
        if (err && err.networkError && err.networkError.errno == "ETIMEDOUT" && err.networkError.syscall == "connect" && retries > 0) {
          console.log("(Got connect ETIMEDOUT, retrying)");
          return doRequest(retries - 1);
        }
        if (err && err.networkError && err.networkError.errno == "ECONNRESET" && err.networkError.syscall == "read" && retries > 0) {
          console.log("(Got read ECONNRESET, retrying)");
          return doRequest(retries - 1);
        }
        throw err;
      });
    return doRequest(10);
  };
  /* eslint-enable no-underscore-dangle */
  yield sfConn.partnerLogin({hostname: loginUrl.hostname, apiVersion: config.apiVersion, username: config.username, password});
  return sfConn;
});

module.exports.asArray = Salesforce.asArray;

module.exports.complete = module.exports.async(function*(doCheck) {
  let interval = 1000;
  yield module.exports.timeout(interval);
  for (;;) {
    let result = yield doCheck();
    if (result.done !== "false") {
      return result;
    }
    interval *= 1.3;
    yield module.exports.timeout(interval);
  }
});

module.exports.nfcall = function nfapply(fn, ...args) {
  return new Promise((resolve, reject) => {
    function nodeResolver(error, ...values) {
      if (error) {
        reject(error);
      } else if (values.length > 1) {
        resolve(values);
      } else {
        resolve(values[0]);
      }
    }
    try {
      fn.apply(undefined, [...args, nodeResolver]);
    } catch (e) {
      reject(e);
    }
  });
};
