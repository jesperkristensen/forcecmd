"use strict";

// A Promise based timeout
let timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

// Turn a Node style callback function into a promise
function nfcall(fn, ...args) {
  return new Promise((resolve, reject) => {
    function nodeResolver(error, ...values) {
      if (error) {
        reject(error);
      } else if (values.length > 1) {
        resolve(values);
      } else {
        resolve(values[0]);
      }
    }
    try {
      fn.apply(undefined, [...args, nodeResolver]);
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = {timeout, nfcall};
