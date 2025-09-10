require('dotenv').config();

module.exports = {
  yahoo: {
    clientId: process.env.YAHOO_CLIENT_ID || 'dj0yJmk9dDVYcU16TERWa25jJmQ9WVdrOU0yUTVVSGREVjBZbWNHbzlNQT09JnM9Y29uc3VtZXJzZWNyZXQmc3Y9MCZ4PWVi',
    clientSecret: process.env.YAHOO_CLIENT_SECRET || '00e9a1cb8102c4942750912352d1bb738175e83d',
    redirectUri: 'https://localhost:3000/auth/callback'
  }
};