"use strict";
var fs = require("graceful-fs");
var rimraf = require('rimraf')
var JSZip = require("jszip");
var common = require("./common");

module.exports.retrieve = function() {
  var asArray = common.asArray;

  function flattenArray(x) {
    return [].concat.apply([], x);
  }

  function writeFile(path, data) {
    var p = Promise.resolve();
    var pos = -1;
    while (true) {
      pos = path.indexOf("/", pos + 1);
      if (pos == -1) {
        break;
      }
      (function() {
        var dir = path.substring(0, pos);
        p = p.then(function() { return common.nfcall(fs.mkdir, dir); }).then(null, function(err) { if (err.code != "EEXIST") throw err; });
      })();
    }
    return p.then(function() { return common.nfcall(fs.writeFile, path, data); });
  }

  var login = common.login();

  login
    .then(function() {
      console.log("DescribeGlobal");
      return common.askSalesforce("/services/data/v" + common.apiVersion + "/sobjects");
    })
    .then(function(describe) {
      var customSettings = describe.sobjects
        .filter(function(sobject) { return sobject.customSetting; })
        .map(function(sobject) { return sobject.name; });

      var objects = common.includeObjects
        .concat(customSettings)
        .filter(function(sobject) { return common.excludeObjects.indexOf(sobject) == -1; });

      var results = objects.map(function(object) {
        console.log("DescribeSObject " + object);
        return common.askSalesforce("/services/data/v" + common.apiVersion + "/sobjects/" + object + "/describe")
          .then(function(objectDescribe) {
            let soql = "select " + objectDescribe.fields.map(field => field.name).join(", ") + " from " + object;
            console.log("Query " + object);
            return common.askSalesforce("/services/data/v" + common.apiVersion + "/query/?q=" + encodeURIComponent(soql));
          })
          .then(function(data) {
            let records = data.records;
            for (var i = 0; i < records.length; i++) {
              delete records[i].attributes;
            }
            return writeFile("data/" + object + ".json", JSON.stringify(records, null, "    "));
          });
      });
      return Promise.all(results);
    })
    .then(null, function(err) { console.error(err); });

  function groupByThree(list) {
    var groups = [];
    list.forEach(function(element) {
      if (groups.length == 0 || groups[groups.length - 1].length == 3) {
        groups.push([]);
      }
      groups[groups.length - 1].push(element);
    });
    return groups;
  }

  login
    .then(function() {
      console.log("DescribeMetadata");
      return common.askSalesforceMetadata("describeMetadata", {apiVersion: common.apiVersion});
    })
    .then(function(res) {
      var folderMap = {};
      var x = res.metadataObjects
        .filter(function(metadataObject) { return metadataObject.xmlName != "InstalledPackage"; })
        .filter(function(metadataObject) {
          if (common.excludeDirs.indexOf(metadataObject.directoryName) > -1) {
            console.log("(Excluding " + metadataObject.directoryName + ")");
            return false;
          }
          return true;
        })
        .map(function(metadataObject) {
          var xmlNames = asArray(metadataObject.childXmlNames).concat(metadataObject.xmlName);
          return xmlNames.map(function(xmlName) {
            if (metadataObject.inFolder == "true") {
              if (xmlName == "EmailTemplate") {
                folderMap["EmailFolder"] = "EmailTemplate";
                xmlName = "EmailFolder";
              } else {
                folderMap[xmlName + "Folder"] = xmlName;
                xmlName = xmlName + "Folder";
              }
            }
            return xmlName;
          });
        });
      return Promise.all(groupByThree(flattenArray(x)).map(function(xmlNames) {
        console.log("ListMetadata " + xmlNames.join(", "));
        return common.askSalesforceMetadata("listMetadata", {queries: xmlNames.map(function(xmlName) { return {type: xmlName}; })})
          .then(asArray)
          .then(function(someItems) {
            var folders = someItems.filter(function(folder) { return folderMap[folder.type]});
            var nonFolders = someItems.filter(function(folder) { return !folderMap[folder.type]});
            return Promise
              .all(groupByThree(folders).map(function(folderGroup) {
                console.log("ListMetadata " + folderGroup.map(function(folder) { return folderMap[folder.type] + "/" + folder.fullName; }).join(", "));
                return common.askSalesforceMetadata("listMetadata", {queries: folderGroup.map(function(folder) { return {type: folderMap[folder.type], folder: folder.fullName}; })}).then(asArray);
              }))
              .then(function(p) {
                return flattenArray(p).concat(
                  folders.map(function(folder) { return {type: folderMap[folder.type], fullName: folder.fullName}; }),
                  nonFolders,
                  xmlNames.map(function(xmlName) { return {type: xmlName, fullName: '*'}; })
                );
              });
          });
      }));
    })
    .then(function (res) {
      var types = flattenArray(res);
      types.sort(function(a, b) {
        var ka = a.type + "~" + a.fullName;
        var kb = b.type + "~" + b.fullName;
        if (ka < kb) {
          return -1;
        }
        if (ka > kb) {
          return 1;
        }
        return 0;
      });
      types = types.map(function(x) { return {name: x.type, members: decodeURIComponent(x.fullName)}; });
      //console.log(types);
      function retrieve() {
        console.log("Retrieve");
        return common.askSalesforceMetadata("retrieve", {retrieveRequest: {apiVersion: common.apiVersion, unpackaged: {types: types, version: common.apiVersion}}}).then(function(result) {
          console.log({id: result.id});
          return common.complete(function() {
            console.log("CheckRetrieveStatus");
            return common.askSalesforceMetadata("checkRetrieveStatus", {id: result.id});
          }, function(result) { return result.done !== "false"; });
        }).then(function(res) {
          if (res.errorStatusCode == "UNKNOWN_EXCEPTION") {
            // Try again, from the beginning, https://developer.salesforce.com/forums/?feedtype=RECENT#!/feedtype=SINGLE_QUESTION_DETAIL&dc=APIs_and_Integration&criteria=OPENQUESTIONS&id=906F0000000AidVIAS
            console.error(res);
            return retrieve();
          }
          return res;
        });
      }
      return retrieve();
    })
    .then(function(res) {
      if (res.success != "true") {
        throw res;
      }
      console.log("(Reading response and writing files)");
      // We wait until the old files are removed before we create the new
      return common.nfcall(rimraf, "src/").then(function() { return res; });
    })
    .then(function(res) {
      var files = [];

      files.push(writeFile("status.json", JSON.stringify({
        fileProperties: asArray(res.fileProperties)
          .filter(function(fp) { return fp.id != "000000000000000AAA" || fp.fullName != ""; })
          .sort(function(fp1, fp2) { return fp1.fileName < fp2.fileName ? -1 : fp1.fileName > fp2.fileName ? 1 : 0 }),
        messages: res.messages
      }, null, "    ")));

      var zip = new JSZip(new Buffer(res.zipFile, "base64"));
      for (var p in zip.files) {
        var file = zip.files[p];
        if (!file.options.dir) {
          var name = "src/" + (file.name.indexOf("unpackaged/") == 0 ? file.name.substring("unpackaged/".length) : file.name);
          files.push(writeFile(name, file.asNodeBuffer()));
        }
      }
      console.log({messages: res.messages, status: res.status});
      return Promise.all(files);
    })
    .then(null, function(err) { console.error(err); });

}
