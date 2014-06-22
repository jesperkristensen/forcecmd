Command line tool for the Salesforce metadata API
========

This command line tool allows you to use the file based Salesforce metadata API
to download and deploy your Org's configuration and code.
The tool will automatically build the required `package.xml` file for you
and work around some bugs and limitations in the metadata API.

## Installation

1. Install Node.js from http://nodejs.org/.
2. Clone this repository or download te source as a ZIP file.
3. Open a command prompt. (Tested in MinGW)
4. Navigate to the root of the source tree from step 2.
5.  Run `npm install`.

## Set up an org

1. Create an empty directory for your org.
2. Create a new file in your org's directory named `forcecmd.json` with content like this:

        {
          "apiVersion": "30.0",
          "loginUrl": "https://login.salesforce.com/",
          "username": "yourname@yourcompany.com"
        }

3. Create a new file in your home directory (`~`) named `forcepw.json` with content like this:

        {
          "passwords": {
            "https://login.salesforce.com/$yourname@yourcompany.com": "YourPasswordYourSecirityToken"
          }
        }

## Download an org

1. Navigate your command prompt to our org's directory.
2. Type `node path/to/this/tool/retrieve.js`.

## Deploy changes

1. Navigate your command prompt to our org's directory.
2. Type for example `node path/to/this/tool/deploy.js src/classes/MyClass.cls src/objects/Account.object`.

## License

MIT
