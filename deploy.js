"use strict";
let fs = require("graceful-fs");
let JSZip = require("jszip");
let xmldom = require("xmldom");
let common = require("./common");

module.exports.deploy = common.async(function*(cliArgs) {
  try {
    let fileNames = [];
    let destroy = false;
    let deployOptions = {};
    for (let arg of cliArgs) {
      if (arg == "--destroy") {
        destroy = true;
      } else if (arg.indexOf("--options=") > -1) {
        // See http://www.salesforce.com/us/developer/docs/api_meta/Content/meta_deploy.htm#deploy_options
        deployOptions = JSON.parse(arg.substring("--options=".length));
      } else if (arg[0] == "-") {
        throw "Unknown argument: " + arg;
      } else {
        fileNames.push(arg);
      }
    }

    let readAllFiles = common.async(function*() {
      let readFiles = [];

      for (let fileName of fileNames) {
        console.log("- " + fileName);
        if (fileName.indexOf("src/") != 0) {
          throw "Not a source file: " + fileName;
        }
        if (fileName.substr(-1) == "/") {
          readFiles.push(fileName.substring(0, fileName.length - 1) + "-meta.xml");
        } else {
          readFiles.push(fileName);
          readFiles.push(fileName + "-meta.xml");
        }
      }

      readFiles = yield Promise
        .all(readFiles.map(common.async(function*(fileName) {
          try {
            let data = yield common.nfcall(fs.readFile, fileName);
            return {fileName: fileName, data: data};
          } catch (err) {
            if (err.code != "ENOENT") { throw err; }
            return {fileName: fileName, data: null};
          }
        })));
      let files = {};
      for (let readFile of readFiles) {
        files[readFile.fileName] = readFile.data;
      }
      console.log("(Reading files done)");
      return files;
    });

    let filesPromise = destroy ? null : readAllFiles();
    let conn = yield common.login({verbose: false});
    console.log("Describe");
    let describeResult = yield conn.metadata(common.apiVersion, "describeMetadata", {apiVersion: common.apiVersion});

    let files = yield filesPromise;

    let metadataObjectsByDir = {};
    for (let metadataObject of describeResult.metadataObjects) {
      metadataObjectsByDir[metadataObject.directoryName] = metadataObject;
    }

    let zip = new JSZip();
    let doc = xmldom.DOMImplementation.prototype.createDocument("http://soap.sforce.com/2006/04/metadata", "Package");
    doc.documentElement.setAttribute("xmlns", "http://soap.sforce.com/2006/04/metadata");
    function E(name, children) {
      let e = doc.createElement(name);
      for (let child of children) {
        e.appendChild(child);
      }
      return e;
    }
    function T(name, text) {
      let e = doc.createElement(name);
      e.textContent = text;
      return e;
    }
    for (let fileName of fileNames) {
      let fullName, zipFileName;
      if (fileName.substr(-1) == "/") { // It is a "Folder". It does not have a main metadata file, only the -meta.xml file.
        let folderMetaName = fileName.substring(0, fileName.length - 1) + "-meta.xml"
        if (!destroy && files[folderMetaName] == null) {
          throw "File not found: " + fileName;
        }
        zipFileName = "unpackaged/" + folderMetaName.substring("src/".length);
        if (!destroy) {
          zip.file(zipFileName, files[folderMetaName]);
        }

        fullName = zipFileName.substring(zipFileName.indexOf("/", "unpackaged/".length) + 1, zipFileName.length - "-meta.xml".length);
      } else {
        if (!destroy && files[fileName] == null) {
          throw "File not found: " + fileName;
        }
        zipFileName = "unpackaged/" + fileName.substring("src/".length);
        if (!destroy) {
          zip.file(zipFileName, files[fileName]);
          if (files[fileName + "-meta.xml"] != null) {
            zip.file(zipFileName + "-meta.xml",  files[fileName + "-meta.xml"]);
          }
        }

        fullName = zipFileName.substring(zipFileName.indexOf("/", "unpackaged/".length) + 1, zipFileName.lastIndexOf("."));
      }
      let typeDirName = zipFileName.substring("unpackaged/".length, zipFileName.indexOf("/", "unpackaged/".length));

      if (!(typeDirName in metadataObjectsByDir)) {
        throw "Metadata not found for file: " + fileName;
      }

      doc.documentElement.appendChild(
        E("types", [
          T("members", fullName),
          T("name", metadataObjectsByDir[typeDirName].xmlName)
        ])
      );
    }

    if (destroy) {
      let destructiveChangesXml = new xmldom.XMLSerializer().serializeToString(doc);
      console.log(destructiveChangesXml);
      zip.file("unpackaged/destructiveChanges.xml", destructiveChangesXml);

      doc = xmldom.DOMImplementation.prototype.createDocument("http://soap.sforce.com/2006/04/metadata", "Package");
      doc.documentElement.setAttribute("xmlns", "http://soap.sforce.com/2006/04/metadata");
    }

    doc.documentElement.appendChild(T("version", common.apiVersion));
    let packageXml = new xmldom.XMLSerializer().serializeToString(doc);
    console.log(packageXml);
    zip.file("unpackaged/package.xml", packageXml);

    let zipFile = yield zip.generate({type: "base64"});
    console.log("Deploy");
    let result = yield conn.metadata(common.apiVersion, "deploy", {zipFile, deployOptions});
    console.log({id: result.id});
    let res = yield common.complete(() => {
      console.log("CheckDeployStatus");
      return conn.metadata(common.apiVersion, "checkDeployStatus", {id: result.id, includeDetails: true});
    });
    console.log({status: res.status, errors: common.asArray(res.details.componentFailures)});
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  }
});