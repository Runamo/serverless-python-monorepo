# Serverless Python Monorepo

This is a fork of the [serverless-python-requirements](https://github.com/UnitedIncome/serverless-python-requirements) repository.  It's been heavily modified to remove most of the functionality from that repository and instead use `poetry` and a custom AWS Docker image for compiling dependencies for AWS Lambda.

This repo is not maintained for public consumption.  It was modeled after the [OpenDoor](https://medium.com/opendoor-labs/our-python-monorepo-d34028f2b6fa) monorepo setup - and currently only works very narrowly for Serverless Python repositories that fit the following pattern:

- Have their handlers split into separate "groups" [due to the limitations on Resources in CloudFormation Templates](https://www.serverless.com/blog/serverless-workaround-cloudformation-200-resource-limit)
- Are using a set of shared libraries across those API groups
- Have Poetry set up and configured for [in-project virtual environments](https://python-poetry.org/docs/configuration/#virtualenvsin-project)
- Shared lib dependencies [are in `develop` mode](https://python-poetry.org/docs/dependency-specification/#path-dependencies) for local development

This project has only been tested for use on Macs (there are some explicit bash calls made in `monorepo.js`).  Pull requests for more support across platforms + testing + re-merging with the original trunk are welcome.

## Installation
At this point in time, because it was built for a narrow use case (ours) and no outside support is intended, installation is via a [direct Github link](https://docs.npmjs.com/cli/v7/commands/npm-install)

To add this repository to your own project, you would use the following command:

> npm install -D git+ssh://git@github.com:runamo/serverless-python-monorepo

You'll also need to add the following to your `serverless.yml` file:

```
plugins:
  - serverless-python-monorepo
```

As well as a few custom variables:

```
custom:
  pythonRequirements:
    dockerBuildPoetryMonorepo: true
    dockerImage: tgrowneyhydra/python-builder:latest
```

## Usage / What it Does
AWS Lambda relies on zipped handlers / dependencies for operating.  If these zipped dependencies have native build / lib requirements, they need to be built targeting the Lambda AWS runtime.

This plugin utilizes a [custom Docker image](https://github.com/Runamo/runamo-lambda-build) that has been modified to include the following:

- Poetry
- Python3.9

At deploy time, this plugin:

- Makes a copy of the parent monorepo directory to a temp mount directory
- During the copy, excludes all .env, node_modules, and the poetry.lock file from the api group directory
- Updates the pyproject.toml file to remove any [`develop`](https://python-poetry.org/docs/dependency-specification/#path-dependencies) attributes from any dependencies
- Runs a docker poetry install command against the custom docker image using the mounted temp directory
- Copies the built dependencies from the shared mounted directory to the .serverless/requirements directory of the target deployment directory
- Adds the built dependencies to the zip file that the Serverless `package` service generates
## Missing Functionality
Right now, the builds take a long time and don't differentiate between environments.  This plugin is also only confirmed to work on Macs.  A few things will go a long way to turn this into a real plugin:

- Build dependency caching into the system so that deploying doesn't rebuild every time
- Only use docker when using an environment that _isn't_ an AWS Linux environment (so that CD doesn't need to rebuild every time)
- Make this plugin work cross-platform
- Fix the unit testing so that these updates are tested regularly
- Make it a real, downloadable npm package OR update it so that the updates will work alongside the original repository functionality and evetually merge it? TBD.
