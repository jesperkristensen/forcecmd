"use strict";
/**
 * A very simple XML parser designed to parse the subset of XML that Salesforce produces.
 * It can read Salesforce SOAP responses and Metadata XML files.
 * It does not support many XML features such as namespaces, comments, attributes, doctypes and cdata.
 * It might not always detect syntax errors in the XML.
 * It supports the XSI attributes.
 * It returns a plain JavaScript object representation of the XML document.
 *
 * The content of an XML element is either of:
 * - null (if the element has the xsi:nil="true" attribute)
 *      We assume it has no child nodes.
 * - A XSD Complex Type (if the element has child elements or if it has the xsi:type="..." attribute)
 *      We represent a Complex Type as a JavaScript object.
 *      We add each child element as a property on the object.
 *      If there are multiple child elements with the same name, the property becomes an array of those childs.
 *      If the caller expects an array, but the array might not always have multiple entries, the caller can ensure the value is an array like this:
 *      let myArray = conn.asArray(mvValue);
 *      The xsi:type attribute is added as a property named "$type" on the JavaScript object, and all other attributes are ignored.
 * - A XSD Simple Type (otherwise)
 *      We represent a Simple Type as a JavaScript string.
 *      The caller can then convert it to the relevant type, for example:
 *      let myNumber = Number(myValue);
 *      let myBoolean = myValue == "true";
 *
 * Our type selection criteria works because:
 * - Salesforce never puts an xsi:type attribute on simple types, only on sObjects.
 * - All complex types in Salesforce always have child elements, except sObjects.
 * - While sObjects are complex types but might not always have child elements, they always have either a xsi:type attribute (in the Enterprise WSDL) or a <type> child element (in the Partner WSDL).
 */
function xmlParser(xml) {
  let parser = new XMLParser();
  parser.xml = xml;
  parser.pos = 0;
  let procEnd = parser.xml.indexOf("?>");
  if (procEnd >= 0) {
    parser.pos = procEnd + "?>".length;
  }
  let {name, value} = parser.parseTag();
  return {[name]: value};
}

/**
 * XML Parser helper class.
 *
 * We have two properties:
 * this.xml : string : The XML data to be parsed.
 * this.pos : integer : The current parsing position in this.xml.
 */
class XMLParser {

  // Precond: this.xml[this.pos] is the "<" character in an start tag
  // Postcond: this.xml[this.pos] is the character after the ">" character in the corresponding end tag
  // Returns: An object with two properties:
  // - name : string : The element's tag name
  // - value : any : A JavaScript value representing the contents of the element.
  parseTag() {
    let name;
    let value = ""; // A string or an object, default is string
    {
      // Consume the start tag
      this.assert(this.xml[this.pos] == "<");
      this.pos++;
      let startEnd = this.xml.indexOf(">", this.pos);
      this.assert(startEnd >= this.pos);
      let startTag = this.xml.substring(this.pos, startEnd);
      this.pos = startEnd + ">".length;

      // Process the start tag
      let nameEnd = startTag.indexOf(" ");
      if (nameEnd >= 0) {
        // We have attributes
        name = startTag.substring(0, nameEnd);

        // Parse the xsi:nil attribute
        if (startTag.includes(" xsi:nil=\"true\"", nameEnd)) {
          if (startTag.endsWith("/")) {
            // Self-closing tag
          } else {
            // Assuming no child elements, find and process the end tag
            let endStart = this.xml.indexOf("<", this.pos);
            this.assert(endStart >= this.pos);
            this.pos = endStart;
            this.parseEndTag(name);
          }
          return {name, value: null};
        }

        // Parse the xsi:type attribute
        let typeStart = startTag.indexOf(" xsi:type=\"");
        if (typeStart >= 0) {
          typeStart += " xsi:type=\"".length;
          let typeEnd = startTag.indexOf("\"", typeStart);
          value = {$type: startTag.substring(typeStart, typeEnd)};
        }

        if (startTag.endsWith("/")) {
          // Self-closing tag
          return {name, value};
        }

      } else {
        // We don't have any attributes
        if (startTag.endsWith("/")) {
          // Self-closing tag
          name = startTag.substring(0, startTag.length - 1);
          return {name, value};
        } else {
          name = startTag;
        }
      }
    }

    // Consume and process child nodes + end tag
    for (;;) {

      // Process text, if there is any
      {
        let nextStart = this.xml.indexOf("<", this.pos);
        this.assert(nextStart >= this.pos);
        if (typeof value == "string") {
          this.assert(value == "");
          let text = this.xml.substring(this.pos, nextStart);
          value = text.replace("&gt;", ">").replace("&lt;", "<").replace("&amp;", "&");
        } else {
          // Ignore text if the value is an object
        }
        this.pos = nextStart;
      }

      // Process next tag
      if (this.xml[this.pos + 1] == "/") {
        // The tag is an end tag
        this.parseEndTag(name);
        return {name, value};
      } else {
        // The tag is a start tag for a child element
        if (typeof value == "string") {
          // Convert from XSD Simple Type to XSD Complex Type, if not already done
          value = {};
        }
        let sub = this.parseTag();
        if (sub.name in value) {
          if (Array.isArray(value[sub.name])) {
            // Third or subsequent child with that name
            value[sub.name].push(sub.value);
          } else {
            // Second child with that name
            value[sub.name] = [value[sub.name], sub.value];
          }
        } else {
          // First child with that name
          value[sub.name] = sub.value;
        }
      }

    }
  }

  parseEndTag(name) {
    let endEnd = this.xml.indexOf(">", this.pos) + 1;
    this.assert(endEnd > this.pos);
    this.assertEq(this.xml.substring(this.pos, endEnd), "</" + name + ">");
    this.pos = endEnd;
  }

  assertEq(a, b) {
    this.assert(a == b, a + "==" + b);
  }

  assert(cond, note) {
    if (!cond) {
      // The error message is just for easier debugging. We don't actually support catching malformed XML.
      throw new Error("XML parser assertion failed\nPos:" + this.pos + "\nXML:" + this.xml.substr(this.pos, 30) + "\nNote:" + note);
    }
  }

}

module.exports = xmlParser;
