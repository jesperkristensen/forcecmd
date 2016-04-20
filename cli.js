#! /usr/bin/env node
"use strict";
switch (process.argv[2]) {
  case "retrieve":
    require("./retrieve").retrieve(process.argv.slice(3));
    break;
  case "deploy":
    require("./deploy").deploy(process.argv.slice(3));
    break;
  default:
    console.error("unknown command: " + process.argv[2]);
}
