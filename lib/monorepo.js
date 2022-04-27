const path = require('path')
const fsExtra = require('fs-extra')
const fs = require('fs')
const {
    dockerPathForWin, getRequirementsWorkingPath
} = require('./shared')
const {
    v4
} = require('uuid')
const TOML = require('@iarna/toml')
const { exec } = require('child_process')

/**
 * Method for using Docker to build dependencies using poetry. Requires that a custom Docker image with the target 
 * Python version + Poetry specified (and part of $PATH). Also requires that in-project virtual environments are configured
 * (see https://python-poetry.org/docs/configuration/#virtualenvsin-project).
 * 
 * Performs the following operations:
 * - Cleans the Docker bindpath of any other files
 * - Copies the monorepo directory (1 directory above the Serverless API directory) to the bind path
 * - Cleans out all .venv directories
 * - Runs an install operation in the API dir
 * - Copies the bindpath's built dependencies to the .serverless/requirements directory
 * - Adds the handler files to the .serverless/requirements directory for further processing later
 * - Cleans up the temp bindpath directory
 */
function buildDockerPoetryMonorepo() {
    if (!this.options.dockerBuildPoetryMonorepo) {
        return
    }

    // Come up with a temp bind path that we can use to share with the Docker instance
    const serverlessMonorepoPath = path.dirname(this.serverless.config.servicePath)
    const bindPath = dockerPathForWin(getRequirementsWorkingPath(v4(), path.join(path.dirname(serverlessMonorepoPath, 'temp')), {useStaticCache: true}))
    const serverlessRequirementsZipPath = path.join(this.serverless.config.servicePath, '.serverless', 'requirements')
    fsExtra.mkdirpSync(bindPath)

    // Create a requirements directory within .serverless for zipping
    fsExtra.ensureDirSync(serverlessRequirementsZipPath)
    fsExtra.emptyDirSync(serverlessRequirementsZipPath)

    this.serverless.cli.log(`Created temp Docker bind path ${bindPath}`);

    const bindPathApiDir = path.join(bindPath, path.basename(this.serverless.config.servicePath))
    const apiDirName = path.basename(this.serverless.config.servicePath)
    const tomlFilePath = path.join(bindPathApiDir, 'pyproject.toml')

    // Clean up the bind path directory so that we can start fresh
    fsExtra.emptyDirSync(bindPath)

    this.serverless.cli.log(`Copying monorepo from ${serverlessMonorepoPath} to ${bindPath}`);
    this.serverless.cli.log(`Excluding node_modules, .venv, poetry.lock, .git`);

    // Copy the contents of the Serverless Monorepo to the bindpath so that
    // Docker has something to work with
    return new Promise((resolve, reject) => {
        exec(`rsync -rav --progress ${serverlessMonorepoPath}/ ${bindPath} --exclude node_modules --exclude .venv --exclude poetry.lock --exclude .git`, (err, stdout, stderr) => {
            if (err) {
                this.serverless.cli.log(`Error copying files from ${serverlessMonorepoPath} to ${bindPath}: ${stderr}`);
                reject()
            } else {
                resolve()
            }
        })
    }).then(() => {
        this.serverless.cli.log(`Updating toml file to remove develop attributes on linked libs`);
        removeTomlEditableDependencies(tomlFilePath)

        return new Promise((resolve, reject) => {
            exec(`find ${bindPath} -name "pyproject.toml"`, (err, stdout, stderr) => {
                if (err) {
                    this.serverless.cli.log(`Error running docker script: ${stderr}`);
                    reject()
                } else {
                    resolve(stdout)
                }
            })         
        })
    }).then((tomlFilePaths) => {
        if (tomlFilePaths && tomlFilePaths.length > 0) {
            tomlFilePaths.split('\n').forEach((path) => {
                removeTomlEditableDependencies(path, bindPath)
            })
        }

        this.serverless.cli.log(`Running docker commands...`);

        /* Runs something like the following:
         * docker run --rm -v /Users/timgrowney/Library/Caches/serverless-python-requirements/cae0c72f-48b1-4171-8ebd-904541244b56_slspyc\:/var/task\:z -w /var/task/api-runamo tgrowneyhydra/python-builder\:latest poetry install
         * Breaking this down, it mounts the temp cache dir on the host side to /var/task, sets the working directory to /var/task/api-runamo, then runs the command `poetry install` on the `tgrowneyhydra/python-builder\:latest` image
        */
        return new Promise((resolve, reject) => {
            const dockerCmd = `docker run --rm -v ${bindPath}:/var/task:z -w /var/task/${apiDirName} ${this.options.dockerImage} poetry install --no-dev`
            this.serverless.cli.log(`Running ${dockerCmd}`);

            exec(`${dockerCmd}`, (err, stdout, stderr) => {
                if (err) {
                    this.serverless.cli.log(`Error running docker script: ${stderr}`);
                    reject()
                } else {
                    this.serverless.cli.log(`${stdout}`);
                    resolve()
                }
            })         
        })
    }).then(() => {
        // Copy packages from the mounted build directory to the .serverless/requirements directory
        const copySourcePath = `${bindPath}/${apiDirName}/.venv/lib/python3.9/site-packages/`
              
        this.serverless.cli.log(`Copying dependencies from ${copySourcePath} to ${serverlessRequirementsZipPath}`);
        return new Promise((resolve, reject) => {
            exec(`rsync -rav --progress ${copySourcePath} ${serverlessRequirementsZipPath} --exclude pip* --exclude setuptools* --exclude wheel* --exclude *.pth --exclude *.virtualenv --exclude __pycache__ --exclude _distutils_hack --exclude pkg_resources --exclude _virtualenv.py`, (err, stdout, stderr) => {
                if (err) {
                    this.serverless.cli.log(`Error copying files from ${bindPath} to ${serverlessRequirementsZipPath}: ${stderr}`);
                    reject()
                } else {
                    resolve()
                }
            })
        })
    }).then(() => {
        this.serverless.cli.log(`Deleting bind path dir ${bindPath}`);

        // It empties the directory before it deletes it, or else it gets the error again
        fsExtra.emptyDirSync(bindPath)
        fsExtra.rmdirSync(bindPath)
    })
}

/**
 * Responsible for zipping the requirements files that were put together during the call to 
 * buildDockerPoetryMonorepo().  Zips the contents of the .serverless/requirements directory
 * (without the requirements parent) and places it at the root of the .serverless directory
 * so that it's ready for the deployment step.
 */
function zipMonoRepoDeps() {
    if (!this.options.dockerBuildPoetryMonorepo) {
        return
    }

    const serverlessRequirementsZipPath = path.join(this.serverless.config.servicePath, '.serverless', 'requirements')
    const serverlessDotDirectoryPath = path.join(this.serverless.config.servicePath, '.serverless')
    const apiDirName = path.basename(this.serverless.config.servicePath)

    fsExtra.rmSync(`${serverlessDotDirectoryPath}/${apiDirName}.zip`, {force: true})

    this.serverless.cli.log(`Zipping dependencies`);

    return new Promise((resolve, reject) => {
        exec(`cd ${serverlessRequirementsZipPath}; zip -r ../${apiDirName}.zip ./*`, (err, stdout, stderr) => {
            if (err) {
                this.serverless.cli.log(`Error zipping requirements files from ${serverlessRequirementsZipPath}: ${stderr}`);
                reject(stderr)
            } else {
                resolve()
            }
        })
    })
}

function addDepsToZipFile() {
    if (!this.options.dockerBuildPoetryMonorepo) {
        return
    }

    const serverlessRequirementsZipPath = path.join(this.serverless.config.servicePath, '.serverless', 'requirements')
    const serverlessDotDirectoryPath = path.join(this.serverless.config.servicePath, '.serverless')
    const apiDirName = path.basename(this.serverless.config.servicePath)

    this.serverless.cli.log(`Adding dependencies to zip file`);

    return new Promise((resolve, reject) => {
        exec(`cd ${serverlessRequirementsZipPath}; zip -ur ../${apiDirName}.zip ./*;`, (err, stdout, stderr) => {
            if (err) {
                this.serverless.cli.log(`Error zipping requirements files from ${serverlessRequirementsZipPath}: ${stderr}`);
                reject(stderr)
            } else {
                resolve()
            }
        })
    })
}

function removeTomlEditableDependencies(tomlFilePath, projectRootPath) {
    if (!tomlFilePath || tomlFilePath.length < 2) {
        return
    }
    
    const tomlFile = tomlFilePath
    const tomlFileStringContents = fs.readFileSync(tomlFile).toString()

    const tomlFileContents = TOML.parse(tomlFileStringContents)

    //@ts-ignore
    const dependencies = tomlFileContents.tool.poetry.dependencies

    //@ts-ignore
    const dependencyKeys = Object.keys(dependencies)

    dependencyKeys.forEach((dependencyKey) => {
        const dependency = dependencies[dependencyKey]

        if (typeof dependency === 'object') {
            //@ts-ignore
            if (dependency.develop) {
                //@ts-ignore
                delete dependency.develop
            }

            /**
             *   The Wheel build process for secondary modules copies the module to a temp dir
             *   then builds the wheel.  This fails for local secondary modules that reference other
             *   local secondary modules by relative path because the wheel build process is happening outside of the
             *   monorepo.
             * 
             *   In the case where we have toml files that are part of other secondary modules
             *   (not the primary API module), then we need to replace any relative paths with
             *   an absolute path _within the Docker context_.
             * 
             *   We know that the monorepo location in Docker is /var/task/, so we should replace the
             *   non-Docker path with the docker task path, then figure out the absolute path based
             *   on the relative path defined in the target pyproject.toml
             * 
             *   For example, say we have a shared lib at `/var/task/sharedlib` that has a logging module and a data access layer (dal) module.
             *   The dal module at `/var/task/sharedlib/shareddal` might want to use the logging module.  During local development, we would have a dependency
             *   that might look like the following:
             *   
             *   sharedlog = {path = "../sharedlog", develop = true}
             * 
             *   During build this will fail because the `shareddal` is copied to a temp directory by the wheel build process, so `../sharedlog` cannot be resolved.
             * 
             *   We know the project root path on the _host_ side (e.g. /Users/[your-user]/Library/Caches/serverless-python-requirements/[uuid]).  We also
             *   know the build path in the Docker instance (/var/task).  We need to do the following:
             *   - Replace the host path to the target toml file with `/var/task` (as this is our current module directory)
             *   - Strip the toml file reference from the end of the path
             *   - Let path.join resolve the relative path specified in the pyproject.toml dependency to give us an absolute path for the build system
             */
            if (projectRootPath && projectRootPath.length > 0 && dependency.path && dependency.path.indexOf('..') > -1) {
                let dockerTomlPath = tomlFilePath.replace(projectRootPath, '/var/task')
                let dockerModulePath = dockerTomlPath.split('/')
                dockerModulePath = dockerModulePath.slice(0, dockerModulePath.length - 1).join('/')

                const finalPath = path.join(dockerModulePath, dependency.path)

                dependency.path = finalPath
            }
        }
    })

    delete tomlFileContents['tool']['poetry']['dev-dependencies']

    fs.rmSync(tomlFilePath)
    fs.writeFileSync(tomlFilePath, TOML.stringify(tomlFileContents))
}

/**
 * Handler files could be at the root of the service path, or they could be in like a /src directory.
 * Figure out where they are
 */
function getHandlerSourcePaths(functions) {
    const paths = {}

    const functionKeys = Object.keys(functions)

    // Serverless functions object looks like the following:
    // {"hello":{"handler":"src/handler.hello","events":[{"http":{"path":"hello","method":"get"}}],"name":"dev-hello"}}
    functionKeys.forEach((slsFuncName) => {
        const slsFunc = functions[slsFuncName]
        const isInRoot = slsFunc.handler.indexOf('/') === -1

        if (isInRoot) {
            if (!paths.root) {
                paths.root = []
            }

            const functionHandlerFile = `${slsFunc.handler.split('.')[0]}.py`
            paths.root.push(functionHandlerFile)
        } else {
            const parentPath = path.dirname(slsFunc.handler)

            if (!paths[parentPath]) {
                paths[parentPath] = true
            }
        }
    })

    return paths
}

module.exports = { buildDockerPoetryMonorepo, zipMonoRepoDeps, addDepsToZipFile }