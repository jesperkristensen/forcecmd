[![Build Status](https://travis-ci.org/jesperkristensen/forcecmd.svg?branch=master)](https://travis-ci.org/jesperkristensen/forcecmd)

Command line tool for the Salesforce metadata API
========

This command line tool allows you to use the file based Salesforce metadata API
to download and deploy your Org's configuration and code.
The tool will automatically build the required `package.xml` file for you
and work around some bugs and limitations in the metadata API.

## Installation

1. Install Node.js from http://nodejs.org/.
2. Open a command prompt / terminal.
3. Run `npm install --global forcecmd`.

## Set up an org

1. Create an empty directory for your org.
2. Create a new file in your org's directory named `forcecmd.json` with content like this:

        {
          "hostname": "login.salesforce.com",
          "username": "yourname@yourcompany.com"
        }

3. Create a new file in your home directory (`~`) named `forcepw.json` with content like this:

        {
          "passwords": {
            "login.salesforce.com:yourname@yourcompany.com": "YourPasswordYourSecirityToken"
          }
        }

## Download an org

1. Navigate your command prompt to your org's directory.
2. Type `forcecmd retrieve`.

All metadata and all custom settings are downloaded by default. You can customize this in `forcecmd.json` like this:

    {
      "apiVersion": "45.0",
      "hostname": "login.salesforce.com",
      "username": "yourname@yourcompany.com",
      "excludeDirs": ["documents"],
      "objects": {
        "MyCustomSetting__c": false,
        "Product2": true,
        "Pricebook2": ["Id", "Name", "IsActive"],
        "PricebookEntry": "select Product2Id, Pricebook2Id, UnitPrice from PricebookEntry where IsActive = true"
      }
    }

Use `forcecmd retrieve --verbose` to see what values are available to customize, or to debug issues finding the right password.

Upon completion the tool will typically print a number of messages from the Metadata API indicating problems. This is normal. If the status is Succeeded, you can ignore the messages.

## Deploy changes

1. Navigate your command prompt to our org's directory.
2. Type for example `forcecmd deploy src/classes/MyClass.cls src/objects/Account.object`.

Additional arguments:
* `--destroy`: Delete all the listed files instead of updating them.
* `'--options={"rollbackOnError":true}'`: Specify deployment options as documented on http://www.salesforce.com/us/developer/docs/api_meta/Content/meta_deploy.htm#deploy_options

## Set up development environment

1. Clone this repository.
2. From the root of the cloned repository, run `npm install`.
3. Replace `forcecmd` with `node path/to/this/tool/cli.js` when you use the tool.

## License

MIT
