"use strict";

let startTime = undefined;

function getTime() {
  if (!startTime) return "";
  let seconds = Math.floor((Date.now() - startTime) / 1000);
  let minutes = Math.floor(seconds / 60);
  return `[${minutes}:${seconds < 10 ? `0${seconds}` : seconds}]`;
}

function setTimed() {
  startTime = Date.now();
  for (let method of ["log", "error"]) {
    let old = console[method];
    console[method] = (...args) => old(getTime(), ...args);
  }
}

module.exports = {setTimed};
