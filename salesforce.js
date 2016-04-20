"use strict";
let https = require("https");
let xml2js = require("xml2js");

let xml = {
  parse(xml) {
    let err, res;
    xml2js.parseString(xml, (error, result) => {
      err = error;
      res = result;
    });
    if (err) {
      throw err;
    }
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
    return unarray(res);
  },
  stringify(obj) {
    return (new xml2js.Builder()).buildObject(obj);
  }
};

module.exports = function() {
  this.instanceHostname = null;
  this.sessionId = null;
}

module.exports.prototype = {
  partnerLogin(options) {
    return this._soap({
      host: options.hostname,
      path: "/services/Soap/u/" + options.apiVersion,
      namespace: "urn:partner.soap.sforce.com",
      method: "login",
      header: {},
      body: {
        "username": options.username,
        "password": options.password
      }
    })
    .then(loginResult => {
      let serverUrl = loginResult.serverUrl;
      let sessionId = loginResult.sessionId;
      serverUrl = /https:\/\/(.*)\/services/.exec(serverUrl)[1];
      if (!serverUrl) {
        throw "Login error: no serverUrl";
      }
      if (!sessionId) {
        throw "Login error: no sessionId";
      }
      this.instanceHostname = serverUrl;
      this.sessionId = sessionId;
    });
  },

  rest(url, options) {
    options = options || {};
    let httpsOptions = {
      host: this.instanceHostname,
      path: url,
      method: options.method || "GET",
      headers: {
        "Authorization": "OAuth " + this.sessionId,
        "Accept": "application/json"
      }
    };
    if (options.body) {
      httpsOptions.headers["Content-Type"] = "application/json";
    }
    let body = JSON.stringify(options.body);
    return this._request(httpsOptions, body).then(res => {
      let response = res.response;
      let responseBody = res.responseBody;
      if (response.statusCode == 200) {
        return JSON.parse(responseBody);
      } else if (response.statusCode == 204) {
        return null;
      } else {
        let text;
        if (response.statusCode == 400 && responseBody) {
          try {
            text = JSON.parse(responseBody).map(err => err.errorCode + ": " + err.message).join("\n");
          } catch(ex) {
          }
        }
        if (response.statusCode == 0) { // TODO does node work that way?
          text = "Network error, offline or timeout";
        }
        if (!text) {
          text = "HTTP error " + response.statusCode + " " + response.statusMessage + (responseBody ? "\n\n" + responseBody : "");
        }
        throw {restError: text};
      }
    });
  },

  metadata(apiVersion, method, body) {
    return this._soap({
      host: this.instanceHostname,
      path: "/services/Soap/m/" + apiVersion,
      namespace: "http://soap.sforce.com/2006/04/metadata",
      header: {SessionHeader: {sessionId: this.sessionId}},
      method,
      body
    });
  },

  _soap(options) {
    let httpsOptions = {
      host: options.host,
      path: options.path,
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "SOAPAction": '""'
      }
    };
    let requestBodyObject = {
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
    let requestBody = xml.stringify(requestBodyObject);
    return this._request(httpsOptions, requestBody).then(res => {
      let response = res.response;
      let responseBody = res.responseBody;
      try {
        let res = xml.parse(responseBody)["soapenv:Envelope"]["soapenv:Body"];
        if (response.statusCode == 200) {
          return res[options.method + "Response"].result;
        } else {
            throw res["soapenv:Fault"];
        }
      } catch (e) {
        throw {soapResponseBody: responseBody, statusCode: response.statusCode, parseException: e};
      }
    });
  },

  _request(httpsOptions, requestBody) {
    return new Promise((resolve, reject) => {
      let req = https.request(httpsOptions, response => {
        let responseBody = "";
        response.on("data", chunk => responseBody += chunk);
        response.on("end", () => {
          resolve({response, responseBody});
        });
        response.on("error", reject);
      });
      req.on("error", ex => {
        reject({networkError: ex});
      });
      if (requestBody) {
        req.write(requestBody);
      }
      req.end();
    });
  }
};

module.exports.asArray = function(x) {
  if (!x) return [];
  if (x instanceof Array) return x;
  return [x];
};
