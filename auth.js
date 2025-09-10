const { AuthorizationCode } = require('simple-oauth2');
const config = require('./config');

const yahoo = new AuthorizationCode({
  client: {
    id: config.yahoo.clientId,
    secret: config.yahoo.clientSecret,
  },
  auth: {
    tokenHost: 'https://api.login.yahoo.com',
    tokenPath: '/oauth2/get_token',
    authorizePath: '/oauth2/request_auth',
  },
});

module.exports = yahoo;
