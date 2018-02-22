/** @flow */
import path from 'path';
import fs from 'fs-extra';
import R from 'ramda';
import format from 'string-format';
import assignwith from 'lodash.assignwith';
import groupby from 'lodash.groupby';
import unionBy from 'lodash.unionby';
import find from 'lodash.find';
import ignore from 'ignore';
import arrayDiff from 'array-difference';
import {
  glob,
  isDir,
  calculateFileInfo,
  existsSync,
  pathNormalizeToLinux,
  getMissingTestFiles,
  retrieveIgnoreList,
  isAutoGeneratedFile
} from '../../../utils';
import { loadConsumer, Consumer } from '../../../consumer';
import BitMap from '../../../consumer/bit-map';
import { BitId } from '../../../bit-id';
import { COMPONENT_ORIGINS, REGEX_PATTERN, DEFAULT_DIST_DIRNAME } from '../../../constants';
import logger from '../../../logger/logger';
import PathNotExists from './exceptions/path-not-exists';
import MissingComponentIdForImportedComponent from './exceptions/missing-id-imported-component';
import IncorrectIdForImportedComponent from './exceptions/incorrect-id-imported-component';
import NoFiles from './exceptions/no-files';
import DuplicateIds from './exceptions/duplicate-ids';
import EmptyDirectory from './exceptions/empty-directory';
import type { ComponentMapFile } from '../../../consumer/bit-map/component-map';
import type { PathLinux, PathOsBased } from '../../../utils/path';

export default (async function addAction(
  componentPaths: string[],
  id?: string,
  main?: string,
  namespace: ?string,
  tests?: string[],
  exclude?: string[],
  override: boolean
): Promise<Object> {
  const warnings = {};
  let gitIgnore;
  /**
   * validatePaths - validate if paths entered by user exist and if not throw error
   *
   * @param {string[]} fileArray - array of paths
   * @returns {Object} componentPathsStats
   */
  function validatePaths(fileArray: string[]): Object {
    const componentPathsStats = {};
    fileArray.forEach((componentPath) => {
      if (!existsSync(componentPath)) {
        throw new PathNotExists(componentPath);
      }
      componentPathsStats[componentPath] = {
        isDir: isDir(componentPath)
      };
    });
    return componentPathsStats;
  }
  /**
   * Group files by componentId
   *
   * @param {BitId} componentId - consumer path
   * @param {Object[]} files consumer bitMap
   * @returns {ComponentMap[]} componentMap
   */
  function groupFilesByComponentId(componentId: BitId, files: Object[], bitMap: BitMap): Object {
    const filesWithId = files.map((file) => {
      const foundComponentFromBitMap = bitMap.getComponentObjectOfFileByPath(file.relativePath);
      const bitMapComponentId = !R.isEmpty(foundComponentFromBitMap)
        ? Object.keys(foundComponentFromBitMap)[0]
        : undefined;
      return { componentId: bitMapComponentId || componentId, file };
    });
    const groudComponentIdsFile = R.groupBy(componentFromMap => componentFromMap.componentId);
    return groudComponentIdsFile(filesWithId);
  }
  /**
   * Add or update existing(imported and new) components according to bitmap
   *
   * @param {string} consumerPath - consumer path
   * @param {BitMap} bitmap consumer bitMap
   * @param {Object} component - component to add
   * @returns {ComponentMap[]} componentMap
   */
  const addOrUpdateExistingComponentsInBitMap = (
    consumerPath: String,
    bitmap: BitMap,
    component: Object
  ): componentMaps[] => {
    const includeSearchByBoxAndNameOnly = true;
    const shouldThrow = false;
    const groupedById = groupFilesByComponentId(component.componentId, component.files, bitmap);
    const addedComponents = Object.keys(groupedById)
      .map((bitMapComponentId) => {
        const parsedBitId = BitId.parse(bitMapComponentId);
        const files = groupedById[bitMapComponentId].map(({ file }) => file);
        const foundComponentFromBitMap = bitmap.getComponent(
          bitMapComponentId,
          shouldThrow,
          includeSearchByBoxAndNameOnly
        );
        if (foundComponentFromBitMap) {
          component.files = files
            .map((file) => {
              if (!isAutoGeneratedFile(path.join(consumerPath, file.relativePath))) {
                if (bitMapComponentId && foundComponentFromBitMap.rootDir) {
                  // throw error in case user didnt add id to imported component or the id is incorrect
                  if (!id) throw new MissingComponentIdForImportedComponent(parsedBitId.toStringWithoutVersion());
                  if (
                    parsedBitId.toStringWithoutScopeAndVersion() !== id &&
                    parsedBitId.toStringWithoutVersion() !== id
                  ) {
                    throw new IncorrectIdForImportedComponent(parsedBitId.toStringWithoutVersion(), id);
                  }

                  const tempFile = path.relative(foundComponentFromBitMap.rootDir, file.relativePath);
                  const foundFile = find(foundComponentFromBitMap.files, file => file.relativePath === tempFile);

                  if (foundFile) {
                    foundFile.relativePath = path.join(foundComponentFromBitMap.rootDir, foundFile.relativePath);
                    return foundFile;
                  }
                }
                // not imported component file but exists in bitmap
                if (bitmap.getComponentIdByPath(file.relativePath) !== parsedBitId.toString()) {
                  if (warnings[bitMapComponentId]) warnings[bitMapComponentId].push(file.relativePath);
                  else warnings[bitMapComponentId] = [file.relativePath];
                }
                return file;
              }
            })
            .filter(file => !R.isNil(file));
          const locatedIDFromBitMap = bitmap.getExistingComponentId(bitMapComponentId);
          component.componentId = locatedIDFromBitMap
            ? BitId.parse(locatedIDFromBitMap)
            : BitId.parse(bitMapComponentId);
          return addToBitMap(bitMap, component);
        }
        // if id is not in bitmap check that files are not tracked by another component
        component.files = files
          .map((file) => {
            const bitMapid = bitmap.getComponentIdByPath(file.relativePath);
            if (bitMapid) {
              if (warnings[bitMapComponentId]) warnings[bitMapid].push(file.relativePath);
              else warnings[bitMapid] = [file.relativePath];
            } else {
              return file;
            }
          })
          .filter(x => x);
        if (!R.isEmpty(component.files)) return addToBitMap(bitMap, component);
      })
      .filter(x => x);
    return addedComponents;
  };

  // used to validate that no two files where added with the same id in the same bit add command
  const validateNoDuplicateIds = (addComponents: Object[]) => {
    const duplicateIds = {};
    const newGroupedComponents = groupby(addComponents, 'componentId');
    Object.keys(newGroupedComponents).forEach(
      key => (newGroupedComponents[key].length > 1 ? (duplicateIds[key] = newGroupedComponents[key]) : '')
    );
    if (!R.isEmpty(duplicateIds) && !R.isNil(duplicateIds)) throw new DuplicateIds(duplicateIds);
  };
  const addToBitMap = (bitmap: BitMap, { componentId, files, mainFile }): { id: string, files: string[] } => {
    bitMap.addComponent({
      componentId,
      files,
      mainFile,
      origin: COMPONENT_ORIGINS.AUTHORED,
      override
    });
    return { id: componentId.toString(), files: bitMap.getComponent(componentId).files };
  };

  function getPathRelativeToProjectRoot(componentPath, projectRoot: PathOsBased): PathOsBased {
    if (!componentPath) return componentPath;
    const absPath = path.resolve(componentPath);
    return path.relative(projectRoot, absPath);
  }

  // update test files according to dsl
  async function getFiles(files: string[], testFiles: string[]): PathLinux[] {
    const fileList = testFiles.map(async (dsl) => {
      const fileList = files.map(async (file) => {
        const fileInfo = calculateFileInfo(file);
        const generatedFile = format(dsl, fileInfo);
        const matches = await glob(generatedFile, { ignore: ignoreList });
        return matches.filter(match => fs.existsSync(match));
      });
      return Promise.all(fileList);
    });
    const fileListRes = R.flatten(await Promise.all(fileList));
    const uniq = R.uniq(fileListRes);
    return uniq.map((testFile) => {
      const relativeToConsumer = getPathRelativeToProjectRoot(testFile, consumer.getPath());
      return pathNormalizeToLinux(relativeToConsumer);
    });
  }

  async function addOneComponent(componentPathsStats: Object, consumer: Consumer) {
    const bitMap: BitMap = consumer.bitMap;
    // remove excluded files from file list
    async function removeExcludedFiles(mapValues, excludedList) {
      const files = R.flatten(mapValues.map(x => x.files.map(i => i.relativePath)));
      const resolvedExcludedFiles = await getFiles(files, excludedList);
      mapValues.forEach((mapVal) => {
        const mainFile = pathNormalizeToLinux(mapVal.mainFile);
        if (resolvedExcludedFiles.includes(mainFile)) {
          mapVal.files = [];
        } else mapVal.files = mapVal.files.filter(key => !resolvedExcludedFiles.includes(key.relativePath)); // if mainFile is excluded, exclude all files
      });
    }

    // used for updating main file if exists or doesn't exists
    function addMainFileToFiles(files: ComponentMapFile[], mainFile): PathOsBased {
      if (mainFile && mainFile.match(REGEX_PATTERN)) {
        files.forEach((file) => {
          const fileInfo = calculateFileInfo(file.relativePath);
          const generatedFile = format(mainFile, fileInfo);
          const foundFile = R.find(R.propEq('relativePath', generatedFile))(files);
          if (foundFile) {
            mainFile = foundFile.relativePath;
          }
          if (fs.existsSync(generatedFile) && !foundFile) {
            files.push({ relativePath: generatedFile, test: false, name: path.basename(generatedFile) });
            mainFile = generatedFile;
          }
        });
      }
      let resolvedMainFile;
      if (mainFile) {
        const mainPath = path.join(consumer.getPath(), consumer.getPathRelativeToConsumer(mainFile));
        if (fs.existsSync(mainPath)) {
          resolvedMainFile = consumer.getPathRelativeToConsumer(mainPath);
        } else {
          resolvedMainFile = mainFile;
        }
      }
      mainFile = resolvedMainFile;
      return resolvedMainFile;
    }

    let componentExists = false;
    let parsedId: BitId;
    let foundId;
    const updateIdAccordingToExistingComponent = (currentId) => {
      const existingComponentId = bitMap.getExistingComponentId(currentId);
      componentExists = !!existingComponentId;
      if (componentExists && bitMap.getComponent(existingComponentId).origin === COMPONENT_ORIGINS.NESTED) {
        throw new Error(`One of your dependencies (${existingComponentId}) has already the same namespace and name. 
      If you're trying to add a new component, please choose a new namespace or name.
      If you're trying to update a dependency component, please re-import it individually`);
      }

      if (componentExists) foundId = existingComponentId;
      parsedId = existingComponentId ? BitId.parse(existingComponentId) : BitId.parse(currentId);
    };

    const idOrFoundID = foundId || id;

    if (idOrFoundID) {
      updateIdAccordingToExistingComponent(idOrFoundID);
    }

    async function mergeTestFilesWithFiles(files: ComponentMapFile[]): ComponentMapFile[] {
      const testFilesArr = !R.isEmpty(tests) ? await getFiles(files.map(file => file.relativePath), tests) : [];
      const resolvedTestFiles = testFilesArr.map(testFile => ({
        relativePath: testFile,
        test: true,
        name: path.basename(testFile)
      }));

      return unionBy(resolvedTestFiles, files, 'relativePath');
    }

    const mapValuesP = await Object.keys(componentPathsStats).map(async (componentPath) => {
      if (componentPathsStats[componentPath].isDir) {
        const relativeComponentPath = getPathRelativeToProjectRoot(componentPath, consumer.getPath());
        const absoluteComponentPath = path.resolve(componentPath);
        const splitPath = absoluteComponentPath.split(path.sep);
        const lastDir = splitPath[splitPath.length - 1];
        const nameSpaceOrDir = namespace || splitPath[splitPath.length - 2];

        const matches = await glob(path.join(relativeComponentPath, '**'), {
          cwd: consumer.getPath(),
          nodir: true
        });

        const filteredMatches = gitIgnore.filter(matches);

        if (!filteredMatches.length) throw new EmptyDirectory();

        let files = filteredMatches.map((match: PathOsBased) => {
          return { relativePath: pathNormalizeToLinux(match), test: false, name: path.basename(match) };
        });

        // merge test files with files
        files = await mergeTestFilesWithFiles(files);
        const resolvedMainFile = addMainFileToFiles(files, pathNormalizeToLinux(main));
        // matches.forEach((match) => {
        //   if (keepDirectoryName) {
        //     files[match] = match;
        //   } else {
        //     const stripMainDir = match.replace(`${relativeComponentPath}${path.sep}`, '');
        //     files[stripMainDir] = match;
        //   }
        // });

        if (!parsedId) {
          parsedId = BitId.getValidBitId(nameSpaceOrDir, lastDir);
        }

        return { componentId: parsedId, files, mainFile: resolvedMainFile };
      }
      // is file
      const resolvedPath = path.resolve(componentPath);
      const pathParsed = path.parse(resolvedPath);
      const relativeFilePath = getPathRelativeToProjectRoot(componentPath, consumer.getPath());
      if (!parsedId) {
        let dirName = pathParsed.dir;
        if (!dirName) {
          const absPath = path.resolve(componentPath);
          dirName = path.dirname(absPath);
        }
        const nameSpaceOrLastDir = namespace || R.last(dirName.split(path.sep));
        parsedId = BitId.getValidBitId(nameSpaceOrLastDir, pathParsed.name);

        updateIdAccordingToExistingComponent(parsedId.toString());
      }

      let files = [
        { relativePath: pathNormalizeToLinux(relativeFilePath), test: false, name: path.basename(relativeFilePath) }
      ];

      files = await mergeTestFilesWithFiles(files);
      const resolvedMainFile = addMainFileToFiles(files, main);
      // const mainFile = componentExists ? resolvedMainFile : relativeFilePath;
      return { componentId: parsedId, files, mainFile: resolvedMainFile };
    });

    let mapValues = await Promise.all(mapValuesP);

    // remove files that are excluded
    if (exclude) await removeExcludedFiles(mapValues, exclude);

    const componentId = mapValues[0].componentId;
    mapValues = mapValues.filter(mapVal => !(Object.keys(mapVal.files).length === 0));

    if (mapValues.length === 0) return { componentId, files: [] };
    if (mapValues.length === 1) return mapValues[0];

    const files = mapValues.reduce((a, b) => {
      return a.concat(b.files);
    }, []);
    const groupedComponents = groupby(files, 'relativePath');
    const uniqComponents = Object.keys(groupedComponents).map(key =>
      assignwith({}, ...groupedComponents[key], (val1, val2) => val1 || val2)
    );
    return { componentId, files: uniqComponents, mainFile: R.head(mapValues).mainFile };
  }

  const consumer: Consumer = await loadConsumer();
  const bitMap: BitMap = consumer.bitMap;
  const bitJson = await consumer.bitJson;

  let ignoreList = retrieveIgnoreList(consumer.getPath());
  if (!bitJson.distTarget) {
    const importedComponents = bitMap.getAllComponents(COMPONENT_ORIGINS.IMPORTED);
    const distDirsOfImportedComponents = Object.keys(importedComponents).map(key =>
      path.join(importedComponents[key].rootDir, DEFAULT_DIST_DIRNAME, '**')
    );
    ignoreList = ignoreList.concat(distDirsOfImportedComponents);
  }

  // add ignore list
  gitIgnore = ignore().add(ignoreList);

  // check unknown test files
  const missingFiles = getMissingTestFiles(tests);
  if (!R.isEmpty(missingFiles)) throw new PathNotExists(missingFiles);

  let componentPathsStats = {};

  const resolvedComponentPathsWithoutGitIgnore = R.flatten(
    await Promise.all(componentPaths.map(componentPath => glob(componentPath)))
  );

  const resolvedComponentPathsWithGitIgnore = gitIgnore.filter(resolvedComponentPathsWithoutGitIgnore);

  // Run diff on both arrays to see what was filtered out because of the gitignore file
  const diff = arrayDiff(resolvedComponentPathsWithGitIgnore, resolvedComponentPathsWithoutGitIgnore);

  if (!R.isEmpty(tests) && id && R.isEmpty(resolvedComponentPathsWithoutGitIgnore)) {
    const resolvedTestFiles = R.flatten(await Promise.all(tests.map(componentPath => glob(componentPath))));
    componentPathsStats = validatePaths(resolvedTestFiles);
  } else {
    if (R.isEmpty(resolvedComponentPathsWithoutGitIgnore)) throw new PathNotExists(componentPaths);
    if (!R.isEmpty(resolvedComponentPathsWithGitIgnore)) {
      componentPathsStats = validatePaths(resolvedComponentPathsWithGitIgnore);
    } else {
      throw new NoFiles(diff);
    }
  }
  // if a user entered multiple paths and entered an id, he wants all these paths to be one component
  const isMultipleComponents = Object.keys(componentPathsStats).length > 1 && !id;
  const added = [];
  if (isMultipleComponents) {
    logger.debug('bit add - multiple components');
    const testToRemove = !R.isEmpty(tests) ? await getFiles(Object.keys(componentPathsStats), tests) : [];
    testToRemove.forEach(test => delete componentPathsStats[path.normalize(test)]);
    const addedP = Object.keys(componentPathsStats).map((onePath) => {
      return addOneComponent(
        {
          [onePath]: componentPathsStats[onePath]
        },
        consumer
      );
    });

    const addedComponents = await Promise.all(addedP);
    validateNoDuplicateIds(addedComponents);
    addedComponents.forEach((component) => {
      if (!R.isEmpty(component.files)) {
        const addedComponent = addOrUpdateExistingComponentsInBitMap(consumer.projectPath, bitMap, component);
        added.push(addedComponent); // addOrUpdateExistingComponentsInBitMap(consumer.projectPath, bitMap, component);
      }
    });
  } else {
    logger.debug('bit add - one component');
    // when a user enters more than one directory, he would like to keep the directories names
    // so then when a component is imported, it will write the files into the original directories

    const addedOne = await addOneComponent(componentPathsStats, consumer);
    if (!R.isEmpty(addedOne.files)) {
      const addedResult = addOrUpdateExistingComponentsInBitMap(consumer.projectPath, bitMap, addedOne);
      added.push(addedResult);
    }
  }
  await bitMap.write();
  return { addedComponents: R.flatten(added.filter(component => !R.isEmpty(component.files))), warnings };
});
