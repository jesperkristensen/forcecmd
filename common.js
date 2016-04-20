"use strict";
var fs = require("graceful-fs");
var url = require("url");
var salesforce = require("./salesforce");

module.exports.login = function(options) {
  var pwfileName = (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) + "/forcepw.json";
  if (options.verbose) {
    console.log("- Looking for password in file: " + pwfileName );
  }
  return Promise
    .all([
      module.exports.nfcall(fs.readFile, "forcecmd.json", "utf-8"),
      module.exports.nfcall(fs.readFile, pwfileName, "utf-8")
    ])
    .then(function(files) {
      var file = files[0];
      var pwfile = files[1];
      var config = JSON.parse(file);
      module.exports.apiVersion = config.apiVersion;
      module.exports.excludeDirs = config.excludeDirs || [];
      module.exports.includeObjects = config.includeObjects || [];
      module.exports.excludeObjects = config.excludeObjects || [];
      var pwKey = config.loginUrl + "$" + config.username;
      if (options.verbose) {
        console.log("- Looking for password with key: " + pwKey);
      }
      var password = JSON.parse(pwfile).passwords[pwKey];
      if (!config.loginUrl) throw "Missing loginUrl";
      if (!config.username) throw "Missing username";
      if (!password) throw "Missing password";
      if (!config.apiVersion) throw "Missing apiVersion";
      let loginUrl = url.parse(config.loginUrl);
      if (loginUrl.protocol != "https:") throw "loginUrl must start with https://";
      if (loginUrl.port) throw "loginUrl must use the default port";
      console.log("Login " + loginUrl.hostname + " " + config.username + " " + config.apiVersion);
      let sfConn = new salesforce();
      return sfConn.partnerLogin({hostname: loginUrl.hostname, apiVersion: config.apiVersion, username: config.username, password}).then(() => sfConn);
    });
}

module.exports.asArray = salesforce.asArray;

module.exports.complete = function complete(doCheck, isDone) {
  return new Promise(function(resolve, reject) {
    var interval = 1000;
    var poll = function() {
      doCheck().then(function(result) {
        if (isDone(result)) {
          resolve(result);
        } else {
          interval *= 1.3;
          setTimeout(poll, interval);
        }
      }, function(err) {
        reject(err);
      });
    };
    setTimeout(poll, interval);
  });
}

module.exports.nfcall = function nfapply(fn) {
  var args = Array.prototype.slice.call(arguments, 1);
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
    } catch(e) {
      reject(e);
    }
  });
}