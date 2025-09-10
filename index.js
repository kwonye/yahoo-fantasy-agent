const express = require('express');
const axios = require('axios');
const { parseString } = require('xml2js');
const fs = require('fs');
const app = express();
const port = 3000;
const yahooAuth = require('./auth');
const config = require('./config');

const TOKEN_PATH = 'token.json';

// Function to read the token from the file
const readToken = () => {
  try {
    const token = fs.readFileSync(TOKEN_PATH);
    return JSON.parse(token);
  } catch (error) {
    return null;
  }
};

// Function to save the token to the file
const saveToken = (token) => {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
};

// In-memory storage for the access token
let accessToken = readToken();

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.get('/auth/yahoo', (req, res) => {
  const authorizationUri = yahooAuth.authorizeURL({
    redirect_uri: config.yahoo.redirectUri,
    scope: 'fspt-r', // Read-only access to fantasy sports
    state: 'some-random-state' // a state string that will be sent back to the client
  });

  res.redirect(authorizationUri);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const options = {
    code,
    redirect_uri: config.yahoo.redirectUri,
  };

  try {
    const token = await yahooAuth.getToken(options);
    accessToken = token;
    saveToken(token);
    console.log('The access token is:', accessToken.token);
    res.send('Authentication successful! You can now close this window.');
  } catch (error) {
    console.error('Access Token Error', error.message);
    res.status(500).send('Authentication failed');
  }
});

app.get('/api/games', async (req, res) => {
  if (!accessToken) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const response = await axios.get('https://fantasysports.yahooapis.com/fantasy/v2/users;use_login=1/games', {
      headers: {
        'Authorization': `Bearer ${accessToken.token.access_token}`
      }
    });

    parseString(response.data, (err, result) => {
      if (err) {
        console.error('XML Parse Error', err.message);
        return res.status(500).send('Failed to parse XML');
      }
      res.json(result);
    });
  } catch (error) {
    console.error('API Error', error.message);
    res.status(500).send('Failed to fetch data from Yahoo API');
  }
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
