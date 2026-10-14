"use strict";
let fs = require("graceful-fs");
let SalesforceConnection = require("node-salesforce-connection");
let {nfcall} = require("./promise-utils");

// Login using the configuration from ./forcecmd.json and client_secret from ~/forcepw.json
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

// Login using a custom configuration and optionally client_secret from ~/forcepw.json
async function salesforceLogin({hostname, client_id, client_secret, robust, verbose}) {
  if (!hostname) throw new Error("Missing hostname");
  if (!client_id) throw new Error("Missing client_id");

  if (!client_secret && process.env.SF_CLIENT_SECRET) {
    if (verbose) {
      console.log("- Using client_secret from SF_CLIENT_SECRET environment variable");
    }
    client_secret = process.env.SF_CLIENT_SECRET;
  }

  if (!client_secret) {
    let pwfileName = (process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE) + "/forcepw.json";
    if (verbose) {
      console.log("- Looking for client_secret in file: " + pwfileName);
    }
    let pwfile = JSON.parse(await nfcall(fs.readFile, pwfileName, "utf-8"));
    let pwKey = hostname + ":" + client_id;
    if (verbose) {
      console.log("- Looking for client_secret with key: " + pwKey);
    }
    client_secret = pwfile.client_secrets[pwKey];
  }
  if (!client_secret) throw new Error("Missing client_secret");

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

  console.log("Login " + hostname + " " + client_id);
  await sfConn.oauthToken(hostname, {grant_type: "client_credentials", client_id, client_secret});
  return sfConn;
}

module.exports = {forcecmdLogin, salesforceLogin};
