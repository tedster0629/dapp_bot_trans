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

const chalk = require('chalk');

let web3 = new Web3();

/*Implement additional addHours method for Date object*/
Date.prototype.addHours = function(h) {
   this.setTime(this.getTime() + (h*60*60*1000));
   return this;
}

function generateDatetimeString(offsetHours) {
  return new Date().addHours(offsetHours || 0).toISOString().slice(0, 19).replace('T', ' ');
}

const printError = (...messages) => {
  console.error(Logger.color(' ',
    "[ERR: " + generateDatetimeString() + " ]" +
    (messages.length > 1 ? "\n  " : "  ") +
    messages.map((msg)=> hasPropertyName(msg, 'stack')? msg.stack : msg).map(String).join("\n  ")
  , chalk.red));
}

const printInfo = (...messages) => {
  console.info(Logger.color(' ',
    "[INF: " + generateDatetimeString() + " ]" +
    (messages.length > 1 ? "\n  " : "  ") +
    messages.map(String).join("\n  ")
  , chalk.yellow));
}

const printWarning = (...messages) => {
  console.warn(Logger.color(' ',
    "[WRN: " + generateDatetimeString() + " ]" + 
    (messages.length > 1 ? "\n  " : "  ") +
    messages.map(String).join("\n  ")
  , chalk.orange));
}

const printLog = (...messages) => {
  console.log(Logger.color(' ',
    "[LOG: " + generateDatetimeString() + " ]" +
    (messages.length > 1 ? "\n  " : "  ") +
    messages.map(String).join("\n  ")
  , chalk.green));
}

const DEFAULT_FUNC = () => {return true;};

const code = fs.readFileSync(path.join(__dirname, '..', 'dapp_src', 'new_logistics.sol')).toString();
const compiledCode = solc.compile(code);
const nonparsedAbiDefinition = compiledCode.contracts[':Shipment'].interface;
const byteCode = compiledCode.contracts[':Shipment'].bytecode;

const monthCode2Nr = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12
};

let bot = new Bot(() => {
  bot.dbStore = new PsqlStore(bot.client.config.storage.postgres.url, process.env.STAGE || 'development');
  bot.dbStore.initialize(DATABASE_TABLES).then(() => {printLog("Database correctly set!");}).catch((err) => {
    printError(err);
  });
});
let botAddress = bot.client.toshiIdAddress;

const DATABASE_TABLES = `
DROP TABLE IF EXISTS nonces;
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
CREATE TABLE IF NOT EXISTS addresses (
   address VARCHAR(42) PRIMARY KEY,
   userID INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
    userID SERIAL PRIMARY KEY,
    username VARCHAR(64) NOT NULL,
    email VARCHAR(128) NOT NULL,
    avatar VARCHAR(64) NOT NULL DEFAULT ''
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

const submenus = [
  {name: "Home", href: "/", permittedRoles: ["any"], permittedStatuses: ["any"]},
  {name: "Create New Contract", href: "/new-contract", permittedRoles: ["any"], permittedStatuses: ["any"]},
  {name: "This Contract", options: [
    {name: "Set as Completed", href: "/set-completed-contract", permittedRoles: ["receiver"], permittedStatuses: [0]},
    {name: "Set as Refused", href: "/set-refused-contract", permittedRoles: ["receiver"], permittedStatuses: [0]},
    {name: "Withdraw", href: "/withdrawal", permittedRoles: ["sender"], permittedStatuses: [1]},
  ]},
];

function Get(yourUrl){
    var Httpreq = new XMLHttpRequest();
    Httpreq.open("GET",yourUrl,false);
    Httpreq.send(null);
    return Httpreq.responseText;
}

function hasPropertyName(obj, name) {
    return typeof(obj) !== 'undefined' ? Object.getOwnPropertyNames(obj).indexOf(name) > -1 : false;
}

const generateNavbarOptions = async (req, isContractSpecific) => {

  isContractSpecific = typeof(isContractSpecific) !== 'undefined' ? Boolean(isContractSpecific) : true;

  let nncInB = nonceInBody(req), nncInQ = nonceInQuery(req);
  let contract = req.query.cAddr || '';
  let contractStatus = (isContractSpecific && contract.length > 0) ? await retrieveContractStatus(contract) : '';
  let nonce = nncInB ? req.body.nonce : (nncInQ ? req.query.nonce : '');
  let user = (await checkNonce(nonce)).address || await maybeSetNonceAndRetrieveUser(req);
  let userRoles = (isContractSpecific && contract.length > 0) ? await retrieveUserRoles(user, contract) : ["any"];

  let urlAttributes = [{name: "nonce", value: nonce}];
  urlAttributes = contract.length > 0 ? urlAttributes.concat({name: "cAddr", value: contract}) : urlAttributes;

  const currentReducer = (res, opt, i) => {
    return res || (hasPropertyName(opt,'isCurrent') && opt['isCurrent']);
  };

  const enabledReducer = (res, opt, i) => {
    return res || (hasPropertyName(opt,'isDisabled') && !opt['isDisabled']);
  };

  const urlAttributeReducer = (res, opt, i) => {
    return res + (/\?/.test(res) ? "&" : "?") + opt.name + "=" + opt.value;
  };

  const menuReducer = (res, opt, i) => {
    let isParentMenu = hasPropertyName(opt,'options');
    let userHasRole = isParentMenu || opt.permittedRoles.indexOf("any") >= 0 || userRoles.reduce(userRoleReducer(opt.permittedRoles), false);
    let contractHasStatus = isParentMenu || opt.permittedStatuses.indexOf("any") >= 0 || opt.permittedStatuses.indexOf(contractStatus) >= 0;
    if(userHasRole) {
      let option = {name: opt.name};
      if(isParentMenu) {
        let options = opt.options.reduce(menuReducer, []);
        if(options.length == 0) return res;
        option['options'] = options;
        option['isCurrent'] = option.options.reduce(currentReducer, false);
        option['isDisabled'] = !option.options.reduce(enabledReducer, false);
      } else {
        option['href'] = urlAttributes.reduce(urlAttributeReducer, opt.href);
        option['isCurrent'] = req.route.path === opt.href;
        option['isDisabled'] = !contractHasStatus;
      }
      res = res.concat(option);
    }
    return res;
  };

  let permittedSubmenus = submenus.reduce(menuReducer, []);
  return permittedSubmenus;
};

function createRandomString(length, possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") {
  return Array.from({length: length},(_, n) => n+1).map(
    ()=>possible[Math.floor(possible.length * Math.random())]
  ).join('');
};

async function maybeCreateAndRegisterNonce(session) {
  let nonce = createRandomString(64);
  let success = false;
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
      return nonce;
    }).catch((err)=>{
      printError("Error while creating new nonce...", err);
      return false;
    });
  } else {
    return result;
  }
}

const checkNonce = async (nonce) => {
  let result = false;
  return await bot.dbStore.fetchrow(
    "SELECT * FROM nonces WHERE nonce = $1",
    [nonce]
  ).then((nonce)=>{
    let v = (nonce == null) ? false : String(nonce.validity).split(/[- :]/);
    return v ? (
      new Date(Date.UTC(v[3], monthCode2Nr[v[1]]-1, v[2], v[4], v[5], v[6])).getTime() >= new Date().getTime() ?
        {address: web3.utils.toChecksumAddress(nonce.address), toshi_id: nonce.toshi_id} :
        false
      ) :
      false;
  }).catch((err)=>{
    printError("Error validating nonce...", err);
    return false;
  });
};

const maybeSetNonceAndRetrieveUser = async (req) => {
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
  }
  return res.address;
};

const MYIP = JSON.parse(Get("https://jsonip.com")).ip;
const storage = multer.diskStorage({
  destination: "/uploads",
  filename: (req, file, callback) => {
    let extname = path.extname(file.originalname);
    callback(null, createRandomString(64 - extname.length - 8) + extname);
  }
});
const upload = multer({storage: storage});

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
    printLog(obj.toString());
    return obj;
});

const asyncMiddleware = fn => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next))
      .catch(next);
  };
};

const retrieveUserRoles = async (user, contract) => {
  return await bot.dbStore.fetchrow(
    "SELECT sender_address, handler_address, receiver_address FROM contracts WHERE contract_address = $1;",
    [contract]
  ).then((result) => {
    let roles = [];
    if(result.sender_address === user) roles = roles.concat(['sender']);
    if(result.handler_address === user) roles = roles.concat(['handler']);
    if(result.receiver_address === user) roles = roles.concat(['receiver']);
    return roles.length > 0 ? roles : ["any"];
  }).catch((err) => {
    printError("Error retrieving user role:", err);
    return "any";
  });
};

const retrieveContractStatus = async (contract) =>  {
  return await bot.dbStore.fetchrow(
    "SELECT contract_status FROM contracts WHERE contract_address = $1;",
    [contract]
  ).then((result) => {
    return result.contract_status;
  }).catch((err) => {
    printError("Error retrieving contract status:", err);
    return "any";
  });
};

const userRoleReducer = (permittedRoles) => {
  return (res, role, i) => {
    return res || permittedRoles.indexOf(role) >= 0;
  };
};

const nonceInBody = (req) => {
  return hasPropertyName(req, 'body') ? (hasPropertyName(req.body, 'nonce') && req.body.nonce.length > 0 && typeof(req.body.nonce) !== 'undefined') : false;
};

const nonceInQuery = (req) => {
  return hasPropertyName(req, 'query') ? (hasPropertyName(req.query, 'nonce') && req.query.nonce.length > 0 && typeof(req.query.nonce) !== 'undefined') : false;
};

const checkPermissions = async (req, res, checkNonceIO, permittedRoles, compatibleContractStatus) => {

  permittedRoles = Array.isArray(permittedRoles) ? permittedRoles : [].concat(permittedRoles);
  compatibleContractStatus = Array.isArray(compatibleContractStatus) ? compatibleContractStatus : [].concat(compatibleContractStatus);

  let nonce, user, contract, userRoles, contractStatus;
  let nncInB = nonceInBody(req), nncInQ = nonceInQuery(req);

  let conditions = [
    {
      name: "has_nonce",
      f: async () => {
        if(!checkNonceIO) return true;
        return nncInB || nncInQ;
      }
    },
    {
      name: "nonce_validity",
      f: async () => {
        if(!checkNonceIO) return true;
        nonce = nonce || nncInB ? req.body.nonce : (nncInQ ? req.query.nonce : '');
        user = user || (await checkNonce(nonce)).address;
        return Boolean(user);
      }
    },
    {
      name: "user_registered",
      f: async () => {
        nonce = nonce || nncInB ? req.body.nonce : (nncInQ ? req.query.nonce : '');
        user = user || (await checkNonce(nonce)).address || await maybeSetNonceAndRetrieveUser(req);
        return Boolean(user || await maybeCreateAndRegisterNonce(req.session));
      }
    },
    {
      name: "user_has_permission",
      f: async () => {
        if(permittedRoles.indexOf("any") >= 0) return true;
        contract = contract || req.query.cAddr || '';
        nonce = nonce || nncInB ? req.body.nonce : (nncInQ ? req.query.nonce : '');
        user = user || (await checkNonce(nonce)).address || await maybeSetNonceAndRetrieveUser(req);
        userRoles = userRoles || await retrieveUserRoles(user, contract);
        return userRoles.reduce(userRoleReducer(permittedRoles), false);
      }
    },
    {
      name: "contract_status_compatible",
      f: async () => {
        if(compatibleContractStatus.indexOf("any") >= 0) return true;
        contract = contract || req.query.cAddr || '';
        contractStatus = contractStatus || await retrieveContractStatus(contract);
        return compatibleContractStatus.indexOf(contractStatus) >= 0;
      }
    }
  ];

  let conditionReducer = async (res, cond, i) =>  {
    return await res === "" ? (await cond.f() ? "" : cond.name) : res;
  };

  let result = await conditions.reduce(conditionReducer, "");
  if(result) {
    res.json({res:'Access denied! Unmet criterium: ' + result, err: true});
    return false;
  }

  return true;
};

app.get('/', upload.array(), asyncMiddleware( async (req, res, next) => {
  if(!await checkPermissions(req, res, false, "any", "any")) return;
  let opts = {};
  let contract = req.query.cAddr || '';
  opts['options'] = await generateNavbarOptions(req, false);
  opts['title'] = "Logistics 3.0";
  opts['subtitle'] = "Logistics Smart-Contract Management for unlimited blockchained fun.";
  opts['currentMarker'] = "<span class=\"sr-only\">(current)</span>";
  opts['nonparsedAbiDefinition'] = nonparsedAbiDefinition;
  opts['byteCode'] = byteCode;
  opts['contractAddress'] = contract;
  opts['MYIP'] = MYIP;
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
    printError("Error retrieving contract info from the database!", err);
  });
  res.render(path.join(__dirname,'public','templates','index.html'), opts);
}));

app.get('/login', upload.array(), asyncMiddleware( async (req, res, next) => {
  if(await checkPermissions(req, res, true, "any", "any")) {
    res.redirect('/logout');
  }
  let opts = {};
  opts['options'] = await generateNavbarOptions(req, false);
  opts['title'] = "Logistics 3.0";
  opts['subtitle'] = "Logistics Smart-Contract Management for unlimited blockchained fun.";
  opts['currentMarker'] = "<span class=\"sr-only\">(current)</span>";
  res.render(path.join(__dirname, 'public', 'templates', 'login.html'), opts);
}));

app.post('/login', upload.array(), asyncMiddleware( async (req, res, next) => {
  if(await checkPermissions(req, res, true, "any", "any")) {
    res.json({res: 'You are already logged in!', err: true});
    return;
  }
  let result = {res: 'Everything turned out fine! Please check your email to finish registration process...', err: false};
  await bot.dbStore.execute("INSERT INTO users (username, email) VALUES ($1, $2);", []).then((res) => {
    printLog("User correctly registered into the database!");
  }).catch((err) => {
    printError("Error inserting user info into the database!", err);
    result = {res: "Error inserting user info into the database!", err: true};
  });
  res.json(result);
  return;
}));

app.post('/upload', upload.single(), asyncMiddleware( async (req, res, next) => {
  if(!await checkPermissions(req, res, true, "any", "any")) return;
  if(!req.file) return;
  let nncInB = nonceInBody(req), nncInQ = nonceInQuery(req);
  let result = {res: 'Everything turned out fine!', err: false};
  const nonce = nncInB ? req.body.nonce : (nncInQ ? req.query.nonce : '');
  const address = (await checkNonce(nonce)).address || '';
  const userID = bot.dbStore.fetchrow("SELECT userID FROM addresses WHERE address = $1", [address]).then((res) => {
    return res.userID;
  }).catch((err) => {
    printError("Error retrieving user info from the database!", err);
    result = {res: "Error retrieving user info from the database!", err: true};
  });
  if(!result.err) {
    await bot.dbStore.execute("UPDATE users SET avatar = $1 WHERE userID = $2;", [req.file.path, userID]).then((res) => {
      printLog("User avatar successfuly updated!", "PATH: " + req.file.path);
    }).catch((err) => {
      printError("Error updating user avatar on the database!", "PATH: " + req.file.path, err);
      result = {res: "Error updating user avatar on the database!", err: true};
    });
  }
  res.json(result);
  return;
}));

app.get('/new-contract', asyncMiddleware( async (req, res, next) => {
  if(!await checkPermissions(req, res, true, "any", "any")) return;
  let opts = {};
  opts['options'] = await generateNavbarOptions(req);
  opts['title'] = "Logistics 3.0";
  opts['subtitle'] = "Logistics Smart-Contract Management for unlimited blockchained fun.";
  opts['currentMarker'] = "<span class=\"sr-only\">(current)</span>";
  opts['nonparsedAbiDefinition'] = nonparsedAbiDefinition;
  opts['byteCode'] = byteCode;
  opts['nonce'] = req.session.nonce;
  opts['MYIP'] = MYIP;
  res.render(path.join(__dirname,'public','templates','new-contract.html'), opts);
}));

app.post('/new-contract', upload.array(), asyncMiddleware( async (req, res, next) => {

  if(!await checkPermissions(req, res, true, "any", "any")) return;

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
    result = {res: 'Everything turned out fine!', err: false};
  }).catch((err) => {
    printError("Error registering new contract in the database!", err);
    result = {res: 'Error registering new contract in the database!', err: true}
  });

  res.json(result);
  return;

}));

app.get('/withdrawal', upload.array(), asyncMiddleware( async (req, res, next) => {
  if(!await checkPermissions(req, res, true, "sender", 1)) return;
  let opts = {};
  opts['options'] = await generateNavbarOptions(req);
  opts['title'] = "Logistics 3.0";
  opts['subtitle'] = "Logistics Smart-Contract Management for unlimited blockchained fun.";
  opts['currentMarker'] = "<span class=\"sr-only\">(current)</span>";
  opts['nonparsedAbiDefinition'] = nonparsedAbiDefinition;
  opts['byteCode'] = byteCode;
  opts['nonce'] = req.session.nonce;
  opts['contractAddress'] = req.query.cAddr || '';
  opts['MYIP'] = MYIP;
  await Fiat.fetch().then((toEth) => { opts['fiatUSDChange'] = toEth.USD(1);});
  res.render(path.join(__dirname,'public','templates','withdrawal.html'), opts);
}));

app.get('/set-completed-contract', upload.array(), asyncMiddleware( async (req, res) => {
  if(!await checkPermissions(req, res, true, "receiver", 0)) return;
  let opts = {};
  opts['options'] = await generateNavbarOptions(req);
  opts['title'] = "Logistics 3.0";
  opts['subtitle'] = "Logistics Smart-Contract Management for unlimited blockchained fun.";
  opts['currentMarker'] = "<span class=\"sr-only\">(current)</span>";
  opts['nonparsedAbiDefinition'] = nonparsedAbiDefinition;
  opts['byteCode'] = byteCode;
  opts['nonce'] = req.query.nonce;
  opts['contractAddress'] = req.query.cAddr || '';
  opts['MYIP'] = MYIP;
  await Fiat.fetch().then((toEth) => { opts['fiatUSDChange'] = toEth.USD(1);});
  res.render(path.join(__dirname,'public','templates','set-completed-contract.html'), opts);
}));

app.post('/set-completed-contract', upload.array(), asyncMiddleware( async (req, res, next) => {

  if(!await checkPermissions(req, res, true, "receiver", 0)) return;

  let result = {res: 'Error awaiting for database write event', err: true};

  await bot.dbStore.execute(
    "UPDATE contracts SET contract_status = 1 WHERE contract_address = $1;",
    [req.body.cAddr]
  ).then((res) => {
    result = {res: 'Everything turned out fine!', err: false};
  }).catch((err) => {
    printError("Error updating contract status in the database!", err);
    result = {res: 'Error updating contract status in the database!', err: true}
  });

  res.json(result);
}));

app.get('/set-refused-contract', upload.array(), asyncMiddleware( async (req, res) => {
  if(!await checkPermissions(req, res, true, "receiver", 0)) return;
  let opts = {};
  let contract = req.query.cAddr || '';
  opts['options'] = await generateNavbarOptions(req);
  opts['title'] = "Logistics 3.0";
  opts['subtitle'] = "Logistics Smart-Contract Management for unlimited blockchained fun.";
  opts['currentMarker'] = "<span class=\"sr-only\">(current)</span>";
  opts['nonparsedAbiDefinition'] = nonparsedAbiDefinition;
  opts['byteCode'] = byteCode;
  opts['nonce'] = req.query.nonce;
  opts['contractAddress'] = contract;
  opts['MYIP'] = MYIP;
  await bot.dbStore.fetchrow(
    "SELECT contract_name FROM contracts WHERE contract_address = $1;",
    [contract]
  ).then((res) => {
    opts['contractName'] = res.contract_name;
  }).catch((err) => {
    printError("Error retrieving contract info from the database!", err);
  });
  res.render(path.join(__dirname,'public','templates','set-refused-contract.html'), opts);
}));

app.post('/set-refused-contract', upload.array(), asyncMiddleware( async (req, res, next) => {
  if(!await checkPermissions(req, res, true, "receiver", 0)) return;

  let result = {res: 'Error awaiting for database write event', err: true};

  await bot.dbStore.execute(
    "UPDATE contracts SET contract_status = 2 WHERE contract_address = $1;",
    [req.body.cAddr]
  ).then((res) => {
    result = {res: 'Everything turned out fine!', err: false};
  }).catch((err) => {
    printError("Error updating contract status in the database!", err);
    result = {res: 'Error updating contract status in the database!', err: true}
  });

  res.json(result);
}));

app.listen(8888, function(){
  printLog("Express Webapp working!!");
});

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
  let myAddress = web3.utils.toChecksumAddress(session.user.payment_address);
  let filterEdges = [
    {name: 'sender_address', value: (role === "sender" || role === "any") ? myAddress : ""},
    {name: 'receiver_address', value: (role === "receiver" || role === "any") ? myAddress : ""},
    {name: 'handler_address', value: (role === "handler" || role === "any") ? myAddress : ""},
    {name: 'contract_status', value: (status === -1 || role === "any") ? "" : status}
  ];
  let filterEdgeReducer = (res, elem, i) => {
    if(hasPropertyName(elem, "value") && String(elem.value).length > 0) {
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
    return {value:[names, await preprocessOptions(session, options)], iserror: false};
  }).catch((err) => {
    printError("An error occurred while querying the database...", err);
    return {value:"An error occurred while querying the database...\n" + err, iserror: true}
  });
};

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

let menuOptions = {
  main: {
    msgHeader: `Hi there! Welcome to the Logistics Smart Contract Handler.`,
    options: [
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
        body: listAndPrompt({role:'sender', status: 1, webview: "http://" + MYIP + ":18889/withdrawal"}),
        v: "withdrawalContractName",
      },
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

/*let default_controls = menuOptions.main.options.map(function(option){return {
  type: option.control.type,
  label: option.control.label,
  value: option.control.label.toLowerCase().split(' ').join('_'),
}});*/

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

function nextPromptPhase(session, menuObj) {
  let promptPhase = checkPromptPhase(session);
  promptPhase = (promptPhase + 1) % menuObj.prompts.length;
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
      printWarning("ATTENTION! PromptPhase Reseted!!");
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

async function sendMessage(session, message, controls_) {
  controls_ = typeof controls_ !== 'undefined' ? controls_ : await preprocessOptions(session, menuOptions.main.options);
  session.reply(SOFA.Message({
    body: message,
    controls: controls_,
    showKeyboard: false,
  }));
}
