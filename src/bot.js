const Bot = require('./lib/Bot')
const SOFA = require('sofa-js')
const Fiat = require('./lib/Fiat')
const fs = require('fs')
//const web3 = require('web3')
const solc = require('solc')
const assert = require('assert')

const DEFAULT_FUNC = () => {return true;};

let code = fs.readFileSync('./dapp_src/logistics.sol').toString();
//let web3 = new Web3( new Web3.providers.HttpProvider('https://ropsten.infura.io/'));
let bot = new Bot();

let last_command = 'main';

const retrieveList = () => {return "Sorry, nothing to show yet...";};
const listSent = (session) => {sendMessage(session, retrieveList()); return true;};
const listPending = (session) => {sendMessage(session, retrieveList()); return true;};
const listAndPrompt = (session, options) => {
  sendMessage(session, `Please, choose one of the following shipping contracts`);
  sendMessage(session, retrieveList(), options);
  return true;
};

let shippingContractName = true;
let shippingContractReceiver = true;
let shippingContractTransporter = true;
let shippingContractPrice = true;
let shippingReceivedAction = true;

function hasPropertyName(obj, name) {
	return typeof(obj) !== 'undefined' ? Object.getOwnPropertyNames(obj).indexOf(name) > -1 : false;
}

let menuOptions = {
  main: {
    msgHeader: `Hi there! Welcome to the Logistics Smart Contract Handler.`,
    options: [
      {
        control: {
          type: 'button',
          label: 'New Shipment',
          description: 'Create a new contract for a shipment',
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
  new_shipment: {
    msgHeader: `You're about to create a new shipping contract.`,
    // TODO: Complete with prompted options
    prompts: [
      {
        body: `Please provide a name to identify your new contract/shipment.`,
        v: shippingContractName,
      },
      {
        body: `What's the shipping receiver's Toshi address?`,
        v: shippingContractReceiver,
      },
      {
        body: `What's the transporter's Toshi address?`,
        v: shippingContractTransporter,
      },
      {
        body: `What's the price to pay on arrival for the packet?`,
        v: shippingContractPrice,
      },
      /*{
        body: `Do you want to handle payment by contract on the arrival?`,
        controls: [
          {type: 'button', label: 'Yes', value: 'yes'},
          {type: 'button', label: 'No', value: 'no'},
        ],
        v: shippingContractPaymentOnArrival,
      },
      {
        body: `What will the deadline be before launching a notification? (format: XX days)`,
        controls: [
          {type: 'button', label: 'Any', value: 'any'},
          {type: 'button', label: '1 Day', value: '1 day'},
          {type: 'button', label: '5 Days', value: '5 days'},
          {type: 'button', label: '15 Days', value: '15 days'},
        ],
        v: shippingContractDeadline,
      },*/
    ],
    parent: 'main',
  },
  shipment_received: {
    msgHeader: `You're about to close a shipping contract.`,
    prompts: [
      {
        body: listAndPrompt,
        v: shippingContractName,
      },
      {
        body: `What do you want to do?`,
        controls: [
          {type: 'button', label: 'Accept & Pay', value: 'accept'},
          {type: 'button', label: 'Refuse & Return', value: 'refuse'},
        ],
        v: shippingReceivedAction,
        f: (session, opt) => {
          if (opt == 'accept') {
            // TODO: Implement contract acceptance method "send"
			return true;
          } else if (opt == 'refuse') {
            // TODO: Implement contract refuse method "send"
			return true;
          } else {
            return false;
          }
        },
      },
    ],
    parent: 'main',
  }
};

let default_controls = menuOptions.main.options.map(function(option){return {
  type: option.control.type,
  label: option.control.label,
  value: option.control.label.toLowerCase().split(' ').join('_'),
}});

bot.onEvent = function(session, message) {
  let prev_submenu = maybeRetrieveSessionVar(session, 'submenu', 'main');
  switch (message.type) {
    case 'Init':
      help(session);
      break
    case 'Message':
    case 'Command':
      onCommandOrMessage(session, message)
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

function maybeRetrieveSessionVar(session, name, default_) {
  default_ = typeof default_ !== 'undefined' ? default_ : false;
  let sessionVar = session.get(name) || default_;
  session.set(name, sessionVar);
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
  session.set('promptphase', promptPhase);
  return promptPhase != 0;
}

function prepareFallBackToMain(session) {
  session.set('promptphase', 0);
  session.set('submenu', 'main');
  sendMessage(session, "Sorry, something didn't go as expected.\n\n Turning back to main menu...");
}

function help(session) {

  let submenu = maybeRetrieveSessionVar(session, 'submenu', 'main');
  assert(hasPropertyName(menuOptions, submenu), 'Menu not found');

  let menuObj = menuOptions[submenu];
  let msg = '';

  if (getUIType(menuObj) == 'options') {

    msg += menuObj.msgHeader + `\n\nPlease, choose one of the following:`;

    for(let i = 0; i < menuObj.options.length; i++) {
      msg += "\n" + menuObj.options[i].control.label + ' - ' + menuObj.options[i].control.description;
    }

    sendMessage(
      session,
      msg,
      menuObj.options.map(function(option){
        return {
          type: option.control.type,
          label: option.control.label,
          value: option.control.label.toLowerCase().split(' ').join('_'),
        };
      })
    );

  } else {
    
    let promptPhase = checkPromptPhase(session);

    if (promptPhase <= -1) {
      session.set('promptphase', 0);
      promptPhase = 0;
    }
	
	let menuPrompt = menuObj.prompts[promptPhase];

	let controls = hasPropertyName(menuPrompt, 'controls') ? menuObj.prompts[promptPhase].controls : [];
	
	if(typeof(menuObj.prompts[promptPhase].body) !== 'function'){
      sendMessage(
        session,
        menuObj.prompts[promptPhase].body,
	    controls
      );
	} else {
	  menuObj.prompts[promptPhase].body(session, controls);
	}

  }
  
  return true;
}

function onCommandOrMessage(session, obj) {
	
  const label2Command = (message) => {return message.toLowerCase().split(' ').join('_')};
  const retrieveOption = (opt) => {return hasPropertyName(opt.content, 'value') ? opt.content.value : label2Command(opt.body);}
  const readPromptData = (opt) => {return hasPropertyName(opt.content, 'value') ? opt.content.value : opt.body;}

  let submenu = maybeRetrieveSessionVar(session, 'submenu', 'main');
  assert(hasPropertyName(menuOptions, submenu), 'Menu not found');

  let menuObj = menuOptions[submenu];
  
  if(typeof(menuObj) === 'undefined') {
	prepareFallBackToMain(session);
	return true;
  }
  
  function handleOption(opt, menuOpt){
	let optFunc = hasPropertyName(menuOpt, 'f') ? menuOpt.f : DEFAULT_FUNC;

	let result = hasPropertyName(menuOpt, 'v') ? optFunc(session, menuOpt.v) : optFunc(session);
	if (hasPropertyName(menuOptions, opt) && result)
	  session.set('submenu', opt);
  
    return result;
  }
  
  function handlePrompt(opt){
	let promptPhase = checkPromptPhase(session);
    let menuPrompt = menuObj.prompts[promptPhase];

	if(typeof(menuPrompt) === 'undefined') {
	  prepareFallBackToMain(session);
	  return true;
    }

    let hasVar = hasPropertyName(menuPrompt, 'v');
    let promptFunc = hasPropertyName(menuPrompt, 'f') ? menuPrompt.f : DEFAULT_FUNC;

    if (hasVar)
      menuOptions[submenu].prompts[promptPhase].v = opt;

    if (hasVar ? promptFunc(session, opt) : promptFunc(session)) {
      if (!nextPromptPhase(session, menuObj))
        session.set('submenu', menuObj.parent);
      return true
    }

    return false
  }
  
  function unknownCommandOrMessage() {
    sendMessage(session, "Unknown command or message...\n\nPlease, provide a valid input based on the following");
    help(session);
  }  

  if (getUIType(menuObj) == 'options') {
	let option = retrieveOption(obj);
	let commandMap = menuObj.options.map((option)=>{return label2Command(option.control.label);});
	let menuOptIdx = commandMap.indexOf(option);
    return menuOptIdx > -1 ? handleOption(option, menuObj.options[menuOptIdx]) : unknownCommandOrMessage();
  } else {
	let data = readPromptData(obj);
	return handlePrompt(data);
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
