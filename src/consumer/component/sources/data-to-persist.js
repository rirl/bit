// @flow
import path from 'path';
import Capsule from '../../../../components/core/capsule';
import AbstractVinyl from './abstract-vinyl';
import Symlink from '../../../links/symlink';
import logger from '../../../logger/logger';
import RemovePath from './remove-path';
import removeFilesAndEmptyDirsRecursively from '../../../utils/fs/remove-files-and-empty-dirs-recursively';

export default class DataToPersist {
  files: AbstractVinyl[];
  symlinks: Symlink[];
  remove: RemovePath[];
  constructor() {
    this.files = [];
    this.symlinks = [];
    this.remove = [];
  }
  addFile(file: AbstractVinyl) {
    if (!file) throw new Error('failed adding an empty file into DataToPersist');
    if (!file.path) {
      throw new Error('failed adding a file into DataToPersist as it does not have a path property');
    }
    const existingFileIndex = this.files.findIndex(existingFile => existingFile.path === file.path);
    if (existingFileIndex !== -1) {
      if (file.override) {
        // delete existing file
        this.files.splice(existingFileIndex, 1);
      } else {
        // don't push this one. keep the existing file
        return;
      }
    }
    this._throwForDirectoryCollision(file);
    this.files.push(file);
  }
  addManyFiles(files: AbstractVinyl[] = []) {
    files.forEach(file => this.addFile(file));
  }
  removePath(pathToRemove: RemovePath) {
    if (!pathToRemove) throw new Error('failed adding a path to remove into DataToPersist');
    if (!this.remove.includes(pathToRemove)) {
      this.remove.push(pathToRemove);
    }
  }
  removeManyPaths(pathsToRemove: RemovePath[] = []) {
    pathsToRemove.forEach(pathToRemove => this.removePath(pathToRemove));
  }
  addSymlink(symlink: Symlink) {
    if (!symlink.src) throw new Error('failed adding a symlink into DataToPersist, src is empty');
    if (!symlink.dest) throw new Error('failed adding a symlink into DataToPersist, dest is empty');
    this.symlinks.push(symlink);
  }
  addManySymlinks(symlinks: Symlink[] = []) {
    symlinks.forEach(symlink => this.addSymlink(symlink));
  }
  merge(dataToPersist: ?DataToPersist) {
    if (!dataToPersist) return;
    this.addManyFiles(dataToPersist.files);
    this.removeManyPaths(dataToPersist.remove);
    this.addManySymlinks(dataToPersist.symlinks);
  }
  async persistAllToFS() {
    this._log();
    this._validate();
    // the order is super important. first remove, then create and finally symlink
    await this._deletePathsFromFS();
    await this._persistFilesToFS();
    await this._persistSymlinksToFS();
  }
  async persistAllToCapsule(capsule: Capsule) {
    this._log();
    // const filesForCapsule = this.files.reduce(
    //   (acc, current) => Object.assign(acc, { [current.path]: current.contents }),
    //   {}
    // );
    await Promise.all(this.remove.map(pathToRemove => capsule.removePath(pathToRemove.path)));
    await Promise.all(this.files.map(file => capsule.outputFile(file.path, file.contents)));
    await Promise.all(this.symlinks.map(symlink => capsule.symlink(symlink.src, symlink.dest)));
  }
  addBasePath(basePath: string) {
    this.files.forEach((file) => {
      this._assertRelative(file.base);
      file.updatePaths({ newBase: path.join(basePath, file.base) });
    });
    this.symlinks.forEach((symlink) => {
      this._assertRelative(symlink.src);
      this._assertRelative(symlink.dest);
      symlink.src = path.join(basePath, symlink.src);
      symlink.dest = path.join(basePath, symlink.dest);
    });
    this.remove.forEach((removePath) => {
      this._assertRelative(removePath.path);
      removePath.path = path.join(basePath, removePath.path);
    });
  }
  /**
   * helps for debugging
   */
  toConsole() {
    console.log(`\nfiles: ${this.files.map(f => f.path).join('\n')}`); // eslint-disable-line no-console
    console.log(`remove: ${this.remove.map(r => r.path).join('\n')}`); // eslint-disable-line no-console
  }
  async _persistFilesToFS() {
    return Promise.all(this.files.map(file => file.write()));
  }
  async _persistSymlinksToFS() {
    return Promise.all(this.symlinks.map(symlink => symlink.write()));
  }
  async _deletePathsFromFS() {
    const pathWithRemoveItsDirIfEmptyEnabled = this.remove.filter(p => p.removeItsDirIfEmpty).map(p => p.path);
    const restPaths = this.remove.filter(p => !p.removeItsDirIfEmpty);
    if (pathWithRemoveItsDirIfEmptyEnabled.length) {
      await removeFilesAndEmptyDirsRecursively(pathWithRemoveItsDirIfEmptyEnabled);
    }
    return Promise.all(restPaths.map(removePath => removePath.persistToFS()));
  }
  _validate() {
    // it's important to make sure that all paths are absolute before writing them to the
    // filesystem. relative paths won't work when running bit commands from an inner dir
    const validateAbsolutePath = (pathToValidate) => {
      if (!path.isAbsolute(pathToValidate)) {
        throw new Error(`DataToPersist expects ${pathToValidate} to be absolute, got relative`);
      }
    };
    this.files.forEach((file) => {
      validateAbsolutePath(file.path);
    });
    this.remove.forEach((removePath) => {
      validateAbsolutePath(removePath.path);
    });
    this.symlinks.forEach((symlink) => {
      validateAbsolutePath(symlink.src);
      validateAbsolutePath(symlink.dest);
    });
  }
  _log() {
    if (this.remove.length) {
      const pathToDeleteStr = this.remove.map(r => r.path).join('\n');
      logger.debug(`DateToPersist, paths-to-delete:\n${pathToDeleteStr}`);
    }
    if (this.files.length) {
      const filesToWriteStr = this.files.map(f => f.path).join('\n');
      logger.debug(`DateToPersist, paths-to-write:\n${filesToWriteStr}`);
    }
    if (this.symlinks.length) {
      const symlinksStr = this.symlinks
        .map(symlink => `src (existing): ${symlink.src}\ndest (new): ${symlink.dest}`)
        .join('\n');
      logger.debug(`DateToPersist, symlinks:\n${symlinksStr}`);
    }
  }
  _assertRelative(pathToCheck: string) {
    if (path.isAbsolute(pathToCheck)) {
      throw new Error(`DataToPersist expects ${pathToCheck} to be relative, but found it absolute`);
    }
  }
  /**
   * prevent adding a file which later on will cause an error "EEXIST: file already exists, mkdir {dirname}".
   * this happens one a file is a directory name of the other file.
   * e.g. adding these two files, will cause the error above: "bar/foo" and "bar"
   *
   * to check for this possibility, we need to consider two scenarios:
   * 1) "bar/foo" is there and now adding "bar" => check whether one of the files starts with "bar/"
   * 2) "bar" is there and now adding "bar/foo" => check whether this file "bar/foo" starts with one of the files with '/'
   * practically, it runs `("bar/foo".startsWith("bar/"))` for both cases above.
   */
  _throwForDirectoryCollision(file: AbstractVinyl) {
    const directoryCollision = this.files.find(
      f => f.path.startsWith(`${file.path}${path.sep}`) || `${file.path}`.startsWith(`${f.path}${path.sep}`)
    );
    if (directoryCollision) {
      throw new Error(`unable to add the file "${file.path}", because another file "${
        directoryCollision.path
      }" is going to be written.
one of them is a directory of the other one, and is not possible to have them both`);
    }
  }
}
