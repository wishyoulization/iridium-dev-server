# Iridium Dev Server

Local dev server for working with Observable notebooks.

## Install

`npm i @wishyoulization/iridium-dev-server`

## Run Development Server

`npx @wishyoulization/iridium-dev-server`

## Static Build

`-build` flag will compile all `.ojs` files to esm modules `.js` without starting the development web server.
`npx @wishyoulization/iridium-dev-server -build`

## Configuration

Save `.iridiumrc` file in the application root directory to configure the dev server.

```json
{
  "notebooks": "./src",
  "compiled": "./dist",
  "static:": "/path-to-serve-additional-static-assets",
  "port": 8080,
  "local_editor": false,
  "head": "<style>body{font-family:'Trebuchet MS';}</style>"
}
```

1. `notebooks` and `compiled` are directories where `.ojs` and compiled esm modules `.js` will be saved to, by default they are saved to the root directory.
2. The dev server by default starts on port `8080` and can be overridden using `port` property in config.
3. `local_editor` can be set to `true`/`false`, to either serve the editor scripts locally or from `unpkg` CDN
4. `head` is a string property for adding to the html page head section (for loading fonts or setting up libraries/scripts)

## Note

Add to your npm `package.json` scripts for convenience.

```json
"scripts": {
    "start":"iridium-dev-server",
    "build":"iridium-dev-server -build"
  }
```
