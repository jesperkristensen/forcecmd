"use strict";
var https = require("https");
var xml2js = require("xml2js");
var fs = require("graceful-fs");
var url = require("url");

let sfServerUrl, sfSessionId;

let xml = {
  parse(xml) {
    let err, res;
    xml2js.parseString(xml, function (error, result) {
      err = error;
      res = result;
    });
    if (err) {
      throw err;
    }
    return res;
  },
  stringify(obj) {
    return (new xml2js.Builder()).buildObject(obj);
  }
};

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
      return askSalesforceSoap({
        host: loginUrl.hostname,
        path: "/services/Soap/u/" + config.apiVersion,
        namespace: "urn:partner.soap.sforce.com",
        method: "login",
        header: {},
        body: {
          "username": config.username,
          "password": password
        }
      });
    })
    .then(function (loginResult) {
      sfServerUrl = loginResult.serverUrl;
      sfSessionId = loginResult.sessionId;
      sfServerUrl = /https:\/\/(.*)\/services/.exec(sfServerUrl)[1];
      if (!sfServerUrl) {
        throw "Login error: no serverUrl";
      }
      if (!sfSessionId) {
        throw "Login error: no sessionId";
      }
    });
}

module.exports.askSalesforce = function(url, options) {
  return new Promise((resolve, reject) => {
    options = options || {};
    let httpsOptions = {
      host: sfServerUrl,
      path: url,
      method: options.method || "GET",
      headers: {
        "Authorization": "OAuth " + sfSessionId,
        "Accept": "application/json"
      }
    };
    if (options.body) {
      httpsOptions.headers["Content-Type"] = "application/json";
    }
    let body = JSON.stringify(options.body);
    let req = https.request(httpsOptions, response => {
      let str = "";
      response.on("data", chunk => str += chunk);
      response.on("end", () => {
        if (response.statusCode == 200) {
          resolve(JSON.parse(str));
        } else if (response.statusCode == 204) {
          resolve(null);
        } else {
          let text;
          if (response.statusCode == 400 && str) {
            try {
              text = JSON.parse(str).map(err => err.errorCode + ": " + err.message).join("\n");
            } catch(ex) {
            }
          }
          if (response.statusCode == 0) { // TODO does node work that way?
            text = "Network error, offline or timeout";
          }
          if (!text) {
            text = "HTTP error " + response.statusCode + " " + response.statusMessage + (str ? "\n\n" + str : "");
          }
          reject({askSalesforceError: text});
        }
      });
      response.on("error", reject);
    });
    req.on("error", ex => {
      reject({askSalesforceError: "Network error, offline or timeout", errorObj: ex});
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

module.exports.askSalesforceMetadata = function(method, body) {
  return askSalesforceSoap({
    host: sfServerUrl,
    path: "/services/Soap/m/" + module.exports.apiVersion,
    namespace: "http://soap.sforce.com/2006/04/metadata",
    header: {SessionHeader: {sessionId: sfSessionId}},
    method,
    body
  });
}

function askSalesforceSoap(options) {
  return new Promise((resolve, reject) => {
    let httpsOptions = {
      host: options.host,
      path: options.path,
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "SOAPAction": '""'
      }
    };
    let x = {
      "soapenv:Envelope": {
        "$": {
          "xmlns:soapenv": "http://schemas.xmlsoap.org/soap/envelope/",
          "xmlns:xsd": "http://www.w3.org/2001/XMLSchema",
          "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance"
        },
        "soapenv:Header": Object.assign({
          "$": {"xmlns": options.namespace}
        }, options.header),
        "soapenv:Body": {
          "$": {"xmlns": options.namespace},
          [options.method]: options.body
        }
      }
    };
    let body = xml.stringify(x);
    let req = https.request(httpsOptions, response => {
      let str = "";
      response.on("data", chunk => str += chunk);
      response.on("end", () => {
        if (response.statusCode == 200) {
          try {
            let res = xml.parse(str);
            resolve(unarray(res)["soapenv:Envelope"]["soapenv:Body"][options.method + "Response"].result);
          } catch (e) {
            reject({soapResponseBody: str, statusCode: response.statusCode, parseException: e});
          }
        } else {
          try {
            let res = xml.parse(str);
            reject(unarray(res)["soapenv:Envelope"]["soapenv:Body"]["soapenv:Fault"]);
          } catch (e) {
            reject({soapResponseBody: str, statusCode: response.statusCode, parseException: e});
          }
        }
      });
      response.on("error", reject);
    });
    req.on("error", ex => {
      reject({askSalesforceError: "Network error, offline or timeout", errorObj: ex});
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function asArray(x) {
  if (!x) return [];
  if (x instanceof Array) return x;
  return [x];
}
module.exports.asArray = asArray;

function unarray(obj) {
  if (obj instanceof Array && obj.length == 1) {
    return unarray(obj[0]);
  } else if (obj instanceof Array) {
    return obj.map(el => unarray(el));
  } else if (obj !== null && typeof obj == "object") {
    let target = {};
    for (let key in obj) {
      target[key] = unarray(obj[key]);
    }
    return target;
  } else {
    return obj;
  }
}

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