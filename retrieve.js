var fs = require("fs-extra");
var Promise = require("jsforce/lib/promise");
var q = require("q");
var JSZip = require("jszip");
var common = require("./common");

module.exports.retrieve = function() {
  var asArray = common.asArray;

  function flattenArray(x) {
    return [].concat.apply([], x);
  }

  function writeFile(path, data) {
    var p = new Promise();
    var pos = -1;
    while (true) {
      pos = path.indexOf("/", pos + 1);
      if (pos == -1) {
        break;
      }
      (function() {
        var dir = path.substring(0, pos);
        p = p.then(function() { return q.nfcall(fs.mkdir, dir); }).then(null, function(err) { if (err.code != "EEXIST") throw err; });
      })();
    }
    return p.then(function() { return q.nfcall(fs.writeFile, path, data); });
  }

  var conn;
  var login = common.login()
    .then(function(c) {
      conn = c;
    });

  login
    .then(function() {
      console.log("DescribeGlobal");
      return conn.describeGlobal();
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
        console.log("Query " + object);
        return conn.sobject(object).find().execute()
          .then(function(records) {
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
      return conn.metadata.describe(common.apiVersion);
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
            if (metadataObject.inFolder) {
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
        return conn.metadata
          .list(xmlNames.map(function(xmlName) { return {type: xmlName}; }))
          .then(asArray)
          .then(function(someItems) {
            var folders = someItems.filter(function(folder) { return folderMap[folder.type]});
            var nonFolders = someItems.filter(function(folder) { return !folderMap[folder.type]});
            return Promise
              .all(groupByThree(folders).map(function(folderGroup) {
                console.log("ListMetadata " + folderGroup.map(function(folder) { return folderMap[folder.type] + "/" + folder.fullName; }).join(", "));
                return conn.metadata.list(folderGroup.map(function(folder) { return {type: folderMap[folder.type], folder: folder.fullName}; })).then(asArray);
              }))
              .then(function(p) {
                return flattenArray(p).concat(folders.map(function(folder) { return {type: folderMap[folder.type], fullName: folder.fullName}; }), nonFolders);
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
        return conn.metadata.retrieve({apiVersion: common.apiVersion, unpackaged: {types: types, version: common.apiVersion}}).then(function(result) {
          console.log({id: result.id});
          return common.complete(function() {
            console.log("CheckRetrieveStatus");
            return conn.metadata.checkRetrieveStatus(result.id);
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
      return q.nfcall(fs.remove, "src/").then(function() { return res; });
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
