const path = require('path');
const nodemailer = require("nodemailer");
const Email = require('email-templates');

//const transporter = nodemailer.createTransport({
//    host: 'smtp.ethereal.email',
//    port: 587,
//    auth: {
//        user: 'z6nihsi54kldyuet@ethereal.email',
//        pass: 'ptAyU5sSweMJ5WmeK5'
//    }
//});

const transporter = nodemailer.createTransport({
  service: "Gmail",
  auth: {
    user: 'danielperezr88@gmail.com',
    pass: 'Lyanna+Luke%021004'
  }
});

const email = new Email({
  views: {
    root: path.join(__dirname, '..', 'public', 'templates'),
    options: {extension: 'ejs'}
  },
  message: {from: 'noreply@logisticsbot.com'},
  transport: transporter
});

// create template based sender function
// assumes text.{ext} and html.{ext} in template/directory
/*const sendResetPasswordLink = transporter.templateSender(
    new Email({views: {root: path.join(__dirname, '..', 'public', 'templates', 'mail-reset-password')}}),
    {from: 'noreply@logisticsbot.com'}
);

const sendVerifyEmailLink = transporter.templateSender(
    new Email({views: {root: path.join(__dirname, '..', 'public', 'templates', 'mail-verify-address')}}),
    {from: 'noreply@logisticsbot.com'}
);*/

exports.sendPasswordReset = (emailAddress, resetUrl, reportUrl) => {
    email.send({
        template: 'mail-reset-password',
        message: {
            to: emailAddress,
            subject: "Password Reset - Logistics Bot"
        },
        locals: {
            resetUrl: resetUrl,
            reportUrl: reportUrl
        }
    }).then((info) => {
            console.log("Link Sent\n" + JSON.stringify(info));
    }).catch(console.error);
};

exports.sendEmailVerify = (emailAddress, verifyUrl, reportUrl) => {
    email.send({
        template: 'mail-verify-address',
        message: {
            to: emailAddress,
            subject: "Email Verify - Logistics Bot"
        },
        locals: {
            verifyUrl: verifyUrl,
            reportUrl: reportUrl
        }
    }).then((info) => {
        console.log("Link Sent\n" + JSON.stringify(info));
    }).catch(console.error);
};

