var fs = require("graceful-fs");
var Promise = require("jsforce/lib/promise");
var q = require("q");
var JSZip = require("jszip");
var xmldom = require("xmldom");
var common = require("./common");

var fileNames = process.argv.slice(2);

function readAllFiles(fileNames) {
  return Promise
    .all(fileNames.map(function(fileName) {
      return q.nfcall(fs.readFile, fileName).then(
        function(data) { return {fileName: fileName, data: data}; },
        function(err) { if (err.code != "ENOENT") { throw err; } return {fileName: fileName, data: null} }
      );
    }))
    .then(function(readFiles) {
      var files = {};
      readFiles.forEach(function(readFile) { files[readFile.fileName] = readFile.data; });
      return files;
    });
}

var filesPromise = function(){
  var readFiles = [];

  fileNames.forEach(function(fileName) {
    console.log(fileName);
    if (fileName.indexOf("src/") != 0) {
      throw "Not a source file: " + fileName;
    }
    if (fileName.substr(-1) == "/") {
      readFiles.push(fileName.substring(0, fileName.length - 1) + "-meta.xml");
    } else {
      readFiles.push(fileName);
      readFiles.push(fileName + "-meta.xml");
    }
  });

  return readAllFiles(readFiles)
    .then(function(files) {
      console.log("Reading files done");
      return files;
    });
}();

var conn;

Promise
  .all([
    common.login()
      .then(function(c) {
        conn = c;
        console.log("Describe");
        return conn.metadata.describe(common.apiVersion);
      }),
    filesPromise
  ])
  .then(function(res) {
    var describeResult = res[0];
    var files = res[1];

    var metadataObjectsByDir = {};
    describeResult.metadataObjects.forEach(function(metadataObject) {
      metadataObjectsByDir[metadataObject.directoryName] = metadataObject;
    });

    var zip = new JSZip();
    var doc = xmldom.DOMImplementation.prototype.createDocument("http://soap.sforce.com/2006/04/metadata", "Package");
    doc.documentElement.setAttribute("xmlns", "http://soap.sforce.com/2006/04/metadata");
    function E(name, children) {
      var e = doc.createElement(name);
      for (var i = 0; i < children.length; i++) {
        e.appendChild(children[i]);
      }
      return e;
    }
    function T(name, text) {
      var e = doc.createElement(name);
      e.textContent = text;
      return e;
    }
    fileNames.forEach(function(fileName) {
      if (fileName.substr(-1) == "/") { // It is a "Folder". It does not have a main metadata file, only the -meta.xml file.
        var folderMetaName = fileName.substring(0, fileName.length - 1) + "-meta.xml"
        if (files[folderMetaName] == null) {
          throw "File not found: " + fileName;
        }
        var zipFileName = "unpackaged/" + folderMetaName.substring("src/".length);
        zip.file(zipFileName, files[folderMetaName]);

        var fullName = zipFileName.substring(zipFileName.indexOf("/", "unpackaged/".length) + 1, zipFileName.length - "-meta.xml".length);
      } else {
        if (files[fileName] == null) {
          throw "File not found: " + fileName;
        }
        var zipFileName = "unpackaged/" + fileName.substring("src/".length);
        zip.file(zipFileName, files[fileName]);
        if (files[fileName + "-meta.xml"] != null) {
          zip.file(zipFileName + "-meta.xml",  files[fileName + "-meta.xml"]);
        }

        var fullName = zipFileName.substring(zipFileName.indexOf("/", "unpackaged/".length) + 1, zipFileName.lastIndexOf("."));
      }
      var typeDirName = zipFileName.substring("unpackaged/".length, zipFileName.indexOf("/", "unpackaged/".length));

      if (!(typeDirName in metadataObjectsByDir)) {
        throw "Metadata not found for file: " + fileName;
      }

      doc.documentElement.appendChild(
        E("types", [
          T("members", fullName),
          T("name", metadataObjectsByDir[typeDirName].xmlName)
        ])
      );
    });
    doc.documentElement.appendChild(T("version", common.apiVersion));
    var xml = new xmldom.XMLSerializer().serializeToString(doc);
    console.log(xml);

    zip.file("unpackaged/package.xml", xml);

    return zip.generate({type: "base64"});
  })
  .then(function(zipFile) {
    conn.metadata.pollTimeout = 100000;
    console.log("Deploy");
    var p = conn.metadata.deploy(new Buffer(zipFile, "base64")).complete();
    return p;
  })
  .then(function(res) { console.log(res); })
  .then(null, function(err) { console.error(err); });
