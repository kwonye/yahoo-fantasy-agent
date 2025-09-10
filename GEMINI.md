## Project Overview

This project is a Node.js server that provides an interface to the Yahoo Fantasy Sports API. It uses the Express framework to create a web server and the `simple-oauth2` library to handle OAuth2 authentication with Yahoo. The server exposes endpoints for authentication and for fetching data from the Yahoo API. The `axios` library is used to make HTTP requests to the Yahoo API, and `xml2js` is used to parse the XML responses from the API.

## Building and Running

### Prerequisites

*   Node.js and npm installed.

### Installation

1.  Install dependencies from `package.json`:
    ```bash
    npm install
    ```

### Configuration

1.  Add your Yahoo API credentials to `config.js`.

### Running the Server

1.  Start the server:
    ```bash
    npm start
    ```

The server will start on `http://localhost:3000`.

## Development Conventions

*   The project uses CommonJS modules (`require`/`module.exports`).
*   The main application logic is in `index.js`.
*   Authentication logic is separated in `auth.js`.
*   Configuration is stored in `config.js`.
*   The server stores the access token in `token.json`. This file is created after successful authentication and is read on server startup.
*   There are no tests in the project. The `test` script in `package.json` is a placeholder.
