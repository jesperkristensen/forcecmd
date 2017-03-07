"use strict";
let fs = require("graceful-fs");
let JSZip = require("jszip");
let {nfcall, login, timeout} = require("./common");

module.exports.retrieve = function(cliArgs) {
  let logger = console;
  let verbose = cliArgs.indexOf("--verbose") > -1;
  let netlog = cliArgs.indexOf("--netlog") > -1;
  if (cliArgs.some(a => a != "--verbose" && a != "--netlog")) {
    throw "unknown argument";
  }

  let writeFile = async (path, data) => {
    let pos = -1;
    for (;;) {
      pos = path.indexOf("/", pos + 1);
      if (pos == -1) {
        break;
      }
      let dir = path.substring(0, pos);
      try {
        await nfcall(fs.mkdir, dir);
      } catch (err) {
        if (err.code != "EEXIST") throw err;
      }
    }
    await nfcall(fs.writeFile, path, data);
  };

  let loginPromise = login({verbose, netlog});

  (async () => {
    try {
      let {sfConn, apiVersion, objects} = await loginPromise;
      logger.log("DescribeGlobal");
      let describe = await sfConn.rest("/services/data/v" + apiVersion + "/sobjects");

      if (verbose) {
        logger.log("- Objects included by default: " + JSON.stringify(describe.sobjects.filter(sobject => sobject.customSetting).map(sobject => sobject.name)));
        logger.log("- Objects not included by default: " + JSON.stringify(describe.sobjects.filter(sobject => !sobject.customSetting).map(sobject => sobject.name)));
      }

      for (let sobject of describe.sobjects) {
        if (sobject.customSetting && !(sobject.name in objects)) {
          objects[sobject.name] = true;
        }
      }

      let results = [];
      for (let object in objects) {
        results.push((async () => {
          let soql = objects[object];
          if (soql === false) {
            return;
          }
          if (soql instanceof Array) {
            soql = "select " + soql.join(", ") + " from " + object;
          }
          if (soql === true) {
            logger.log("DescribeSObject " + object);
            let objectDescribe = await sfConn.rest("/services/data/v" + apiVersion + "/sobjects/" + object + "/describe");
            soql = "select " + objectDescribe.fields.map(field => field.name).join(", ") + " from " + object;
          }
          if (typeof soql != "string") {
            throw "Cannot understand configuration of object: " + object;
          }
          if (verbose) {
            logger.log("- Using " + object + " SOQL: " + soql);
          }
          logger.log("Query " + object);
          let data = await sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(soql));
          let records = [];
          for (;;) {
            for (let record of data.records) {
              delete record.attributes;
            }
            records = records.concat(data.records);
            if (!data.nextRecordsUrl) {
              break;
            }
            logger.log("QueryMore " + object);
            data = await sfConn.rest(data.nextRecordsUrl);
          }
          await writeFile("data/" + object + ".json", JSON.stringify(records, null, "    "));
        })());
      }
      await Promise.all(results);
    } catch (e) {
      process.exitCode = 1;
      logger.error(e);
    }
  })();

  (async () => {
    function flattenArray(x) {
      return [].concat(...x);
    }

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

    try {
      let {sfConn, apiVersion, excludeDirs} = await loginPromise;
      let metadataApi = sfConn.wsdl(apiVersion, "Metadata");
      logger.log("DescribeMetadata");
      let res = await sfConn.soap(metadataApi, "describeMetadata", {apiVersion});
      let availableMetadataObjects = res.metadataObjects
        .filter(metadataObject => metadataObject.xmlName != "InstalledPackage");
      if (verbose) {
        logger.log("- Options available for excludeDirs: " + JSON.stringify(availableMetadataObjects.map(metadataObject => metadataObject.directoryName)));
      }
      let selectedMetadataObjects = availableMetadataObjects
        .filter(metadataObject => {
          if (excludeDirs.indexOf(metadataObject.directoryName) > -1) {
            logger.log("(Excluding " + metadataObject.directoryName + ")");
            return false;
          }
          return true;
        });
      let folderMap = {};
      let x = selectedMetadataObjects
        .map(metadataObject => {
          let xmlNames = sfConn.asArray(metadataObject.childXmlNames).concat(metadataObject.xmlName);
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
      res = await Promise.all(groupByThree(flattenArray(x)).map(async xmlNames => {
        logger.log("ListMetadata " + xmlNames.join(", "));
        let someItems = sfConn.asArray(await sfConn.soap(metadataApi, "listMetadata", {queries: xmlNames.map(xmlName => ({type: xmlName}))}));
        let folders = someItems.filter(folder => folderMap[folder.type]);
        let nonFolders = someItems.filter(folder => !folderMap[folder.type]);
        let p = await Promise
          .all(groupByThree(folders).map(async folderGroup => {
            logger.log("ListMetadata " + folderGroup.map(folder => folderMap[folder.type] + "/" + folder.fullName).join(", "));
            return sfConn.asArray(await sfConn.soap(metadataApi, "listMetadata", {queries: folderGroup.map(folder => ({type: folderMap[folder.type], folder: folder.fullName}))}));
          }));
        return flattenArray(p).concat(
          folders.map(folder => ({type: folderMap[folder.type], fullName: folder.fullName})),
          nonFolders,
          xmlNames.map(xmlName => ({type: xmlName, fullName: "*"}))
        );
      }));
      let types = flattenArray(res);
      if (types.filter(x => x.type == "StandardValueSet").map(x => x.fullName).join(",") == "*") {
        // We are using an API version that supports the StandardValueSet type, but it didn't list its contents.
        // https://success.salesforce.com/ideaView?id=0873A000000cMdrQAE
        // Here we hardcode the supported values as of Winter 17 / API version 38.
        types = types.concat([
          "AccountContactMultiRoles", "AccountContactRole", "AccountOwnership", "AccountRating", "AccountType", "AddressCountryCode", "AddressStateCode", "AssetStatus", "CampaignMemberStatus", "CampaignStatus", "CampaignType", "CaseContactRole", "CaseOrigin", "CasePriority", "CaseReason", "CaseStatus", "CaseType", "ContactRole", "ContractContactRole", "ContractStatus", "EntitlementType", "EventSubject", "EventType", "FiscalYearPeriodName", "FiscalYearPeriodPrefix", "FiscalYearQuarterName", "FiscalYearQuarterPrefix", "IdeaCategory1", "IdeaMultiCategory", "IdeaStatus", "IdeaThemeStatus", "Industry", "InvoiceStatus", "LeadSource", "LeadStatus", "OpportunityCompetitor", "OpportunityStage", "OpportunityType", "OrderStatus1", "OrderType", "PartnerRole", "Product2Family", "QuestionOrigin1", "QuickTextCategory", "QuickTextChannel", "QuoteStatus", "SalesTeamRole", "Salutation", "ServiceContractApprovalStatus", "SocialPostClassification", "SocialPostEngagementLevel", "SocialPostReviewedStatus", "SolutionStatus", "TaskPriority", "TaskStatus", "TaskSubject", "TaskType", "WorkOrderLineItemStatus", "WorkOrderPriority", "WorkOrderStatus"
        ].map(x => ({type: "StandardValueSet", fullName: x})));
      }
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
      //logger.log(types);
      logger.log("Retrieve");
      let result = await sfConn.soap(metadataApi, "retrieve", {retrieveRequest: {apiVersion, unpackaged: {types, version: apiVersion}}});
      logger.log({id: result.id});
      for (let interval = 1000; ; interval *= 1.3) {
        await timeout(interval);
        logger.log("CheckRetrieveStatus");
        res = await sfConn.soap(metadataApi, "checkRetrieveStatus", {id: result.id});
        if (res.done !== "false") {
          break;
        }
      }
      if (res.success != "true") {
        throw res;
      }
      let statusJson = JSON.stringify({
        fileProperties: sfConn.asArray(res.fileProperties)
          .filter(fp => fp.id != "000000000000000AAA" || fp.fullName != "")
          .sort((fp1, fp2) => fp1.fileName < fp2.fileName ? -1 : fp1.fileName > fp2.fileName ? 1 : 0),
        messages: res.messages
      }, null, "    ");
      logger.log("(Reading response and writing files)");
      let fsRemove = async path => {
        try {
          await nfcall(fs.unlink, path);
        } catch (ex) {
          if (ex.code == "ENOENT") {
            // File does not exist
            return;
          }
          if (ex.code == "EPERM") {
            // Was not a file. Assume it was a directory
            let files = await nfcall(fs.readdir, path);
            await Promise.all(files.map(file => fsRemove(path + "/" + file)));
            await nfcall(fs.rmdir, path);
          }
        }
      };
      await fsRemove("src");
      // We wait until the old files are removed before we create the new
      let files = [];

      files.push(writeFile("status.json", statusJson));

      // JSZip does not use the Base64 encoder built into Node. The custom Base64 encoder will cause Node to run out of memory on normally sized orgs.
      // JSZip will convert all input types to Uint8Array if they are deflate compressed (which they are).
      // If the input is a Node Buffer, JSZip will split it up into individual files and then convert each file to a Uint8Array.
      // For all other types, JSZip will first convert the whole zip file into a Uint8Array.
      // Here we convert the input to a Buffer before giving it to JSZip, to avoid the inefficient base64 decoding in JSZip.
      // We let JSZip convert the Buffer to a Uint8Array since we cannot do that more efficiently than JSZip does.
      let zip = new JSZip(Buffer.from(res.zipFile, "base64"));
      for (let p in zip.files) {
        let file = zip.files[p];
        if (!file.options.dir) {
          let name = "src/" + (file.name.indexOf("unpackaged/") == 0 ? file.name.substring("unpackaged/".length) : file.name);
          // We use Buffer.from(arraybuffer) since that is supposedly a little more performant than the Buffer constructor used by file.asNodeBuffer(), but the difference is probably tiny.
          let arrBuf = file.asArrayBuffer();
          files.push(writeFile(name, arrBuf.byteLength == 0 ? Buffer.alloc(0) : Buffer.from(arrBuf)));
        }
      }
      logger.log({messages: res.messages, status: res.status});
      await Promise.all(files);
    } catch (e) {
      process.exitCode = 1;
      logger.error(e);
    }
  })();
};
