var fs = require("graceful-fs");
var Promise = require("jsforce/lib/promise");
var q = require("q");
var JSZip = require("jszip");
var common = require("./common");

function asArray(x) {
  if (!x) return [];
  if (x instanceof Array) return x;
  return [x];
}
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

function complete(self) {
  var deferred = Promise.defer();
  var interval = 1000;
  var poll = function() {
    console.log("Check");
    self.check().then(function(results) {
      var done = results && asArray(results).every(function(result) { return result.done; });
      if (done) {
        deferred.resolve(results);
      } else {
        interval *= 1.3;
        setTimeout(poll, interval);
      }
    }, function(err) {
      deferred.reject(err);
    });
  };
  setTimeout(poll, interval);
  return deferred.promise;
}

var conn;
common.login()
  .then(function(c) {
    conn = c;
    console.log("Describe");
    return conn.metadata.describe(common.apiVersion);
  })
  .then(function(res) {
    // TODO: Batch list calls into groups of three
    var x = res.metadataObjects
      .filter(function(metadataObject) { return metadataObject.xmlName != "InstalledPackage"; })
      .map(function(metadataObject) {
        var xmlNames = metadataObject.childXmlNames ? metadataObject.childXmlNames.concat(metadataObject.xmlName) : [metadataObject.xmlName];
        // TODO: should we avoid hardcoding the excluded component types?
        xmlNames = xmlNames.filter(function(xmlName) { return typeof xmlName == "string" && ["ApexTriggerCoupling", "WorkflowActionFlow"].indexOf(xmlName) == -1; });
        if (common.excludeDirs.indexOf(metadataObject.directoryName) > -1) {
          console.log("Excluding " + metadataObject.directoryName);
          return [];
        }
        if (metadataObject.inFolder) {
          var folderType = metadataObject.xmlName == "EmailTemplate" ? "EmailFolder" : metadataObject.xmlName + "Folder";
          console.log("List " + folderType);
          var folders = conn.metadata
            .list({type: folderType})
            .then(asArray);
          return xmlNames.map(function(xmlName) {
            return folders
              .then(function(folders) {
                return Promise
                  .all(folders.map(function(folder) {
                    console.log("List " + xmlName + "/" + folder.fullName);
                    return conn.metadata.list({type: xmlName, folder: folder.fullName}).then(asArray);
                  }))
                  .then(function(p) {
                    return p.concat(folders.map(function(folder) { return {type: xmlName, fullName: folder.fullName}; }));
                  });
              })
              .then(flattenArray);
          });
        } else {
          return xmlNames.map(function(xmlName) {
            if (["AnalyticSnapshot", "RemoteSiteSetting", "ApexTriggerCoupling", "Folder", "PackageManifest", "CustomObjectSharingRules", "CustomObjectOwnerSharingRule", "CustomObjectCriteriaBasedSharingRule", "AutoResponseRule", "AssignmentRule", "EscalationRule", "Translations"].indexOf(xmlName) != -1) {
              console.log("List " + xmlName);
              return conn.metadata.list({type: xmlName}).then(asArray);
            }
            if (xmlName == "CustomObject") {
              console.log("List " + xmlName);
              return conn.metadata.list({type: xmlName}).then(function(z) {
                z = asArray(z);
                z = z.filter(function(a) { return a.fullName.indexOf("__c") == -1; });
                z.push({type: metadataObject.xmlName, fullName: "*"});
                return z;
              })
            }
            return new Promise([{type: xmlName, fullName: "*"}]);
          });
        }
      });
    return Promise.all(flattenArray(x));
  })
  .then(function (res) {
    var types = res
      .filter(function(x) { return x.length > 0})
      .map(function(x) { return {name: x[0].type, members: x.map(function(y) { return y.fullName; })}; });
    //console.log(types);
    console.log("Retrieve");
    return complete(
      conn.metadata
        .retrieve({apiVersion: common.apiVersion, unpackaged: {types: types, version: common.apiVersion}})
    );
  })
  .then(function(result) {
    console.log("CheckRetrieveStatus");
    return conn.metadata.checkRetrieveStatus(result.id);
  })
  .then(function(res) {
    console.log("Reading response");
    var files = [];
    files.push(writeFile("status.json", JSON.stringify({fileProperties: res.fileProperties, messages: res.messages})));
    var zip = new JSZip(res.zipFile, {base64: true});
    for (var p in zip.files) {
      var file = zip.files[p];
      if (!file.options.dir) {
        var name = "src/" + (file.name.indexOf("unpackaged/") == 0 ? file.name.substring("unpackaged/".length) : file.name);
        files.push(writeFile(name, file.asNodeBuffer()));
      }
    }
    console.log(res.messages);
    console.log("Writing files");
    return Promise.all(files);
  })
  .then(null, function(err) { console.error(err); });
