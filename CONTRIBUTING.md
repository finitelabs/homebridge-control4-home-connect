## Setup Development Environment

To develop Homebridge plugins you must have Node.js 12 or later installed, and a modern code editor such as [VS Code](https://code.visualstudio.com/). This plugin uses [TypeScript](https://www.typescriptlang.org/) to make development easier and comes with pre-configured settings for [VS Code](https://code.visualstudio.com/) and ESLint. If you are using VS Code install these extensions:

- [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)

## Install Development Dependencies

Using a terminal, navigate to the project folder and run this command to install the development dependencies:

```
npm install
```

## Build Plugin

TypeScript needs to be compiled into JavaScript before it can run. The following command will
compile the contents of your [`src`](./src) directory and put the resulting code into the `dist`
folder.

```
npm run build
```

## Link To Homebridge

Run this command so your global install of Homebridge can discover the plugin in your development environment:

```
npm link
```

You can now start Homebridge, use the `-D` flag so you can see debug log messages from the plugin:

```
homebridge -D
```

## Watch For Changes and Build Automatically

If you want to have your code compile automatically as you make changes, and restart Homebridge
automatically between changes, you first need to add your plugin as a platform in `./config/config.json`:

```
{
...
    "platforms": [
        {
            "name": "Config",
            "port": 8581,
            "platform": "config"
        },
        {
            "name": "Control4 Home Connect",
            "platform": "Control4HomeConnect"
            //... any other options, as listed in config.schema.json ...
        }
    ]
}
```

and then you can run:

```
npm run watch
```

This will launch an instance of Homebridge in debug mode which will restart every time you make a
change to the source code. It will load the config stored in the default location under
`~/.homebridge`. You may need to stop other running instances of Homebridge while using this command
to prevent conflicts. You can adjust the Homebridge startup command in the
[`nodemon.json`](./nodemon.json) file.

## Versioning

Given a version number `MAJOR`.`MINOR`.`PATCH`, such as `1.4.3`, increment the:

1. **MAJOR** version when you make breaking changes to the plugin,
2. **MINOR** version when you add functionality in a backwards compatible manner, and
3. **PATCH** version when you make backwards compatible bug fixes.

## Releasing

A release is a tag. Pushing a `v*` tag runs [`release.yml`](./.github/workflows/release.yml),
which sets the package's version from the tag, publishes it to npm and creates the GitHub release.
Nothing is committed for a release, so the version in `package.json` on `master` isn't kept current.

```bash
git switch master
git pull
git tag v2.1.4
git push origin v2.1.4
```

The release notes list the pull requests merged since the previous tag. Label a pull request
`skip-release-notes` to leave it out.

#### Publishing Beta Versions

You can publish _beta_ versions of this plugin for other users to test before you release it to everyone.
A tag with a suffix publishes to `@beta` and as a pre-release:

```bash
git tag v2.1.4-beta.1
git push origin v2.1.4-beta.1
```

Users can then install the _beta_ version by appending `@beta` to the install command, for example:

```
sudo npm install -g homebridge-control4-home-connect@beta
```
