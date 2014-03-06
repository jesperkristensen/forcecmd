var jsforce = require("jsforce");
var fs = require("fs");
var Promise = require("jsforce/lib/promise");
var stream = require("stream"),
    Stream = stream.Stream;
var q = require("q");

function asArray(x) {
  if (!x) return [];
  if (x instanceof Array) return x;
  return [x];
}
function flattenArray(x) {
  return [].concat.apply([], x);
}

var conn;
q.nfcall(fs.readFile, "forcecmd.json", "utf-8")
  .then(function(file) {
    var config = JSON.parse(file);
    conn = new jsforce.Connection({loginUrl: config.loginUrl, version: "28.0"});
    console.log("Login");
    return conn.login(config.username, config.password);
  })
  .then(function() {
    console.log("Describe");
    return conn.metadata.describe("28.0")
  })
  .then(function(res) {
    // TODO: Batch list calls into groups of three
    var x = res.metadataObjects
      .filter(function(metadataObject) { return metadataObject.xmlName != "InstalledPackage"; })
      .map(function(metadataObject) {
        var xmlNames = metadataObject.childXmlNames ? metadataObject.childXmlNames.concat(metadataObject.xmlName) : [metadataObject.xmlName];
        // TODO: should we avoid hardcoding the excluded component types?
        xmlNames = xmlNames.filter(function(xmlName) { return typeof xmlName == "string" && ["ApexTriggerCoupling", "WorkflowActionFlow"].indexOf(xmlName) == -1; });
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
    conn.metadata.pollTimeout = 100000;
    console.log("Retrieve");
    return conn.metadata
      .retrieve({apiVersion: "28.0", unpackaged: {types: types, version: "28.0"}})
      .complete();
  })
  .then(function(result) {
    var rstream = new Stream();
    rstream.readable = true;
    rstream.pipe(fs.createWriteStream("./MyPackage.zip"));
    rstream.emit("data", new Buffer(result.zipFile, "base64"));
    rstream.emit("end");
    return result.messages;
  })
  .then(function(res) { console.log(res); }, function(err) { console.error(err); });
