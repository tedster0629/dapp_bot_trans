const Bot = require('./lib/Bot')
const SOFA = require('sofa-js')
const Fiat = require('./lib/Fiat')
const web3 = require('web3')
const solc = require('solc')
const assert = require('assert')

let code = fs.readFileSync('./solidity/logistics.sol').toString();
let web3 = new Web3( new Web3.providers.HttpProvider('https://ropsten.infura.io/'));
let bot = new Bot();



let last_command = 'main'

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
        body: `Please, choose one of the following shipping contracts`,
        v: shippingContractName,
        f: listPending,
      },
      {
        body: `What do you want to do?`,
        controls: [
          {type: 'button', label: 'Accept & Pay', value: 'accept'},
          {type: 'button', label: 'Refuse & Return', value: 'refuse'},
        ],
        v: shippingReceivedAction,
        f: (opt) => {
          if (opt == 'accept') {
            // TODO: Implement contract acceptance method "send"
          } else if (opt == 'refuse') {
            // TODO: Implement contract refuse method "send"
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
  type: option.type,
  label: option.label,
  value: option.label.toLowerCase().split(' ').join('_'),
}});

// ROUTING

bot.onEvent = function(session, message) {
  switch (message.type) {
    case 'Init':
      help(session);
      break
    case 'Message':
    case 'Command':
      onCommandOrMessage(session, message) ? return : unknownCommandOrMessage(session, message);
      break
    case 'Payment':
      onPayment(session, message);
      break
    case 'PaymentRequest':
      help(session);
      break
  }
}

function maybeRetrieveSessionVar(session, name, default_) {
  default_ = typeof default_ !== 'undefined' ? default_ : false;
  let sessionVar = session.get(name) || default_;
  session.set(name, sessionVar);
  return sessionVar;
}

function getUIType(menuObj) {
  return Object.getOwnPropertyNames(menuObj).indexOf('options') > -1 ? 'options' : 'prompts';
}

function checkPromptPhase(session) {
  return session.get('promptphase') || 0;
}

function nextPromptPhase(session, menuObj) {
  let promptPhase = checkPromptPhase(session);
  session.set('promptphase', promptPhase + 1);
  return promptPhase >= menuObj.prompts.length ? -1 : promptPhase;
}

function help(session) {

  let submenu = maybeRetrieveSessionVar(session, 'submenu', 'main');
  assert(Object.getOwnPropertyNames(menuOptions).indexOf(submenu) > -1, 'Menu not found');

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
      }
    );

  } else {
    
    let promptPhase = checkPromptPhase(session);

    if (promptPhase <= -1) {
      session.set('promptphase', 0);
      promptPhase = 0;
    }

    sendMessage(
      session,
      menuObj.prompts[promptPhase].body
    );

  }
}

function onCommandOrMessage(session, obj) {

  let submenu = maybeRetrieveSessionVar(session, 'submenu', 'main');
  assert(Object.getOwnPropertyNames(menuOptions).indexOf(submenu) > -1, 'Menu not found');

  let menuObj = menuOptions[submenu];

  function maybeCallCommand(opt) {

    if (getUIType(menuObj) == 'options') {

      let didAnything = false;

      let optIdx = menuObj.options.map(function(option){
        return option.control.label.toLowerCase().split(' ').join('_');
      }).indexOf(opt);

      if (optIdx <= -1)
        return false

      if (Object.getOwnPropertyNames(menuOptions).indexOf(opt) > -1) {
        session.set('submenu', opt);
        didAnything = true;
      }

      let menuOpt = menuObj.options[optIdx];
      return Object.getOwnPropertyNames(menuOpt).indexOf('f') > -1 ? !menuOpt.f(session) : didAnything;

    } else {

      let promptPhase = checkPromptPhase(session);
      let menuPrompt = menuObj.prompts[promptPhase];

      let hasVar = Object.getOwnPropertyNames(menuPrompt).indexOf('v') > -1;
      let hasFunc = Object.getOwnPropertyNames(menuPrompt).indexOf('f') > -1;

      let promptFunc = hasFunc > -1 ? menuPrompt.f : ()=>true;

      if (hasVar)
        menuOptions[submenu].prompts[promptPhase].v = opt

      if (hasVar ? promptFunc(session, opt) : promptFunc(session)) {
        if (nextPromptPhase() <= -1)
          session.set('submenu', menuObj.parent);
        return true
      }

      return false

    }
            
  }

  function onCommand (command) {
    return maybeCallCommand(command.content.value);
  }

  function onMessage(message) {
    return maybeCallCommand(message.toLowerCase().split(' ').join('_'));
  }

  obj.hasOwnProperty('content') ? (onCommand(obj) ? true : onMessage(obj)) : onMessage(obj);

  help(session);

}

function unknownCommandOrMessage(session, obj) {
  help(session);
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
