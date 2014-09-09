var fs = require("fs-extra");
var Promise = require("jsforce/lib/promise");
var q = require("q");
var JSZip = require("jszip");
var common = require("./common");

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
        var xmlNames = asArray(metadataObject.childXmlNames).concat(metadataObject.xmlName);
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
                var folderGroups = [];
                folders.forEach(function(folder) {
                  if (folderGroups.length == 0 || folderGroups[folderGroups.length - 1].length == 3) {
                    folderGroups.push([]);
                  }
                  folderGroups[folderGroups.length - 1].push(folder);
                });
                return Promise
                  .all(folderGroups.map(function(folderGroup) {
                    console.log("List " + folderGroup.map(function(folder) { return xmlName + "/" + folder.fullName; }).join(", "));
                    return conn.metadata.list(folderGroup.map(function(folder) { return {type: xmlName, folder: folder.fullName}; })).then(asArray);
                  }))
                  .then(function(p) {
                    return flattenArray(p).concat(folders.map(function(folder) { return {type: xmlName, fullName: folder.fullName}; }));
                  });
              });
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
    return common.complete(
      conn.metadata
        .retrieve({apiVersion: common.apiVersion, unpackaged: {types: types, version: common.apiVersion}})
    );
  })
  .then(function(result) {
    console.log("CheckRetrieveStatus");
    return conn.metadata.checkRetrieveStatus(result.id);
  })
  .then(function(res) {
    console.log("Reading response and writing files");
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
    console.log(res.messages);
    return Promise.all(files);
  })
  .then(null, function(err) { console.error(err); });
