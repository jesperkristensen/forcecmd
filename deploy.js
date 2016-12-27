"use strict";
let fs = require("graceful-fs");
let JSZip = require("jszip");
let xmldom = require("xmldom");
let {async, nfcall, login, timeout} = require("./common");

module.exports.deploy = async(function*(cliArgs) {
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

    let readAllFiles = async(function*() {
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
        .all(readFiles.map(async(function*(fileName) {
          try {
            let data = yield nfcall(fs.readFile, fileName);
            return {fileName, data};
          } catch (err) {
            if (err.code != "ENOENT") { throw err; }
            return {fileName, data: null};
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
    let {sfConn, apiVersion} = yield login({verbose: false});
    let metadataApi = sfConn.wsdl(apiVersion, "Metadata");
    console.log("Describe");
    let describeResult = yield sfConn.soap(metadataApi, "describeMetadata", {apiVersion});

    let files = yield filesPromise;

    let metadataObjectsByDir = {};
    for (let metadataObject of describeResult.metadataObjects) {
      metadataObjectsByDir[metadataObject.directoryName] = metadataObject;
    }

    let zip = new JSZip();
    let doc = xmldom.DOMImplementation.prototype.createDocument("http://soap.sforce.com/2006/04/metadata", "Package");
    doc.documentElement.setAttribute("xmlns", "http://soap.sforce.com/2006/04/metadata");
    let el = (name, children) => {
      let e = doc.createElement(name);
      for (let child of children) {
        e.appendChild(child);
      }
      return e;
    };
    let tx = (name, text) => {
      let e = doc.createElement(name);
      e.textContent = text;
      return e;
    };
    for (let fileName of fileNames) {
      let fullName, zipFileName;
      if (fileName.substr(-1) == "/") { // It is a "Folder". It does not have a main metadata file, only the -meta.xml file.
        let folderMetaName = fileName.substring(0, fileName.length - 1) + "-meta.xml";
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
            zip.file(zipFileName + "-meta.xml", files[fileName + "-meta.xml"]);
          }
        }

        fullName = zipFileName.substring(zipFileName.indexOf("/", "unpackaged/".length) + 1, zipFileName.lastIndexOf("."));
      }
      let typeDirName = zipFileName.substring("unpackaged/".length, zipFileName.indexOf("/", "unpackaged/".length));

      if (!(typeDirName in metadataObjectsByDir)) {
        throw "Metadata not found for file: " + fileName;
      }

      doc.documentElement.appendChild(
        el("types", [
          tx("members", fullName),
          tx("name", metadataObjectsByDir[typeDirName].xmlName)
        ])
      );
    }

    if (destroy) {
      let destructiveChangesXml = new xmldom.XMLSerializer().serializeToString(doc);
      console.log(destructiveChangesXml);
      zip.file("unpackaged/destructiveChanges.xml", Buffer.from(destructiveChangesXml, "utf8"));

      doc = xmldom.DOMImplementation.prototype.createDocument("http://soap.sforce.com/2006/04/metadata", "Package");
      doc.documentElement.setAttribute("xmlns", "http://soap.sforce.com/2006/04/metadata");
    }

    doc.documentElement.appendChild(tx("version", apiVersion));
    let packageXml = new xmldom.XMLSerializer().serializeToString(doc);
    console.log(packageXml);
    zip.file("unpackaged/package.xml", Buffer.from(packageXml, "utf8"));

    // JSZip#generate supports a number of data types with different performance.
    // The type argument to the generate method:
    //    "string" is quite ineficcient. It will involve a fair amount of data copying, and data take twice the required space.
    //    "base64" is very inefficient. Same ineficciency as "string", plus it does not use the Base64 encoder built into Node. The custom Base64 encoder will cause Node to run out of memory on normally sized orgs.
    //    "uint8array", "arraybuffer", "nodebuffer" and "blob" are efficient. "uint8array" is the most efficient, since that is the internal format used by JSZip.
    // The type of each file in the zip, assuming the generate method is called with the type argument set to one of the binary types:
    //    A Node Buffer will be converted to a Uint8Array by naively copying each byte.
    //    An ArrayBuffer will be converted to a Uint8Array by reading its .buffer property.
    //    Uint8Array will be used directly.
    // We let JSZip convert input files from Buffer to Uint8Array since we cannot do it better ourselves.
    // We use the Base64 encoder built into the Buffer object, since the Base64 encoder in JSZip is not performant enough.
    // We use Buffer.from(arraybuffer) since that is supposedly a little more performant than the Buffer constructor used when passing "nodebuffer" to JSZip, but the difference is probably tiny.
    let zipFile = Buffer.from(zip.generate({type: "arraybuffer"})).toString("base64");
    console.log("Deploy");
    let result = yield sfConn.soap(metadataApi, "deploy", {zipFile, deployOptions});
    console.log({id: result.id});
    let res;
    for (let interval = 1000; ; interval *= 1.3) {
      yield timeout(interval);
      console.log("CheckDeployStatus");
      res = yield sfConn.soap(metadataApi, "checkDeployStatus", {id: result.id, includeDetails: true});
      if (res.done !== "false") {
        break;
      }
    }
    console.log({status: res.status, errors: sfConn.asArray(res.details.componentFailures)});
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  }
});
