"use strict";
let fs = require("graceful-fs");
let SalesforceConnection = require("node-salesforce-connection");
let {nfcall} = require("./promise-utils");

// Login using the configuration from ./forcecmd.json and password from ~/forcepw.json
async function forcecmdLogin(options) {
  if (options.verbose) {
    console.log("- Running from directory: " + __dirname);
  }
  let config = JSON.parse(await nfcall(fs.readFile, "forcecmd.json", "utf-8"));
  let sfConn = await salesforceLogin(Object.assign({robust: true}, config, options));
  if (!config.apiVersion) {
    console.log("API-Versions");
    let apis = await sfConn.rest("/services/data");
    let latestApi = apis.pop();
    console.log({label: latestApi.label, version: latestApi.version});
    config.apiVersion = latestApi.version;
  }
  return {sfConn, config};
}

// Login using a custom configuration and optionally password from ~/forcepw.json
async function salesforceLogin({apiVersion, hostname, username, password, robust, verbose}) {
  if (!apiVersion) apiVersion = "45.0";
  if (!hostname) throw new Error("Missing hostname");
  if (!username) throw new Error("Missing username");

  if (!password && process.env.FORCEPW) {
    if (verbose) {
      console.log("- Using password from FORCEPW environment variable");
    }
    password = process.env.FORCEPW;
  }

  if (!password) {
    let pwfileName = (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) + "/forcepw.json";
    if (verbose) {
      console.log("- Looking for password in file: " + pwfileName);
    }
    let pwfile = JSON.parse(await nfcall(fs.readFile, pwfileName, "utf-8"));
    let pwKey = hostname + ":" + username;
    if (verbose) {
      console.log("- Looking for password with key: " + pwKey);
    }
    password = pwfile.passwords[pwKey];
  }
  if (!password) throw new Error("Missing password");

  let sfConn = new SalesforceConnection();

  /* eslint-disable no-underscore-dangle */
  if (robust) {
    let oldRequest = sfConn._request;
    sfConn._request = function(...args) {
      let doRequest = retries =>
        oldRequest.apply(this, args).catch(err => {
          if (err.errno == "ETIMEDOUT" && err.syscall == "connect" && retries > 0) {
            console.log("(Got connect ETIMEDOUT, retrying)");
            return doRequest(retries - 1);
          }
          if (err.errno == "ECONNRESET" && err.syscall == "read" && retries > 0) {
            console.log("(Got read ECONNRESET, retrying)");
            return doRequest(retries - 1);
          }
          throw err;
        });
      return doRequest(10);
    };
  }
  /* eslint-enable no-underscore-dangle */

  console.log("Login " + hostname + " " + username + " " + apiVersion);
  await sfConn.soapLogin({hostname, apiVersion, username, password});
  return sfConn;
}

module.exports = {forcecmdLogin, salesforceLogin};
