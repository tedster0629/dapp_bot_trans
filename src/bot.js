const path = require('path');
const fs = require('fs');
const assert = require('assert');
const XMLHttpRequest = require('xmlhttprequest').XMLHttpRequest;

const Bot = require('./lib/Bot');
const SOFA = require('sofa-js');
const Fiat = require('./lib/Fiat');
const Logger = require('./lib/Logger');
//const Session = require('./lib/Session');
const Mailer = require('./lib/Mailer');
const solc = require('solc');

const nunjucks = require('nunjucks');
const express = require('express');
const session = require('express-session');

const redis = require('redis');
const RedisStore = require('connect-redis')(session);
const favicon = require('serve-favicon');
const multer = require('multer');
const bodyParser = require('body-parser');
const generateAvatar = require('no-avatar').make;

const PsqlStore = require('./PsqlStore');
const Web3 = require('web3');

const chalk = require('chalk');

let web3 = new Web3();

/*Implement additional addHours method for Date object*/
Date.prototype.addHours = function(h) {
  this.setTime(this.getTime() + (h*60*60*1000));
  return this;
}

function mergeDicts(...dicts) {
  return dicts.reduce((res, elem) => {
    Object.keys(elem).forEach((k)=>{ res[k] = elem[k]; });
    return res;
  }, {});
}

function generateDatetimeString(offsetHours) {
  return new Date().addHours(offsetHours || 0).toISOString().slice(0, 19).replace('T', ' ');
}

const printError = (...messages) => {
  console.error(Logger.color(' ',
    "[ERR: " + generateDatetimeString() + " ]" +
    (messages.length > 1 ? "\n  " : "  ") +
    messages.map((msg)=> msg ? (hasPropertyName(msg, 'stack')? msg.stack : msg) : "--NO MESSAGE--").map(String).join("\n  ")
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

const code = fs.readFileSync(path.join(__dirname, '..', 'dapp_src', 'new_logistics.sol')).toString();
const compiledCode = solc.compile(code);
const nonparsedAbiDefinition = compiledCode.contracts[':Shipment'].interface;
const byteCode = compiledCode.contracts[':Shipment'].bytecode;

const DEFAULT_FUNC = () => {return true;};
const COMMON_OPTS = {
  title: "Logistics 3.0",
  subtitle: "Logistics Smart-Contract Management for unlimited blockchained fun.",
  currentMarker: "<span class=\"sr-only\">(current)</span>"
};
const CONTRACT_OPTS = {
  nonparsedAbiDefinition: nonparsedAbiDefinition,
  byteCode: byteCode
};

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

//const DATABASE_TABLES = `
//DROP TABLE IF EXISTS contracts;
//DROP TABLE IF EXISTS nonces;
//DROP TABLE IF EXISTS addresses;
//DROP TABLE IF EXISTS users;
const DATABASE_TABLES = `
CREATE TABLE IF NOT EXISTS contracts (
    contract_address VARCHAR(42) NOT NULL,
    network_id VARCHAR(8) NOT NULL,
    contract_name VARCHAR(32),
    sender_address VARCHAR(42),
    handler_address VARCHAR(42),
    receiver_address VARCHAR(42),
    contract_status SMALLINT,
    deployment_dt TIMESTAMP NOT NULL,
    PRIMARY KEY(contract_address, network_id)
);
CREATE TABLE IF NOT EXISTS nonces (
    nonce_id SERIAL PRIMARY KEY,
    address VARCHAR(42),
    toshi_id VARCHAR(42),
    email VARCHAR(128),
    ip VARCHAR(64),
    nonce VARCHAR(64) NOT NULL,
    validity TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ip_nonces ON nonces (ip) WHERE ip IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS email_nonces ON nonces (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS address_nonces ON nonces (address) WHERE address IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS toshi_id_nonces ON nonces (toshi_id) WHERE toshi_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS addresses (
   address_id SERIAL PRIMARY KEY,
   address VARCHAR(42) NOT NULL,
   network_id VARCHAR(8) NOT NULL,
   user_id INTEGER
);
CREATE TABLE IF NOT EXISTS users (
    user_id SERIAL PRIMARY KEY,
    username VARCHAR(64) NOT NULL,
    email VARCHAR(128) UNIQUE NOT NULL,
    pass_digest VARCHAR(66) NOT NULL,
    verified BOOLEAN NOT NULL,
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
  {name: "Home", href: "/", permittedRoles: ["any"], permittedStatuses: ["any"], permittedLoginStatuses: ["any"]},
  {name: "Create New Contract", href: "/new-contract", permittedRoles: ["any"], permittedStatuses: ["any"], permittedLoginStatuses: ["logged"]},
  {name: "This Contract", options: [
    {name: "Set as Completed", href: "/set-completed-contract", permittedRoles: ["receiver"], permittedStatuses: [0], permittedLoginStatuses: ["logged"]},
    {name: "Set as Refused", href: "/set-refused-contract", permittedRoles: ["receiver"], permittedStatuses: [0], permittedLoginStatuses: ["logged"]},
    {name: "Withdraw", href: "/withdrawal", permittedRoles: ["sender"], permittedStatuses: [1], permittedLoginStatuses: ["logged"]},
  ]},
  {name: "Login", href: "/login", permittedRoles: ["any"], permittedStatuses: ["any"], permittedLoginStatuses: ["non-logged"], floatRight: true},
  {name: "Profile", floatRight: true, image: {origin: "session", name: "avatar"}, options: [
    {name: "Edit Profile", href: "/profile", permittedRoles: ["any"], permittedStatuses: ["any"], permittedLoginStatuses: ["logged"]},
    {name: "Logout", href: "/logout", permittedRoles: ["any"], permittedStatuses: ["any"], permittedLoginStatuses: ["logged"]},
  ]},
  {name: "Register", href: "/register", permittedRoles: ["any"], permittedStatuses: ["any"], permittedLoginStatuses: ["non-logged"], floatRight: true}
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

/**async generateNavbarOptions(req, isContractSpecific)
 *
 *
 *
 * @param req
 * @param isContractSpecific
 * @returns {Promise.<*>}
 */

const generateNavbarOptions = async (req, isContractSpecific) => {

  isContractSpecific = typeof(isContractSpecific) !== 'undefined' ? Boolean(isContractSpecific) : true;

  //let nncInB = nonceInBody(req), nncInQ = nonceInQuery(req);
  let contract = req.query.cAddr || '';
  let contractStatus = (isContractSpecific && contract.length > 0) ? await retrieveContractStatus(contract) : '';
  //let nonce = nonceInSession(req) ? req.session.nonce : (nncInB ? req.body.nonce : (nncInQ ? req.query.nonce : ''));
  let address = req.session.address || false;
  let userAuthenticated = Boolean(req.session && req.session.authenticated);
  let userRoles = (isContractSpecific && contract.length > 0) ? await retrieveUserRoles(address, contract) : ["any"];

  let urlAttributes = [];//[{name: "nonce", value: nonce}];
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
    let loginStatusAllowed = !hasPropertyName(opt, "permittedLoginStatuses") || opt.permittedLoginStatuses.indexOf("any") >= 0 ||
      opt.permittedLoginStatuses.indexOf(userAuthenticated ? "logged" : "non-logged") >= 0;

    //printLog(
    //  "OPTION NAME:        " + opt.name,
    //  "USER HAS ROLE:      " + userHasRole ? "TRUE" : "FALSE",
    //  "USER AUTHENTICATED: " + userAuthenticated ? "TRUE" : "FALSE",
    //  "PERMITED LOGIN STATUSES"
    //);

    if(userHasRole && loginStatusAllowed) {
      let option = {name: opt.name};
      if(isParentMenu) {
        let options = opt.options.reduce(menuReducer, []);
        if(options.length == 0) return res;
        option['options'] = options;
        option['isCurrent'] = option.options.reduce(currentReducer, false);
        option['isDisabled'] = !option.options.reduce(enabledReducer, false);
        option['floatRight'] = opt.floatRight || false;
        option['image'] = (opt.image ?
          opt.image.origin === "path" ? opt.image.name : (opt.image.origin === "session" ? req.session[opt.image.name] : "") :
          ""
        )
      } else {
        option['href'] = urlAttributes.reduce(urlAttributeReducer, opt.href);
        option['isCurrent'] = req.route.path === opt.href;
        option['isDisabled'] = !contractHasStatus;
        option['floatRight'] = opt.floatRight || false;
        option['image'] = (opt.image ?
          opt.image.origin === "path" ? opt.image.name : (opt.image.origin === "session" ? req.session[opt.image.name] : "") :
          ""
        )
      }
      res = res.concat(option);
    }
    return res;
  };

  let permittedSubmenus = submenus.reduce(menuReducer, []);
  printLog(
    "URL:                " + req.url,
    "Permitted Submenus: " + JSON.stringify(permittedSubmenus.map((submenu)=>submenu.name)),
    "Avatar Image:       " + JSON.stringify(permittedSubmenus.map((submenu)=>submenu.name).indexOf("Profile") !== -1 ? permittedSubmenus.filter((s)=>s.name==="Profile")[0].image : "")
  );
  return permittedSubmenus;
};

function createRandomString(length, possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") {
  return Array.from({length: length},(_, n) => n+1).map(
    ()=>possible[Math.floor(possible.length * Math.random())]
  ).join('');
};

async function maybeCreateAndRegisterNonce(session) {
  let success = false;
  const comesFromToshi = Boolean(session.user) && Boolean(session.user.toshi_id);
  if(!comesFromToshi && !session.authenticated) return false;
  let result = await bot.dbStore.fetchval(
    "SELECT nonce FROM nonces WHERE address = $1 AND validity >= $2 :: timestamp",
    [
      web3.utils.toChecksumAddress(hasPropertyName(session, 'user') ? session.user.payment_address : session.payment_address),
      generateDatetimeString(0)
    ]);
  if(!result){
    let nonce = await maybeSetNonce({
      toshi_id: hasPropertyName(session, 'user') ? session.user.toshi_id : '',
      address: web3.utils.toChecksumAddress(hasPropertyName(session, 'user') ? session.user.payment_address : session.payment_address)
    }, "nonce", 8);

    if(nonce) {
      session.nonce = nonce;
      session.save((err)=>{
        if(!err) return;
        printError(err);
      });
      return nonce;
    }

    printError("Error while creating new nonce...", err);
    return false;

  } else {
    return result;
  }
}

const maybeSetNoncedLocals = async (req, res, checkIP) => {

  checkIP = typeof(checkIP) !== 'undefined' ? Boolean(checkIP) : false;

  res.locals.nonce = await maybeRetrieveNoncedData(req, checkIP);

  printLog(
    "maybeSetNoncedLocals() called",
    "NONCE: " + JSON.stringify(res.locals.nonce)
  );

  if(!res.locals.nonce) return false;

  res.locals.user = await bot.dbStore.fetchrow(
    "SELECT * FROM users WHERE email = $1;",
    [res.locals.nonce.email]
  ).catch((err)=> {
    printError("Error retrieving user info...", err);
    return false;
  });

  printLog("USER:  " + JSON.stringify(res.locals.user));

  return true;
};

const maybeSetSession = async (req, checkIP) => {

  printLog("maybeSetSession() called");

  checkIP = typeof(checkIP) !== 'undefined' ? Boolean(checkIP) : false;
  let nonce = await maybeRetrieveNoncedData(req, checkIP);

  printLog("Nonce: " + JSON.stringify(nonce));

  if(nonce.email) {

    let user = await bot.dbStore.fetchrow(
      "SELECT * FROM users WHERE email = $1;",
      [nonce.email]
    ).catch((err)=> {
      printError("Error retrieving user info...", err);
      return false;
    });

    printLog(
      "User:  " + JSON.stringify(user)
    );

    req.session.authenticated = true;
    req.session.email = nonce.email;
    req.session.username = user.username;
    req.session.avatar = user.avatar;
    req.session.save((err)=>{
      if(!err) return;
      printError(err);
    });
    return true;
  }

  return false;

};

const checkNonce = async (nonce, ip) => {

  ip = typeof(ip) !== 'undefined' ? ip : '';

  let result = false;

  let selectQuery = "SELECT * FROM nonces WHERE nonce = $1 AND validity >= $2 :: timestamp";
  let selectQArgs = [nonce, generateDatetimeString(0)];

  let deleteQuery = "DELETE FROM nonces WHERE nonce = $1";
  let deleteQArgs = [nonce];

  if(ip){

    selectQuery += " AND ip = $3";
    selectQArgs = selectQArgs.concat([ip]);

    deleteQuery += " AND ip = $2";
    deleteQArgs = deleteQArgs.concat([ip]);

  }

  result = await bot.dbStore.fetchrow(selectQuery, selectQArgs).then((nonce)=>{
    if(nonce) {

      bot.dbStore.execute(deleteQuery, deleteQArgs).catch((err)=> {
        printError("Error deleting nonce info from the database!", err);
      });

      return {
        nonce: nonce.nonce,
        address: nonce.address ? web3.utils.toChecksumAddress(nonce.address) : "",
        toshi_id: nonce.toshi_id || "",
        email: nonce.email || "",
        ip: nonce.ip || ""
      };
    }
    return false;
  }).catch((err)=>{
    printError("Error validating nonce...", err);
    return false;
  });

  printLog(
    "checkNonce() called",
    "NONCE:        " + JSON.stringify(nonce),
    "IP:           " + JSON.stringify(ip),
    "SELECT QUERY: " + JSON.stringify(selectQuery),
    "SELECT QARGS: " + JSON.stringify(selectQArgs),
    "DELETE QUERY: " + JSON.stringify(deleteQuery),
    "DELETE QARGS: " + JSON.stringify(deleteQArgs),
    "RESULT:       " + JSON.stringify(result)
  );

  return result;
};

const maybeSetNonce = async (toCheck, resultFormat, validityHours) => {

  resultFormat = typeof(resultFormat) !== 'undefined' ? resultFormat : "nonce";
  validityHours = typeof(validityHours) !== 'undefined' ? validityHours : 24;
  if(Object.keys(toCheck).length == 0) return resultFormat == "nonce" ? false : {res: "A nonce must have at least one variable to check later...", err: true};

  toCheck["nonce"] = createRandomString(64);
  toCheck["validity"] = generateDatetimeString(validityHours);
  let result = (resultFormat == "nonce") ? false : {res: "Unknown error on Nonce registration...", nonce: "", err: true};

  let queryVars = Object.keys(toCheck);
  let queryValues = Object.values(toCheck);
  let conflictVars = queryVars.filter((edge)=>["email","address","ip","toshi_id"].indexOf(edge) != -1);

  let query = "INSERT INTO nonces (" + queryVars.join(', ')  + ")" +
              "  VALUES (" + [...Array(queryVars.length).keys()].map((i)=>"$"+(i+1)).join(', ') + ")";

  if(conflictVars.length > 0)
    query += " ON CONFLICT (" + conflictVars[0] + ") WHERE " + conflictVars[0] + " IS NOT NULL" +
             " DO UPDATE SET " + queryVars.map((v)=> v + " = $" + (queryVars.indexOf(v)+1)).join(', ');

  query += ";";

  result = await bot.dbStore.execute(query, queryValues).then(()=>{
    return (resultFormat == "nonce") ? toCheck["nonce"] : {res: "Success!", nonce: toCheck["nonce"], err: false};
  }).catch((err)=>{
    printError("Error on Nonce Creation!", err);
    return (resultFormat == "nonce") ? false : {res: "Error: " + err, nonce: "", err: true};
  });

  return result;

};

const maybeRetrieveNoncedData = async (req, checkIP) => {

  checkIP = typeof(checkIP) !== 'undefined' ? Boolean(checkIP) : false;

  // Since ES6, an object iterates in definition order, except for the numerical keys,
  // which come first (and numerically ordered).
  let origins = {
    query: nonceInQuery(req),
    body: nonceInBody(req),
    session: nonceInSession(req)
  };

  const originReducer = (res, key) => {
    if(res.length > 0 ) return res;
    return origins[key] ? res.concat([req[key].nonce]) : res;
  };

  let args = Object.keys(origins).reduce(originReducer, []);

  printLog(
    "maybeRetrieveNoncedData() called",
    "Origins: " + JSON.stringify(origins),
    "Args:    " + JSON.stringify(args)
  );

  if(args.length == 1) {
    if(checkIP) args.concat([req.ip]);
    let result = await checkNonce(...args);
    if(origins['session']) delete req.session.nonce;
    return result;
  }

  return false;
};

const MYIP = JSON.parse(Get("https://jsonip.com")).ip;

const asyncMiddleware = fn => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next))
            .catch(next);
    };
};

const permissionHandler = async (req, res, next) => {
  const endpointFilter = (endpoint) => {
    return endpoint.path === req.path && RegExp(req.method,"i").test(endpoint.method);
  };
  printLog(
    "REQUEST:                 " + req.path,
    "METHOD:                  " + req.method
  );
  const filteredEndpoints = appEndpoints.filter(endpointFilter);
  let violatedPermission = "";
  if(filteredEndpoints.length > 0){
    violatedPermission = await checkPermissions(req, res, ...filteredEndpoints[0].permissions);
    if(!Boolean(violatedPermission)){
      next();
      return;
    }
    printError(
      "VIOLATED PERMISSION:     " + JSON.stringify(violatedPermission),
      "!BOOL:                   " + JSON.stringify(!Boolean(violatedPermission))
    );
    filteredEndpoints[0].unauthorisedQueryHandler(req, res, violatedPermission);
    return;
  }
  res.render("/not-found", {status: 404});
  return;
};

const storage = multer.diskStorage({
  destination: path.join(__dirname, 'public', 'uploads'),
  filename: (req, file, callback) => {
    let extname = path.extname(file.originalname);
    callback(null, createRandomString(64 - extname.length - 16) + extname);
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
//app.use(app.router);
app.use(asyncMiddleware(permissionHandler));

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

const nonceInSession = (req) => {
  return hasPropertyName(req, 'session') ? (hasPropertyName(req.session, 'nonce') && req.session.nonce.length > 0 && typeof(req.session.nonce) !== 'undefined') : false;
};

PERMISSION_PROFILE__ANY_USER = [];
PERMISSION_PROFILE__ONLY_NON_AUTHENTICATED = ["user_non_authenticated"];
PERMISSION_PROFILE__ONLY_AUTHENTICATED = ["user_authenticated"];
PERMISSION_PROFILE__RESTRICTED_API = ["nonce_validity", "user_has_permission", "contract_status_compatible"];
PERMISSION_PROFILE__RESTRICTED_GUI = ["user_authenticated", "user_has_permission", "contract_status_compatible"];

const checkPermissions = async (req, res, mandatoryConditions, permittedRoles, compatibleContractStatus) => {

  mandatoryConditions = typeof(mandatoryConditions) !== 'undefined' ? mandatoryConditions : ["all"];
  mandatoryConditions = Array.isArray(mandatoryConditions) ? mandatoryConditions : [].concat(mandatoryConditions);

  permittedRoles = typeof(permittedRoles) !== 'undefined' ? permittedRoles : ["any"];
  permittedRoles = Array.isArray(permittedRoles) ? permittedRoles : [].concat(permittedRoles);

  compatibleContractStatus = typeof(compatibleContractStatus) !== 'undefined' ? compatibleContractStatus : ["any"];
  compatibleContractStatus = Array.isArray(compatibleContractStatus) ? compatibleContractStatus : [].concat(compatibleContractStatus);

  if(req.query.action === 'login')
    if(!maybeSetSession(req, true)) {
      res.redirect('/login');
    } else if(req.path !== '/') {
      res.redirect('/');
    }

  let maybeAddress = req.session.authenticated ? req.session.address || false : false;

  let conditions = [
    /*{
      name: "has_nonce",
      f: async () => {
        return nonceInSession(req) || nonceInBody(req) || nonceInQuery(req);
      }
    },*/
    {
      name: "nonce_validity",
      f: async () => {
        return Boolean(await maybeSetNoncedLocals(req, res));
      }
    },
    {
      name: "user_registered",
      f: async () => {
        return Boolean(req.session && await maybeCreateAndRegisterNonce(req.session));
      }
    },
    {
      name: "user_authenticated",
      f: async () => {
        return Boolean(req.session && req.session.authenticated);
      }
    },
    {
      name: "user_non_authenticated",
      f: async () => {
        return !Boolean(req.session && req.session.authenticated);
      }
    },
    {
      name: "user_has_permission",
      f: async () => {
        if(permittedRoles.indexOf("any") >= 0) return true;
        let contract = req.query.cAddr || '';
        let userRoles = await retrieveUserRoles(maybeAddress, contract);
        return userRoles.reduce(userRoleReducer(permittedRoles), false);
      }
    },
    {
      name: "contract_status_compatible",
      f: async () => {
        if(compatibleContractStatus.indexOf("any") >= 0) return true;
        let contract = req.query.cAddr || '';
        let contractStatus = await retrieveContractStatus(contract);
        return compatibleContractStatus.indexOf(contractStatus) >= 0;
      }
    }
  ];

  let conditionFilter = (cond) => {
    return mandatoryConditions.indexOf("all") >= 0 || mandatoryConditions.indexOf(cond.name) >= 0;
  };

  let conditionReducer = async (res, cond, i) =>  {
    return await res === "" ? (await cond.f() ? "" : cond.name) : res;
  };

  return await conditions.filter(conditionFilter).reduce(conditionReducer, "");

  //let result = await conditions.filter(conditionFilter).reduce(conditionReducer, "");
  //if(result) {
  //  res.json({res:'Access denied! Unmet criterium: ' + result, err: true});
  //  return false;
  //}
  //
  //return true;
};

const appEndpoints = [
  {
    path: "/",
    method: "get",
    permissions: [PERMISSION_PROFILE__ANY_USER, "any", "any"],
    unauthorisedQueryHandler: DEFAULT_FUNC,
    callbacks: [
      upload.array(),
      //asyncMiddleware( async (req, res, next) => {
      //  if(req.query.action === 'login') {
      //    const nonce = req.query.nonce ? await checkNonce(req.query.nonce) : false;
      //    printLog(
      //      "NONCE CODE: " + JSON.stringify(req.query.nonce),
      //      "NONCE DATA: " + JSON.stringify(nonce)
      //    );
      //    if(nonce && nonce.ip === req.ip) {
      //      bot.dbStore.execute(
      //        "DELETE FROM nonces WHERE nonce = $1 AND ip = $2;",
      //        [nonce.nonce, nonce.ip]
      //      ).catch((err)=> {
      //        printError("Error retrieving deleting nonce info from the database!", err);
      //      });
      //      req.session.authenticated = true;
      //      next();
      //    }
      //    res.redirect('/login');
      //  }
      //  next();
      //}),
      asyncMiddleware( async (req, res) => {

        let opts = mergeDicts(COMMON_OPTS, CONTRACT_OPTS);
        let contract = req.query.cAddr || '';

        opts['options'] = await generateNavbarOptions(req, false);
        opts['session'] = req.session;
        opts['contractAddress'] = contract;
        opts['MYIP'] = MYIP;

        await Fiat.fetch().then((toEth) => { opts['fiatUSDChange'] = toEth.USD(1);});
        await bot.dbStore.fetchrow(
          "SELECT contract_name, sender_address, handler_address, receiver_address," +
          " contract_status FROM contracts WHERE contract_address = $1;",
          [contract]
        ).then((res) => {
          opts['contractName'] = res ? res.contract_name || "" : "";
          opts['contractSender'] = res ? res.sender_address || "" : "";
          opts['contractHandler'] = res ? res.handler_address || "" : "";
          opts['contractReceiver'] = res ? res.receiver_address || "" : "";
          opts['contractStatus'] = res ? res.contract_status || "" : "";
        }).catch((err) => {
          printError("Error retrieving contract info from the database!", err);
        });

        res.render(path.join(__dirname,'public','templates','index.html'), opts);
      })
    ]
  },
  {
    path: "/login",
    method: "get",
    permissions: [PERMISSION_PROFILE__ONLY_NON_AUTHENTICATED],
    unauthorisedQueryHandler: (req, res) => {
      res.redirect('/logout');
      return;
    },
    callbacks: [
      upload.array(),
      asyncMiddleware( async (req, res) => {
        let opts = COMMON_OPTS;
        opts['options'] = await generateNavbarOptions(req, false);
        res.render(path.join(__dirname, 'public', 'templates', 'login.html'), opts);
      })
    ]
  },
  {
    path: "/login",
    method: "post",
    permissions: [PERMISSION_PROFILE__ANY_USER],
    unauthorisedQueryHandler: DEFAULT_FUNC,
    callbacks: [
      upload.array(),
      asyncMiddleware( async (req, res) => {
        let result = {res: "Invalid credentials", nonce: "", err: true};

        let user = await bot.dbStore.fetchval(
          "SELECT email FROM users WHERE pass_digest = $1 AND (username = $2 OR email = $2);",
          [req.body.pass_digest, req.body.user]
        ).catch((err)=> {
          printError(err);
        });

        if(user) result = await maybeSetNonce({email: user, ip: req.ip}, "json", 24);

        res.json(result);
        return;
      })
    ]
  },
  {
    path: "/profile",
    method: "get",
    permissions: [PERMISSION_PROFILE__ONLY_AUTHENTICATED],
    unauthorisedQueryHandler: (req, res) => {
      res.redirect('/login');
      return;
    },
    callbacks: [
      upload.array(),
      asyncMiddleware( async (req, res) => {
        let opts = COMMON_OPTS;
        opts['options'] = await generateNavbarOptions(req, false);
        opts['nonce'] = await maybeSetNonce({email: req.session.email, ip: req.ip}, "nonce", 1);
        res.render(path.join(__dirname, 'public', 'templates', 'profile.html'), opts);
      })
    ]
  },
  //{
  //  path: "/profile",
  //  method: "post",
  //  permissions: [PERMISSION_PROFILE__ONLY_AUTHENTICATED],
  //  unauthorisedQueryHandler: (req, res) => {
  //    res.redirect('/login');
  //    return;
  //  },
  //  callbacks: [
  //    upload.array(),
  //    asyncMiddleware( async (req, res) => {
  //      let opts = COMMON_OPTS;
  //      opts['options'] = await generateNavbarOptions(req, false);
  //      res.render(path.join(__dirname, 'public', 'templates', 'register.html'), opts);
  //    })
  //  ]
  //},
  {
    path: "/register",
    method: "get",
    permissions: [PERMISSION_PROFILE__ONLY_NON_AUTHENTICATED],
    unauthorisedQueryHandler: asyncMiddleware( async (req, res) => {
      let opts = COMMON_OPTS;
      opts['options'] = await generateNavbarOptions(req, false);
      opts['result'] = {res: 'You are already logged in!', err: true};
      res.render(path.join(__dirname, 'public', 'templates', 'register.html'), opts);
    }),
    callbacks: [
      upload.array(),
      asyncMiddleware( async (req, res) => {
        let opts = COMMON_OPTS;
        opts['options'] = await generateNavbarOptions(req, false);
        res.render(path.join(__dirname, 'public', 'templates', 'register.html'), opts);
      })
    ]
  },
  {
    path: "/register",
    method: "post",
    permissions: [PERMISSION_PROFILE__ANY_USER],
    unauthorisedQueryHandler: DEFAULT_FUNC,
    callbacks: [
      upload.array(),
      asyncMiddleware( async (req, res) => {
        let result = {res: 'Everything turned out fine! Please check your email to finish registration process...', err: false};

        await bot.dbStore.execute(
          "INSERT INTO users (username, email, pass_digest, verified) VALUES ($1, $2, $3, FALSE);",
          [req.body.username, req.body.mail, req.body.pass_digest]
        ).then(() => {
          printLog("User correctly registered into the database!");
        }).catch((err) => {
          printError("Error inserting user info into the database!", err);
          result = {res: "Error inserting user info into the database!", err: true};
        });

        result = await maybeSetNonce({email: req.body.email, ip: req.ip}, "json", 24);

        Mailer.sendEmailVerify(
          req.body.mail,
          req.protocol + '://' + req.get('Host') + '/verify?nonce=' + result.nonce + '&mail=' + encodeURIComponent(req.body.mail),
          req.protocol + '://' + req.get('Host') + '/report-verify?nonce=' + result.nonce + '&mail=' + encodeURIComponent(req.body.mail)
        );

        res.json(result);
        return;
      })
    ]
  },
  {
    path: "/report-verify",
    method: "get",
    permissions: [PERMISSION_PROFILE__ANY_USER],
    unauthorisedQueryHandler: DEFAULT_FUNC,
    callbacks: [
      upload.array(),
      asyncMiddleware( async (req, res) => {

        let opts = COMMON_OPTS;
        opts['options'] = await generateNavbarOptions(req, false);
        let result = {res: "Unknown error", err: true};

        let nonce_id = await bot.dbStore.fetchval(
          "SELECT nonce_id FROM nonces WHERE nonce = $1 AND email = $2;",
          [req.query.nonce, req.query.mail]
        ).catch((err)=>{
          result = {res: err, err: true};
        });

        if(nonce_id) {
            await bot.dbStore.execute(
              "DELETE FROM users WHERE email = $1",
              [req.query.mail]
            ).then(() => {
              result = {res: "Your verification issue report was correctly processed. Sorry for the inconveniences.", err: false};
            }).catch((err) => {
              result = {res: err, err: true};
            });
        } else {
          result = {res: "Sorry, we couldn't find any pending verification process related with your email address.", err: true};
        }

        if(!result.err) {
          bot.dbStore.execute(
            "DELETE FROM nonces WHERE nonce_id = $1;",
            [nonce_id]
          );
        }

        opts['result'] = result;

        res.render(path.join(__dirname, 'public', 'templates', 'report-verify.html'), opts);
      })
    ]
  },
  {
    path: "/verify",
    method: "get",
    permissions: [PERMISSION_PROFILE__ONLY_NON_AUTHENTICATED],
    unauthorisedQueryHandler: asyncMiddleware( async (req, res) => {
      let opts = COMMON_OPTS;
      opts['options'] = await generateNavbarOptions(req, false);
      opts['result'] = {res: 'You are already logged in!', err: true};
      res.render(path.join(__dirname, 'public', 'templates', 'verify.html'), opts);
    }),
    callbacks: [
      upload.array(),
      asyncMiddleware( async (req, res) => {

        let opts = COMMON_OPTS;
        opts['options'] = await generateNavbarOptions(req, false);
        let result = {res: "Unknown error", err: true};

        let nonce_id = await bot.dbStore.fetchval(
          "SELECT nonce_id FROM nonces WHERE nonce = $1 AND email = $2 AND ip = $3 AND validity >= $4 :: timestamp;",
          [req.query.nonce, req.query.mail, req.ip, generateDatetimeString(0)]
        ).then((res)=>{
          return res;
        }).catch((err)=>{
          result = {res: err, err: true};
        });

        if(nonce_id) {
          let username = await bot.dbStore.fetchval("SELECT username FROM users WHERE email = $1;", [req.query.mail]) || "??";
          let avatarFile = path.join(__dirname, 'public', 'uploads', username == "??" ? 'unknown.png' : username.slice(0,2).toUpperCase() + '.png');
          if(!fs.existsSync(avatarFile))
            generateAvatar({width: 50, height: 50, text: username.slice(0,2).toUpperCase(), fontSize: 25}, (err, buffer) => {
              if(err) {
                avatarFile = '';
                printError(err);
              } else {
                fs.writeFileSync(avatarFile, buffer);
              }
            });
          await bot.dbStore.execute(
            "UPDATE users SET verified = TRUE, avatar = $1 WHERE email = $2",
            [avatarFile.split(path.sep).slice(-2).join(path.sep), req.query.mail]
          ).then(() => {
            result = {res: "Your registration was processed correctly. Please check your email account in order to verify your address.", err: false};
          }).catch((err) => {
            result = {res: err, err: true};
          });
        } else {
          result = {res: "Couldn't find pending verification. Tip: You must verify your email address from the same IP used for registration...", err: true};
        }

        printLog(
          "IP:    " + req.ip,
          "NONCE: " + req.query.nonce,
          "MAIL:  " + req.query.mail,
          "RESULT: " + JSON.stringify(result)
        );

        if(!result.err) {
          bot.dbStore.execute(
            "DELETE FROM nonces WHERE nonce_id = $1;",
            [nonce_id]
          );
        }

        opts['result'] = result;

        res.render(path.join(__dirname, 'public', 'templates', 'verify.html'), opts);
      })
    ]
  },
  {
    path: "/logout",
    method: "get",
    permissions: [PERMISSION_PROFILE__ONLY_AUTHENTICATED],
    unauthorisedQueryHandler: (req, res) => {
      res.redirect('/login');
      return;
    },
    callbacks: [
      asyncMiddleware( async (req, res) => {
        delete req.session.authenticated;
        res.redirect('/');
      })
    ]
  },
  {
    path: "/upload",
    method: "post",
    permissions: [PERMISSION_PROFILE__ANY_USER],
    unauthorisedQueryHandler: DEFAULT_FUNC,
    callbacks: [
      //upload.single(),
      asyncMiddleware( async (req, res) => {
        await upload.single("file")(req, res, async (err)=> {
          if(err) {printError(err); return;}
          if(!req.file) return;
          let result = {res: 'Everything turned out fine!', err: false};
          const nonce = req.body.nonce;
          const email = (await checkNonce(nonce, req.ip)).email || '';
          if(email) {
            await bot.dbStore.execute("UPDATE users SET avatar = $1 WHERE email = $2;", [req.file.path.split(path.sep).slice(-2).join(path.sep), email]).then((res) => {
              printLog("User avatar successfuly updated!", "PATH: " + req.file.path);
            }).catch((err) => {
              printError("Error updating user avatar on the database!", "PATH: " + req.file.path, err);
              result = {res: "Error updating user avatar on the database!", err: true};
            });
          }
          res.json(result);
          return;
        });
      })
    ]
  },
  {
    path: "/new-contract",
    method: "get",
    permissions: [PERMISSION_PROFILE__ONLY_AUTHENTICATED],
    unauthorisedQueryHandler: DEFAULT_FUNC,
    callbacks: [
      asyncMiddleware( async (req, res) => {
        let opts = mergeDicts(COMMON_OPTS, CONTRACT_OPTS);
        opts['options'] = await generateNavbarOptions(req);
        opts['nonce'] = await maybeSetNonce({email: req.session.email, ip: req.ip}, "nonce", 24);
        opts['MYIP'] = MYIP;
        res.render(path.join(__dirname,'public','templates','new-contract.html'), opts);
      })
    ]
  },
  {
    path: "/new-contract",
    method: "post",
    permissions: [PERMISSION_PROFILE__RESTRICTED_API],
    unauthorisedQueryHandler: DEFAULT_FUNC,
    callbacks: [
      upload.array(),
      asyncMiddleware( async (req, res) => {
        let result = {res: 'Error awaiting for database write event', err: true};

        bot.dbStore.execute(
          "INSERT INTO addresses (address, network_id, user_id)" +
          "  VALUES ($1,$2,$3) " +
          "  ON CONFLICT (address) DO NOTHING;",
          [req.body.sAddr, req.body.netId, res.locals.user.user_id]
        ).catch((err) => {
          printError("Error registering new address in the database!", err);
        });

        await bot.dbStore.execute(
          "INSERT INTO contracts" +
          "  (contract_address, contract_name, sender_address, handler_address," +
          "    receiver_address, contract_status, deployment_dt, network_id)" +
          "  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            req.body.cAddr,
            req.body.n,
            req.body.sAddr,
            req.body.hAddr,
            req.body.rAddr,
            req.body.s,
            req.body.timestamp,
            req.body.netId
          ]
        ).then((res) => {
          result = {res: 'Everything turned out fine!', err: false};
        }).catch((err) => {
          printError("Error registering new contract in the database!", err);
          result = {res: 'Error registering new contract in the database!', err: true}
        });

        res.json(result);
        return;
      })
    ]
  },
  {
    path: "/withdrawal",
    method: "get",
    permissions: [PERMISSION_PROFILE__RESTRICTED_GUI, "sender", 1],
    unauthorisedQueryHandler: DEFAULT_FUNC,
    callbacks: [
      upload.array(),
      asyncMiddleware( async (req, res) => {
        let opts = mergeDicts(COMMON_OPTS, CONTRACT_OPTS);
        opts['options'] = await generateNavbarOptions(req);
        opts['nonce'] = req.session.nonce;
        opts['contractAddress'] = req.query.cAddr || '';
        opts['MYIP'] = MYIP;
        await Fiat.fetch().then((toEth) => { opts['fiatUSDChange'] = toEth.USD(1);});
        res.render(path.join(__dirname,'public','templates','withdrawal.html'), opts);
      })
    ]
  },
  {
    path: "/set-completed-contract",
    method: "get",
    permissions: [PERMISSION_PROFILE__RESTRICTED_GUI, "receiver", 0],
    unauthorisedQueryHandler: DEFAULT_FUNC,
    callbacks: [
      upload.array(),
      asyncMiddleware( async (req, res) => {
        let opts = mergeDicts(COMMON_OPTS, CONTRACT_OPTS);
        opts['options'] = await generateNavbarOptions(req);
        opts['nonce'] = req.session.nonce;
        opts['contractAddress'] = req.query.cAddr || '';
        opts['MYIP'] = MYIP;
        await Fiat.fetch().then((toEth) => { opts['fiatUSDChange'] = toEth.USD(1);});
        res.render(path.join(__dirname,'public','templates','set-completed-contract.html'), opts);
      })
    ]
  },
  {
    path: "/set-completed-contract",
    method: "post",
    permissions: [PERMISSION_PROFILE__RESTRICTED_API, "receiver", 0],
    unauthorisedQueryHandler: DEFAULT_FUNC,
    callbacks: [
      upload.array(),
      asyncMiddleware( async (req, res) => {
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
      })
    ]
  },
  {
    path: "/set-refused-contract",
    method: "get",
    permissions: [PERMISSION_PROFILE__RESTRICTED_GUI, "receiver", 0],
    unauthorisedQueryHandler: DEFAULT_FUNC,
    callbacks: [
      upload.array(),
      asyncMiddleware( async (req, res) => {
        let opts = mergeDicts(COMMON_OPTS, CONTRACT_OPTS);
        let contract = req.query.cAddr || '';
        opts['options'] = await generateNavbarOptions(req);
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
      })
    ]
  },
  {
    path: "/set-refused-contract",
    method: "post",
    permissions: [PERMISSION_PROFILE__RESTRICTED_API, "receiver", 0],
    unauthorisedQueryHandler: DEFAULT_FUNC,
    callbacks: [
      upload.array(),
      asyncMiddleware(async (req, res) => {
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
      })
    ]
  },
  /*{
    path: "/upload",
    method: "post",
    permissions: [PERMISSION_PROFILE__ONLY_AUTHENTICATED],
    unauthorisedQueryHandler: DEFAULT_FUNC,
    callbacks: [
      upload.single("file"),
      asyncMiddleware(async (req, res) => {
        if(req.file){
          await bot.dbStore.execute(
            "UPDATE user SET avatar = $1 WHERE email = $2 and verified = TRUE;",
            [req.file, req.session.cAddr]
          ).catch((err)=>{
          });
          return res.json({res: "File uploaded successfully", err: false});
        }
        printError("No file received");
        return res.json({res: "No file received", err: true});
      })
    ]
  },*/
];

appEndpoints.forEach((elem) => {app[elem.method](elem.path,...elem.callbacks)});

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
