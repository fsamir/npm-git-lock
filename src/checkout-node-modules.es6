'use strict';

let gitPromise = require(`git-promise`);
let gitUtil = require(`git-promise/util`);
let del = require(`del`);
let fs = require(`fs`);
let os = require(`os`);
let promisify = require(`es6-promisify`);
let log = require(`loglevel`);
let crypto = require(`crypto`);
let shell = require(`shelljs`);
let stringify = require(`json-stable-stringify`);
let uniq = require(`lodash/array/uniq`);

require('es6-promise').polyfill();
require('string.prototype.startswith');

let readFilePromise = promisify(fs.readFile);
let delPromise = promisify(del);
let statPromise = promisify(fs.stat);

/**
 * List of platforms that we know only work on a certain platform.
 * Unfortunately, this is necessary since `npm rebuild` doesn't ignore build failures in optional dependencies
 * like it should (cf. https://github.com/npm/npm/issues/10335).
 * Obviously, this list is not complete, but contains just what was necessary to make this work for "us".
 */
const PLATFORM_SPECIFIC_MODULES = {
    'fsevents': 'darwin'
};

/**
 * Conservative estimate of the maximum number of characters for a single shell line.
 * According to https://support.microsoft.com/en-us/kb/830473 this is no less than 2047.
 * Platforms other than Windows shouldn't pose a problem.
 * @type {number}
 */
const MAX_SHELL_LENGTH = 2000;

module.exports = (cwd, {repo, verbose, crossPlatform, incrementalInstall, production, skipInstall}) => {

    let packageJsonSha1;
    let packageJsonVersion;
    let leaveAsIs = false;
    log.setLevel(verbose ? `debug` : `info`);
    log.debug(`Updating ${cwd}/node_modules using repo ${repo}`);
    return readFilePromise(`${cwd}/package.json`, `utf-8`)
        .then((packageJsonContent) => {
            let packageJson = JSON.parse(packageJsonContent);
            // compute a hash based on the stable-stringified contents of package.json
            // (`packageJsonContent` might differ on different platforms, depending on line endings etc.)
            let stableContent = stringify([packageJson.dependencies, packageJson.devDependencies]);
            // replace / in hash with _ because git does not allow leading / in tags
            packageJsonSha1 = crypto.createHash(`sha1`).update(stableContent).digest(`base64`).replace(/\//g, "_");
            packageJsonVersion = packageJson.version;
            log.debug(`SHA-1 of package.json (version ${packageJsonVersion}) is ${packageJsonSha1}`);
            return packageJsonSha1;
        })
        .then(() => {
            return statPromise(`${cwd}/node_modules`)
                .then(() => {
                    log.debug(`Checking if remote ${repo} exists`);
                    process.chdir(`${cwd}/node_modules`);
                    return git(`git remote -v`)
                        .then((remoteCommandOutput) => {
                            if (remoteCommandOutput.indexOf(repo) !== -1) {
                                // repo is in remotes
                                return git(`tag -l --points-at HEAD`)
                                    .then((tags) => {
                                        if (tags.split('\n').indexOf(packageJsonSha1) >= 0) {
                                            // if the current HEAD is at the right commit, don't change anything
                                            log.debug(`${repo} is already at tag ${packageJsonSha1}, leaving as is`);
                                            leaveAsIs = true;
                                        } else {
                                            log.debug(`Remote exists, fetching from it`);
                                            return git(`git fetch -t ${repo}`);
                                        }
                                    });
                            }
                            return cloneRepo();
                        });
                })
                .catch(cloneRepo)
        })
        .then((tags) => {
            if (leaveAsIs) {
                return;
            }
            log.debug(`Remote ${repo} is in node_modules, checking out ${packageJsonSha1} tag`);
            process.chdir(`${cwd}/node_modules`);
            return git(`rev-list ${packageJsonSha1}`, {silent: true})
                .then(() => runNpmScript('preinstall'))
                .then(() => git(`checkout tags/${packageJsonSha1}`, {silent: true}))
                .then(() => {
                    log.debug(`Cleanup checked out commit`);
                    return git(`clean -df`);
                })
                .then(() => {
                    if (crossPlatform) {
                        return rebuildAndIgnorePlatformSpecific();
                    }
                })
                .then(() => runNpmScript('postinstall'))
                .catch(installPackagesTagAndPushToRemote);
        })
        .then(() => {
            process.chdir(`${cwd}`);
            log.info(`Node_modules are in sync with ${repo} ${packageJsonSha1}`);
        })
        .catch((error) => {
            process.chdir(`${cwd}`);
            log.info(`Failed to synchronise node_modules with ${repo}: ${error}`);
            process.exit(1);
        });

    function cloneRepo() {
        log.debug(`Remote ${repo} is not present in ${cwd}/node_modules/.git repo`);
        log.debug(`Removing ${cwd}/node_modules`);
        process.chdir(`${cwd}`);
        return delPromise([`node_modules/`])
            .then(() => {
                log.debug(`Cloning ${repo}`);
                return git(`clone ${repo} node_modules`);
            });
    }

    function git(cmd, {silent}={}) {
        return gitPromise(cmd).catch((error) => {
            if (!silent) {
                // report any Git errors immediately
                log.info(`Git command '${cmd}' failed:\n${error.stdout}`);
            }
            throw error;
        });
    }

    function gitGetUntracked() {
        return git(`status --porcelain --untracked-files=all`)
            .then(result => {
                return result.split('\n').filter(line => line && line.startsWith('??')).map(line => line.substr(3));
            });
    }

    function isNonEmpty(value) {
        return value && value.length;
    }

    /**
     * Determines if the working tree of a Git repository in the current directory has any changes.
     */
    function gitHasChanges() {
        return git(`status --porcelain --untracked-files=all`)
            .then(result => {
                let {index, workingTree} = gitUtil.extractStatus(result);
                if (index) {
                    if (isNonEmpty(index.modified) || isNonEmpty(index.added) || isNonEmpty(index.deleted) ||
                        isNonEmpty(index.renamed) || isNonEmpty(index.copied)) {
                        return true;
                    }
                }
                if (workingTree) {
                    if (isNonEmpty(workingTree.modified) || isNonEmpty(workingTree.added) ||
                        isNonEmpty(workingTree.deleted)) {
                        return true;
                    }
                }
                return false;
            });
    }

    function npmRunCommands(npmCommand, listOfArgs, {silent}={}) {
        let logLevel = [`--loglevel=${verbose ? 'warn' : 'silent'}`];
        return new Promise((resolve, reject) => {
            let output = [];
            listOfArgs.every((args) => {
                let command = ['npm', npmCommand].concat(logLevel).concat(args || []);
                let result = shell.exec(command.join(' '), {silent});
                if (result.code !== 0) {
                    log.info(`npm command '${npmCommand}' failed:\n${result.output}`);
                    reject(new Error(`Running npm returned error code ${result.code}`));
                    return false;
                } else {
                    output.push(result.output);
                    return true;
                }
            });
            resolve(output.join('\n'));
        });
    }

    function npmRunCommand(npmCommand, args, {silent}={}) {
        return npmRunCommands(npmCommand, [args], {silent});
    }

    function runNpmScript(scriptName) {
        return readFilePromise(`${cwd}/package.json`, `utf-8`)
            .then((packageJsonContent) => {
                let packageJson = JSON.parse(packageJsonContent);
                if (packageJson.scripts && packageJson.scripts[scriptName]) {
                    log.debug(`Running ${scriptName} script...`);
                    return npmRunCommand(`run`, scriptName);
                }
            });
    }

    function groupPackages(packages) {
        var groups = [[]];
        packages.forEach((pkg) => {
            let existingGroup = groups[groups.length - 1].concat([pkg]);
            if (existingGroup.join(' ').length < MAX_SHELL_LENGTH - 20) {
                groups[groups.length - 1] = existingGroup;
            } else {
                groups.push([pkg]);
            }
        });
        return groups;
    }

    function rebuildAndIgnorePlatformSpecific() {
        log.debug(`Rebuilding packages in ${cwd}`);
        process.chdir(`${cwd}`);
        let packages = fs.readdirSync(`${cwd}/node_modules`);
        let platform = os.platform();
        let packagesToRebuild = packages.filter(pkg => {
            let platformSpecific = PLATFORM_SPECIFIC_MODULES[pkg];
            if (!platformSpecific || platformSpecific === platform) {
                return true;
            } else {
                log.debug(`Skipping platform-specific build of ${pkg} on ${platform}`);
                return false;
            }
        });
        packagesToRebuild.sort();
        let packageGroups = groupPackages(packagesToRebuild);
        return npmRunCommands('rebuild', packageGroups)
            .then(() => {
                process.chdir(`${cwd}/node_modules`);
                return gitGetUntracked();
            })
            .then((files) => {
                let ignored = [];
                try {
                    ignored = fs.readFileSync('.gitignore', {encoding: 'utf8'}).split('\n');
                } catch (e) {
                    // ignore errors while reading .gitignore
                }
                ignored = ignored.concat(files);
                ignored.sort();
                ignored = uniq(ignored);
                fs.writeFileSync('.gitignore', ignored.join('\n'), {encoding: 'utf8'});
                return git(`add .gitignore`);
            });
    }

    function installPackagesTagAndPushToRemote() {
        log.debug(`Requested tag does not exist, installing node_modules`);
        process.chdir(`${cwd}/node_modules`);
        // Stash any local changes before switching to master.
        // This doesn't seem very elegant... Maybe we should rather hard-reset master to origin/master.
        // This just seems a little "safer".
        // We should also think about what happens if origin/master diverges between here and the actual push.
        return git(`stash save --include-untracked`)
            .then(() => {
                return git(`checkout master`);
            })
            .then(() => {
                // Pull first so that the push later does not (or at least is much less likely to)
                // fail due to diverged branches.
                return git(`pull`);
            })
            .then(() => {
                if (!incrementalInstall) {
                    log.debug(`Removing everything from node_modules`);
                    return delPromise([`**`, `!.git/`]);
                }
            })
            .then(() => {
                process.chdir(`${cwd}`);
                return Promise.resolve();
            })
            .then(() => {
                if (crossPlatform) {
                    return runNpmScript('preinstall');
                }
                return Promise.resolve();
            })
            .then(() => {
                var options = [];
                if (skipInstall) {
                    log.debug(`Skipping 'npm install'`);
                    return Promise.resolve();
                } else {
                    if (crossPlatform) {
                        log.debug(`Running 'npm install'`);
                        options.push('--ignore-scripts');
                    }
                    if (production) {
                        log.debug(`Running 'npm install --production'`);
                        options.push('--production');
                    }
                    log.debug(`This might take a few minutes -- please be patient`);
                    return npmRunCommand(`install`, options);
                }

            })
            .then(() => {
                if (crossPlatform) {
                    return runNpmScript('postinstall');
                }
                return Promise.resolve();
            })
            .then(() => {
                log.debug(`All packages installed, adding files to repo`);
                process.chdir(`${cwd}/node_modules`);
                return git(`add .`);
            })
            .then(() => {
                if (crossPlatform) {
                    return rebuildAndIgnorePlatformSpecific();
                }
            })
            .then(() => {
                return npmRunCommand(`--version`, [], {silent: true});
            })
            .then((versionOutput) => {
                let npmVersion = versionOutput.trim();
                log.debug(`Ran npm ${npmVersion}`);
                process.chdir(`${cwd}/node_modules`);
                return gitHasChanges()
                    .then((hasChanges) => {
                        if (hasChanges) {
                            // Only make another commit if there are actual changes (avoiding an "empty" commit).
                            // Changes in the project's package.json might not lead to changes in installed dependencies
                            // (e.g. because only other metadata was changed).
                            // Then running npm-git-lock will not install new dependencies, if --incremental-install is set.
                            return git(`commit -a -m "sealing package.json dependencies of version ${packageJsonVersion}, using npm ${npmVersion}"`)
                                .then(() => {
                                    log.debug(`Committed`);
                                });
                        }
                    });
            })
            .then(() => {
                log.debug(`Adding tag`);
                return git(`tag ${packageJsonSha1}`)
                    .catch(() => {
                        // Ignore errors while tagging (it's not a problem if the tag already exists)
                    })
                    .then(() => {
                        log.debug(`Pushing tag ${packageJsonSha1} to ${repo}`);
                        return git(`push ${repo} master --tags`);
                    });
            });
    }
};




