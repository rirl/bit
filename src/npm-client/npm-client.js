// @flow
import execa from 'execa';
import pMapSeries from 'p-map-series';
import semver from 'semver';
import R, { isNil, merge, toPairs, map, join, is } from 'ramda';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import logger from '../logger/logger';
import { DEFAULT_PACKAGE_MANAGER, BASE_DOCS_DOMAIN } from '../constants';
import type { PathOsBased } from '../utils/path';
import GeneralError from '../error/general-error';
import { Analytics } from '../analytics/analytics';

type PackageManagerResults = { stdout: string, stderr: string };

const objectToArray = obj => map(join('@'), toPairs(obj));
const rejectNils = R.reject(isNil);

const defaultNpmArgs = [];
const defaultYarnArgs = [];
const defaultPackageManagerArgs = {
  npm: defaultNpmArgs,
  yarn: defaultYarnArgs
};
const defaultPackageManagerProcessOptions = {
  cwd: process.cwd
};
const warningPrefix = (packageManager: string): string => {
  return packageManager === 'npm' ? 'npm WARN' : 'warning';
};
const errorPrefix = (packageManager: string): string => {
  return packageManager === 'npm' ? 'npm ERR!' : 'error';
};
const peerDependenciesMissing = (packageManager: string): string => {
  return packageManager === 'npm' ? 'requires a peer' : 'unmet peer';
};

const stripNonNpmErrors = (errors: string, packageManager: string) => {
  // a workaround to remove all 'npm warn' and 'npm notice'.
  // NPM itself returns them even when --loglevel = error or when --silent/--quiet flags are set
  const prefix = errorPrefix(packageManager);
  return errors
    .split('\n')
    .filter(error => error.startsWith(prefix))
    .join('\n');
};

const stripNonPeerDependenciesWarnings = (errors: string, packageManager: string) => {
  const prefix = warningPrefix(packageManager);
  const peer = peerDependenciesMissing(packageManager);
  return errors
    .split('\n')
    .filter(error => error.startsWith(prefix) && error.includes(peer))
    .join('\n');
};

/**
 * Pick only allowed to be overridden options
 * @param {Object} userOptions
 */
const getAllowdPackageManagerProcessOptions = (userOptions) => {
  const allowdOptions = ['shell', 'env', 'extendEnv', 'uid', 'gid', 'preferLocal', 'localDir', 'timeout'];
  return R.pick(allowdOptions, userOptions);
};

type installArgs = {
  modules?: string[] | { [string]: number | string },
  packageManager: 'npm' | 'yarn',
  packageManagerArgs: string[],
  packageManagerProcessOptions: Object,
  useWorkspaces: boolean,
  dirs: string[],
  rootDir: ?string, // Used for yarn workspace
  installRootPackageJson: boolean,
  installPeerDependencies: boolean,
  verbose: boolean
};

/**
 * Install packages in specific directory
 */
const _installInOneDirectory = ({
  modules = [],
  packageManager = DEFAULT_PACKAGE_MANAGER,
  packageManagerArgs = [],
  packageManagerProcessOptions = {},
  dir,
  verbose = false
}): Promise<PackageManagerResults> => {
  // Handle process options
  const allowedPackageManagerProcessOptions = getAllowdPackageManagerProcessOptions(packageManagerProcessOptions);
  const concretePackageManagerProcessOptions = merge(
    defaultPackageManagerProcessOptions,
    allowedPackageManagerProcessOptions
  );
  concretePackageManagerProcessOptions.cwd = dir || concretePackageManagerProcessOptions.cwd;
  const cwd = concretePackageManagerProcessOptions.cwd;

  // taking care of object case
  const processedModules = is(Object, modules) && !Array.isArray(modules) ? objectToArray(modules) : modules;

  // Handle process args
  const concretePackageManagerDefaultArgs = [
    'install',
    ...processedModules,
    ...defaultPackageManagerArgs[packageManager]
  ];
  const concretePackageManagerArgs = rejectNils(R.concat(concretePackageManagerDefaultArgs, packageManagerArgs));

  // Add npm verbose flag
  if (verbose && packageManager === 'npm') {
    // we may want to use it later. For now, it print too much information
    // concretePackageManagerArgs.push('--verbose');
  }

  fs.ensureDirSync(path.join(cwd, 'node_modules'));
  logger.debug(
    `installing npm packages using ${packageManager} at ${cwd} with options:`,
    concretePackageManagerProcessOptions,
    `and args: ${concretePackageManagerArgs}`
  );

  // Set the shell to true to prevent problems with post install scripts when running as root
  const packageManagerClientName = packageManager;
  const childProcess = execa(
    packageManagerClientName,
    concretePackageManagerArgs,
    concretePackageManagerProcessOptions
  );

  // Remove the install from args since it's always there
  const printArgs = concretePackageManagerArgs.filter(arg => arg !== 'install');
  const argsString = printArgs && printArgs.length > 0 ? `with args: ${printArgs}` : '';

  return childProcess
    .then(({ stdout, stderr }) => {
      const successMessage = `\nsuccessfully ran ${packageManager} install at ${cwd} ${argsString}`;
      const peerWarnings = stripNonPeerDependenciesWarnings(stderr, packageManager);

      stdout = verbose ? stdout + successMessage : chalk.white(peerWarnings) + successMessage;
      stderr = verbose ? stderr : '';
      return { stdout, stderr };
    })
    .catch((err) => {
      let stderr = `failed running ${packageManager} install at ${cwd} ${argsString}  \n`;
      stderr += verbose ? err.stderr : stripNonNpmErrors(err.stderr, packageManager);
      return Promise.reject(
        new GeneralError(
          `${stderr}\n\n${chalk.yellow(
            `see troubleshooting at https://${BASE_DOCS_DOMAIN}/docs/install-components.html`
          )}`
        )
      );
    });
};

/**
 * Get peer dependencies for directory
 * you should run this after you run npm install
 * internally it uses npm list -j
 */
const _getPeerDeps = async (dir: PathOsBased): Promise<Object> => {
  const packageManager = DEFAULT_PACKAGE_MANAGER;
  let npmList;
  try {
    npmList = await execa(packageManager, ['list', '-j'], { cwd: dir });
  } catch (err) {
    if (err.stdout && err.stdout.startsWith('{')) {
      // it's probably a valid json with errors, that's fine, parse it.
      npmList = err;
    } else {
      logger.error(err);
      throw new Error(`failed running ${err.cmd} to find the peer dependencies due to an error: ${err.message}`);
    }
  }
  return getPeerDepsFromNpmList(npmList.stdout, packageManager);
};

async function getPeerDepsFromNpmList(npmList: string, packageManager: string): Promise<string[]> {
  const parsePeers = (deps: Object): Object => {
    const result = {};
    R.forEachObjIndexed((dep) => {
      if (dep.peerMissing) {
        const name = dep.required.name;
        const version = dep.required.version;
        result[name] = version;
      }
    }, deps);
    return result;
  };

  const npmListObject = await parseNpmListJsonGracefully(npmList, packageManager);
  const peers = parsePeers(npmListObject.dependencies);
  return objectToArray(peers);
}

async function parseNpmListJsonGracefully(str: string, packageManager: string): Object {
  try {
    const json = JSON.parse(str);
    return json;
  } catch (err) {
    logger.error(err);
    if (packageManager === 'npm') {
      const version = await getNpmVersion();
      Analytics.setExtraData('npmVersion', version);
      if (version && semver.gte(version, '5.0.0') && semver.lt(version, '5.1.0')) {
        // see here for more info about this issue with npm 5.0.0
        // https://github.com/npm/npm/issues/17331
        throw new Error(
          `error: your npm version "${version}" has issues returning json, please upgrade to 5.1.0 or above (npm install -g npm@5.1.0)`
        );
      }
    }
    throw new Error(`failed parsing the output of npm list due to an error: ${err.message}`);
  }
}

/**
 * A wrapper function to call the install
 * then get the peers
 * then install the peers
 */
const _installInOneDirectoryWithPeerOption = async ({
  modules = [],
  packageManager = DEFAULT_PACKAGE_MANAGER,
  packageManagerArgs = [],
  packageManagerProcessOptions = {},
  dir,
  installPeerDependencies = false,
  verbose = false
}): Promise<PackageManagerResults | PackageManagerResults[]> => {
  const rootDirResults = await _installInOneDirectory({
    modules,
    packageManager,
    packageManagerArgs,
    packageManagerProcessOptions,
    dir,
    installPeerDependencies,
    verbose
  });

  if (installPeerDependencies) {
    const peers = await _getPeerDeps(dir);
    const peerResults = await _installInOneDirectory({
      modules: peers,
      packageManager,
      packageManagerArgs,
      packageManagerProcessOptions,
      dir,
      verbose
    });
    return [rootDirResults, peerResults];
  }
  return rootDirResults;
};

/**
 * when modules is empty, it runs 'npm install' without any package, which installs according to package.json file
 */
const installAction = async ({
  modules,
  packageManager = DEFAULT_PACKAGE_MANAGER,
  packageManagerArgs = [],
  packageManagerProcessOptions = {},
  useWorkspaces = false,
  dirs = [],
  rootDir,
  installRootPackageJson = false,
  installPeerDependencies = false,
  verbose = false
}: installArgs): Promise<PackageManagerResults | PackageManagerResults[]> => {
  if (useWorkspaces && packageManager === 'yarn') {
    await _installInOneDirectoryWithPeerOption({
      modules,
      packageManager,
      packageManagerArgs,
      packageManagerProcessOptions,
      dir: rootDir,
      installPeerDependencies,
      verbose
    });
  }

  const results = [];
  if (installRootPackageJson) {
    // installation of the root package.json has to be completed before installing the sub-directories package.json.
    const rootDirResults = await _installInOneDirectoryWithPeerOption({
      modules,
      packageManager,
      packageManagerArgs,
      packageManagerProcessOptions,
      dir: rootDir,
      installPeerDependencies,
      verbose
    });
    if (Array.isArray(rootDirResults)) {
      results.concat(rootDirResults);
    } else {
      results.push(rootDirResults);
    }
  }

  const installInDir = dir =>
    _installInOneDirectoryWithPeerOption({
      modules,
      packageManager,
      packageManagerArgs,
      packageManagerProcessOptions,
      dir,
      installPeerDependencies,
      verbose
    });

  // run npm install for each one of the directories serially, not in parallel. Don’t use Promise.all() here.
  // running them in parallel result in race condition and random NPM errors. (see https://github.com/teambit/bit/issues/1617)
  const promisesResults = await pMapSeries(dirs, installInDir);
  return results.concat(R.flatten(promisesResults));
};

const printResults = ({ stdout, stderr }: { stdout: string, stderr: string }) => {
  console.log(chalk.yellow(stdout)); // eslint-disable-line
  console.log(chalk.yellow(stderr)); // eslint-disable-line
};

async function getNpmVersion(): Promise<?string> {
  try {
    const { stdout, stderr } = await execa('npm', ['--version']);
    if (stdout && !stderr) return stdout;
  } catch (err) {
    logger.debugAndAddBreadCrumb('npm-client', `got an error when executing "npm --version". ${err.message}`);
  }
  return null;
}

async function getYarnVersion(): Promise<?string> {
  try {
    const { stdout } = await execa('yarn', ['-v']);
    return stdout;
  } catch (e) {
    logger.debugAndAddBreadCrumb('npm-client', `can't find yarn version by running yarn -v. ${e.message}`);
  }
  return null;
}

/**
 * a situation where rootDir and subDir have package.json, some of the packages may be shared
 * and some may be conflicted. And the "npm/yarn install" is done from the root dir.
 * package managers install the shared packages only once in the rootDir.
 * however, as to the conflicted packages, only npm@5 and above install it in the subDir.
 * others, install it in the root, which, result in an incorrect package resolution for the subDir.
 */
async function isSupportedInstallationOfSubDirFromRoot(packageManager: string): Promise<boolean> {
  if (packageManager === 'npm') {
    const version = await getNpmVersion();
    if (version && semver.gte(version, '5.0.0')) {
      return true;
    }
  }
  return false;
}

async function getPackageLatestVersion(packageName: string): Promise<?string> {
  try {
    const { stdout } = await execa('npm', ['show', packageName, 'version']);
    return stdout;
  } catch (e) {
    logger.debugAndAddBreadCrumb(
      'npm-client',
      `can't find ${packageName} version by running npm show ${packageName} version. ${e.message}`
    );
  }
  return null;
}

export default {
  install: installAction,
  printResults,
  isSupportedInstallationOfSubDirFromRoot,
  getNpmVersion,
  getYarnVersion,
  getPeerDepsFromNpmList,
  getPackageLatestVersion
};
