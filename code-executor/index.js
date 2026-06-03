const functions = require('@google-cloud/functions-framework');
const buffer = require('buffer').Buffer;
const lodash = require('lodash');
const crypto = require('crypto');
const cheerio = require('cheerio');
const dateFns = require('date-fns');
const fastXmlParser = require('fast-xml-parser');
const Fuse = require('fuse.js');
const mime = require('mime');
const numberToWords = require('number-to-words');
const url = require('url');
const uuid = require('uuid');
const axios = require('axios');
const dfd = require("danfojs-node")
const jszip = require("jszip")
const dayjs = require("dayjs")

const createModuleContext = () => ({
  lodash,
  require: (moduleName) => {
    const allowedModules = {
      'lodash': lodash,
      'crypto': crypto,
      'buffer': buffer,
      'cheerio': cheerio,
      'date-fns': dateFns,
      'fast-xml-parser': fastXmlParser,
      'fuse.js': Fuse,
      'mime': mime,
      'number-to-words': numberToWords,
      'url': url,
      'uuid': uuid,
      'axios': axios,
      'dfd': dfd,
      'jszip': jszip,
      'dayjs': dayjs
    };

    if (!allowedModules[moduleName]) {
      throw new Error(`Module "${moduleName}" is not allowed or not installed`);
    }

    return allowedModules[moduleName];
  }
});

functions.http('executeCode', async (req, res) => {
  try {
    console.log(`Request Data:`, req.body);
    const reqbody = req.body;

    if (!reqbody || !reqbody.code || !reqbody.input) {
      res.status(400).json({ error: 'Incomplete data provided. Need code and input.' });
      return;
    }

    const moduleContext = createModuleContext();
    const contextKeys = Object.keys(moduleContext);

    const userCode = reqbody.code;
    const inputData = reqbody.input;

    console.log(`User Code ${userCode}`);
    console.log(`User Input`, inputData);

    const executeCode = new Function(
      ...contextKeys,
      'input',
      `return (async () => { ${userCode} })();`
    );
    const result = await executeCode(
      ...contextKeys.map(key => moduleContext[key]),
      inputData
    );

    console.log('Result', result);

    res.status(200).json({ result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
