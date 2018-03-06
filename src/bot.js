const path = require('path');
const fs = require('fs');
const assert = require('assert');
const XMLHttpRequest = require('xmlhttprequest').XMLHttpRequest;

const Bot = require('./lib/Bot');
const SOFA = require('sofa-js');
const Fiat = require('./lib/Fiat');
const Logger = require('./lib/Logger');
//const Session = require('./lib/Session');
const solc = require('solc');

const nunjucks = require('nunjucks');
const express = require('express');
const session = require('express-session');
const redis = require('redis');
const RedisStore = require('connect-redis')(session);
const favicon = require('serve-favicon');
const multer = require('multer');
const bodyParser = require('body-parser');

const PsqlStore = require('./PsqlStore');
const Web3 = require('web3');

let web3 = new Web3();

/*Implement additional addHours method for Date object*/
Date.prototype.addHours = function(h) {
   this.setTime(this.getTime() + (h*60*60*1000));
   return this;
}

function generateDatetimeString(offsetHours) {
  return new Date().addHours(offsetHours).toISOString().slice(0, 19).replace('T', ' ');
}

const DEFAULT_FUNC = () => {return true;};

const code = fs.readFileSync(path.join(__dirname, '..', 'dapp_src', 'new_logistics.sol')).toString();
const compiledCode = solc.compile(code);
const nonparsedAbiDefinition = compiledCode.contracts[':Shipment'].interface;
const byteCode = compiledCode.contracts[':Shipment'].bytecode;
//const contractTx = web3.eth.contract(abiDefinition);

const monthCode2Nr = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12
};

let bot = new Bot(() => {
  bot.dbStore = new PsqlStore(bot.client.config.storage.postgres.url, process.env.STAGE || 'development');
  bot.dbStore.initialize(DATABASE_TABLES).then(() => {Logger.info("Database correctly set!");}).catch((err) => {
    Logger.error(err);
  });
});
let botAddress = bot.client.toshiIdAddress;

const DATABASE_TABLES = `
CREATE TABLE IF NOT EXISTS contracts (
    contract_address VARCHAR(42) PRIMARY KEY,
    contract_name VARCHAR(32),
    sender_address VARCHAR(42),
    handler_address VARCHAR(42),
    receiver_address VARCHAR(42),
    contract_status SMALLINT,
    deployment_dt TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
    address VARCHAR(42) PRIMARY KEY,
    toshi_id VARCHAR(42),
    nonce VARCHAR(64),
    validity TIMESTAMP NOT NULL
);
`;

const expressOptions = {
  dotfiles: 'ignore',
  etag: false,
  extensions: ['html','htm'],
  index: false,
  maxAge: 3600 * 1000,
  redirect: false,
  setHeaders: (res, path, stat) => {
	res.set('x-timestamp', Date.now());
  }
};

const expressNavbarOptions = {
  sender: [
    {name: "Home", href: "/", isCurrent: true, isDisabled: false},
    {name: "Create New Contract", href: "/new-contract", isCurrent: false, isDisabled: false},
    {name: "Withdraw Funds", href: "/withdrawal", isCurrent: false, isDisabled: false},
  ],
  handler: [
    {name: "Home", href: "/", isCurrent: true, isDisabled: false},
    {name: "Create New Contract", href: "/new-contract", isCurrent: false, isDisabled: false},
  ],
  receiver: [
    {name: "Home", href: "/", isCurrent: true, isDisabled: false},
    {name: "Create New Contract", href: "/new-contract", isCurrent: false, isDisabled: false},
    {name: "This Contract", isCurrent: false, isDisabled: false, options: [
      {name: "Set as Completed", href: "/set-completed-contract", isCurrent: false, isDisabled: false},
      {name: "Set as Refused", href: "/set-refused-contract", isCurrent: false, isDisabled: false},
    ]},
  ],
  anyone: [
    {name: "Home", href: "/", isCurrent: true, isDisabled: false},
    {name: "Create New Contract", href: "/new-contract", isCurrent: false, isDisabled: false},
  ],
};

function Get(yourUrl){
    var Httpreq = new XMLHttpRequest();
    Httpreq.open("GET",yourUrl,false);
    Httpreq.send(null);
    return Httpreq.responseText;
}

function hasPropertyName(obj, name) {
	return typeof(obj) !== 'undefined' ? Object.getOwnPropertyNames(obj).indexOf(name) > -1 : false;
}

function generateNavbarOptions(req) {
  return expressNavbarOptions.anyone;
}

async function maybeCreateAndRegisterNonce(session) {
  let possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = Array.from({length: 64},(_, n) => n+1).map(
    ()=>possible[Math.floor(possible.length * Math.random())]
  ).join('');
  let success = false;
  //Logger.info("USER SESSION PROPERTIES: " + Object.getOwnPropertyNames(session.user));
  //Logger.info("PAYMENT ADDRESS:         " + session.user.payment_address);
  let result = await bot.dbStore.fetchval(
    "SELECT nonce FROM nonces WHERE address = $1 AND validity >= $2 :: timestamp",
    [
      web3.utils.toChecksumAddress(hasPropertyName(session, 'user') ? session.user.payment_address : session.payment_address),
      generateDatetimeString(0)
    ]);
  if(!result){
    return bot.dbStore.execute(
      "INSERT INTO nonces (nonce, toshi_id, address, validity)" +
      "  VALUES ($1,$2,$3,$4) " +
      "  ON CONFLICT (address) DO UPDATE" +
      "    SET nonce = $1, toshi_id = $2, validity = $4;",
      [
        nonce,
        hasPropertyName(session, 'user') ? session.user.toshi_id : '',
        web3.utils.toChecksumAddress(hasPropertyName(session, 'user') ? session.user.payment_address : session.payment_address),
        generateDatetimeString(8)
      ]
    ).then(()=>{
      Logger.info("Nonce successfuly created!");
      return nonce;
    }).catch((err)=>{
      Logger.error("Error while creating new nonce...\n");
      console.error("Error while creating new nonce...\n");
      Logger.error(err);
      console.error(err);
      return false;
    });
  } else {
    return result;
  }
}

function checkNonce(nonce) {
  let result = false;
  return bot.dbStore.fetchrow(
    "SELECT * FROM nonces WHERE nonce = $1",
    [nonce]
  ).then((nonce)=>{
    //Logger.info("Validity:   " + String(nonce.validity));
    let v = (nonce == null) ? false : String(nonce.validity).split(/[- :]/);
    //Logger.info("Date:       " + String(new Date()));
    return v ? (
      new Date(Date.UTC(v[3], monthCode2Nr[v[1]]-1, v[2], v[4], v[5], v[6])).getTime() >= new Date().getTime() ?
        {address: web3.utils.toChecksumAddress(nonce.address), toshi_id: nonce.toshi_id} :
        false
      ) :
      false;
  }).catch((err)=>{
    Logger.error("Error validating nonce...\n");
    console.error("Error validating nonce...\n");
    Logger.error(err);
    console.error(err);
    return false;
  });
}

async function maybeSetNonceAndRetrieveUser(req) {
  let inQuery = hasPropertyName(req.query, 'nonce');
  let inSession = hasPropertyName(req.session, 'nonce');
  let res = false;
  if(inQuery) {
    res = await checkNonce(req.query.nonce);
  } else if(inSession) {
    res = await checkNonce(req.session.nonce);
  }
  if(res){
    req.session.nonce = inQuery ? req.query.nonce : req.session.nonce;
    req.session.toshi_id = res.toshi_id;
    req.session.payment_address = res.address;
    req.session.save(Logger.error)
    Logger.info("Nonce: " + String(req.session.nonce));
  }
  return res.address;
}

function retrieveContractAttributes(contract) {
  
}

const MYIP = JSON.parse(Get("https://jsonip.com")).ip;
const upload = multer();

const redisUrl = process.env.REDIS_URL;
const redisPort = parseInt(redisUrl.split(':')[-1]);
const redisClient = redis.createClient({port: redisPort, url: redisUrl});

let app = express();
app.use('static', express.static(path.join(__dirname,'public'), expressOptions));
app.use(express.static(path.join(__dirname,'public'), {maxAge: 3600*1000}));
app.use(favicon(path.join(__dirname,'public','img','favicon.ico')));
app.use(session({ store: new RedisStore({
  host: '127.0.0.1',
  port: redisPort,
  client: redisClient,
  prefix: 'express_session_',
}), secret: 'SEKR37$$', resave: false, saveUninitialized: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));

let env = nunjucks.configure(path.join(__dirname,'public','templates'), {
  autoescape: true,
  express: app,
});

env.addFilter('istype', function(obj, type_) {
    return typeof(obj) === type_;
});

env.addFilter('washere', function(obj) {
    console.log(obj.toString());
    return obj;
});

const asyncMiddleware = fn =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next))
      .catch(next);
  };

app.get('/', upload.array(), asyncMiddleware( async (req, res, next) => {
  //let user;
  //if(!(user = await maybeSetNonceAndRetrieveUser(req)) || !await maybeCreateAndRegisterNonce(req.session)) {
  //  res.send('Access denied! Please access through Toshi');
  //  return;
  //}
  let opts = {};
  let contract = req.query.cAddr || '';
  opts['options'] = generateNavbarOptions(req);
  opts['title'] = "Logistics 3.0";
  opts['subtitle'] = "Logistics Smart-Contract Management for unlimited blockchained fun.";
  opts['currentMarker'] = "<span class=\"sr-only\">(current)</span>";
  opts['nonparsedAbiDefinition'] = nonparsedAbiDefinition;
  opts['byteCode'] = byteCode;
  opts['contractAddress'] = contract;
  await Fiat.fetch().then((toEth) => { opts['fiatUSDChange'] = toEth.USD(1);});
  await bot.dbStore.fetchrow(
    "SELECT contract_name, sender_address, handler_address, receiver_address," +
    " contract_status FROM contracts WHERE contract_address = $1;",
    [contract]
  ).then((res) => {
    opts['contractName'] = res.contract_name;
    opts['contractSender'] = res.sender_address;
    opts['contractHandler'] = res.handler_address;
    opts['contractReceiver'] = res.receiver_address;
    opts['contractStatus'] = res.contract_status;
  }).catch((err) => {
    Logger.error("Error retrieving contract info from the database!");
    Logger.error(err);
    console.error("Error retrieving contract info from the database!");
    console.error(err);
  });
  res.render(path.join(__dirname,'public','templates','index.html'), opts);
}));

app.get('/new-contract', asyncMiddleware( async (req, res, next) => {
  let user;
  if(!(user = await maybeSetNonceAndRetrieveUser(req)) || !await maybeCreateAndRegisterNonce(req.session)) {
    res.send('Access denied! Please access through Toshi');
    return;
  }
  let opts = {};
  opts['options'] = generateNavbarOptions(req);
  opts['title'] = "Logistics 3.0";
  opts['subtitle'] = "Logistics Smart-Contract Management for unlimited blockchained fun.";
  opts['currentMarker'] = "<span class=\"sr-only\">(current)</span>";
  opts['nonparsedAbiDefinition'] = nonparsedAbiDefinition;
  opts['byteCode'] = byteCode;
  opts['nonce'] = req.session.nonce;
  res.render(path.join(__dirname,'public','templates','new-contract.html'), opts);
}));

app.post('/new-contract', upload.array(), asyncMiddleware( async (req, res, next) => {
  Logger.info("Request body:  " + String(Object.getOwnPropertyNames(req.body)));
  Logger.info("Request nonce: " + String(req.body.nonce));
  if(!hasPropertyName(req.body, 'nonce')){
    res.json({res: 'Error, unexistent nonce', err: true});
    return;
  }

  let user = await checkNonce(req.body.nonce);
  if(!user || !hasPropertyName(user, 'address')){
    res.json({res: 'Error, session expired. Please, go back to Toshi to update your session info', err: true});
    return;
  }

  if(user.address !== req.body.sAddr){
    Logger.error('Error, incorrect sender address. Are you the contract signer?');
    Logger.error('Nonce User:     ' + user.address);
    Logger.error('Given Address:  ' + req.body.sAddr);
    res.json({res: 'Error, incorrect sender address. Are you the contract signer?', err: true});
    return;
  }

  Logger.info("New contract correctly deployed!");

  let result = {res: 'Error awaiting for database write event', err: true};

  await bot.dbStore.execute(
    "INSERT INTO contracts" +
    "  (contract_address, contract_name, sender_address, handler_address," +
    "    receiver_address, contract_status, deployment_dt)" +
    "  VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [
      req.body.cAddr,
      req.body.n,
      req.body.sAddr,
      req.body.hAddr,
      req.body.rAddr,
      req.body.s,
      req.body.timestamp
    ]
  ).then((res) => {
    Logger.info("Contract correctly registered in the database!");
    Logger.info("DATA: " + JSON.stringify(req.body));
    result = {res: 'Everything turned out fine!', err: false};
  }).catch((err) => {
    Logger.error("Error registering new contract in the database!");
    Logger.error(err);
    console.error("Error registering new contract in the database!");
    console.error(err);
    result = {res: 'Error registering new contract in the database!', err: true}
  });

  res.json(result);
  return;

}));

app.get('/withdrawal', upload.array(), asyncMiddleware( async (req, res, next) => {
  let user;
  if(!(user = await maybeSetNonceAndRetrieveUser(req)) || !await maybeCreateAndRegisterNonce(req.session)) {
    res.send('Access denied! Please access through Toshi');
    return;
  }
  let opts = {};
  opts['options'] = generateNavbarOptions(req);
  opts['title'] = "Logistics 3.0";
  opts['subtitle'] = "Logistics Smart-Contract Management for unlimited blockchained fun.";
  opts['currentMarker'] = "<span class=\"sr-only\">(current)</span>";
  opts['nonparsedAbiDefinition'] = nonparsedAbiDefinition;
  opts['byteCode'] = byteCode;
  opts['nonce'] = req.session.nonce;
  opts['contractAddress'] = req.query.cAddr || '';
  await Fiat.fetch().then((toEth) => { opts['fiatUSDChange'] = toEth.USD(1);});
  res.render(path.join(__dirname,'public','templates','withdrawal.html'), opts);
}));

app.get('/set-completed-contract', upload.array(), asyncMiddleware( async (req, res) => {
  let opts = {};
  opts['options'] = generateNavbarOptions(req);
  opts['title'] = "Logistics 3.0";
  opts['subtitle'] = "Logistics Smart-Contract Management for unlimited blockchained fun.";
  opts['currentMarker'] = "<span class=\"sr-only\">(current)</span>";
  opts['nonparsedAbiDefinition'] = nonparsedAbiDefinition;
  opts['byteCode'] = byteCode;
  opts['nonce'] = req.session.nonce;
  opts['contractAddress'] = req.query.cAddr || '';
  await Fiat.fetch().then((toEth) => { opts['fiatUSDChange'] = toEth.USD(1);});
  res.render(path.join(__dirname,'public','templates','set-completed-contract.html'), opts);
}));

app.get('/set-refused-contract', upload.array(), asyncMiddleware( async (req, res) => {
  let opts = {};
  opts['options'] = generateNavbarOptions(req);
  opts['title'] = "Logistics 3.0";
  opts['subtitle'] = "Logistics Smart-Contract Management for unlimited blockchained fun.";
  opts['currentMarker'] = "<span class=\"sr-only\">(current)</span>";
  opts['nonparsedAbiDefinition'] = nonparsedAbiDefinition;
  opts['byteCode'] = byteCode;
  opts['nonce'] = req.session.nonce;
  opts['contractAddress'] = req.query.cAddr || '';
  res.render(path.join(__dirname,'public','templates','set-refused-contract.html'), opts);
}));

app.listen(8888, function(){
  console.log("Express Webapp working!!");
});

//let code = fs.readFileSync('./dapp_src/logistics.sol').toString();
//let web3 = new Web3( new Web3.providers.HttpProvider('http://ropsten.infura.io/'));

let last_command = 'main';

const preprocessOptions = async (session, options) => {
  return await Promise.all(
    options.map(async function(option) {
      let opt = {};
      option = hasPropertyName(option, 'control') ? option.control : option;
      opt['type'] = option.type;
      opt['label'] = option.label;
      if(hasPropertyName(option, 'action')){
        if(option.action.type === "webview"){
          let parameterReducer = (res, key) => {
            res += "&" + key + "=" + option.action.parameters[key];
            return res;
          }
          opt['action'] = "Webview::" + option.action.value + "?nonce=";
          opt['action'] += await Promise.resolve(maybeCreateAndRegisterNonce(session));
          opt['action'] += hasPropertyName(option.action, 'parameters') ? Object.keys(option.action.parameters).reduce(parameterReducer,'') : '';
        } else {
          opt['action'] = option.action.value;
        }
      } else {
        opt['value'] = hasPropertyName(option, "value") ? option.value : label2Command(option.label);
      }
      return opt;
    })
  );
};

const label2Command = (message) => {return message.toLowerCase().split(' ').join('_')};
const retrieveList = async (session, role, status, webview) => {
  status = typeof status !== 'undefined' ? status : -1;
  webview = typeof webview !== 'undefined' ? webview : false;
  let option_reducer = (res, opt, i) => {
    let res_ = {type:'button',label:""+(i+1)};
    if(webview) {
      res_['action'] = {
        type:'webview',
        value: webview,
        parameters: {cAddr:opt.contract_address}
      };
    } else {
      res_['value'] = opt.contract_address;
    }
    res[res.length] = res_;
    return res;
  }
  let name_reducer = (res, opt, i) => {
    res[res.length] = " " + (i+1) + ". " + opt.contract_name;
    return res;
  }
  Logger.info("Retrieve list STATUS: " + status);
  let myAddress = web3.utils.toChecksumAddress(session.user.payment_address);
  let filterEdges = [
    {name: 'sender_address', value: (role === "sender" || role === "any") ? myAddress : ""},
    {name: 'receiver_address', value: (role === "receiver" || role === "any") ? myAddress : ""},
    {name: 'handler_address', value: (role === "handler" || role === "any") ? myAddress : ""},
    {name: 'contract_status', value: (status === -1 || role === "any") ? "" : status}
  ];
  let filterEdgeReducer = (res, elem, i) => {
    if(hasPropertyName(elem, "value") && elem.value.length > 0) {
      res.subqueries[res.subqueries.length] = elem.name + " = $" + (res.subqueries.length + 1);
      res.arguments[res.arguments.length] = elem.value;
    }
    return res;
  };
  let queryParts = filterEdges.reduce(filterEdgeReducer, {subqueries: [], arguments: []});
  let query = "SELECT contract_address, contract_name FROM contracts";
  if(role === "any") {
    query += " WHERE (" + queryParts.subqueries.join(" OR ") + (
      status !== -1 ? ") AND status = $" + (queryParts.arguments.length + 1) + ";" : ");"
    );
    if(status !== -1) queryParts.arguments[queryParts.arguments.length] = status;
  } else {
    query += queryParts.subqueries.length > 0 ? " WHERE " + queryParts.subqueries.join(" AND ") + ";" : ";";
  }
  return await bot.dbStore.fetch(query, queryParts.arguments).then(async (res) => {
    if(res.length == 0) return {value:"Sorry, nothing to show yet...", iserror: true};
    let names = res.reduce(name_reducer, []).join("\n");
    let options = res.reduce(option_reducer, [{type: 'button',label: 'Done',value: 'done'}]);
    Logger.info("Query result: " + JSON.stringify(res));
    Logger.info("Names:        " + JSON.stringify(names));
    Logger.info("Options:      " + JSON.stringify(options));
    return {value:[names, await preprocessOptions(session, options)], iserror: false};
  }).catch((err) => {
    return {value:"An error occurred while querying the database...\n" + err, iserror: true}
  });
};

/*const retrieveNonces = async (session) => {
  let name_reducer = (res, opt, i) => {
    res[res.length] = " " + (i+1) + ". " + opt.address;
    return res;
  }
  return await bot.dbStore.fetch(
    "SELECT address FROM nonces;",
    []
  ).then((res) => {return {value: res.reduce(name_reducer, []).join("\n"), iserror: false};}
  ).catch((err) => {return {value:"An error occurred while querying the database...\n" + err, iserror: true};});
};
const listNonces = async (session) => {sendMessage(...[session].concat([].concat((await retrieveNonces(session)).value))); return true;};*/

const listSent = async (session) => {sendMessage(...[session].concat([].concat((await retrieveList(session, 'sender', 0)).value)[0])); return true;};
const listPending = async (session) => {sendMessage(...[session].concat([].concat((await retrieveList(session, 'receiver', 0)).value)[0])); return true;};
const listAndPrompt = (listOptions) => {
  return async (session) => {

    let allowedOptions = ["role", "status", "webview"];
    let allowedOptionsDefaults = {role:'any', status: -1, webview: false};
    const statusNames = ["pending", "accepted", "refused"];

    const listOptionsValueReducer = (res, opt) => {
      let i = allowedOptions.indexOf(opt);
      if(i > -1)
        res[i] = listOptions[opt];
      return res;
    }

    let listOpt = Object.keys(listOptions).reduce(listOptionsValueReducer,allowedOptions.map((name)=>{return allowedOptionsDefaults[name];}));
    let res = await retrieveList(...[session].concat(listOpt));
    if(res.iserror){
      sendMessage(
        session,
        `Sorry, you don't appear as a ` + (listOptions.role || allowedOptionsDefaults.role) +
        ` for any ` + statusNames[listOptions.status || allowedOptionsDefaults.status] + ` shipment...`
      );
      prepareFallBackToMain(session, false);
      return false;
    }
    sendMessage(session, `Please, choose one of the following shipping contracts`,[]);
    sendMessage(...[session].concat([].concat(res.value)));
    return true;
  };
};
/// Work In Progress
const promptJSONTemplate = (template, ...substitutions) => {
  const parseSubstitution = (session, opt) => {return hasPropertyName(opt, 'sessVar') ? maybeRetrieveSessionVar(session, opt.sessVar, "") : opt;};
  return async (session) => {

    let done_option = [{type: 'button',label: 'Done',value: 'done'}];

    const templateReducer = (res, piece, i) => {return res + parseSubstitution(session, substitutions[i])};
    let result = template.slice(1).reduce(templateReducer, template[0]);

    sendMessage(...[session].concat([].concat(JSON.parse(result)).concat(done_option)));
  };
};

const renderControlsAndPrompt = (body, processes) => {
  return (session, options) => {
    for(let i = 0; i < processes.length; i++) {
      let proc = processes[i];
      let anonymousAttributeCounts = Array(options.length).fill(0);
      for(let j = 0; j < options.length; j++) {
        if(hasPropertyName(proc, "filter") ? !proc.filter(options[j]) : false) continue;
        switch(proc.type) {
        case "attribute":
          Logger.info("Attribute process - Has sessVar? " + (hasPropertyName(proc.arguments, "sessVar") ? "YES" : "NO"));
          Logger.info("Session Var: " + proc.arguments.sessVar);
          Logger.info("Session Var Value: " + maybeRetrieveSessionVar(session, proc.arguments.sessVar, ""));
          let attrValue = hasPropertyName(proc.arguments, "sessVar") ? maybeRetrieveSessionVar(session, proc.arguments.sessVar, "") : (proc.arguments.value || true);
          let attrName = hasPropertyName(proc.arguments, "alias") ? proc.arguments.alias : (
            typeof(attrValue) === 'string' ? attrValue : "attr" + ++anonymousAttributeCounts[j]
          );
          options[j].action += (/\?/.test(options[j].action) ? "&" : "?") + attrName + "=" + attrValue;
        }
      }
    }
    sendMessage(session, body, options);
  };
};

// Format checking functions
const hasWebview = (obj) => {return hasPropertyName(obj, "action") ? /^Webview/.test(obj.action) : false;};

//const listAndPromptSender = async (session, options) => {
//  let res = await retrieveList(session, 'sender');
//  if(res.iserror){
//    sendMessage(session, `Sorry, you don't appear as sender for any pending shipment...`);
//    prepareFallBackToMain(session, false);
//    return false;
//  }
//  sendMessage(session, `Please, choose one of the following shipping contracts`,[]);
//  sendMessage(...[session].concat([].concat(res.value)));
//  return true;
//};

let menuOptions = {
  main: {
    msgHeader: `Hi there! Welcome to the Logistics Smart Contract Handler.`,
    options: [
      /*{
        control: {
          type: 'button',
          label: 'List Nonces',
          description: 'Retrieve existing nonces',
        },
        f: listNonces
      },*/
      {
        control: {
          type: 'button',
          label: 'New Shipment',
          action: {type:"webview", value:"http://" + MYIP + ":18889/new-contract"},
          description: 'Create a new contract for a shipment',
        }
      },
      {
        control: {
          type: 'button',
          label: 'Check Contract',
          description: 'Access Contract Info GUI',
        }
      },
      {
        control: {
          type: 'button',
          label: 'List Sent',
          description: 'Show a list for all sent packets',
        },
        f: listSent,
      },
      {
        control: {
          type: 'button',
          label: 'Shipment Received',
          description: 'Set packet as received and accept it or refuse it and return it',
        }
      },
      {
        control: {
          type: 'button',
          label: 'List Pending',
          description: 'Show a list for all pending packets',
        },
	  f: listPending,
      },
      {
        control: {
          type: 'button',
          label: 'Withdraw',
          description: 'Withdraw pending ETH from a contract',
        },
      },
      {
        control: {
          type: 'button',
          label: 'Help',
          description: 'Show this message again',
        },
        f: help,
      },
      {
        control: {
          type: 'button',
          label: 'Donate',
          description: 'Support this project :)',
        },
        f: donate,
      },
    ],
  },
  /*new_shipment: {
    msgHeader: `You're about to create a new shipping contract.`,
    // TODO: Complete with prompted options
    prompts: [
      {
        body: `Please provide a name to identify your new contract/shipment.`,
        v: "shippingContractName",
      },
      {
        body: `What's the shipping receiver's Toshi address?`,
        v: "shippingContractReceiver",
      },
      {
        body: `What's the transporter's Toshi address?`,
        v: "shippingContractTransporter",
      },
      {
        body: `What's the price to pay on arrival for the packet?`,
        v: "shippingContractPrice",
      },
      //{
      //  body: `Do you want to handle payment by contract on the arrival?`,
      //  controls: [
      //    {type: 'button', label: 'Yes', value: 'yes'},
      //    {type: 'button', label: 'No', value: 'no'},
      //  ],
      //  v: "shippingContractPaymentOnArrival",
      //},
      //{
      //  body: `What will the deadline be before launching a notification? (format: XX days)`,
      //  controls: [
      //    {type: 'button', label: 'Any', value: 'any'},
      //    {type: 'button', label: '1 Day', value: '1 day'},
      //    {type: 'button', label: '5 Days', value: '5 days'},
      //    {type: 'button', label: '15 Days', value: '15 days'},
      //  ],
      //  v: "shippingContractDeadline",
      //},
    ],
    parent: 'main',
  },*/
  shipment_received: {
    msgHeader: `You're about to close a shipping contract.`,
    prompts: [
      {
        body: listAndPrompt({role:'receiver', status: 0}),
        v: "shippingContractName",
      },
      {
        body: renderControlsAndPrompt(`What do you want to do?`, [{filter: hasWebview, type: "attribute", arguments: {alias: "cAddr", sessVar: "shippingContractName"}}]),
        controls: [
          {
            type: 'button',
            label: 'Accept & Pay',
            //value: 'accept'
            action: {type:"webview", value:"http://" + MYIP + ":18889/set-completed-contract"},
          },
          {
            type: 'button',
            label: 'Refuse & Return',
            //value: 'refuse'
            action: {type:"webview", value:"http://" + MYIP + ":18889/set-refused-contract"},
          },
          {
            type: 'button',
            label: 'Done',
            value: 'done',
          },
        ],
        v: "shippingReceivedAction",
        f: (session, opt) => {
          //TODO: Maybe apply changes to contract
          return true;
        },
      },
    ],
    parent: 'main',
  },
  withdraw: {
    msgHeader: `You're about to withdraw pending ETH from a contract.`,
    prompts: [
      {
        body: listAndPrompt({role:'sender', status: 0, webview: "http://" + MYIP + ":18889/withdrawal"}),
        v: "withdrawalContractName",
      },
      /*{
        body: `What do you want to do?`,
        controls: [
          {
            type: 'button',
            label: 'Withdraw',
            //value: 'accept'
            action: {type:"webview", value:"http://" + MYIP + ":18889/withdrawal"},
          },
          {
            type: 'button',
            label: 'Done',
            value: 'done',
          },
        ],
        v: "withdrawalReceivedAction",
        f: (session, opt) => {
          //TODO: Maybe apply changes to contract
          Logger.info("Withdrawal function called with argument '" + opt + "'");
          return true;
        },
      },*/
    ],
    parent: 'main',
  },
  check_contract: {
    msgHeader: `Choose a contract.`,
    prompts: [
      {
        body: listAndPrompt({webview: "http://" + MYIP + ":18889/"}),
      },
    ],
    parent: 'main',
  },
};

let default_controls = menuOptions.main.options.map(function(option){return {
  type: option.control.type,
  label: option.control.label,
  value: option.control.label.toLowerCase().split(' ').join('_'),
}});

bot.onEvent = async function(session, message) {
  let prev_submenu = maybeRetrieveSessionVar(session, 'submenu', 'main');
  switch (message.type) {
    case 'Init':
      help(session);
      break
    case 'Message':
    case 'Command':
      await onCommandOrMessage(session, message)
      break
    case 'Payment':
      onPayment(session, message);
      break
    case 'PaymentRequest':
      help(session);
      break
  }
  let new_submenu = maybeRetrieveSessionVar(session, 'submenu', 'main');
  if((prev_submenu != new_submenu) || (getUIType(menuOptions[new_submenu]) === 'prompts'))
    help(session);
}

function setSessionVar(session, name, value) {
  session.set(name, value);
  session.flush();
}

function maybeRetrieveSessionVar(session, name, default_) {
  default_ = typeof default_ !== 'undefined' ? default_ : false;
  let sessionVar = session.get(name) || default_;
  setSessionVar(session, name, sessionVar);
  return sessionVar;
}

function getUIType(menuObj) {
  return hasPropertyName(menuObj, 'options') ? 'options' : 'prompts';
}

function checkPromptPhase(session) {
  return session.get('promptphase') || 0;
}

/*function retrieveUserMenuOptions(session) {

  let reviver = (key, value) => {
    if (typeof(value)==='string' && value.indexOf('function ') === 0)
      return eval(`(${value})`);
    return value
  };

  let replacer = (key, value) => {
    if (typeof(value) === 'function')
      return value.toString();
    return value;
  };

  let result;
  let menuopt = session.get('menuoptions');
  if(!menuopt || (menuopt === 'undefined') || !(result = JSON.parse(menuopt, reviver))) {
    session.set('menuoptions', JSON.stringify(menuOptions, replacer, 2));
    session.flush();
    result = menuOptions;
  }

  return result;

}*/

function nextPromptPhase(session, menuObj) {
  let promptPhase = checkPromptPhase(session);
  Logger.info("Current Prompt Phase:" + promptPhase);
  promptPhase = (promptPhase + 1) % menuObj.prompts.length;
  Logger.info("Next Prompt Phase:   " + promptPhase);
  setSessionVar(session, 'promptphase', promptPhase);
  return promptPhase != 0;
}

function prepareFallBackToMain(session, addMsg=true) {
  setSessionVar(session, 'promptphase', 0);
  setSessionVar(session, 'submenu', 'main');
  if(addMsg)
    sendMessage(session, "Sorry, something didn't go as expected.\n\n Turning back to main menu...");
}

async function help(session) {

  let submenu = maybeRetrieveSessionVar(session, 'submenu', 'main');
  assert(hasPropertyName(menuOptions, submenu), 'Menu not found');

  let menuObj = menuOptions[submenu];
  let msg = '';

  if (getUIType(menuObj) == 'options') {

    msg += menuObj.msgHeader + `\n\nPlease, choose one of the following:`;

    for(let i = 0; i < menuObj.options.length; i++) {
      msg += "\n" + menuObj.options[i].control.label + ' - ' + menuObj.options[i].control.description;
    }

    let controls = await preprocessOptions(session, menuObj.options);

    sendMessage(session, msg, controls);

  } else {

    let promptPhase = checkPromptPhase(session);

    if (promptPhase <= -1) {
      Logger.info("ATTENTION! PromptPhase Reseted!!");
      setSessionVar(session, 'promptphase', 0);
      promptPhase = 0;
    }

    let menuPrompt = menuObj.prompts[promptPhase];
    let controls = hasPropertyName(menuPrompt, 'controls') ? await preprocessOptions(session, menuPrompt.controls) : [];
    if(typeof(menuPrompt.body) !== 'function'){
      sendMessage(
        session,
        menuPrompt.body,
        controls
      );
    } else {
      Logger.info("About to execute \"" + menuPrompt.body.name + "\"");
      menuPrompt.body(session, controls);
    }

  }

  return true;
}

async function handlePrompt(session, opt){
  let submenu = maybeRetrieveSessionVar(session, 'submenu', 'main');
  let menuObj = menuOptions[submenu];
  let promptPhase = checkPromptPhase(session);
  let menuPrompt = menuObj.prompts[promptPhase];

  if(typeof(menuPrompt) === 'undefined') {
    prepareFallBackToMain(session);
    return true;
  }

  let hasVar = hasPropertyName(menuPrompt, 'v');
  let promptFunc = hasPropertyName(menuPrompt, 'f') ? menuPrompt.f : DEFAULT_FUNC;

  if (hasVar)
    setSessionVar(session, menuPrompt.v, opt);

  Logger.info("Prompt Function Name: " + promptFunc.name);
  Logger.info("Arguments:            " + opt);
  Logger.info("Result:               " + String(hasVar ? await promptFunc(session, opt) : await promptFunc(session)));

  if (hasVar ? await promptFunc(session, opt) : await promptFunc(session)) {
    if (!nextPromptPhase(session, menuObj))
      setSessionVar(session, 'submenu', menuObj.parent);
    return true
  }

  return false;
}

async function handleOption(session, opt, menuOpt){
  let optFunc = hasPropertyName(menuOpt, 'f') ? menuOpt.f : DEFAULT_FUNC;

  let result = hasPropertyName(menuOpt, 'v') ? optFunc(session, session.get(menuOpt.v)) : optFunc(session);
  if (hasPropertyName(menuOptions, opt) && result)
    setSessionVar(session, 'submenu', opt);

  return await result;
}

async function onCommandOrMessage(session, obj) {

  const retrieveOption = (opt) => {return hasPropertyName(opt.content, 'value') ? opt.content.value : label2Command(opt.body);}
  const readPromptData = (opt) => {return hasPropertyName(opt.content, 'value') ? opt.content.value : opt.body;}

  let submenu = maybeRetrieveSessionVar(session, 'submenu', 'main');
  assert(hasPropertyName(menuOptions, submenu), 'Menu not found');

  let menuObj = menuOptions[submenu];

  if(typeof(menuObj) === 'undefined') {
    prepareFallBackToMain(session);
    return true;
  }

  function unknownCommandOrMessage() {
    sendMessage(session, "Unknown command or message...\n\nPlease, provide a valid input based on the following");
    help(session);
  }

  if (getUIType(menuObj) == 'options') {
    let option = retrieveOption(obj);
    let commandMap = menuObj.options.map((option)=>{return label2Command(option.control.label);});
    let menuOptIdx = commandMap.indexOf(option);
    return menuOptIdx > -1 ? await handleOption(session, option, menuObj.options[menuOptIdx]) : unknownCommandOrMessage();
  } else {
    let data = readPromptData(obj);
    return await handlePrompt(session, data);
  }

}

function onPayment(session, message) {
  if (message.fromAddress == session.config.paymentAddress) {
    // handle payments sent by the bot
    if (message.status == 'confirmed') {
      // perform special action once the payment has been confirmed
      // on the network
    } else if (message.status == 'error') {
      // oops, something went wrong with a payment we tried to send!
    }
  } else {
    // handle payments sent to the bot
    if (message.status == 'unconfirmed') {
      // payment has been sent to the ethereum network, but is not yet confirmed
      sendMessage(session, `Thanks for the payment! 🙏`);
    } else if (message.status == 'confirmed') {
      // handle when the payment is actually confirmed!
    } else if (message.status == 'error') {
      sendMessage(session, `There was an error with your payment!🚫`);
    }
  }
}

// STATES

function pong(session) {
  sendMessage(session, `Pong`)
}

function donate(session) {
  // request $1 USD at current exchange rates
  Fiat.fetch().then((toEth) => {
    session.requestEth(toEth.USD(1));
  });
}

// HELPERS

function sendMessage(session, message, controls_) {
  controls_ = typeof controls_ !== 'undefined' ? controls_ : default_controls;
  session.reply(SOFA.Message({
    body: message,
    controls: controls_,
    showKeyboard: false,
  }));
}
