"use strict";

/**
 * Build an XML document to be consumed by Salesforce.
 * We can create Salesforce SOAP requests and Metadata XML files.
 * @param name : string : The tag name of the root element.
 * @param attributes : string : An XML string with attributes for the root element, such as namespace declarations.
 * @param value : any : A JavaScript object representing the contents of the XML.
 * @return string : The generated XML.
 *
 * A value is placed into an XML element like this:
 * - A null value puts the xsi:nil="true" attribute on the XML element.
 * - An object generates a child XML element for each property, with the property name used as the tag name and the child elements contents is generated from the property value.
 *      If a property value is an array, multiple child XML elements are created with the same tag name.
 *      The "$type" property is special because it does not create a child element, but instead puts an xsi:type attribute on the element.
 * - Any other type is used as the text contents of the element.
 */
function xmlBuilder(name, attributes, value) {
  return Array.from(xmlTagBuilder(name, attributes, value)).join("");
}

function* xmlTagBuilder(name, attributes, value) {
  if (Array.isArray(value)) {
    for (let val of value) {
      yield* xmlTagBuilder(name, attributes, val);
    }
    return;
  }

  if (value === null) {
    attributes += " xsi:nil=\"true\"";
  } else if (typeof value === "object" && "$type" in value) {
    attributes += " xsi:type=\"" + value.$type + "\"";
  }

  yield "<" + name + attributes + ">";

  if (value === null) {
    // nothing
  } else if (typeof value == "object") {
    for (let [key, val] of Object.entries(value)) {
      if (key != "$type") {
        yield* xmlTagBuilder(key, "", val);
      }
    }
  } else {
    yield String(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
  }

  yield "</" + name + ">";
}

module.exports = xmlBuilder;
