const path = require('path');
const nodeMailer = require("nodemailer");
const EmailTemplate = require('email-templates').EmailTemplate;

const transporter = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    auth: {
        user: 'z6nihsi54kldyuet@ethereal.email',
        pass: 'ptAyU5sSweMJ5WmeK5'
    }
});

// create template based sender function
// assumes text.{ext} and html.{ext} in template/directory
const sendResetPasswordLink = transporter.templateSender(
    new EmailTemplate(path.join(__dirname, '..', 'public', 'templates', 'mail-reset-password')),
    {
        from: 'noreply@logisticsbot.com',
    }
);

const sendVerifyEmailLink = transporter.templateSender(
    new EmailTemplate(path.join(__dirname, '..', 'public', 'templates', 'mail-verify-address')),
    {
        from: 'noreply@logisticsbot.com',
    }
);

exports.sendPasswordReset = (email, resetUrl, reportUrl) => {
    sendResetPasswordLink({
            to: email,
            subject: "Password Reset - Logistics Bot"
        },
        {
            resetUrl: resetUrl,
            reportUrl: reportUrl
        },
        (err, info) => {
            if(!err){
                console.log("Link Sent\n" + JSON.stringify(info));
            } else {
                console.error(err);
            }
        })
};

exports.sendEmailVerify = (email, verifyUrl, reportUrl) => {
    sendResetPasswordLink({
            to: email,
            subject: "Email Verify - Logistics Bot"
        },
        {
            verifyUrl: verifyUrl,
            reportUrl: reportUrl
        },
        (err, info) => {
            if(!err){
                console.log("Link Sent\n" + JSON.stringify(info));
            } else {
                console.error(err);
            }
        })
};

