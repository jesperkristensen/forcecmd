"use strict";
let fs = require("graceful-fs");
let rimraf = require('rimraf');
let JSZip = require("jszip");
let common = require("./common");

module.exports.retrieve = common.async(function*(cliArgs) {
  try {
    let verbose = cliArgs.indexOf("--verbose") > -1;
    if (cliArgs.some(a => a != "--verbose")) {
      throw "unknown argument";
    }
    let asArray = common.asArray;

    function flattenArray(x) {
      return [].concat.apply([], x);
    }

    let writeFile = common.async(function*(path, data) {
      let pos = -1;
      while (true) {
        pos = path.indexOf("/", pos + 1);
        if (pos == -1) {
          break;
        }
        let dir = path.substring(0, pos);
        try {
          yield common.nfcall(fs.mkdir, dir);
        } catch (err) {
          if (err.code != "EEXIST") throw err;
        }
      }
      yield common.nfcall(fs.writeFile, path, data);
    });

    let conn = yield common.login({verbose});

    let dataPromise = common.async(function*() {
      console.log("DescribeGlobal");
      let describe = yield conn.rest("/services/data/v" + common.apiVersion + "/sobjects");
      let customSettings = describe.sobjects
        .filter(sobject => sobject.customSetting)
        .map(sobject => sobject.name);

      if (verbose) {
        console.log("- Options available for includeObjects: " + JSON.stringify(customSettings));
        console.log("- Options available for excludeObjects: " + JSON.stringify(describe.sobjects.filter(sobject => !sobject.customSetting).map(sobject => sobject.name)));
      }

      let objects = common.includeObjects
        .concat(customSettings)
        .filter(sobject => common.excludeObjects.indexOf(sobject) == -1);

      let results = objects.map(common.async(function*(object) {
        console.log("DescribeSObject " + object);
        let objectDescribe = yield conn.rest("/services/data/v" + common.apiVersion + "/sobjects/" + object + "/describe")
        let soql = "select " + objectDescribe.fields.map(field => field.name).join(", ") + " from " + object;
        console.log("Query " + object);
        let data = yield conn.rest("/services/data/v" + common.apiVersion + "/query/?q=" + encodeURIComponent(soql));
        let records = data.records;
        for (let record of records) {
          delete record.attributes;
        }
        yield writeFile("data/" + object + ".json", JSON.stringify(records, null, "    "));
      }));
      return Promise.all(results);
    })();

    function groupByThree(list) {
      let groups = [];
      for (let element of list) {
        if (groups.length == 0 || groups[groups.length - 1].length == 3) {
          groups.push([]);
        }
        groups[groups.length - 1].push(element);
      }
      return groups;
    }

    let metadataPromise = common.async(function*() {
      console.log("DescribeMetadata");
      let res = yield conn.metadata(common.apiVersion, "describeMetadata", {apiVersion: common.apiVersion});
      let folderMap = {};
      let x1 = res.metadataObjects
        .filter(metadataObject => metadataObject.xmlName != "InstalledPackage");
      if (verbose) {
        console.log("- Options available for excludeDirs: " + JSON.stringify(x1.map(metadataObject => metadataObject.directoryName)));
      }
      let x = x1
        .filter(metadataObject => {
          if (common.excludeDirs.indexOf(metadataObject.directoryName) > -1) {
            console.log("(Excluding " + metadataObject.directoryName + ")");
            return false;
          }
          return true;
        })
        .map(metadataObject => {
          let xmlNames = asArray(metadataObject.childXmlNames).concat(metadataObject.xmlName);
          return xmlNames.map(xmlName => {
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
      res = yield Promise.all(groupByThree(flattenArray(x)).map(common.async(function*(xmlNames) {
        console.log("ListMetadata " + xmlNames.join(", "));
        let someItems = asArray(yield conn.metadata(common.apiVersion, "listMetadata", {queries: xmlNames.map(xmlName => ({type: xmlName}))}));
        let folders = someItems.filter(folder => folderMap[folder.type]);
        let nonFolders = someItems.filter(folder => !folderMap[folder.type]);
        let p = yield Promise
          .all(groupByThree(folders).map(common.async(function*(folderGroup) {
            console.log("ListMetadata " + folderGroup.map(folder => folderMap[folder.type] + "/" + folder.fullName).join(", "));
            return asArray(yield conn.metadata(common.apiVersion, "listMetadata", {queries: folderGroup.map(folder => ({type: folderMap[folder.type], folder: folder.fullName}))}));
          })));
        return flattenArray(p).concat(
          folders.map(folder => ({type: folderMap[folder.type], fullName: folder.fullName})),
          nonFolders,
          xmlNames.map(xmlName => ({type: xmlName, fullName: '*'}))
        );
      })));
      let types = flattenArray(res);
      types.sort((a, b) => {
        let ka = a.type + "~" + a.fullName;
        let kb = b.type + "~" + b.fullName;
        if (ka < kb) {
          return -1;
        }
        if (ka > kb) {
          return 1;
        }
        return 0;
      });
      types = types.map(x => ({name: x.type, members: decodeURIComponent(x.fullName)}));
      //console.log(types);
      let retrieve = common.async(function*() {
        console.log("Retrieve");
        let result = yield conn.metadata(common.apiVersion, "retrieve", {retrieveRequest: {apiVersion: common.apiVersion, unpackaged: {types: types, version: common.apiVersion}}})
        console.log({id: result.id});
        let res = yield common.complete(() => {
          console.log("CheckRetrieveStatus");
          return conn.metadata(common.apiVersion, "checkRetrieveStatus", {id: result.id});
        });
        if (res.errorStatusCode == "UNKNOWN_EXCEPTION") {
          // Try again, from the beginning, https://developer.salesforce.com/forums/?feedtype=RECENT#!/feedtype=SINGLE_QUESTION_DETAIL&dc=APIs_and_Integration&criteria=OPENQUESTIONS&id=906F0000000AidVIAS
          console.error(res);
          return yield retrieve();
        }
        return res;
      });
      res = yield retrieve();
      if (res.success != "true") {
        throw res;
      }
      console.log("(Reading response and writing files)");
      // We wait until the old files are removed before we create the new
      yield common.nfcall(rimraf, "src/");
      let files = [];

      files.push(writeFile("status.json", JSON.stringify({
        fileProperties: asArray(res.fileProperties)
          .filter(fp => fp.id != "000000000000000AAA" || fp.fullName != "")
          .sort((fp1, fp2) => fp1.fileName < fp2.fileName ? -1 : fp1.fileName > fp2.fileName ? 1 : 0),
        messages: res.messages
      }, null, "    ")));

      let zip = new JSZip(new Buffer(res.zipFile, "base64"));
      for (let p in zip.files) {
        let file = zip.files[p];
        if (!file.options.dir) {
          let name = "src/" + (file.name.indexOf("unpackaged/") == 0 ? file.name.substring("unpackaged/".length) : file.name);
          files.push(writeFile(name, file.asNodeBuffer()));
        }
      }
      console.log({messages: res.messages, status: res.status});
      yield Promise.all(files);
    })();
    yield dataPromise;
    yield metadataPromise;
  } catch (e) {
    process.exitCode = 1;
    console.error(e);
  }
});
