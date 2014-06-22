var jsforce = require("jsforce");
var fs = require("fs");
var Promise = require("jsforce/lib/promise");
var q = require("q");
module.exports.login = function() {
  return Promise
    .all([
      q.nfcall(fs.readFile, "forcecmd.json", "utf-8"),
      q.nfcall(fs.readFile, (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) + "/forcepw.json", "utf-8")
    ])
    .then(function(files) {
      var file = files[0];
      var pwfile = files[1];
      var config = JSON.parse(file);
      module.exports.apiVersion = config.apiVersion;
      var password = JSON.parse(pwfile).passwords[config.loginUrl + "$" + config.username];
      if (!config.loginUrl) throw "Missing loginUrl";
      if (!config.username) throw "Missing username";
      if (!password) throw "Missing password";
      if (!config.apiVersion) throw "Missing apiVersion";
      var conn = new jsforce.Connection({loginUrl: config.loginUrl, version: module.exports.apiVersion});
      console.log("Login");
      return conn.login(config.username, password).then(function() { return conn; });
    });
}
